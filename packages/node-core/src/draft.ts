import { createHash, randomUUID } from 'node:crypto';

import { digest, ErrorCode, TorosError, type JobRecord, type JsonValue, type Store, type Workspace } from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';

import { asRecord, optionalString, requiredPositiveInteger, requiredString, stringArray, toros } from './http.js';

/** The largest turn Node Core will persist, matching the coordinator's own cap. */
export const MAX_TURN_BYTES = 8 * 1024;

/**
 * A CLI session cannot do useful work with only `start`. Sessions are born
 * inside one job, so send/read/stop are the minimum lifecycle needed to give
 * the agent its task, observe the result, and close it. Interrupt remains an
 * optional emergency control and is never added implicitly.
 */
const REQUIRED_CLI_LIFECYCLE = ['start', 'send', 'read', 'stop'] as const;
const CLI_LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set([...REQUIRED_CLI_LIFECYCLE, 'interrupt']);
const MAX_PLAN_STEPS = 12;
const MAX_PLAN_STEP_CHARS = 300;
/** The largest `intent`, `target` or `changes` field a proposal may carry. */
const MAX_AGREEMENT_FIELD_CHARS = 2_000;
/** The domain separator for the deterministic agreement job id. */
const AGREEMENT_JOB_ID_DOMAIN = 'toros-agreement';

interface DraftCapability {
  readonly id: string;
  readonly [key: string]: JsonValue;
  readonly why: string;
}

function capabilityParts(id: string): { readonly adapter: string; readonly action: string } | null {
  const separator = id.lastIndexOf('.');
  if (separator <= 0 || separator === id.length - 1) return null;
  return { adapter: id.slice(0, separator), action: id.slice(separator + 1) };
}

function cliLifecycleFamilies(registered: readonly string[]): readonly string[] {
  const ids = new Set(registered);
  const candidates = new Set(registered.map((id) => capabilityParts(id)?.adapter).filter((id): id is string => id !== undefined));
  return [...candidates].filter((adapter) => REQUIRED_CLI_LIFECYCLE.every((action) => ids.has(`${adapter}.${action}`)));
}

function lifecycleReason(adapter: string, action: typeof REQUIRED_CLI_LIFECYCLE[number]): string {
  const name = `${adapter.slice(0, 1).toUpperCase()}${adapter.slice(1)}`;
  if (action === 'start') return `Required to open the ${name} session.`;
  if (action === 'send') return `Required to give ${name} the approved task.`;
  if (action === 'read') return `Required to read ${name}'s result.`;
  return `Required to close the ${name} session.`;
}

function completeCliLifecycle(
  requested: readonly DraftCapability[],
  registered: readonly string[],
): readonly DraftCapability[] {
  const completed = [...requested];
  const selected = new Set(requested.map((capability) => capability.id));
  for (const adapter of cliLifecycleFamilies(registered)) {
    const usesFamily = requested.some((capability) => {
      const parts = capabilityParts(capability.id);
      return parts?.adapter === adapter && CLI_LIFECYCLE_ACTIONS.has(parts.action);
    });
    if (!usesFamily) continue;
    for (const action of REQUIRED_CLI_LIFECYCLE) {
      const id = `${adapter}.${action}`;
      if (!selected.has(id)) {
        completed.push({ id, why: lifecycleReason(adapter, action) });
        selected.add(id);
      }
    }
  }
  return completed;
}

function assertCompleteCliLifecycle(selectedCapabilities: readonly string[], registered: readonly string[]): void {
  const selected = new Set(selectedCapabilities);
  for (const adapter of cliLifecycleFamilies(registered)) {
    const usesFamily = [...selected].some((id) => {
      const parts = capabilityParts(id);
      return parts?.adapter === adapter && CLI_LIFECYCLE_ACTIONS.has(parts.action);
    });
    if (!usesFamily) continue;
    const missing = REQUIRED_CLI_LIFECYCLE
      .map((action) => `${adapter}.${action}`)
      .filter((id) => !selected.has(id));
    if (missing.length > 0) {
      throw toros(ErrorCode.E_SCHEMA, `Incomplete ${adapter} session capability bundle; missing: ${missing.join(', ')}`);
    }
  }
}

/**
 * An optional free-text agreement field (`intent`, `target`, `changes`).
 * Absent is null; present must be a string of at most 2,000 characters.
 */
function optionalAgreementField(args: Readonly<Record<string, JsonValue>>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw toros(ErrorCode.E_SCHEMA, `${name} must be a string`);
  if (value.length > MAX_AGREEMENT_FIELD_CHARS) {
    throw toros(ErrorCode.E_SCHEMA, `${name} must not exceed ${MAX_AGREEMENT_FIELD_CHARS} characters`);
  }
  return value;
}

