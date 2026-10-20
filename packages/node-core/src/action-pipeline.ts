import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  ErrorCode, TorosError, digest,
  type ActionResult, type ActionSchema, type Adapter, type AdapterContext,
  type AppIdentity, type CapabilityId, type JsonValue, type Receipt, type ResolvedTarget, type SessionAdapter, type Store, type TargetDecisions, type Workspace,
} from '@toros/contracts';
import type { Policy } from '@toros/policy';

import type { ApprovalRegistry, ApprovalReplayAction, ApprovalReplayTool } from './approvals.js';
import { asRecord, optionalString, requiredString, toros } from './http.js';
import type { StageGraphController } from './stage-graph.js';

function now(): string { return new Date().toISOString(); }

/**
 * The settlement timing a `send_cli` receipt runs under.
 *
 * The documented exchange-settlement design keeps the receipt `running` until
 * a later `read_cli` reports the terminal exchange state; the GUARANTEED close
 * on top of it settles the receipt as `terminated`/`unsettled_deadline` at
 * `started_at + timeout + grace` if nothing else settled it first, and if that
 * close cannot be durably recorded it retries on the bounded schedule.
 *
 * The timing is INSTANCE-SCOPED (Round 4 item 4): a pipeline is constructed
 * with the timing it should run — tests inject short values into their own
 * Core/pipeline, and production runs on the immutable defaults below. There is
 * deliberately no process-wide override: shared mutable timing would leak
 * between tests and silently change what a separately created pipeline does.
 */
export interface SettlementTimingOptions {
  /** Bounded grace after the action's own timeout before Core closes an open send, ms. */
  readonly cli_settle_grace_ms?: number;
  /**
   * The bounded retry delays — ms, in order — for a settlement close that did
   * not fully persist. Once exhausted, retries repeat at
   * `settle_retry_max_delay`. Must be non-empty when provided.
   */
  readonly settle_retry_delays?: readonly number[];
  /** The repeating retry delay once the schedule is exhausted, ms. */
  readonly settle_retry_max_delay?: number;
}

/**
 * The immutable production timing every pipeline runs on unless constructed
 * with an explicit `settlement` option: 1 s, then 5 s, then 30 s, then every
 * 60 s, after a 30 s grace.
 */
export const PRODUCTION_SETTLEMENT_TIMING: Readonly<Required<SettlementTimingOptions>> = Object.freeze({
  cli_settle_grace_ms: 30_000,
  settle_retry_delays: Object.freeze([1_000, 5_000, 30_000]),
  settle_retry_max_delay: 60_000,
});

/** The resolved, validated per-pipeline timing. */
interface ResolvedSettlementTiming {
  readonly graceMs: number;
  readonly retryDelays: readonly number[];
  readonly retryMaxDelay: number;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validate and resolve a pipeline's settlement timing. Every value must be
 * finite and non-negative and the retry schedule non-empty, or the pipeline
 * refuses to start — a caller must not be able to arm a NaN or negative
 * timer. The caller's array is copied (never retained by reference) and the
 * resolved schedule is frozen, so a running pipeline cannot be mutated from
 * outside.
 */
function resolveSettlementTiming(options: SettlementTimingOptions | undefined): ResolvedSettlementTiming {
  if (options?.cli_settle_grace_ms !== undefined && !isFiniteNonNegative(options.cli_settle_grace_ms)) {
    throw new Error('pipeline settlement: cli_settle_grace_ms must be a finite, non-negative number of milliseconds');
  }
  if (options?.settle_retry_max_delay !== undefined && !isFiniteNonNegative(options.settle_retry_max_delay)) {
    throw new Error('pipeline settlement: settle_retry_max_delay must be a finite, non-negative number of milliseconds');
  }
  if (options?.settle_retry_delays !== undefined) {
    if (!Array.isArray(options.settle_retry_delays) || options.settle_retry_delays.length === 0) {
      throw new Error('pipeline settlement: settle_retry_delays must be a non-empty array of finite, non-negative delays');
    }
    if (!options.settle_retry_delays.every((delay) => typeof delay === 'number' && isFiniteNonNegative(delay))) {
      throw new Error('pipeline settlement: settle_retry_delays must contain only finite, non-negative numbers');
    }
  }
  return {
    graceMs: options?.cli_settle_grace_ms ?? PRODUCTION_SETTLEMENT_TIMING.cli_settle_grace_ms,
    retryDelays: Object.freeze([...(options?.settle_retry_delays ?? PRODUCTION_SETTLEMENT_TIMING.settle_retry_delays)]),
    retryMaxDelay: options?.settle_retry_max_delay ?? PRODUCTION_SETTLEMENT_TIMING.settle_retry_max_delay,
  };
}

function declaredAdapterFields(adapter: Adapter, result: ActionResult): Readonly<Record<string, JsonValue>> {
  const allowed = new Set(adapter.manifest.receipt_fields);
  const fields: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(result.receipt_extra)) {
    if (!allowed.has(key)) throw toros(ErrorCode.E_ADAPTER_FAILURE, `Adapter returned undeclared receipt field: ${key}`);
    fields[key] = value;
  }
  return fields;
}

/**
 * Receipt keys Core itself writes (amendment A8): the two-phase resolve reduces
 * to counts, never identities. An adapter may not declare these in its
 * manifest — Core owns them, and a manifest that claims one would let the
 * adapter overwrite Core's audit value.
 */
export const CORE_RESERVED_RECEIPT_KEYS: ReadonlySet<string> = new Set(['targets_allowed', 'targets_denied']);

