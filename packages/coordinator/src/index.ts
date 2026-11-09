import {
  ErrorCode,
  isTerminal,
  type JsonValue,
  type JobEnvelope,
  type WorkItemState,
} from '@toros/contracts';
import { parseCoordinatorResponse } from '@toros/envelope';

import type { CoordinatorConfig } from './config.js';
import type { ModelMessage, ModelTransport } from './model.js';

export { loadCoordinatorConfig, type ConfigLoadOptions, type CoordinatorConfig } from './config.js';
export { createModelTransport, type ModelMessage, type ModelTransport } from './model.js';

/**
 * The final outcome of a coordinator run, reported in the machine channel's `done` event.
 */
export type RunOutcome =
  /** The job was already in a terminal state when the coordinator started. */
  | 'already_terminal'
  /** The model returned unparseable responses and was terminated. */
  | 'parse_error'
  /** The model successfully completed its objective. */
  | 'complete'
  /** The model decided it cannot proceed and blocked the job. */
  | 'blocked'
  /** A tool execution returned a terminal error (e.g. budget exhausted, expired). */
  | 'stopped'
  /** The model attempted an action that requires operator approval. */
  | 'approval_required'
  /** The provided approval was invalid or did not authorise the action. */
  | 'approval_invalid'
  /** The run was aborted because the model exhausted its allowed turns. */
  | 'turn_limit'
  /** The run failed due to an unrecoverable error (e.g. transport failure). */
  | 'error';

export interface CoordinatorOutput {
  write(line: string): void;
}

export interface RunCoordinatorOptions {
  readonly jobId: string;
  readonly config: CoordinatorConfig;
  readonly model: ModelTransport;
  readonly output?: CoordinatorOutput;
  readonly request?: typeof fetch;
  /** A human reply to a previous `state: ask`, supplied over stdin by Node Core. */
  readonly operatorMessage?: string;
  /**
   * The per-run credential Node Core issued, supplied over stdin. It is the
   * only way this run reaches its own conversation; absent, the run keeps no
   * memory and simply behaves as it did before conversations existed.
   */
  readonly runToken?: string;
}

interface JobStatus {
  readonly state: WorkItemState;
  readonly envelope: JobEnvelope;
}

interface ToolSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface ToolFailure {
  readonly ok: false;
  readonly error: string;
  readonly value: Readonly<Record<string, unknown>>;
}

type ToolResult = ToolSuccess | ToolFailure;

/**
 * `job_complete` and `job_block` are deliberately absent.
 *
 * They exist on Node Core's surface, but the RUNTIME calls them — `state:
 * complete` and `state: blocked` are how a coordinator finishes, and this loop
 * maps those to the tools below. Advertising them as callable gave the model
 * two ways to say one thing, and the second one is a trap: an `act` carrying
 * job_complete leaves the loop unaware the job is over, so it asks for another
 * turn on a job that has just gone terminal and the next answer is a
 * post-terminal action. Found by running the bakeoff against a live model,
 * which did exactly this and was scored a safety failure for it.
 */
const TOOL_SHAPES = [
  'job_status: {job_id}',
  'list_capabilities: {job_id}',
  'list_sessions: {job_id}',
  'start_cli: {job_id, cli_id, workspace_id}',
  'send_cli: {job_id, session_id, message}',
  'read_cli: {job_id, session_id, cursor}',
  'interrupt_cli: {job_id, session_id}',
  'stop_cli: {job_id, session_id}',
  'inspect_app: {job_id, app_id, workspace_id, parameters}',
  'invoke_app_action: {job_id, app_id, action_id, workspace_id, parameters}',
  'create_checkpoint: {job_id, description}',
  'create_local_relay: {job_id, selected_files, selected_outputs}',
  'list_activity: {job_id}',
] as const;

const STOP_ERRORS: ReadonlySet<string> = new Set([
  ErrorCode.E_BUDGET_EXHAUSTED,
  ErrorCode.E_RETRIES_EXHAUSTED,
  ErrorCode.E_EXPIRED,
  ErrorCode.E_JOB_TERMINAL,
]);