/**
 * The deterministic job id for an accepted proposal: the first 16 bytes of
 * `sha256("toros-agreement\0" + conversation_id + "\0" + seq)`, with the
 * version nibble set to 8 and the RFC 4122 variant bits, formatted as a
 * lowercase UUID. The same (conversation, seq) always yields the same id, so
 * a retried accept can never seal a second job.
 */
export function deriveJobId(conversationId: string, seq: number): string {
  const bytes = createHash('sha256')
    .update(`${AGREEMENT_JOB_ID_DOMAIN}\0${conversationId}\0${seq}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The agreement digest: SHA-256 over the canonicalized normalized proposal
 * (`validateDraft`'s output, including defaults and completed CLI lifecycle
 * capabilities). It is what the operator's accept names, so a proposal whose
 * re-validation changes its normalized form no longer hashes to it.
 */
export function agreementDigest(proposal: Readonly<Record<string, JsonValue>>): string {
  return digest(proposal);
}

/**
 * Redact every string value in a proposal, exactly as the turn it is stored in
 * is redacted. The agreement digest is computed over this redacted form, so a
 * proposal that carried a credential still hashes to the same digest when it is
 * re-validated from the stored (redacted) turn.
 */
export function redactProposal(
  proposal: Readonly<Record<string, JsonValue>>,
  redact: (content: string) => string,
): Record<string, JsonValue> {
  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [key, member] of Object.entries(value)) out[key] = walk(member);
      return out;
    }
    return value;
  };
  return walk(proposal) as Record<string, JsonValue>;
}

/** The optional second argument to `createJobFromArgs`, used only by accept. */
export interface CreateJobOptions {
  readonly job_id?: string;
  readonly conversation_id?: string;
  readonly agreement?: { readonly agreement_digest: string; readonly proposal_seq: number };
}

export interface DraftService {
  readonly createJobFromArgs: (args: Readonly<Record<string, JsonValue>>, options?: CreateJobOptions) => Promise<JobRecord>;
  readonly validateDraft: (args: Readonly<Record<string, JsonValue>>, agent?: string | null) => Readonly<Record<string, JsonValue>>;
  readonly liveProposal: (conversationId: string, seq: number) => Promise<{ readonly args: Record<string, JsonValue>; readonly agreement_digest: string }>;
  readonly storedProposalDigest: (conversationId: string, seq: number) => Promise<string>;
  readonly agents: () => readonly string[];
}

export function createDraftService(deps: {
  readonly node_id: string;
  readonly workspaces: readonly Workspace[];
  readonly registeredCapabilities: () => readonly string[];
  readonly store: () => Store;
  readonly redactSecrets: (content: string) => string;
}): DraftService {
  /**
   * Seal and persist one job. The single place an envelope comes into
   * existence, whether the operator authored it directly or confirmed a
   * proposal Hermes drafted — so both paths get the same validation and the
   * same digest, and neither can acquire a capability the other could not.
   */
  async function createJobFromArgs(args: Readonly<Record<string, JsonValue>>, options?: CreateJobOptions): Promise<JobRecord> {
    if (args['expires_at'] !== undefined) {
      throw toros(ErrorCode.E_SCHEMA, 'a job is created with expires_in_hours, not expires_at');
    }
    const expiresInHours = requiredPositiveInteger(args, 'expires_in_hours', 168);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1_000);
    // sealEnvelope rejects unknown properties, so anything that is a transport
    // convenience rather than part of the envelope must be dropped before it
    // can reach the digest.
    //
    // Free-text fields are redacted BEFORE sealing. The envelope's objective and
    // acceptance criteria go into every coordinator run's system prompt, so an
    // operator who pastes a bearer into an objective — a footgun, but one this
    // must survive — would otherwise feed that credential to the untrusted
    // model on every rehydration. Redacting the turn alone would not: the seal
    // is the durable source the prompt is built from.
    const envelopeArgs: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === 'expires_in_hours' || key === 'conversation_id') continue;
      if (key === 'objective' && typeof value === 'string') {
        envelopeArgs[key] = deps.redactSecrets(value);
      } else if ((key === 'acceptance' || key === 'forbidden') && Array.isArray(value)) {
        envelopeArgs[key] = value.map((item) => (typeof item === 'string' ? deps.redactSecrets(item) : item));
      } else {
        envelopeArgs[key] = value;
      }
    }
    const sealed = sealEnvelope({ ...envelopeArgs, job_id: options?.job_id ?? randomUUID(), expires_at: expiresAt.toISOString() });
    const registered = deps.registeredCapabilities();
    const unknownCapability = sealed.envelope.allowed_capabilities.find((capability) => !registered.includes(capability));
    if (unknownCapability !== undefined) {
      throw toros(ErrorCode.E_NOT_REGISTERED, `Unknown capability: ${unknownCapability}`);
    }
    const workspaceIds = new Set(deps.workspaces.map((workspace) => workspace.id));
    assertCompleteCliLifecycle(sealed.envelope.allowed_capabilities, registered);
    const unknownWorkspace = sealed.envelope.allowed_workspaces.find((workspace) => !workspaceIds.has(workspace));
    if (unknownWorkspace !== undefined) {
      throw toros(ErrorCode.E_WORKSPACE_DENIED, `Unknown workspace: ${unknownWorkspace}`);
    }
    const job = await deps.store().createJob(
      sealed,
      options?.conversation_id === undefined ? undefined : { conversation_id: options.conversation_id },
    );
    const eventPayload: Record<string, JsonValue> = { envelope_digest: job.envelope_digest };
    if (options?.agreement !== undefined && options.conversation_id !== undefined) {
      eventPayload['agreement_digest'] = options.agreement.agreement_digest;
      eventPayload['conversation_id'] = options.conversation_id;
      eventPayload['proposal_seq'] = options.agreement.proposal_seq;
    }
    await deps.store().appendEvent({
      node_id: deps.node_id,
      job_id: job.job_id,
      kind: 'job.created',
      payload: eventPayload,
    });
    return job;
  }

  /**
   * Check a draft envelope against what this node actually registered, and
   * carry each requested capability's justification through untouched so the
   * operator reads Hermes's own words for why it wants what it wants.
   */
  function validateDraft(
    args: Readonly<Record<string, JsonValue>>,
    agent: string | null = null,
  ): Readonly<Record<string, JsonValue>> {
    const objective = requiredString(args, 'objective');
    const acceptance = stringArray(args, 'acceptance');
    if (acceptance.length === 0) throw toros(ErrorCode.E_SCHEMA, 'acceptance must list at least one criterion');
    const plan = stringArray(args, 'plan').map((step) => step.trim()).filter((step) => step.length > 0);
    if (plan.length === 0) throw toros(ErrorCode.E_SCHEMA, 'plan must list at least one step');
    if (plan.length > MAX_PLAN_STEPS) throw toros(ErrorCode.E_SCHEMA, `plan must not exceed ${MAX_PLAN_STEPS} steps`);
    if (plan.some((step) => step.length > MAX_PLAN_STEP_CHARS)) {
      throw toros(ErrorCode.E_SCHEMA, `a plan step must not exceed ${MAX_PLAN_STEP_CHARS} characters`);
    }
    const rawCapabilities = args['capabilities'];
    if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
      throw toros(ErrorCode.E_SCHEMA, 'capabilities must list at least one entry');
    }
    const registered = deps.registeredCapabilities();
    const capabilities = completeCliLifecycle(rawCapabilities.map((entry) => {
      const record = asRecord(entry);
      const id = requiredString(record, 'id');
      if (!registered.includes(id)) throw toros(ErrorCode.E_NOT_REGISTERED, `Unknown capability: ${id}`);
      if (agent !== null) {
        const parts = capabilityParts(id);
        if (parts !== null && parts.adapter !== agent && cliLifecycleFamilies(registered).includes(parts.adapter)) {
          throw toros(ErrorCode.E_CAP_NOT_ALLOWED, `This conversation is set to ${agent}; ${id} belongs to ${parts.adapter}`);
        }
      }
      return { id, why: optionalString(record, 'why') ?? '' };
    }), registered);
    const workspaceIds = new Set(deps.workspaces.map((workspace) => workspace.id));
    const workspaces = stringArray(args, 'workspaces');
    if (workspaces.length === 0) throw toros(ErrorCode.E_SCHEMA, 'workspaces must list at least one entry');
    for (const workspace of workspaces) {
      if (!workspaceIds.has(workspace)) throw toros(ErrorCode.E_WORKSPACE_DENIED, `Unknown workspace: ${workspace}`);
    }
    const intent = optionalAgreementField(args, 'intent');
    const target = optionalAgreementField(args, 'target');
    const changes = optionalAgreementField(args, 'changes');
    const draft = {
      objective,
      plan,
      acceptance: [...acceptance],
      capabilities,
      workspaces: [...workspaces],
      forbidden: [...stringArray(args, 'forbidden')],
      max_actions: requiredPositiveInteger(args, 'max_actions', 1_000),
      max_retries: typeof args['max_retries'] === 'number' ? args['max_retries'] : 2,
      expires_in_hours: requiredPositiveInteger(args, 'expires_in_hours', 168),
      ...(intent === null ? {} : { intent }),
      ...(target === null ? {} : { target }),
      ...(changes === null ? {} : { changes }),
    };
    // Prove the draft can actually be sealed, using the real validator rather
    // than a second one that agrees with it by hand. A proposal that validates
    // here and fails on approval is worse than one refused now: the operator
    // discovers it only after deciding to trust it.
    sealEnvelope({
      job_id: randomUUID(), objective: draft.objective,
      allowed_capabilities: draft.capabilities.map((capability) => capability.id),
      allowed_workspaces: draft.workspaces, acceptance: draft.acceptance,
      forbidden: draft.forbidden, max_actions: draft.max_actions, max_retries: draft.max_retries,
      expires_at: new Date(Date.now() + draft.expires_in_hours * 60 * 60 * 1_000).toISOString(),
    });
    return draft;
  }

  /**
   * Resolve the proposal the operator is accepting: the turn at `seq`, which
   * must be the conversation's last turn and a proposal. Returns the envelope
   * arguments to seal plus the agreement digest of the re-validated proposal.
   */
  async function liveProposal(
    conversationId: string,
    seq: number,
  ): Promise<{ readonly args: Record<string, JsonValue>; readonly agreement_digest: string }> {
    const turns = await deps.store().listTurns(conversationId);
    const last = turns.at(-1);
    // Anything but the conversation's current machine proposal is a stale or
    // non-existent acceptance, refused with one message.
    const changed = () => toros(ErrorCode.E_SCHEMA, 'the proposal changed; review it again');
    if (last === undefined || last.channel !== 'machine' || last.seq !== seq) throw changed();
    let parsed: unknown;
    try { parsed = JSON.parse(last.content); }
    catch { throw changed(); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw changed();
    const candidate = (parsed as Record<string, unknown>)['propose_job'];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw changed();

    // Registered adapters or workspaces may have changed since the turn was
    // written, so the stored proposal is validated again before sealing. A
    // re-validation failure — a capability or workspace that has since been
    // unregistered, or a capability that no longer matches the pinned agent —
    // means the normalized form no longer matches what the operator saw, so the
    // accept is refused with the same "the proposal changed" refusal as a stale
    // seq or wrong digest, not the raw E_NOT_REGISTERED error code.
    const draft = (() => {
      try {
        return validateDraft(candidate as Record<string, JsonValue>);
      } catch (cause: unknown) {
        if (cause instanceof TorosError && (cause.code === ErrorCode.E_NOT_REGISTERED || cause.code === ErrorCode.E_WORKSPACE_DENIED || cause.code === ErrorCode.E_CAP_NOT_ALLOWED)) {
          throw changed();
        }
        throw cause;
      }
    })();
    const capabilities = draft['capabilities'] as ReadonlyArray<{ readonly id: string }>;
    return {
      args: {
        objective: draft['objective'] as JsonValue,
        acceptance: draft['acceptance'] as JsonValue,
        allowed_capabilities: capabilities.map((capability) => capability.id),
        allowed_workspaces: draft['workspaces'] as JsonValue,
        forbidden: draft['forbidden'] as JsonValue,
        max_actions: draft['max_actions'] as JsonValue,
        max_retries: draft['max_retries'] as JsonValue,
        expires_in_hours: draft['expires_in_hours'] as JsonValue,
      },
      agreement_digest: agreementDigest(draft),
    };
  }

  /**
   * The agreement digest the proposal turn at `seq` was stored with, verified
   * against its own immutable recorded proposal.
   *
   * This is the retry path's read: it does NOT re-validate against the
   * registry. The registry may have changed since the accept, and that must
   * not invalidate an already-sealed job; what matters is that the turn at
   * `seq` is a proposal and internally consistent — its stored
   * `agreement_digest` equals the digest recomputed over its stored (already
   * redacted) proposal. The turn is immutable, so this is a faithful record of
   * what the operator agreed to, never of what the caller now claims.
   *
   * Any other case (missing turn, not a proposal, a recomputed digest that
   * diverges from the stored one) is `E_SCHEMA` "the proposal changed; review
   * it again".
   */
  async function storedProposalDigest(conversationId: string, seq: number): Promise<string> {
    const changed = () => toros(ErrorCode.E_SCHEMA, 'the proposal changed; review it again');
    const turns = await deps.store().listTurns(conversationId);
    const turn = turns.find((entry) => entry.seq === seq);
    if (turn === undefined || turn.channel !== 'machine') throw changed();
    let parsed: unknown;
    try { parsed = JSON.parse(turn.content); }
    catch { throw changed(); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw changed();
    const record = parsed as Record<string, unknown>;
    const storedDigest = record['agreement_digest'];
    const proposal = record['propose_job'];
    if (typeof storedDigest !== 'string' || typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
      throw changed();
    }
    // The stored proposal is already redacted, and its digest was computed over
    // exactly that redacted form, so recompute directly — no redaction, no
    // registry — and compare to what the turn recorded.
    if (agreementDigest(proposal as Record<string, JsonValue>) !== storedDigest) throw changed();
    return storedDigest;
  }

  return {
    createJobFromArgs,
    validateDraft,
    liveProposal,
    storedProposalDigest,
    agents: () => cliLifecycleFamilies(deps.registeredCapabilities()),
  };
}