/** The ceiling on resolved targets from one adapter resolve call (amendment A8). */
const MAX_RESOLVED_TARGETS = 1000;

function resolveFailure(message: string): TorosError {
  return toros(ErrorCode.E_ADAPTER_FAILURE, message);
}

/**
 * Validate the adapter's resolve output (amendment A8). It is untrusted — the
 * adapter is reached only after the decision, but its resolve result is still
 * adapter-supplied data, so nothing is taken on faith: an array of well-formed
 * targets with unique, bounded keys, at most `MAX_RESOLVED_TARGETS` long.
 * Anything else is E_ADAPTER_FAILURE.
 */
function validateResolvedTargets(value: unknown): readonly ResolvedTarget[] {
  if (!Array.isArray(value)) throw resolveFailure('Adapter resolver returned a non-array result');
  if (value.length > MAX_RESOLVED_TARGETS) {
    throw resolveFailure(`Adapter resolver returned more than ${MAX_RESOLVED_TARGETS} targets`);
  }
  const seen = new Set<string>();
  const targets: ResolvedTarget[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw resolveFailure('Adapter resolver returned a malformed target');
    }
    const record = item as Record<string, unknown>;
    const kind = record['kind'];
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      throw resolveFailure('Adapter resolver returned a target with an invalid key');
    }
    if (seen.has(key)) throw resolveFailure('Adapter resolver returned duplicate target keys');
    seen.add(key);

    if (kind === 'app') {
      targets.push({ kind: 'app', key, identity: validateAppIdentity(record['identity']) });
    } else if (kind === 'capability') {
      const capability = record['capability'];
      if (typeof capability !== 'string' || capability.length === 0) {
        throw resolveFailure('Adapter resolver returned a capability target with an invalid capability');
      }
      targets.push({ kind: 'capability', key, capability });
    } else {
      throw resolveFailure('Adapter resolver returned a target with an unknown kind');
    }
  }
  return targets;
}

function validateAppIdentity(value: unknown): AppIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw resolveFailure('Adapter resolver returned an app target with a malformed identity');
  }
  const id = value as Record<string, unknown>;

  const pid = id['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid pid');
  }
  const created_at = id['created_at'];
  if (typeof created_at !== 'string' || created_at.length === 0) {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid created_at');
  }
  const image_path = id['image_path'];
  if (typeof image_path !== 'string' || image_path.length === 0) {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid image_path');
  }
  const image_sha256 = id['image_sha256'];
  if (typeof image_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image_sha256)) {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid image_sha256');
  }
  const signature = id['signature'];
  if (signature !== 'valid' && signature !== 'unsigned' && signature !== 'invalid') {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid signature');
  }
  const signer = id['signer'];
  if (signer !== null && typeof signer !== 'string') {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid signer');
  }
  const product_name = id['product_name'];
  if (product_name !== null && typeof product_name !== 'string') {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid product_name');
  }
  const session_id = id['session_id'];
  if (typeof session_id !== 'number' || !Number.isInteger(session_id)) {
    throw resolveFailure('Adapter resolver returned an app identity with an invalid session_id');
  }

  return { pid, created_at, image_path, image_sha256, signature, signer, product_name, session_id };
}

/**
 * The action's arguments with every declared path field replaced by its
 * absolute form, resolved against the workspace root exactly as policy
 * resolved it when deciding containment.
 */
function resolvePathArgs(
  args: Readonly<Record<string, JsonValue>>,
  schema: ActionSchema,
  workspaceRoot: string,
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = { ...args };
  for (const field of schema.path_fields) {
    const value = out[field];
    if (typeof value === 'string') out[field] = resolve(workspaceRoot, value);
  }
  return out;
}

/**
 * The actor to record, given whatever label the caller supplied.
 *
 * `operator` means a human acted at the console. Nothing arriving over the HTTP
 * tool surface qualifies, so the value is reserved: a caller that asks for it —
 * in any case, with any surrounding whitespace — is recorded as the coordinator
 * it actually is. Everything else is kept as a model identifier, trimmed and
 * bounded so a receipt cannot be padded out with arbitrary text.
 */
function coordinatorActor(supplied: string | null): string {
  const label = (supplied ?? '').trim();
  if (label.length === 0) return 'coordinator';
  if (label.toLowerCase() === 'operator') return 'coordinator';
  return label.slice(0, 128);
}

function sessionAdapter(adapter: Adapter): SessionAdapter {
  if (!('start' in adapter) || !('send' in adapter) || !('read' in adapter) || !('interrupt' in adapter) || !('stop' in adapter)) {
    throw toros(ErrorCode.E_NOT_REGISTERED, 'The selected adapter is not a session adapter');
  }
  return adapter as SessionAdapter;
}

export interface ActionPipeline {
  readonly execute: (tool: string, args: Readonly<Record<string, JsonValue>>) => Promise<unknown>;
  readonly replay: (approvalId: string, jobId: string) => Promise<unknown>;
  /**
   * Restart reconciliation for the `send_cli` settlement deadline: settlement
   * timers are in-memory and die with the process, so at Core start any
   * `send_cli` receipt still `running` whose deadline
   * (`started_at` + action timeout + 30 s) has already passed is closed the
   * same way the in-process deadline would have closed it.
   */
  readonly reconcileCliSettlements: () => Promise<void>;
}