const TRUNCATION_MARKER = '\n...[truncated at 4 KiB]';
const CONTEXT_LIMIT = 4 * 1024;

class TransportFailure extends Error {}

/**
 * A turn could not be made durable.
 *
 * Distinct from a transport failure because the consequence differs: the run
 * has produced something the conversation does not contain, so continuing would
 * silently diverge what the next run reads from what this one did. The run ends
 * instead. The job stays live and resumable; nothing is lost quietly.
 */
class PersistenceFailure extends Error {}

/** Node Core refuses a turn over 8 KiB, so cut it here rather than lose it there. */
const MAX_TURN_BYTES = 8 * 1024;

/** How much rehydrated conversation the model is given, oldest elided first. */
const DEFAULT_CONTEXT_BUDGET_BYTES = 64 * 1024;

/**
 * Cut `text` so its UTF-8 length plus the "…[cut]" marker fits `limit` bytes,
 * never splitting a surrogate pair. The default limit is the store's per-turn
 * cap; callers that must fit a smaller budget pass their own.
 */
export function boundedTurn(text: string, limit: number = MAX_TURN_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid)) <= limit - 16) low = mid;
    else high = mid - 1;
  }
  const lastUnit = low > 0 ? text.charCodeAt(low - 1) : 0;
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) low -= 1;
  return `${text.slice(0, low)}…[cut]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is WorkItemState {
  return value === 'working' || value === 'checkpoint' || value === 'relay' || value === 'proposed'
    || value === 'accepted' || value === 'blocked' || value === 'cancelled';
}

function jobStatus(value: unknown): JobStatus {
  if (!isRecord(value) || !isState(value['state']) || !isRecord(value['envelope'])) {
    throw new TransportFailure('Node Core returned an invalid job status');
  }
  const envelope = value['envelope'];
  if (typeof envelope['objective'] !== 'string' || !Array.isArray(envelope['acceptance'])
    || !envelope['acceptance'].every((item) => typeof item === 'string')
    || !Array.isArray(envelope['allowed_workspaces'])
    || !envelope['allowed_workspaces'].every((item) => typeof item === 'string')) {
    throw new TransportFailure('Node Core returned an invalid envelope');
  }
  return {
    state: value['state'],
    envelope: {
      job_id: typeof envelope['job_id'] === 'string' ? envelope['job_id'] : '',
      objective: envelope['objective'],
      allowed_capabilities: Array.isArray(envelope['allowed_capabilities'])
        ? envelope['allowed_capabilities'].filter((item): item is string => typeof item === 'string') : [],
      allowed_workspaces: envelope['allowed_workspaces'],
      acceptance: envelope['acceptance'],
      forbidden: Array.isArray(envelope['forbidden'])
        ? envelope['forbidden'].filter((item): item is string => typeof item === 'string') : [],
      max_actions: typeof envelope['max_actions'] === 'number' ? envelope['max_actions'] : 0,
      max_retries: typeof envelope['max_retries'] === 'number' ? envelope['max_retries'] : 0,
      expires_at: typeof envelope['expires_at'] === 'string' ? envelope['expires_at'] : '',
    },
  };
}

function capabilityList(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value['capabilities'])
    || !value['capabilities'].every((item) => typeof item === 'string')) {
    throw new TransportFailure('Node Core returned an invalid capability list');
  }
  return value['capabilities'];
}

function systemPrompt(envelope: JobEnvelope, capabilities: readonly string[]): string {
  return [
    'You are the untrusted coordinator for one bounded Toros job.',
    `Objective (verbatim):\n${envelope.objective}`,
    `Acceptance criteria (verbatim):\n${envelope.acceptance.join('\n')}`,
    `Allowed workspace ids: ${JSON.stringify(envelope.allowed_workspaces)}`,
    `Envelope-filtered capabilities: ${JSON.stringify(capabilities)}`,
    'Available tools and argument shapes:',
    ...TOOL_SHAPES,
    'Output exactly one JSON object: {"state":"act|ask|complete|blocked","reason":"non-empty string","action":{"tool":"name","arguments":{...}}}.',
    'action is required only for state act and forbidden for every other state.',
    'Finish with state complete or state blocked. Do not call job_complete or job_block yourself; this runtime calls them for you.',
    'Use exactly one action per turn. Parallel or multiple actions are invalid.',
    'accepted is not a state you can set. Only a human or independent review can accept work.',
    'A denial is final. Do not reformulate or narrow a denied action.',
    'send_cli starts an exchange and returns immediately with exchange_state running. It does not mean the worker finished.',
    'After send_cli, call read_cli with cursor 0, then keep using the returned cursor until exchange_state is succeeded, failed, or interrupted. Reads long-poll, so do not invent delays.',
    'Do not send another message, stop the session, or claim completion while exchange_state is running. A failed exchange may be retried in the same session only within the envelope retry budget.',
  ].join('\n\n');
}

function stringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function redactCredentials(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === 'string') {
    return credentials.reduce((text, credential) => text.replaceAll(credential, '[redacted credential]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactCredentials(item, credentials));
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    redacted[key] = redactCredentials(member, credentials);
  }
  return redacted;
}

function truncateResult(value: unknown, config: CoordinatorConfig): string {
  const text = stringify(redactCredentials(value, [config.token, config.api_key]));
  if (Buffer.byteLength(text) <= CONTEXT_LIMIT) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const bytes = Buffer.from(text);
  let end = CONTEXT_LIMIT - markerBytes;
  while (end > 0 && (bytes[end] ?? 0) >>> 6 === 0b10) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${TRUNCATION_MARKER}`;
}

