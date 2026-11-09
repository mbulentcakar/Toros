import { ErrorCode, isTerminal, type JsonValue, type Store } from '@toros/contracts';
import type { Relay } from '@toros/relay';

import type { ActionPipeline } from './action-pipeline.js';
import type { ConversationGuard } from './conversation-guard.js';
import { agreementDigest, redactProposal, MAX_TURN_BYTES, type DraftService } from './draft.js';
import { optionalString, requiredString, stringArray, toros, type ToolRouteSurface } from './http.js';
import type { RunBinding, RunCredentials } from './run-credentials.js';
import type { StageGraphController } from './stage-graph.js';

export const TOOL_NAMES = new Set([
  'job_status', 'job_complete', 'job_block', 'list_capabilities', 'list_sessions',
  'start_cli', 'send_cli', 'read_cli', 'interrupt_cli', 'stop_cli',
  'inspect_app', 'invoke_app_action', 'create_checkpoint', 'create_local_relay', 'list_activity',
  'list_turns', 'append_turn', 'propose_job',
  'rename_conversation', 'record_model_usage',
]);

/**
 * What an advisory run may call. Everything absent from this set touches the
 * machine and is refused before it reaches a capability, a workspace, or an
 * adapter.
 */
export const ADVISORY_TOOLS: ReadonlySet<string> = new Set(['propose_job', 'list_turns', 'append_turn', 'rename_conversation', 'record_model_usage']);

