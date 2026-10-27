/**
 * The `/agent/*` surface (spec AT): an operator-granted Claude or Codex session
 * reads the node's read-only discovery state through its own bearer, bound to
 * exactly one job by a grant. Nothing here can click, type, select, launch or
 * write — the three capabilities it permits are `desktop.state`,
 * `desktop.inspect` and `machine.inventory`, the same surfaces Spec AR shows a
 * job, with no UIA names/values, window titles only for allowed apps, opaque
 * single-use handles, and nothing while the desktop is locked.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ErrorCode, TorosError, isTerminal,
  type Adapter, type CapabilityId, type JsonValue, type Store,
} from '@toros/contracts';

import type { ActionPipeline } from './action-pipeline.js';
import type { AgentGrant, AgentGrants, AgentName } from './agent-grants.js';
import { asRecord, readBody, requiredString, send, toros, type RouteSurface } from './http.js';

/** The three read-only discovery capabilities the agent surface permits (spec AT). */
export const AGENT_DISCOVERY_CAPABILITIES = ['desktop.state', 'desktop.inspect', 'machine.inventory'] as const;
export type AgentDiscoveryCapability = (typeof AGENT_DISCOVERY_CAPABILITIES)[number];

function isDiscoveryCapability(value: unknown): value is AgentDiscoveryCapability {
  return typeof value === 'string' && (AGENT_DISCOVERY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The mission hook (owned by AS1, left as a single point for AT1). Without AS
 * it allows everything: the granted job's envelope still bounds the call.
 */
export type MissionHook = (jobId: string, capability: CapabilityId) =>
  | { readonly allow: true }
  | { readonly allow: false; readonly code: ErrorCode; readonly reason: string };

export interface AgentRouteDeps {
  readonly store: () => Store;
  readonly agentGrants: () => AgentGrants;
  readonly agentTokens: { readonly claude?: string; readonly codex?: string };
  readonly desktopArGateCleared: boolean;
  readonly adapters: readonly Adapter[];
  readonly actionPipeline: ActionPipeline;
  readonly missionHook: MissionHook;
}

type GrantOutcome =
  | { readonly kind: 'live'; readonly grant: AgentGrant }
  | { readonly kind: 'denied'; readonly reason: 'no_grant' | 'revoked' };

/** Per-agent call token derived from the request bearer, or null when it matches none. */
function resolveAgent(request: IncomingMessage, tokens: AgentRouteDeps['agentTokens']): AgentName | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const supplied = Buffer.from(header.slice(7));
  for (const name of ['claude', 'codex'] as const) {
    const token = tokens[name];
    if (token === undefined) continue;
    const expected = Buffer.from(token);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return name;
  }
  return null;
}

export function createAgentRoutes(deps: AgentRouteDeps): RouteSurface {
  /** One /agent/invoke at a time per agent, held until the pipeline returns. */
  const locks = new Set<AgentName>();

  /** The most recent grant for an agent — live or revoked — or null. */
  function latestGrant(agent: AgentName): AgentGrant | null {
    const rows = deps.agentGrants().list().filter((grant) => grant.agent === agent);
    return rows.length === 0 ? null : (rows[rows.length - 1] ?? null);
  }

  /** The input-schema property keys a capability declares, or [] when unknown. */
  function schemaPropertyNames(capability: CapabilityId): readonly string[] {
    for (const adapter of deps.adapters) {
      if (!capability.startsWith(`${adapter.manifest.id}.`)) continue;
      const action = adapter.manifest.actions.find((candidate) => `${adapter.manifest.id}.${candidate.id}` === capability);
      if (action === undefined) continue;
      const schema = action.input_schema;
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [];
      const properties = (schema as { readonly properties?: unknown })['properties'];
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
      return Object.keys(properties);
    }
    return [];
  }

  /**
   * Keep only the keys the capability's registered input schema declares, and
   * force `session_scope: "interactive"` on desktop calls. Everything else a
   * caller smuggled in (a foreign `job_id`, `workspace_id`, `model`, `actor`,
   * a nested `session_scope`) is dropped here, so it can never reach the
   * pipeline.
   */
  function filterParameters(capability: CapabilityId, parameters: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
    const out: Record<string, JsonValue> = {};
    for (const key of schemaPropertyNames(capability)) {
      const value = parameters[key];
      if (value !== undefined) out[key] = value;
    }
    if (capability.startsWith('desktop.')) out['session_scope'] = 'interactive';
    return out;
  }

  async function handleStatus(agent: AgentName, grant: AgentGrant | null, response: ServerResponse): Promise<void> {
    if (grant === null) {
      send(response, 200, {
        agent,
        grant: null,
        objective: null,
        allowed_capabilities: null,
        desktop_enabled: deps.desktopArGateCleared,
      });
      return;
    }
    const job = await deps.store().getJob(grant.job_id);
    send(response, 200, {
      agent,
      grant: { grant_id: grant.grant_id, job_id: grant.job_id, expires_at: grant.expires_at },
      objective: job?.envelope.objective ?? null,
      allowed_capabilities: job?.envelope.allowed_capabilities ?? null,
      desktop_enabled: deps.desktopArGateCleared,
    });
  }

  async function handleInvoke(agent: AgentName, outcome: GrantOutcome, params: Readonly<Record<string, JsonValue>>, response: ServerResponse): Promise<void> {
    if (outcome.kind === 'denied') {
      if (outcome.reason === 'revoked') {
        throw new TorosError(ErrorCode.E_GRANT_INVALID, 'The agent grant has been revoked', { reason: 'revoked' });
      }
      throw new TorosError(ErrorCode.E_GRANT_INVALID, 'This agent has no live grant', { reason: 'no_grant' });
    }
    const grant = outcome.grant;
    const job = await deps.store().getJob(grant.job_id);
    if (job === null) throw toros(ErrorCode.E_ENVELOPE_INVALID, 'Unknown job');
    const nowMs = Date.now();
    if (Date.parse(grant.expires_at) <= nowMs || Date.parse(job.envelope.expires_at) <= nowMs) {
      throw toros(ErrorCode.E_EXPIRED, 'The grant or the job envelope has expired');
    }
    if (isTerminal(job.state)) throw toros(ErrorCode.E_JOB_TERMINAL, `The job is ${job.state}`);

    const capability = requiredString(params, 'capability');
    const parameters = filterParameters(capability, asRecord(params['parameters'] ?? {}));
    const workspaceId = job.envelope.allowed_workspaces[0];
    if (workspaceId === undefined) {
      throw new TorosError(ErrorCode.E_GRANT_INVALID, 'The granted job has no workspace', { reason: 'workspace_count' });
    }
    const actor = `agent:${agent}`;

    // Mode: exactly the three discovery capabilities, and desktop.* only while
    // the AR gate is cleared. The capability-outside-the-three refusal is
    // recorded as a denied receipt through the pipeline; the ar_gate refusal is
    // answered here with its reason.
    if (!isDiscoveryCapability(capability)) {
      const result = await deps.actionPipeline.executeAgent({
        job_id: job.job_id,
        workspace_id: workspaceId,
        capability,
        parameters,
        actor,
        modeRefusal: { code: ErrorCode.E_MODE_DENIED },
      });
      send(response, 200, result);
      return;
    }
    if (capability.startsWith('desktop.') && !deps.desktopArGateCleared) {
      throw new TorosError(ErrorCode.E_MODE_DENIED, 'The desktop AR gate is not cleared for this node', { reason: 'ar_gate' });
    }

    // Mission hook (owned by AS1; without AS it allows everything).
    const hook = deps.missionHook(job.job_id, capability);
    if (hook.allow === false) throw toros(hook.code, hook.reason);

    const result = await deps.actionPipeline.executeAgent({
      job_id: job.job_id,
      workspace_id: workspaceId,
      capability,
      parameters,
      actor,
    });
    send(response, 200, result);
  }

  async function handle(operation: string | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const agent = resolveAgent(request, deps.agentTokens);
      if (agent === null) { send(response, 401, { error: 'Unauthorized' }); return; }
      if (operation === undefined || (operation !== 'status' && operation !== 'invoke')) {
        send(response, 404, { error: 'Not found' });
        return;
      }
      if (operation === 'status') {
        await handleStatus(agent, deps.agentGrants().live(agent), response);
        return;
      }
      // /agent/invoke: capture the live grant at request start, read the body,
      // take the per-agent lock, then re-read the grant. A grant revoked or
      // replaced while the body was arriving refuses the call; a second
      // concurrent call for the same agent is E_PARALLEL_ACTION.
      const before = deps.agentGrants().live(agent);
      const body = await readBody(request);
      if (locks.has(agent)) throw toros(ErrorCode.E_PARALLEL_ACTION, `An action for agent ${agent} is already running`);
      locks.add(agent);
      try {
        const after = deps.agentGrants().live(agent);
        // Revoked vs no-grant is read from the agent's LATEST grant row, not
        // from the request-time snapshot: a grant revoked before this request
        // began would otherwise look like "no grant". Replacement during the
        // body read (grant_id changed) is its own refusal.
        const latest = latestGrant(agent);
        let outcome: GrantOutcome;
        if (after === null) {
          outcome = { kind: 'denied', reason: latest !== null && latest.revoked_at !== null ? 'revoked' : 'no_grant' };
        } else if (before !== null && before.grant_id !== after.grant_id) {
          outcome = { kind: 'denied', reason: 'revoked' };
        } else {
          outcome = { kind: 'live', grant: after };
        }
        await handleInvoke(agent, outcome, asRecord(body), response);
      } finally {
        locks.delete(agent);
      }
    } catch (error: unknown) {
      const e = error instanceof TorosError ? error : toros(ErrorCode.E_ADAPTER_FAILURE, 'Node Core request failed');
      const status = e.detail['body_too_large'] === true ? 413 : e.code === ErrorCode.E_PARALLEL_ACTION ? 409 : 400;
      const reason = e.detail['reason'];
      send(response, status, { error: e.code, message: e.message, ...(typeof reason === 'string' ? { reason } : {}) });
    }
  }

  return { handle };
}