export function createActionPipeline(deps: {
  readonly node_id: string;
  readonly adapters: readonly Adapter[];
  readonly workspaces: readonly Workspace[];
  readonly registeredCapabilities: () => readonly string[];
  readonly store: () => Store;
  readonly policy: () => Policy;
  readonly stageGraphs: () => StageGraphController;
  readonly approvals: ApprovalRegistry;
  readonly recordSession: (sessionId: string, jobId: string) => void;
  readonly removeSession: (sessionId: string) => void;
  /** Per-pipeline settlement timing; defaults to the immutable production values. */
  readonly settlement?: SettlementTimingOptions;
}): ActionPipeline {
  const settlement = resolveSettlementTiming(deps.settlement);
  const locks = new Set<string>();
  /**
   * In-memory settlement-deadline timers for `send_cli` receipts returned while
   * still `running`, keyed by receipt id. Cleared when the exchange settles
   * itself (via `read_cli`) or when the deadline fires.
   */
  const pendingSettleTimers = new Map<string, NodeJS.Timeout>();

  function getPolicyRegistryEntry(capability: CapabilityId): { readonly adapter: Adapter; readonly actionId: string } {
    // The policy owns the registry, so resolving through the adapters keeps the
    // core from inventing a second capability catalogue.
    for (const adapter of deps.adapters) if (deps.registeredCapabilities().includes(capability) && capability.startsWith(`${adapter.manifest.id}.`) && adapter.manifest.actions.some((action) => `${adapter.manifest.id}.${action.id}` === capability)) return { adapter, actionId: capability.slice(adapter.manifest.id.length + 1) };
    throw toros(ErrorCode.E_NOT_REGISTERED, 'The capability is not registered');
  }

  /** Resolve a capability, or null when it is not registered on this node. */
  function tryResolve(capability: CapabilityId): { adapter: Adapter; actionId: string } | null {
    try { return getPolicyRegistryEntry(capability); } catch { return null; }
  }

  /**
   * The path-valued arguments for this action, taken from the action's own
   * declaration rather than inferred from the values.
   *
   * Inferring was a containment bypass: the previous rule kept only strings
   * containing a separator, so a bare relative 'book.xlsx' or a drive-relative
   * 'C:book.xlsx' reached the adapter without ever being contained.
   */
  function paths(args: Readonly<Record<string, JsonValue>>, schema: ActionSchema): readonly string[] {
    return schema.path_fields.map((field) => args[field]).filter((value): value is string => typeof value === 'string');
  }

  async function job(args: Readonly<Record<string, JsonValue>>) {
    const found = await deps.store().getJob(requiredString(args, 'job_id'));
    if (found === null) throw toros(ErrorCode.E_ENVELOPE_INVALID, 'Unknown job');
    return found;
  }

  const replayTools: readonly ApprovalReplayTool[] = [
    'invoke_app_action', 'inspect_app', 'start_cli', 'send_cli', 'read_cli', 'interrupt_cli', 'stop_cli',
  ];

  async function prepare(toolName: string, args: Readonly<Record<string, JsonValue>>): Promise<ApprovalReplayAction> {
    if (!replayTools.includes(toolName as ApprovalReplayTool)) throw toros(ErrorCode.E_SCHEMA, `Unsupported action tool: ${toolName}`);
    const tool = toolName as ApprovalReplayTool;
    const currentJob = await job(args);
    const jobId = currentJob.job_id;
    const workspaceId = tool === 'start_cli' ? requiredString(args, 'workspace_id') : optionalString(args, 'workspace_id');
    const sessionId = ['send_cli', 'read_cli', 'interrupt_cli', 'stop_cli'].includes(tool) ? requiredString(args, 'session_id') : null;
    let sessionWorkspaceId: string | null = workspaceId;
    let sessionAdapterId: string | null = null;
    if (sessionId !== null) {
      const session = await deps.store().getSession(sessionId);
      if (session === null || session.job_id !== jobId) throw toros(ErrorCode.E_SESSION_UNKNOWN, 'Unknown session');
      sessionWorkspaceId = session.workspace_id;
      sessionAdapterId = session.adapter_id;
    }
    let capability: CapabilityId;
    let actionId: string;
    let actionArgs: Readonly<Record<string, JsonValue>>;
    if (tool.includes('_cli')) {
      const cliId = tool === 'start_cli' ? requiredString(args, 'cli_id') : sessionAdapterId;
      if (cliId === null) throw toros(ErrorCode.E_SESSION_UNKNOWN, 'Unknown session');
      actionId = tool.replace('_cli', '');
      capability = `${cliId}.${actionId}`;
      actionArgs = tool === 'send_cli' ? { message: args.message ?? null } : tool === 'read_cli' ? { cursor: args.cursor ?? null } : {};
    } else {
      const appId = requiredString(args, 'app_id');
      actionId = tool === 'inspect_app' ? 'inspect_workbook' : requiredString(args, 'action_id');
      capability = `${appId}.${actionId}`;
      actionArgs = asRecord(args.parameters ?? {});
    }
    return {
      tool,
      job_id: jobId,
      capability,
      action_id: actionId,
      arguments: structuredClone(actionArgs),
      workspace_id: sessionWorkspaceId,
      session_id: sessionId,
      session_adapter_id: sessionAdapterId,
      actor: coordinatorActor(optionalString(args, 'model')),
    };
  }

  async function runPrepared(prepared: ApprovalReplayAction, approvalToken: string | null, mayRequestApproval: boolean): Promise<unknown> {
    const jobId = prepared.job_id;
    if (locks.has(jobId)) throw toros(ErrorCode.E_PARALLEL_ACTION, 'An action for this job is already running');
    locks.add(jobId);
    try {
      const currentJob = await job({ job_id: jobId });
      const { tool, capability, arguments: actionArgs } = prepared;
      const sessionId = prepared.session_id;
      const sessionWorkspaceId = prepared.workspace_id;
      const sessionAdapterId = prepared.session_adapter_id;
      let actionId = prepared.action_id;
      // Best-effort schema lookup for the path declaration. Absent for an
      // unregistered capability, which policy denies at rule 6 — before path
      // containment at rule 10 — so an empty path list here cannot widen
      // anything.
      const resolved = tryResolve(capability);
      const actionSchema: ActionSchema | null = resolved?.adapter.manifest.actions.find((a) => a.id === resolved.actionId) ?? null;
      const store = deps.store();
      const receiptId = randomUUID();
      await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.requested', payload: { receipt_id: receiptId, capability } });
      // Retries are counted, not assumed zero. Passing a constant 0 made
      // E_RETRIES_EXHAUSTED unreachable through the real service: a failing
      // action could be re-requested until max_actions ran out, whatever
      // max_retries said.
      //
      // Derived from the receipts rather than a new column, so there is one
      // source of truth and no state to fall out of step with the audit log.
      const retries = await retriesUsed(store, jobId, capability, actionArgs);
      const decision = deps.policy().decide({ envelope: currentJob.envelope, envelope_digest: currentJob.envelope_digest, state: currentJob.state, actions_used: currentJob.actions_used, retries_used: retries, capability, arguments: actionArgs, workspace_id: sessionWorkspaceId, paths: actionSchema === null ? [] : paths(actionArgs, actionSchema), approval_token: approvalToken, now: new Date() });
      await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.decided', payload: decision });
      const started = now();
      // The actor is a LABEL supplied by the caller, so it must not be able to
      // claim to be a human. A request carrying `model: "operator"` would
      // otherwise write a receipt attributing its own action to the person at
      // the console — the one attribution nobody should be able to forge.
      // Anything arriving over this surface is the coordinator by definition.
      const actor = prepared.actor;
      let receipt: Receipt = { receipt_id: receiptId, job_id: jobId, node_id: deps.node_id, session_id: sessionId, actor, capability, arguments_normalized: null, arguments_digest: digest({ ...actionArgs }), decision, envelope_digest: currentJob.envelope_digest, started_at: started, ended_at: null, outcome: decision.allow ? 'running' : 'denied', artifact_refs: [], finding_refs: [], adapter_fields: {} };
      if (!decision.allow) {
        // A denied action is a completed action: it has an outcome and it is
        // over. Leaving ended_at null made every denial look like an action
        // still in flight, which is the opposite of what a reader needs from
        // the most security-relevant rows in the log.
        receipt = { ...receipt, ended_at: now() };
        await store.putReceipt(receipt);
        // A gate hit is not a dead end — it is a question for the operator, and
        // somebody has to record the question. Open (or re-open) the pending
        // request here and hand its id back, so the operator can see what is
        // waiting and the coordinator knows what to present once it is granted.
        //
        // Only for E_APPROVAL_REQUIRED. E_APPROVAL_INVALID means something was
        // presented that does not hold, and minting a fresh request for it
        // would turn a rejected approval into a new prompt on every retry.
        if (mayRequestApproval && decision.code === ErrorCode.E_APPROVAL_REQUIRED) {
          // The SAME expression policy uses to build the binding it will check
          // at spend time. Taking it from `receipt.arguments_digest` would read
          // nearly identical and be a latent mismatch the moment either side's
          // normalisation changes — and a binding that does not match is an
          // approval the operator grants and the coordinator can never spend.
          const pending = deps.approvals.request(
            { job_id: jobId, capability, arguments_digest: digest({ ...actionArgs }) },
            actionArgs,
            prepared,
            new Date(),
          );
          // The queue is full of decisions the operator has already made, and
          // an approved decision is never displaced to make room for a request.
          // Say so rather than silently dropping one of them.
          if (pending === null) throw toros(decision.code, 'This action requires operator approval, and the approval queue is full of pending decisions');
          try {
            await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'approval.requested', payload: { approval_id: pending.approval_id, capability, arguments_digest: pending.binding.arguments_digest, receipt_id: receiptId, expires_at: pending.expires_at } });
          } catch (appendFailure: unknown) {
            // Do not leave a record the log does not know about. It is inert
            // until approved, but the operator would be looking at a request
            // with no corresponding audit entry.
            deps.approvals.revoke(pending.approval_id);
            throw appendFailure;
          }
          throw new TorosError(decision.code, decision.reason, { approval_id: pending.approval_id, expires_at: pending.expires_at });
        }
        throw toros(decision.code, decision.reason);
      }
      // Policy has allowed, so the capability is registered and resolution
      // cannot fail. Resolving here rather than before the decision is what
      // keeps an unknown capability inside the audit pipeline.
      const { adapter, actionId: resolvedActionId } = getPolicyRegistryEntry(capability);
      actionId = resolvedActionId;
      // The workspace is resolved BEFORE the budget is spent (AR-06). A
      // pathless action with no workspace used to fail here — after the
      // increment, after action.started, and after a `running` receipt — which
      // consumed budget and left a false in-flight audit record forever. A
      // failure that happens before the adapter runs must cost nothing and be
      // written down once, already closed.
      const workspace = deps.workspaces.find((candidate) => candidate.id === sessionWorkspaceId);
      if (workspace === undefined) {
        receipt = { ...receipt, ended_at: now(), outcome: 'failed' };
        await store.putReceipt(receipt);
        await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.finished', payload: { receipt_id: receiptId, outcome: receipt.outcome, error: ErrorCode.E_WORKSPACE_DENIED } });
        throw toros(ErrorCode.E_WORKSPACE_DENIED, 'Unknown workspace');
      }
      // Pipeline order, normative (G-node-core): spend the budget at step 7,
      // THEN record the start at step 8.
      //
      // Writing the receipt first inverted them, and the inversion is visible
      // in the audit: if the atomic increment failed, the log held a `running`
      // action that never spent budget and never reached action.started. A
      // receipt that does not reconstruct the real sequence is the one thing
      // §8.3 asks it not to be.
      const spent = await store.incrementActionsUsed(jobId);
      await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.started', payload: { receipt_id: receiptId } });
      // One closing path for the `running` receipt. From action.started on,
      // EVERY failure — the first receipt write itself, timeout controller and
      // timer setup, path-argument resolution, the adapter call, a store
      // failure while recording the session or its artifacts, or Core's own
      // timeout/cancellation — closes the receipt `failed`/`terminated` before
      // the error propagates, and success closes it `succeeded`. A receipt
      // never stays `running` after this call returns or throws.
      try {
        // Still before the adapter runs — a crash or a hung adapter must not
        // leave an action that spent budget with no record of it. INSIDE the
        // closing path on purpose: a store failure while persisting the
        // `running` row (or one that persists the row and then rejects) must
        // still produce a closed receipt and an action.finished event.
        await store.putReceipt(receipt);
        // Core-level timeout (AR-07). One controller per action; its signal is
        // handed to the adapter, and the adapter call races a timer armed with
        // the action's OWN ceiling: ActionSchema.timeout_ms, else the manifest
        // default. On timeout the controller aborts, the run fails with
        // E_TIMEOUT (receipt `terminated`), and a late adapter result cannot
        // overwrite the already-closed receipt. Wiring a job-cancellation hook
        // (E_CANCELLED) would land here; the pipeline has no such hook today, so
        // one is not invented.
        const controller = new AbortController();
        const timeoutMs = actionSchema?.timeout_ms ?? adapter.manifest.default_timeout_ms;
        const timedOut = toros(ErrorCode.E_TIMEOUT, `The action exceeded its ${timeoutMs}ms timeout`);
        async function withinTimeout<T>(work: () => Promise<T>): Promise<T> {
          let timer: NodeJS.Timeout | undefined;
          let didTimeOut = false;
          try {
            try {
              const outcome = await Promise.race([
                work(),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    // Mark the action timed out BEFORE aborting the adapter's
                    // signal. Abort listeners run synchronously: an adapter
                    // that resolves (or rejects) its pending promise from its
                    // own abort listener would otherwise settle the race first
                    // and replace E_TIMEOUT with a success or its own error.
                    // Deciding the timeout before the abort makes E_TIMEOUT the
                    // only outcome the race can produce.
                    didTimeOut = true;
                    controller.abort();
                    reject(timedOut);
                  }, timeoutMs);
                }),
              ]);
              if (didTimeOut) throw timedOut;
              return outcome;
            } catch (error: unknown) {
              if (didTimeOut) throw timedOut;
              throw error;
            }
          } finally { if (timer !== undefined) clearTimeout(timer); }
        }
        const context: AdapterContext = { job_id: jobId, session_id: sessionId, workspace, correlation_id: receiptId, signal: controller.signal, actor };
        // Hand the adapter the SAME path policy approved, not the string the
        // caller wrote.
        //
        // Policy resolves a workspace-relative path against the workspace root to
        // decide containment — `book.xlsx` is checked as
        // `<workspace>\book.xlsx`. Passing the original relative string on meant
        // the adapter resolved it again, against Node Core's own process
        // directory, so what executed was not what was authorised. That is a
        // check-then-use gap, and it lands outside the workspace.
        //
        // Substituting the resolved absolute form closes it: the argument the
        // adapter receives is exactly the one that was contained.
        const executedArgs = actionSchema === null ? actionArgs : resolvePathArgs(actionArgs, actionSchema, workspace.root);
        // Two-phase resolve (amendment A8). For an adapter with a resolver, Core
        // resolves the targets, decides each one against the envelope, and hands
        // the decisions to invoke. The resolve runs under the same timeout and
        // abort as invoke, and a resolve failure closes the receipt the same way
        // an invoke failure does. An adapter without a resolver behaves exactly
        // as before.
        const resolver = adapter.resolver;
        let invokeContext: AdapterContext = context;
        let resolveCounts: { readonly allowed: number; readonly denied: number } | undefined;
        if (resolver !== undefined) {
          const rawTargets = await withinTimeout(() => resolver.resolve(actionId, executedArgs, context));
          const targets = validateResolvedTargets(rawTargets);
          const decisions = deps.policy().authorizeTargets(currentJob.envelope, capability, targets);
          let allowed = 0;
          let denied = 0;
          for (const decision of decisions.values()) { if (decision === 'allowed') allowed += 1; else denied += 1; }
          resolveCounts = { allowed, denied };
          invokeContext = { ...context, target_decisions: decisions };
        }
        let result: ActionResult;
        let adapterFields: Readonly<Record<string, JsonValue>> = {};
        if (tool === 'start_cli') {
          const startedSession = await withinTimeout(() => sessionAdapter(adapter).start({ ...invokeContext, session_id: receiptId }));
          await store.createSession({ session_id: receiptId, job_id: jobId, adapter_id: adapter.manifest.id, workspace_id: workspace.id, pid: startedSession.pid, started_at: started });
          // Index it for correlation before anything the child does can be
          // observed. The adapter named its working directory after this same
          // id, so this is the entry that makes route 1 resolvable.
          deps.recordSession(receiptId, jobId);
          try {
            await deps.stageGraphs().seedSession(jobId, receiptId, workspace);
          } catch (seedFailure: unknown) {
            try { await sessionAdapter(adapter).stop(receiptId); } catch { /* best-effort child cleanup */ }
            await store.stopSession(receiptId, now());
            deps.removeSession(receiptId);
            throw seedFailure;
          }
          result = { output: '', truncated: false, artifacts: [], receipt_extra: {} };
        } else {
          result = await withinTimeout(() => adapter.invoke(actionId, executedArgs, invokeContext));
          // stop_cli killed the process and left the session row untouched, so
          // persisted state kept showing a live pid and a null stopped_at —
          // across restarts. The lifecycle has to be recorded where it is read
          // from, not only where it happened.
          if (tool === 'stop_cli' && sessionId !== null) {
            await store.stopSession(sessionId, now());
            await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'session.stopped', payload: { session_id: sessionId, receipt_id: receiptId } });
          }
        }
        adapterFields = declaredAdapterFields(adapter, result);
        // Core records only the counts, never the identities (amendment A8). The
        // two reserved keys are Core-owned and can never collide with an adapter
        // field because registration refuses a manifest that declares them.
        if (resolveCounts !== undefined) {
          adapterFields = { ...adapterFields, targets_allowed: resolveCounts.allowed, targets_denied: resolveCounts.denied };
        }
        const exchangeState = adapterFields['exchange_state'];
        const exchangeError = adapterFields['exchange_error'];
        if (tool === 'read_cli' && sessionId !== null) {
          const cursor = result.receipt_extra['bytes_read'];
          if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) await store.setReadCursor(sessionId, cursor);
        }
        if (sessionId !== null && sessionAdapterId !== null && typeof exchangeState === 'string' && exchangeState !== 'running' && exchangeState !== 'idle') {
          await settleCliExchange(store, jobId, sessionId, sessionAdapterId, exchangeState, exchangeError, adapterFields);
        }
        const artifactRefs: string[] = [];
        for (const artifact of result.artifacts) { const id = randomUUID(); artifactRefs.push(id); await store.putArtifact({ ...artifact, artifact_id: id, job_id: jobId, created_at: now() }); }
        const response = {
          ...(tool === 'read_cli' && typeof adapterFields['bytes_read'] === 'number' ? { cursor: adapterFields['bytes_read'] } : {}),
          output: result.output, artifacts: artifactRefs, receipt_id: receiptId,
          ...(typeof exchangeState === 'string' ? { exchange_state: exchangeState, exchange_error: typeof exchangeError === 'string' ? exchangeError : null } : {}),
        };
        if (tool === 'send_cli' && exchangeState === 'running') {
          // The one deliberate exception to "never return a `running` receipt":
          // an exchange that is still in flight is settled later by the next
          // read_cli (see settleCliExchange), so the receipt stays open on
          // purpose. It is never open-ended, though: the settlement deadline
          // closes it `terminated` with exchange_state `unsettled_deadline`
          // after the action's timeout plus the bounded grace, so the receipt
          // cannot remain `running` forever.
          receipt = { ...receipt, artifact_refs: artifactRefs, adapter_fields: adapterFields };
          await store.putReceipt(receipt);
          armCliSettlementDeadline(store, receipt, timeoutMs);
          return response;
        }
        receipt = { ...receipt, ended_at: now(), outcome: 'succeeded', artifact_refs: artifactRefs, adapter_fields: adapterFields };
        await store.putReceipt(receipt);
        await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.finished', payload: { receipt_id: receiptId, outcome: receipt.outcome, actions_used: spent.actions_used } });
        return response;
      } catch (error: unknown) {
        const failed = error instanceof TorosError ? error : toros(ErrorCode.E_ADAPTER_FAILURE, 'The adapter failed');
        receipt = { ...receipt, ended_at: now(), outcome: failed.code === ErrorCode.E_TIMEOUT || failed.code === ErrorCode.E_CANCELLED || failed.code === ErrorCode.E_OUTPUT_LIMIT ? 'terminated' : 'failed' };
        await store.putReceipt(receipt);
        await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.finished', payload: { receipt_id: receiptId, outcome: receipt.outcome, error: failed.code } });
        throw failed;
      }
    } finally { locks.delete(jobId); }
  }

  async function execute(tool: string, args: Readonly<Record<string, JsonValue>>): Promise<unknown> {
    const prepared = await prepare(tool, args);
    return runPrepared(prepared, optionalString(args, 'approval_token'), true);
  }

  async function replay(approvalId: string, jobId: string): Promise<unknown> {
    const retained = deps.approvals.replay(approvalId, jobId, new Date());
    if (retained === null) throw toros(ErrorCode.E_APPROVAL_INVALID, 'Unknown, ungranted, expired, spent, or wrong-job approval');
    const action = retained.action;
    const exact = action.job_id === retained.binding.job_id
      && action.job_id === jobId
      && action.capability === retained.binding.capability
      && digest({ ...action.arguments }) === retained.binding.arguments_digest;
    if (!exact) throw toros(ErrorCode.E_APPROVAL_INVALID, 'The retained approval action does not match its binding');
    return runPrepared(action, approvalId, false);
  }

  async function settleCliExchange(store: Store, jobId: string, sessionId: string, adapterId: string, state: string, error: JsonValue | undefined, adapterFields: Readonly<Record<string, JsonValue>>): Promise<void> {
    const pending = await store.latestRunningReceipt(jobId, sessionId, `${adapterId}.send`);
    if (pending === null) return;
    const terminated = state === 'interrupted' || error === ErrorCode.E_TIMEOUT || error === ErrorCode.E_CANCELLED || error === ErrorCode.E_OUTPUT_LIMIT;
    const outcome: Receipt['outcome'] = state === 'succeeded' ? 'succeeded' : terminated ? 'terminated' : 'failed';
    const settled: Receipt = { ...pending, ended_at: now(), outcome, adapter_fields: { ...pending.adapter_fields, ...adapterFields } };
    // Two durable steps close an exchange: the terminal receipt write and the
    // `action.finished` event. The deadline timer is cleared only once BOTH are
    // on disk (Round 3 item 1 kept it armed across a failed write; Round 4
    // item 2 extends that to the event). If either persists and the other
    // fails, the timer stays armed and closeUnsettledCliReceipt recovers the
    // missing step — without rewriting the receipt or duplicating the event.
    // The deadline close is idempotent with this one: the receipt is now
    // closed, so whichever runs first wins and neither reopens nor rewrites it.
    await store.putReceipt(settled);
    await store.appendEvent({ node_id: deps.node_id, job_id: jobId, kind: 'action.finished', payload: { receipt_id: pending.receipt_id, outcome, exchange_state: state, exchange_error: typeof error === 'string' ? error : null } });
    clearPendingSettleTimer(pending.receipt_id);
  }

  /** Cancel a pending settlement-deadline timer, if any. */
  function clearPendingSettleTimer(receiptId: string): void {
    const timer = pendingSettleTimers.get(receiptId);
    if (timer !== undefined) { timer.unref(); clearTimeout(timer); pendingSettleTimers.delete(receiptId); }
  }

  /**
   * Try to close a still-open `send_cli` receipt that reached its settlement
   * deadline. Idempotent by design: the receipt is re-read and re-checked
   * immediately before the write, so a `read_cli` that settled the receipt a
   * moment earlier (or a duplicate deadline firing) closes nothing and rewrites
   * nothing.
   *
   * The close has two durable steps — the terminal receipt write and the
   * `action.finished` event — and only the FAILED step is retried:
   *
   * - receipt still `running` → write the terminal receipt, then append the
   *   event;
   * - receipt closed but no `action.finished` for it → append the event only,
   *   describing the receipt exactly as it was persisted, never rewriting it;
   * - both present → stop.
   *
   * The ENTIRE attempt is caught, including `store.getReceipt` itself. Any
   * failure — a rejected read, a rejected terminal write, a rejected event
   * append — schedules the bounded retry (1 s, 5 s, 30 s, then every 60 s by
   * default; the retry stops the moment the closure is complete). Because the
   * whole body is inside the catch, this function NEVER rejects, so nothing a
   * `void`-ed caller (the deadline timer, reconciliation) awaits can produce
   * an unhandled rejection.
   */
  async function closeUnsettledCliReceipt(receiptId: string, store: Store, retryCount = 0): Promise<void> {
    try {
      const current = await store.getReceipt(receiptId);
      if (current === null) return;
      if (current.outcome === 'running') {
        const settled: Receipt = {
          ...current,
          ended_at: now(),
          outcome: 'terminated',
          adapter_fields: { ...current.adapter_fields, exchange_state: 'unsettled_deadline' },
        };
        await store.putReceipt(settled);
        // The second durable step. If this append fails — even after
        // persisting — the retry sees a closed receipt and recovers the
        // missing event instead of rewriting anything or duplicating it.
        await store.appendEvent({ node_id: deps.node_id, job_id: current.job_id, kind: 'action.finished', payload: cliFinishedPayload(settled) });
        return;
      }
      // Already closed by another path (a read_cli settlement, or an earlier
      // attempt whose terminal write landed). Audit recovery: append exactly
      // one event for the missing finished record, never re-open, never
      // rewrite, never duplicate.
      const finished = (await store.listEvents(current.job_id)).some(
        (event) => event.kind === 'action.finished' && (event.payload as { readonly receipt_id?: string }).receipt_id === current.receipt_id,
      );
      if (!finished) {
        await store.appendEvent({ node_id: deps.node_id, job_id: current.job_id, kind: 'action.finished', payload: cliFinishedPayload(current) });
      }
    } catch (error: unknown) {
      // The attempt failed anywhere — the read, the terminal write, or the
      // event append. Schedule the bounded retry and return. This function
      // never rejects, so fire-and-forget callers stay safe.
      const delay = retryCount < settlement.retryDelays.length
        ? (settlement.retryDelays[retryCount] ?? settlement.retryMaxDelay)
        : settlement.retryMaxDelay;
      const timer = setTimeout(() => { void closeUnsettledCliReceipt(receiptId, store, retryCount + 1); }, delay);
      timer.unref();
    }
  }

  /**
   * The `action.finished` payload describing a closed exchange clocked in the
   * way the receipt itself was persisted. Recovery paths append this so that
   * a recovered event reads identically to the one the original closure would
   * have written.
   */
  function cliFinishedPayload(receipt: Receipt): { readonly receipt_id: string; readonly outcome: Receipt['outcome']; readonly exchange_state: string; readonly exchange_error: string | null } {
    const fields = (receipt.adapter_fields ?? {}) as Readonly<Record<string, JsonValue>>;
    const exchangeState = typeof fields['exchange_state'] === 'string' ? fields['exchange_state'] : 'unsettled_deadline';
    const exchangeError = typeof fields['exchange_error'] === 'string' ? fields['exchange_error'] : null;
    return { receipt_id: receipt.receipt_id, outcome: receipt.outcome, exchange_state: exchangeState, exchange_error: exchangeError };
  }

  /**
   * Arm the guaranteed close for a `send_cli` receipt that returns open. The
   * deadline is the action's own timeout plus the bounded grace, counted from
   * the receipt's `started_at`; any later `read_cli` settlement cancels it.
   */
  function armCliSettlementDeadline(store: Store, receipt: Receipt, timeoutMs: number): void {
    const deadlineMs = Date.parse(receipt.started_at) + timeoutMs + settlement.graceMs;
    clearPendingSettleTimer(receipt.receipt_id);
    const timer = setTimeout(() => {
      pendingSettleTimers.delete(receipt.receipt_id);
      void closeUnsettledCliReceipt(receipt.receipt_id, store);
    }, Math.max(0, deadlineMs - Date.now()));
    timer.unref();
    pendingSettleTimers.set(receipt.receipt_id, timer);
  }

  /**
   * Restart reconciliation for the `send_cli` settlement deadline. Deadline
   * timers are in-memory and die with the process, so a `send_cli` receipt
   * still `running` after a crash would otherwise stay open forever. Called at
   * Core start: every running send whose deadline (`started_at` + the send
   * action's timeout + the grace) has already passed is closed exactly as the
   * in-process deadline would have closed it. Receipts whose deadline has not
   * passed yet get their in-memory timer re-armed with the remaining time, so
   * the guaranteed close still fires without another restart.
   *
   * Also handles the case where a `send` receipt is already closed but its
   * `action.finished` event is missing (the event append failed and the process
   * restarted before the bounded retry). The event-only recovery path appends
   * exactly one finished event without rewriting the receipt or duplicating the
   * event, with the same retry schedule on failure.
   */
  async function reconcileCliSettlements(): Promise<void> {
    const store = deps.store();
    const adaptersById = new Map(deps.adapters.map((adapter) => [adapter.manifest.id, adapter]));
    for (const job of await store.listJobs()) {
      for (const receipt of await store.listReceipts(job.job_id)) {
        if (!receipt.capability.endsWith('.send')) continue;
        if (receipt.outcome === 'running') {
          const adapter = adaptersById.get(receipt.capability.slice(0, -'.send'.length));
          if (adapter === undefined) continue;
          const sendAction = adapter.manifest.actions.find((action) => action.id === 'send');
          const timeoutMs = sendAction?.timeout_ms ?? adapter.manifest.default_timeout_ms;
          const deadlineMs = Date.parse(receipt.started_at) + timeoutMs + settlement.graceMs;
          if (Date.now() >= deadlineMs) {
            // Fire-and-forget: a write failure arms the retry schedule; a
            // failure for one receipt must not stop the scan. The retry
            // catches its own errors and never produces an unhandled rejection.
            void closeUnsettledCliReceipt(receipt.receipt_id, store);
          } else {
            // The deadline has not passed: re-arm the in-memory timer so the
            // receipt does not stay open until the next restart. Calling
            // armCliSettlementDeadline with the timeout computed above sets the
            // delay to exactly the remaining wall-clock time.
            armCliSettlementDeadline(store, receipt, timeoutMs);
          }
        } else {
          // Receipt is already closed but may be missing its action.finished
          // event (the event append failed and the process restarted before
          // the retry). Use the existing event-only recovery path in
          // closeUnsettledCliReceipt: it sees a closed receipt with no
          // finished event and appends exactly one, never rewriting the
          // receipt or duplicating the event. On failure the same bounded
          // retry schedule applies.
          void closeUnsettledCliReceipt(receipt.receipt_id, store);
        }
      }
    }
  }

  /**
   * How many times this exact action has already failed for this job since it
   * last succeeded.
   *
   * A retry is a re-request of the same capability with the same arguments, so
   * both are matched — the arguments through their digest, which is already on
   * every receipt. Counting stops at the most recent success, because a run
   * that worked resets the budget rather than holding it against the next one.
   *
   * Derived from the receipts instead of a stored counter on purpose: the
   * receipts are the audit record, and a separate counter is a second source of
   * truth that can disagree with it.
   */
  async function retriesUsed(store: Store, jobId: string, capability: CapabilityId, actionArgs: Readonly<Record<string, JsonValue>>): Promise<number> {
    const argumentsDigest = digest({ ...actionArgs });
    const failures = await store.countRetries(jobId, capability, argumentsDigest);
    // The first attempt is not a retry, so the first failure does not spend the
    // budget — it creates the opportunity for one. With max_retries: 1 that
    // gives two attempts in total, which is what "one retry" means.
    //
    // Same off-by-one that `assertRetries` itself had: retries_used counts
    // retries ALREADY PERFORMED, and there have been none until an attempt has
    // already failed once.
    return Math.max(0, failures - 1);
  }

  return { execute, replay, reconcileCliSettlements };
}