export function createToolRoutes(deps: {
  readonly registeredCapabilities: () => readonly string[];
  readonly store: () => Store;
  readonly stageGraphs: () => StageGraphController;
  readonly relay: () => Relay;
  readonly runCredentials: RunCredentials;
  readonly draft: DraftService;
  readonly actionPipeline: ActionPipeline;
  readonly conversationGuard: ConversationGuard;
}): ToolRouteSurface {
  async function job(args: Readonly<Record<string, JsonValue>>) {
    const found = await deps.store().getJob(requiredString(args, 'job_id'));
    if (found === null) throw toros(ErrorCode.E_ENVELOPE_INVALID, 'Unknown job');
    return found;
  }

  async function dispatch(tool: string, args: Readonly<Record<string, JsonValue>>, advisory: RunBinding | null = null): Promise<unknown> {
    if (tool === 'job_status') return job(args);
    if (tool === 'job_complete' || tool === 'job_block') {
      const current = await job(args);
      if (isTerminal(current.state)) throw toros(ErrorCode.E_JOB_TERMINAL, 'The job is in a terminal state');
      const summary = optionalString(args, 'summary') ?? optionalString(args, 'reason') ?? '';
      return tool === 'job_complete'
        ? deps.stageGraphs().completeJob(current.job_id, summary)
        : deps.stageGraphs().blockJob(current.job_id, summary || 'The stage coordinator reported it was blocked.');
    }
    if (tool === 'list_capabilities') {
      const current = await job(args);
      return { capabilities: deps.registeredCapabilities().filter((capability) => current.envelope.allowed_capabilities.includes(capability)) };
    }
    if (tool === 'list_sessions') { const current = await job(args); return { sessions: await deps.store().listSessions(current.job_id) }; }
    if (tool === 'list_activity') {
      const current = await job(args);
      return { receipts: await deps.store().listReceipts(current.job_id), events: await deps.store().listEvents(current.job_id) };
    }
    // The conversation surface is addressed by run credential, never by
    // conversation id: a run can reach its own history and nothing else.
    if (tool === 'list_turns') {
      const run = deps.runCredentials.runFor(args, advisory);
      const after = args['after'];
      if (after !== undefined && after !== null && (typeof after !== 'number' || !Number.isInteger(after) || after < 0)) {
        throw toros(ErrorCode.E_SCHEMA, 'after must be a non-negative integer');
      }
      return { turns: await deps.store().listTurns(run.conversation_id, typeof after === 'number' ? { after } : {}) };
    }
    if (tool === 'append_turn') {
      const run = deps.runCredentials.runFor(args, advisory);
      const content = requiredString(args, 'content');
      if (Buffer.byteLength(content) > MAX_TURN_BYTES) throw toros(ErrorCode.E_SCHEMA, `content must not exceed ${MAX_TURN_BYTES} bytes`);
      const role = requiredString(args, 'role');
      const channel = requiredString(args, 'channel');
      // The coordinator may only speak as itself. Writing an `operator` turn
      // would let it manufacture instructions it then reads back as human.
      if (role !== 'hermes' && role !== 'tool') throw toros(ErrorCode.E_SCHEMA, 'role must be hermes or tool');
      if (channel !== 'human' && channel !== 'machine') throw toros(ErrorCode.E_SCHEMA, 'channel must be human or machine');
      return deps.conversationGuard.run(run.conversation_id, () => deps.store().appendTurn({ conversation_id: run.conversation_id, role, channel, content: deps.runCredentials.redactSecrets(content), job_id: run.job_id }));
    }
    if (tool === 'rename_conversation') {
      const run = deps.runCredentials.runFor(args, advisory);
      const title = requiredString(args, 'title').trim();
      if (title.length < 2 || title.length > 60) throw toros(ErrorCode.E_SCHEMA, 'title must contain 2 to 60 characters');
      return deps.conversationGuard.run(run.conversation_id, () => deps.store().renameConversation(run.conversation_id, title));
    }
    if (tool === 'record_model_usage') {
      const run = deps.runCredentials.runFor(args, advisory);
      const whole = (field: string): number => {
        const value = args[field];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw toros(ErrorCode.E_SCHEMA, `${field} must be a non-negative integer`);
        return value;
      };
      const model = requiredString(args, 'model');
      if (run.model !== null && model !== run.model) throw toros(ErrorCode.E_SCHEMA, 'model does not match this run');
      const cost = args['cost_usd'];
      if (cost !== null && cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw toros(ErrorCode.E_SCHEMA, 'cost_usd must be a non-negative number or null');
      return deps.store().recordModelUsage({
        conversation_id: run.conversation_id,
        job_id: run.job_id,
        provider: requiredString(args, 'provider').slice(0, 100),
        model,
        prompt_tokens: whole('prompt_tokens'),
        completion_tokens: whole('completion_tokens'),
        total_tokens: whole('total_tokens'),
        cost_usd: typeof cost === 'number' ? cost : null,
      });
    }
    /**
     * A proposal is not a job. Nothing is sealed, nothing is persisted as an
     * envelope, and no action budget exists until the operator confirms. What
     * this does is check the draft against what the node actually has, so an
     * operator is never shown a card offering a capability that does not exist.
     */
    if (tool === 'propose_job') {
      const run = deps.runCredentials.runFor(args, advisory);
      return deps.conversationGuard.run(run.conversation_id, async () => {
        const proposal = deps.draft.validateDraft(args, run.agent);
        const redacted = redactProposal(proposal, deps.runCredentials.redactSecrets);
        const agreement_digest = agreementDigest(redacted);
        await deps.store().appendTurn({ conversation_id: run.conversation_id, role: 'hermes', channel: 'machine', content: JSON.stringify({ propose_job: redacted, agreement_digest }), job_id: null });
        return { proposal };
      });
    }
    if (tool === 'create_checkpoint') {
      const current = await job(args);
      // "Stop means stop" (SPEC §3.7). Without this, job_complete followed by
      // create_checkpoint moved a `proposed` or `blocked` job back to
      // `checkpoint` — a resumable state — and re-enabled adapter actions on a
      // job that was over. A terminal state that any tool can undo is not
      // terminal.
      if (isTerminal(current.state)) throw toros(ErrorCode.E_JOB_TERMINAL, `The job is ${current.state} and cannot be checkpointed`);
      // Delegate to @toros/relay rather than just flipping the state. A
      // checkpoint has to record enough to resume — cursors, artifacts, the
      // chain head at that moment — and setJobState alone records none of it,
      // so the SPEC §10 "a checkpoint survives restart" criterion would be
      // satisfied in name only.
      return deps.relay().createCheckpoint(current.job_id, requiredString(args, 'description'));
    }
    if (tool === 'create_local_relay') {
      const current = await job(args);
      // The same §3.7 guard as create_checkpoint, for the same reason. Adding
      // `isTerminal` to the checkpoint tool and stopping there left its sibling
      // open: a `proposed`, `blocked`, `accepted` or `cancelled` job could
      // still read selected files off disk and write a capsule whose manifest
      // declares `state: "relay"` — a resumable handoff asserted for work that
      // is over. Both tools act on a job, so both have to ask whether it is.
      if (isTerminal(current.state)) throw toros(ErrorCode.E_JOB_TERMINAL, `The job is ${current.state} and cannot be relayed`);
      return deps.relay().createCapsule({ job_id: current.job_id, selected_files: stringArray(args, 'selected_files'), selected_outputs: stringArray(args, 'selected_outputs') });
    }
    return deps.actionPipeline.execute(tool, args);
  }

  return {
    has: (tool) => TOOL_NAMES.has(tool),
    authorize(tool, mode): void {
      if (mode === 'advisory' && !ADVISORY_TOOLS.has(tool)) throw toros(ErrorCode.E_MODE_DENIED, `An advisory run may not call ${tool}`);
      if (mode === 'job' && tool === 'propose_job') throw toros(ErrorCode.E_MODE_DENIED, 'A job already exists; propose_job is for advisory runs');
    },
    dispatch,
  };
}