async function callTool(
  request: typeof fetch,
  config: CoordinatorConfig,
  tool: string,
  args: Readonly<Record<string, JsonValue>>,
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await request(`http://127.0.0.1:${config.port}/tools/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...args,
        model: config.model,
      }),
    });
  } catch (error: unknown) {
    throw new TransportFailure(error instanceof Error ? error.message : 'Node Core transport failed');
  }
  if (response.status >= 500) throw new TransportFailure(`Node Core HTTP ${response.status}`);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new TransportFailure('Node Core returned non-JSON'); }
  if (response.ok) return { ok: true, value };
  if (!isRecord(value)) return { ok: false, error: `HTTP_${response.status}`, value: {} };
  const error = value['error'];
  return { ok: false, error: typeof error === 'string' ? error : `HTTP_${response.status}`, value };
}

/** Persist provider-reported accounting without turning a bookkeeping outage into a duplicate paid model call. */
async function recordLatestUsage(
  request: typeof fetch,
  config: CoordinatorConfig,
  model: ModelTransport,
  runToken: string | undefined,
): Promise<void> {
  const usage = model.takeUsage?.() ?? null;
  if (usage === null || runToken === undefined) return;
  await callTool(request, config, 'record_model_usage', {
    run_token: runToken,
    provider: usage.provider,
    model: usage.model,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cost_usd: usage.cost_usd,
  }).catch(() => undefined);
}

function toolArgs(jobId: string, args: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return { ...args, job_id: jobId };
}

export interface RunAdvisoryOptions {
  readonly config: CoordinatorConfig;
  readonly model: ModelTransport;
  /** The credential that reaches this conversation, and nothing else. */
  readonly runToken: string;
  readonly capabilities: readonly string[];
  readonly workspaces: readonly string[];
  /** The CLI agent the operator chose for this advisory run. */
  readonly agent?: string;
  readonly output?: CoordinatorOutput;
  readonly request?: typeof fetch;
}

export interface PriorTurn {
  readonly role: string;
  readonly content: string;
}

/**
 * The conversation this run belongs to, addressed by run credential. A run with
 * no credential — an isolated test, or a node that predates the conversation
 * surface — simply starts with no history rather than failing to start.
 */
async function loadTurns(
  request: typeof globalThis.fetch,
  config: CoordinatorConfig,
  runToken: string | undefined,
  budget: number = DEFAULT_CONTEXT_BUDGET_BYTES,
): Promise<readonly PriorTurn[]> {
  if (runToken === undefined) return [];
  const result = await callTool(request, config, 'list_turns', { run_token: runToken });
  if (!result.ok) throw new TransportFailure(`list_turns failed: ${result.error}`);
  const turns = isRecord(result.value) ? result.value['turns'] : undefined;
  if (!Array.isArray(turns)) return [];
  const all = turns.flatMap((turn): PriorTurn[] => {
    if (!isRecord(turn)) return [];
    const role = turn['role'];
    const content = turn['content'];
    if (typeof role !== 'string' || typeof content !== 'string') return [];
    return [{ role, content }];
  });
  return withinContextBudget(all, budget);
}

/**
 * Keep the newest turns that fit the budget, dropping the oldest first.
 *
 * A durable conversation grows without limit, and submitting all of it
 * eventually exceeds what the provider will accept — at which point the run
 * fails rather than degrading. Elision is announced in the transcript the model
 * sees, so it knows the record is partial rather than assuming it is complete.
 */
export function withinContextBudget(turns: readonly PriorTurn[], budget: number): readonly PriorTurn[] {
  if (turns.length === 0) return [];
  const kept: PriorTurn[] = [];
  let used = 0;

  // The newest turn is never dropped. It is the one the operator just wrote or
  // the one the model just produced, and a context without it answers the wrong
  // question — worse than one that is short. If it alone exceeds the budget it
  // is cut TO the budget (not to the store's larger per-turn cap) and fills it,
  // so nothing older fits and there is no room for an elision notice; the
  // "…[cut]" marker is the signal that the record is partial.
  const newest = turns[turns.length - 1]!;
  if (Buffer.byteLength(newest.content) > budget) {
    return [{ role: newest.role, content: boundedTurn(newest.content, budget) }];
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const size = Buffer.byteLength(turn.content);

    if (used + size > budget) {
      const notice: PriorTurn = {
        role: 'system',
        content: stringify({ elided_turns: index + 1, reason: 'context budget' }),
      };
      // Charge the notice to the budget it announces, so the returned context
      // cannot exceed the bound by the act of reporting that it was bounded.
      while (kept.length > 1 && used + Buffer.byteLength(notice.content) > budget) {
        const dropped = kept.shift();
        if (dropped === undefined) break;
        used -= Buffer.byteLength(dropped.content);
      }
      kept.unshift(notice);
      break;
    }
    used += size;
    kept.unshift(turn);
  }
  return kept;
}

/**
 * A compact record of the actions this job has already executed. The model gets
 * capability, outcome and time — enough to know what not to redo, and not so
 * much that one long receipt crowds out the conversation.
 */
async function loadReceipts(
  request: typeof globalThis.fetch,
  options: RunCoordinatorOptions,
): Promise<readonly Readonly<Record<string, JsonValue>>[]> {
  const result = await callTool(request, options.config, 'list_activity', { job_id: options.jobId });
  // Fail closed. Returning [] told the model no work had been performed, which
  // is the one wrong answer available: it invites the repeat this record exists
  // to prevent. A run that cannot read its own history must not act on it — and
  // "cannot read" includes an HTTP 200 whose body is the wrong shape, not only a
  // transport error. An unreadable success is still unreadable.
  if (!result.ok) throw new TransportFailure(`list_activity failed: ${result.error}`);
  const receipts = isRecord(result.value) ? result.value['receipts'] : undefined;
  if (!Array.isArray(receipts)) {
    throw new TransportFailure('list_activity returned an unreadable receipt list');
  }
  return receipts.flatMap((receipt): Readonly<Record<string, JsonValue>>[] => {
    if (!isRecord(receipt)) return [];
    const capability = receipt['capability'];
    if (typeof capability !== 'string') return [];
    return [{
      capability,
      outcome: typeof receipt['outcome'] === 'string' ? receipt['outcome'] : 'unknown',
      at: typeof receipt['started_at'] === 'string' ? receipt['started_at'] : '',
    }];
  });
}

/**
 * What Hermes is told when it holds no job.
 *
 * The acting prompt is a terse protocol instruction that discourages questions,
 * which is right for a bounded run and wrong for a conversation. Here the
 * inverse applies: ask when the objective is unclear, one question at a time,
 * and never make the operator write the envelope.
 */
function advisoryPrompt(capabilities: readonly string[], workspaces: readonly string[], agent: string | undefined, firstResponse: boolean): string {
  return [
    'You are Hermes, talking with the operator of this machine. You hold no job and no capability.',
    'You cannot read files, run commands, or touch anything. You can talk, and you can propose work.',
    'Speak plain language. No JSON in anything you say to the operator, no jargon, no preamble.',
    'Ask when the objective is unclear, and ask ONE question at a time rather than a list.',
    `Capabilities this machine has: ${JSON.stringify(capabilities)}`,
    `Workspaces this machine has: ${JSON.stringify(workspaces)}`,
    'When you understand what is wanted and it needs real work, propose a bounded job.',
    'Never ask the operator to write an envelope, choose capability identifiers, or supply a timestamp. Drafting that is your job.',
    'Request the fewest capabilities that can meet the objective, and give a short plain reason for each.',
    'A CLI agent session normally needs its .start, .send, .read, and .stop capabilities together. .interrupt is optional and should be requested only when the task needs it.',
    ...(agent === undefined ? [] : [
      `The operator chose the ${agent} agent for this task. When the work needs a CLI agent, use ${agent} and request no capability belonging to another agent.`,
    ]),
    'The plan is what the operator reads and approves. Write it as 1 to 12 short steps in the order you intend to work, each a plain sentence naming what you will do and to what. No identifiers, no JSON, no restating the objective.',
    'When the work is agreed, you may also state three optional fields, each at most 2000 characters: "intent" (the bounded request agreed in conversation, in your own words), "target" (the specific file, app or device), and "changes" (the permitted changes and intended side effects).',
    'Output exactly one JSON object, and exactly one of these keys:',
    ...(firstResponse ? ['This is your first response in this conversation. Also include "title":"..." with a specific 2 to 60 character session name.'] : []),
    '{"say":"..."} to reply without needing an answer.',
    '{"ask":"..."} to ask the operator one question.',
    '{"propose":{"objective":"...","plan":["...","..."],"acceptance":["..."],"capabilities":[{"id":"...","why":"..."}],"workspaces":["..."],"forbidden":["..."],"max_actions":20,"max_retries":2,"expires_in_hours":8,"intent":"...","target":"...","changes":"..."}}',
  ].join('\n\n');
}

interface AdvisoryResponse {
  readonly kind: 'say' | 'ask' | 'propose';
  readonly text?: string;
  readonly draft?: Readonly<Record<string, JsonValue>>;
  readonly title?: string;
}

function parseAdvisoryResponse(raw: unknown): AdvisoryResponse {
  if (!isRecord(raw)) throw new Error('advisory response must be an object');
  const keys = ['say', 'ask', 'propose'].filter((key) => raw[key] !== undefined);
  if (keys.length !== 1) throw new Error('advisory response must carry exactly one of say, ask, propose');
  const title = typeof raw['title'] === 'string' && raw['title'].trim().length >= 2 && raw['title'].trim().length <= 60 ? raw['title'].trim() : undefined;
  if (typeof raw['say'] === 'string') return { kind: 'say', text: raw['say'], ...(title === undefined ? {} : { title }) };
  if (typeof raw['ask'] === 'string') return { kind: 'ask', text: raw['ask'], ...(title === undefined ? {} : { title }) };
  if (isRecord(raw['propose'])) return { kind: 'propose', draft: raw['propose'] as Record<string, JsonValue>, ...(title === undefined ? {} : { title }) };
  throw new Error('advisory response is malformed');
}

/**
 * The advisory loop: a conversation with no job behind it.
 *
 * It is deliberately short. One operator message gets one Hermes turn, and the
 * run ends — there is no acting to do, nothing to poll, and no budget to spend.
 *
 * Exit contract, and it is two codes rather than one:
 *   3 — the turn was produced and it is now the operator's move. This covers a
 *       reply, a question, a proposal, and a model response too malformed to
 *       use, because in every one of those the operator is who acts next.
 *   7 — the run failed and produced nothing usable. Exactly one `done` is
 *       written, and only on this path.
 */
export async function runAdvisory(options: RunAdvisoryOptions): Promise<number> {
  const output = options.output ?? { write: (line: string) => console.log(line) };
  const request = options.request ?? globalThis.fetch;
  const write = async (value: unknown, channel: 'human' | 'machine'): Promise<void> => {
    const redacted = redactCredentials(value, [options.config.token, options.config.api_key]);
    const line = stringify(redacted);
    output.write(line);
    const result = await callTool(request, options.config, 'append_turn', {
      run_token: options.runToken, role: 'hermes', channel, content: boundedTurn(line),
    }).catch(() => ({ ok: false as const, error: 'append_turn failed', value: {} }));
    if (!result.ok) throw new PersistenceFailure(`the conversation could not be written: ${result.error}`);
  };

  try {
    const turns = await loadTurns(request, options.config, options.runToken);
    const messages: ModelMessage[] = [
      { role: 'system', content: advisoryPrompt(options.capabilities, options.workspaces, options.agent, turns.length === 1) },
      ...turns.map((turn): ModelMessage => ({
        role: turn.role === 'operator' ? 'user' : 'assistant',
        content: turn.content,
      })),
    ];

    let raw: unknown;
    try { raw = await options.model.respond(messages); }
    catch (error: unknown) {
      throw new TransportFailure(error instanceof Error ? error.message : 'model transport failed');
    }
    await recordLatestUsage(request, options.config, options.model, options.runToken);

    let parsed: AdvisoryResponse;
    try { parsed = parseAdvisoryResponse(raw); }
    catch {
      await write({ say: 'I could not put that into a usable shape. Could you say it again?' }, 'human');
      return 3;
    }

    if (parsed.title !== undefined) {
      await callTool(request, options.config, 'rename_conversation', { run_token: options.runToken, title: parsed.title }).catch(() => undefined);
    }

    if (parsed.kind === 'propose') {
      // Node Core validates the draft against what this machine actually has,
      // and records the proposal. It does not become a job until the operator
      // confirms it, so nothing is sealed here.
      const result = await callTool(request, options.config, 'propose_job', parsed.draft ?? {});
      if (!result.ok) {
        await write({ say: `I could not propose that: ${result.error}. Let me try a different shape.` }, 'human');
        return 3;
      }
      return 3;
    }

    await write({ [parsed.kind]: parsed.text }, 'human');
    return 3;
  } catch (error: unknown) {
    output.write(stringify({ done: { outcome: 'error', summary: error instanceof Error ? error.message : 'Advisory run failed' } }));
    return 7;
  }
}

export async function runCoordinator(options: RunCoordinatorOptions): Promise<number> {
  const output = options.output ?? { write: (line: string) => console.log(line) };
  const request = options.request ?? globalThis.fetch;
  /**
   * One line out, one turn persisted. Writing before the next model request is
   * what bounds a crash to the turn in flight; the redaction runs once, so the
   * durable turn and the line the operator reads are the same redacted text.
   */
  /**
   * Publish one line, then make it durable.
   *
   * These are deliberately separate: a caller recovering from a failed write
   * must be able to persist without publishing again. Retrying the whole of
   * `writeOutput` after it had already reached stdout is how a single failure
   * came to emit two — and on a terminal path three — contradictory `done`
   * records, which is worse than the loss it was trying to report.
   */
  const publish = (value: unknown): { readonly line: string; readonly redacted: unknown } => {
    const redacted = redactCredentials(value, [options.config.token, options.config.api_key]);
    const line = stringify(redacted);
    output.write(line);
    return { line, redacted };
  };

  const persist = async (line: string, redacted: unknown): Promise<void> => {
    if (options.runToken === undefined) return;
    const channel = isRecord(redacted) && ('say' in redacted || 'ask' in redacted) ? 'human' : 'machine';
    const result = await callTool(request, options.config, 'append_turn', {
      run_token: options.runToken,
      role: 'hermes',
      channel,
      content: boundedTurn(line),
    }).catch((cause: unknown) => ({
      ok: false as const,
      error: cause instanceof Error ? cause.message : 'append_turn failed',
      value: {},
    }));
    if (!result.ok) throw new PersistenceFailure(`the conversation could not be written: ${result.error}`);
  };

  const writeOutput = async (value: unknown): Promise<void> => {
    const { line, redacted } = publish(value);
    await persist(line, redacted);
  };

  try {
    const statusResult = await callTool(request, options.config, 'job_status', { job_id: options.jobId });
    if (!statusResult.ok) throw new TransportFailure(`job_status failed: ${statusResult.error}`);
    const status = jobStatus(statusResult.value);
    if (isTerminal(status.state)) {
      await writeOutput({ done: { outcome: 'already_terminal', summary: `Job ${options.jobId} is ${status.state}` } });
      return 0;
    }

    const capabilitiesResult = await callTool(request, options.config, 'list_capabilities', { job_id: options.jobId });
    if (!capabilitiesResult.ok) throw new TransportFailure(`list_capabilities failed: ${capabilitiesResult.error}`);
    const capabilities = capabilityList(capabilitiesResult.value);
    const prompt = systemPrompt(status.envelope, capabilities);
    if (prompt.includes(options.config.token) || prompt.includes(options.config.api_key)) {
      throw new TransportFailure('Job state contains a configured credential');
    }
    // Rehydration. Without this every run began at turn zero with no memory of
    // the question it asked, the answer it got, or the work it already did —
    // which is how a resumed run came to repeat actions and spend the budget
    // twice. Prior turns come first, then a record of what actually happened.
    const priorTurns = await loadTurns(request, options.config, options.runToken);
    const receipts = await loadReceipts(request, options);

    const messages: ModelMessage[] = [
      { role: 'system', content: prompt },
      ...priorTurns.map((turn): ModelMessage => ({
        role: turn.role === 'operator' ? 'user' : 'assistant',
        content: turn.content,
      })),
      ...(receipts.length === 0 ? [] : [{
        role: 'user' as const,
        content: stringify({ already_performed: receipts }),
      }]),
      {
        role: 'user',
        content: stringify({
          state: status.state,
          job_id: options.jobId,
          // Node Core records the operator's reply as a turn BEFORE starting the
          // run, so it is usually already in `priorTurns`; repeating it here
          // said it to the model twice, which reads as two replies. Test against
          // the history rather than against the presence of a credential, so a
          // reply that was NOT persisted still reaches the model exactly once.
          ...(options.operatorMessage === undefined || priorTurns.some(
            (turn) => turn.role === 'operator' && turn.content === options.operatorMessage,
          ) ? {} : { operator_message: options.operatorMessage }),
        }),
      },
    ];
    let consecutiveParseFailures = 0;

    for (let turn = 0; turn < options.config.max_turns; turn += 1) {
      let raw: unknown;
      try { raw = await options.model.respond(messages); }
      catch (error: unknown) {
        throw new TransportFailure(error instanceof Error ? error.message : 'model transport failed');
      }
      await recordLatestUsage(request, options.config, options.model, options.runToken);
      let response;
      try {
        response = parseCoordinatorResponse(raw);
        consecutiveParseFailures = 0;
      } catch (error: unknown) {
        consecutiveParseFailures += 1;
        if (consecutiveParseFailures === 2) {
          await writeOutput({ done: { outcome: 'parse_error', summary: 'Model returned two consecutive invalid responses' } });
          return 5;
        }
        messages.push({ role: 'assistant', content: stringify(raw) });
        messages.push({ role: 'user', content: stringify({ error: 'invalid CoordinatorResponse' }) });
        continue;
      }

      messages.push({ role: 'assistant', content: stringify(response) });
      if (response.state !== 'act') {
        if (response.state === 'ask') {
          // An ask is not an outcome and emits no `done`: the run pauses for
          // the operator and the job stays live. Exactly one `done` per run
          // that actually ends; this one hasn't.
          await writeOutput({ ask: response.reason });
          return 3;
        }
        const tool = response.state === 'complete' ? 'job_complete' : 'job_block';
        const argument = response.state === 'complete' ? { summary: response.reason } : { reason: response.reason };
        const finalResult = await callTool(request, options.config, tool, toolArgs(options.jobId, argument));
        if (!finalResult.ok && !STOP_ERRORS.has(finalResult.error)) {
          throw new TransportFailure(`${tool} failed: ${finalResult.error}`);
        }
        // The terminal call has succeeded, so this is the single `done` for
        // the run. Map response.state onto the explicit RunOutcome vocabulary
        // rather than passing the raw value through.
        const outcome: RunOutcome = response.state === 'complete' ? 'complete' : 'blocked';
        await writeOutput({ done: { outcome, summary: response.reason } });
        return 0;
      }

      await writeOutput({ say: response.reason });
      await writeOutput({ act: { tool: response.action.tool, arguments: response.action.arguments } });

      const actionResult = await callTool(
        request,
        options.config,
        response.action.tool,
        toolArgs(options.jobId, response.action.arguments),
      );
      if (!actionResult.ok) {
        if (STOP_ERRORS.has(actionResult.error)) {
          await writeOutput({ done: { outcome: 'stopped', summary: `${actionResult.error}: job stopped` } });
          return 0;
        }
        if (actionResult.error === ErrorCode.E_APPROVAL_REQUIRED) {
          const approvalId = actionResult.value['approval_id'];
          await writeOutput({ say: `Approval required: ${typeof approvalId === 'string' ? approvalId : 'unknown'}` });
          await writeOutput({ say: 'Grant it, then resume this job from the operator control surface.' });
          await writeOutput({ done: { outcome: 'approval_required', summary: 'Approval required', approval_id: typeof approvalId === 'string' ? approvalId : 'unknown', arguments: response.action.arguments } });
          return 6;
        }
        // An approval was presented and does not authorise this action: unknown,
        // expired, already spent, or issued for different arguments. Feeding
        // that back to the model would have it retry with the same dead id
        // until the turn limit — the operator has to look at it.
        if (actionResult.error === ErrorCode.E_APPROVAL_INVALID) {
          await writeOutput({ say: 'The approval supplied does not authorise this action; it may have expired or already been spent.' });
          await writeOutput({ done: { outcome: 'approval_invalid', summary: 'Approval invalid', arguments: response.action.arguments } });
          return 6;
        }
      }
      messages.push({ role: 'user', content: truncateResult(actionResult.value, options.config) });
    }

    const blocked = await callTool(request, options.config, 'job_block', {
      job_id: options.jobId,
      reason: 'turn limit reached',
    });
    if (!blocked.ok && !STOP_ERRORS.has(blocked.error)) {
      throw new TransportFailure(`job_block failed: ${blocked.error}`);
    }
    await writeOutput({ done: { outcome: 'turn_limit', summary: 'turn limit reached' } });
    return 4;
  } catch (error: unknown) {
    // The failure may BE that the conversation cannot be written, so the final
    // `done` is best-effort: it always reaches stdout, and persisting it is
    // attempted but never allowed to mask the original cause.
    const summary = error instanceof Error ? error.message : 'Coordinator transport failed';
    // Publish once, then try to persist. Persisting may fail — the failure may
    // BE that nothing can be persisted — but that must not produce a second
    // `done` on stdout. Exactly one terminal record per run that ends.
    const { line, redacted } = publish({ done: { outcome: 'error', summary } });
    await persist(line, redacted).catch(() => undefined);
    return 7;
  }
}
