import { randomUUID } from 'node:crypto';

import { ErrorCode, type JobRecord, type JsonValue, type Store, type Workspace } from '@toros/contracts';
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

export interface DraftService {
  readonly createJobFromArgs: (args: Readonly<Record<string, JsonValue>>) => Promise<JobRecord>;
  readonly validateDraft: (args: Readonly<Record<string, JsonValue>>, agent?: string | null) => Readonly<Record<string, JsonValue>>;
  readonly liveProposal: (conversationId: string) => Promise<Record<string, JsonValue>>;
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
  async function createJobFromArgs(args: Readonly<Record<string, JsonValue>>): Promise<JobRecord> {
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
    const sealed = sealEnvelope({ ...envelopeArgs, job_id: randomUUID(), expires_at: expiresAt.toISOString() });
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
    const job = await deps.store().createJob(sealed);
    await deps.store().appendEvent({
      node_id: deps.node_id,
      job_id: job.job_id,
      kind: 'job.created',
      payload: { envelope_digest: job.envelope_digest },
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

  /** Resolve the only proposal that can still be approved. */
  async function liveProposal(conversationId: string): Promise<Record<string, JsonValue>> {
    const last = (await deps.store().listTurns(conversationId)).at(-1);
    const nothingToApprove = () => toros(ErrorCode.E_SCHEMA, 'There is no proposal to approve in this conversation');
    if (last === undefined || last.channel !== 'machine') throw nothingToApprove();
    let parsed: unknown;
    try { parsed = JSON.parse(last.content); }
    catch { throw nothingToApprove(); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw nothingToApprove();
    const candidate = (parsed as Record<string, unknown>)['propose_job'];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw nothingToApprove();

    // Registered adapters or workspaces may have changed since the turn was
    // written, so the stored proposal is validated again before sealing.
    const draft = validateDraft(candidate as Record<string, JsonValue>);
    const capabilities = draft['capabilities'] as ReadonlyArray<{ readonly id: string }>;
    return {
      objective: draft['objective'] as JsonValue,
      acceptance: draft['acceptance'] as JsonValue,
      allowed_capabilities: capabilities.map((capability) => capability.id),
      allowed_workspaces: draft['workspaces'] as JsonValue,
      forbidden: draft['forbidden'] as JsonValue,
      max_actions: draft['max_actions'] as JsonValue,
      max_retries: draft['max_retries'] as JsonValue,
      expires_in_hours: draft['expires_in_hours'] as JsonValue,
    };
  }

  return {
    createJobFromArgs,
    validateDraft,
    liveProposal,
    agents: () => cliLifecycleFamilies(deps.registeredCapabilities()),
  };
}
