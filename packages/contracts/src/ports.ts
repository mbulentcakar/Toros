import type { JsonValue } from './canonical.js';
import type { JobEnvelope, SealedEnvelope, WorkItemState } from './envelope.js';
import type { AdapterManifest, CapabilityId, Workspace } from './capability.js';
import type { ChainHead, ChainVerification, EventKind, EventRow, Receipt } from './receipt.js';

/**
 * The ports every unit codes against. They are declared here, together, so
 * that units built in parallel compose without their authors negotiating.
 *
 * Each port is implemented by exactly one package and consumed by several.
 * Consumers depend on the interface; nobody depends on an implementation.
 */

// ---------------------------------------------------------------------------
// Store — implemented by @toros/store
// ---------------------------------------------------------------------------

export interface JobRecord {
  readonly job_id: string;
  readonly envelope: JobEnvelope;
  readonly envelope_digest: string;
  readonly state: WorkItemState;
  readonly created_at: string;
  readonly updated_at: string;
  /** Actions executed so far, checked against `max_actions`. */
  readonly actions_used: number;
  /**
   * The conversation this job belongs to, or null before its first Hermes run
   * has minted one. Bound once and never moved.
   */
  readonly conversation_id: string | null;
}

export interface SessionRecord {
  readonly session_id: string;
  readonly job_id: string;
  readonly adapter_id: string;
  readonly workspace_id: string;
  /** OS process id while running, null once stopped. */
  readonly pid: number | null;
  readonly started_at: string;
  readonly stopped_at: string | null;
  /**
   * Byte offset the coordinator has read up to. `read_cli` is incremental, so
   * this is state, not a derived value.
   */
  readonly read_cursor: number;
}

export interface ArtifactRecord {
  readonly artifact_id: string;
  readonly job_id: string;
  /** Absolute path inside the workspace. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly created_at: string;
}

/**
 * SPEC §8.2. How a security record was resolved to a receipt, strongest first.
 *
 * This is stored rather than inferred because a receipt is an audit record.
 * Presenting a `session`-grade time-window match as though it were an exact
 * link would make the trail assert something it does not know.
 */
export type CorrelationConfidence =
  /** The record carried a `project_path` Toros itself assigned to one session. */
  | 'exact'
  /** A finding cited an event that resolved as `exact`. */
  | 'cited'
  /**
   * Matched on run, agent, and endpoint within the session's active window.
   * Session-granular by construction; never narrow it to an action afterwards.
   */
  | 'session'
  /** Nothing matched. Still stored — an uncorrelated finding is still a finding. */
  | 'none';

export interface FindingRecord {
  readonly finding_id: string;
  /** Null unless correlation reached a specific action. */
  readonly receipt_id: string | null;
  readonly job_id: string | null;
  /** Set whenever correlation reached a session, even if not an action. */
  readonly session_id: string | null;
  readonly correlation: CorrelationConfidence;
  readonly rule_id: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly title: string;
  readonly observed_at: string;
  /** The source record, already redacted by the observer. */
  readonly detail: JsonValue;
}

export interface AppendEventInput {
  readonly node_id: string;
  readonly job_id: string | null;
  readonly kind: EventKind;
  readonly payload: JsonValue;
}

/**
 * A long-lived Hermes conversation (spec Y). May relate to zero, one, or many
 * jobs; the binding is recorded on turns, not here.
 */
export interface ConversationRecord {
  readonly conversation_id: string;
  readonly node_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state: 'open' | 'archived';
  /** Last worker CLI chosen for work proposed from this conversation. */
  readonly agent: string | null;
  /** Last API model chosen for Hermes in this conversation. */
  readonly model: string | null;
}

export interface ModelUsageRecord {
  readonly usage_id: string;
  readonly conversation_id: string;
  readonly job_id: string | null;
  readonly provider: string;
  readonly model: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number | null;
  readonly recorded_at: string;
}

/** Who produced a turn. */
export type ConversationTurnRole = 'operator' | 'hermes' | 'system' | 'tool';

/**
 * Where a turn is destined. `human` is cockpit-visible prose; `machine` is
 * act/done traffic and is never rendered as prose.
 */
export type ConversationTurnChannel = 'human' | 'machine';

/**
 * One immutable turn in a conversation. `seq` is assigned by the store and is
 * monotonic per conversation; turns are never updated or deleted.
 */
export interface ConversationTurn {
  readonly conversation_id: string;
  readonly seq: number;
  readonly role: ConversationTurnRole;
  readonly channel: ConversationTurnChannel;
  readonly content: string;
  readonly job_id: string | null;
  readonly recorded_at: string;
}

/** Caller input for `appendTurn`. `seq` and `recorded_at` are store-assigned. */
export interface AppendTurnInput {
  readonly conversation_id: string;
  readonly role: ConversationTurnRole;
  readonly channel: ConversationTurnChannel;
  readonly content: string;
  readonly job_id: string | null;
}

/**
 * Persistence and the append-only log.
 *
 * `appendEvent` is the only way to write the log, and it computes the chain
 * links itself — callers cannot supply `prev_hash` or `hash`. That is what
 * makes the chain meaningful: a caller cannot forge a link it does not
 * already hold.
 */
export interface Store {
  createJob(sealed: SealedEnvelope): Promise<JobRecord>;
  getJob(jobId: string): Promise<JobRecord | null>;
  /**
   * Bind a job to its conversation, once. Rebinding to a different
   * conversation is refused: a job's history cannot move.
   */
  setJobConversation(jobId: string, conversationId: string): Promise<JobRecord>;
  /** Operator-facing local inventory, newest first. */
  listJobs(): Promise<readonly JobRecord[]>;
  setJobState(jobId: string, state: WorkItemState): Promise<JobRecord>;
  /** Atomically increments `actions_used`; the caller must have checked the budget. */
  incrementActionsUsed(jobId: string): Promise<JobRecord>;

  createSession(input: Omit<SessionRecord, 'stopped_at' | 'read_cursor'>): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(jobId: string): Promise<readonly SessionRecord[]>;
  setReadCursor(sessionId: string, cursor: number): Promise<SessionRecord>;
  stopSession(sessionId: string, stoppedAt: string): Promise<SessionRecord>;

  putReceipt(receipt: Receipt): Promise<void>;
  getReceipt(receiptId: string): Promise<Receipt | null>;
  listReceipts(jobId: string): Promise<readonly Receipt[]>;
  countRetries(jobId: string, capability: CapabilityId, argumentsDigest: string): Promise<number>;
  latestRunningReceipt(jobId: string, sessionId: string, capability: CapabilityId): Promise<Receipt | null>;

  putArtifact(artifact: ArtifactRecord): Promise<void>;
  listArtifacts(jobId: string): Promise<readonly ArtifactRecord[]>;

  putFinding(finding: FindingRecord): Promise<void>;
  listFindings(jobId: string): Promise<readonly FindingRecord[]>;

  /**
   * The only writer of the event log. Reads the head, computes the link, and
   * writes the row and the new head in a single transaction, so appends for a
   * node are serialised. Two writers that both read the same head would
   * produce two rows sharing a `prev_hash` — a fork, not a chain — which is
   * why this is a correctness requirement and not a throughput detail.
   *
   * Callers cannot supply `prev_hash` or `hash`: a caller must not be able to
   * forge a link it does not already hold.
   */
  appendEvent(input: AppendEventInput): Promise<EventRow>;
  listEvents(jobId: string): Promise<readonly EventRow[]>;
  /** The anchor `verifyChain` checks the recomputed chain against (SPEC §8.1). */
  getChainHead(nodeId: string): Promise<ChainHead>;
  /**
   * Walks the chain for a node and reports the first break, then checks the
   * result against the head anchor. The anchor is what makes tail truncation
   * detectable: dropping the final rows leaves a shorter but internally valid
   * prefix that the links alone accept.
   */
  verifyChain(nodeId: string): Promise<ChainVerification>;

  /**
   * Durable Hermes conversation (spec Y). Turns are append-only; `seq` is
   * assigned by the store under a serialising transaction so concurrent
   * appends cannot duplicate or gap.
   */
  createConversation(
    input: Omit<ConversationRecord, 'created_at' | 'updated_at' | 'agent' | 'model'> & {
      readonly agent?: string | null;
      readonly model?: string | null;
    },
  ): Promise<ConversationRecord>;
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  listConversations(): Promise<readonly ConversationRecord[]>;
  renameConversation(conversationId: string, title: string): Promise<ConversationRecord>;
  setConversationState(conversationId: string, state: ConversationRecord['state']): Promise<ConversationRecord>;
  setConversationPreferences(conversationId: string, agent: string | null, model: string | null): Promise<ConversationRecord>;
  appendTurn(input: AppendTurnInput): Promise<ConversationTurn>;
  /**
   * Turns for a conversation in `seq` order. When `after` is set, only turns
   * with `seq > after` are returned.
   */
  listTurns(
    conversationId: string,
    opts?: { readonly after?: number },
  ): Promise<readonly ConversationTurn[]>;
  recordModelUsage(input: Omit<ModelUsageRecord, 'usage_id' | 'recorded_at'>): Promise<ModelUsageRecord>;
  listModelUsage(conversationId: string): Promise<readonly ModelUsageRecord[]>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter — implemented by @toros/adapters-cli and @toros/adapters-app
// ---------------------------------------------------------------------------

/**
 * OS-observed identity of a process that owns a target. Never caller-supplied:
 * an adapter reads it from the OS, so it cannot be forged by the coordinator
 * or carried between jobs. Node Core records only counts derived from it,
 * never the identity itself.
 */
export interface AppIdentity {
  readonly pid: number;
  /** Process creation time, ISO-8601 UTC. Guards against pid reuse. */
  readonly created_at: string;
  /** Canonical full image path, as the OS reports it. */
  readonly image_path: string;
  /** Lower-case hex SHA-256 of the image file. */
  readonly image_sha256: string;
  readonly signature: 'valid' | 'unsigned' | 'invalid';
  /** Authenticode subject CN when signature is 'valid', else null. */
  readonly signer: string | null;
  /** Version resource ProductName, or null. */
  readonly product_name: string | null;
  /** Windows session id of the process. */
  readonly session_id: number;
}

/**
 * One OS-observed target an adapter resolved ahead of execution (amendment A8,
 * the two-phase resolve). `key` is adapter-opaque: Core carries it unchanged
 * and returns a decision per key, but never interprets it.
 */
export type ResolvedTarget =
  | { readonly kind: 'app'; readonly key: string; readonly identity: AppIdentity }
  | { readonly kind: 'capability'; readonly key: string; readonly capability: CapabilityId };

/** Core's decision for each resolved key. Keys absent from the map are denied. */
export type TargetDecisions = ReadonlyMap<string, 'allowed' | 'denied'>;

/**
 * Resolves an action's OS targets before execution so policy can decide each
 * one (amendment A8). Declared here, implemented by the desktop adapter (F3b)
 * and consumed by Node Core.
 */
export interface TargetResolver {
  /** Read-only. Must not mutate any target. Called by Core before invoke. */
  resolve(
    actionId: string,
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<readonly ResolvedTarget[]>;
}

export interface AdapterContext {
  readonly job_id: string;
  readonly session_id: string | null;
  readonly workspace: Workspace;
  /**
   * Correlation id handed to the child process so Numbat records can be
   * matched to Toros receipts deterministically (SPEC §8.2). CLI adapters
   * must propagate it; desktop adapters may ignore it.
   */
  readonly correlation_id: string;
  /**
   * Who called: the receipt's actor. Lets an adapter bind handles to the
   * caller, so a handle minted for one actor cannot be replayed by another.
   */
  readonly actor: string;
  /**
   * Present only when the adapter has a resolver: Core's decision per resolved
   * key. An adapter must act only on keys whose decision is `allowed` and
   * re-verify the resolved identity at execution.
   */
  readonly target_decisions?: TargetDecisions;
  /** Aborts on timeout, output limit, or operator cancellation. */
  readonly signal: AbortSignal;
}

export interface ActionResult {
  readonly output: string;
  /** Truncated because the output limit was hit; the run is terminated. */
  readonly truncated: boolean;
  /** Artifacts produced, to be recorded by the caller. */
  readonly artifacts: readonly Omit<ArtifactRecord, 'artifact_id' | 'job_id' | 'created_at'>[];
  /** Adapter-specific receipt fields, matching `manifest.receipt_fields`. */
  readonly receipt_extra: Readonly<Record<string, JsonValue>>;
}

/**
 * Every adapter, of every kind. Note what is absent: no adapter receives the
 * envelope, and none can consult or alter policy. An adapter is reached only
 * after the decision has already been made.
 */
export interface Adapter {
  readonly manifest: AdapterManifest;
  /**
   * Optional two-phase resolver (amendment A8). Absent adapters behave exactly
   * as before. Present, it is called by Core after the policy decision and
   * before invoke; the adapter then acts only on the targets Core allowed.
   */
  readonly resolver?: TargetResolver;
  /** Called once at registration. Throw to refuse registration on this host. */
  init(): Promise<void>;
  invoke(actionId: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext): Promise<ActionResult>;
  dispose(): Promise<void>;
}

/** Adapters that supervise a long-lived child process (SPEC §6 `*_cli` tools). */
export interface SessionAdapter extends Adapter {
  start(ctx: AdapterContext): Promise<{ readonly pid: number }>;
  send(sessionId: string, message: string): Promise<void>;
  /** Reads from `cursor`; returns the new cursor so reads stay incremental. */
  read(sessionId: string, cursor: number): Promise<{
    readonly chunk: string;
    readonly cursor: number;
    /** State of the most recent exchange. Optional for non-CLI test adapters. */
    readonly exchange_state?: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
    /** Stable Toros error code when the exchange did not succeed. */
    readonly exchange_error?: string | null;
  }>;
  /** Interrupt the current turn without ending the session. */
  interrupt(sessionId: string): Promise<void>;
  /** End the session. */
  stop(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// SecurityObserver — implemented by @toros/observer
// ---------------------------------------------------------------------------

/**
 * SPEC §8.2. Monitor-only, by contract as well as by configuration.
 *
 * The interface has no method that returns a decision, and nothing in the
 * policy path imports it. An observer cannot deny an action even if a future
 * implementation wanted to — the type system does not offer it the vocabulary.
 */
/**
 * A withdrawal of a correlation the observer previously reported (SPEC §8.2).
 *
 * A separate channel rather than a re-emitted finding, because a duplicate
 * finding is indistinguishable from a second observation of the same thing —
 * the audit could not tell which earlier attribution was withdrawn, which is
 * the entire point of recording the retraction.
 *
 * It carries no correlation of its own: a retraction says only "this is no
 * longer attributed", never "it belongs to something else".
 */
export interface CorrelationRetraction {
  /** The run whose binding was invalidated. */
  readonly run_id: string;
  /** The session the retracted records had been attributed to. */
  readonly retracted_session_id: string;
  /** Findings whose attribution is withdrawn, as the observer reported them. */
  readonly retracted_finding_keys: readonly string[];
  readonly observed_at: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Approvals — implemented by @toros/node-core, consumed by @toros/policy
// ---------------------------------------------------------------------------

/**
 * Exactly which action an approval authorises.
 *
 * All three fields, because an approval that named only the capability would
 * authorise the next call with *different arguments* — the operator approved
 * writing one cell, and the coordinator writes another. The digest is computed
 * the same way the receipt's `arguments_digest` is, so the log and the gate
 * agree on what "this exact action" means.
 */
export interface ApprovalBinding {
  readonly job_id: string;
  readonly capability: CapabilityId;
  readonly arguments_digest: string;
}

/**
 * The gate policy consults at rule 12.
 *
 * `approval_token` is an approval REQUEST ID, not a secret. Knowing it grants
 * nothing: the authority is the operator's recorded decision against that
 * record, which only the operator surface can set. That is deliberate — a
 * bearer secret handed back to the coordinator is a secret the coordinator can
 * mint, replay, or keep, and this gate exists precisely because the coordinator
 * is not trusted to approve its own high-impact actions.
 */
export interface ApprovalVerifier {
  /**
   * Spend an approval if it authorises exactly this action, right now.
   *
   * Single-use, and it must be the same call that checks and spends: two
   * actions that both verified before either spent would both be allowed on one
   * operator decision.
   */
  consume(token: string, binding: ApprovalBinding, now: Date): boolean;
}

export interface SecurityObserver {
  readonly id: string;
  start(): Promise<void>;
  /** Fires for each observed record, already redacted and correlated. */
  onFinding(handler: (finding: Omit<FindingRecord, 'finding_id'>) => void): void;
  /**
   * Fires when a route-3 run binding is invalidated. Still no decision channel:
   * a retraction corrects the record and cannot influence execution.
   */
  onRetraction(handler: (retraction: CorrelationRetraction) => void): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry — implemented by @toros/registry
// ---------------------------------------------------------------------------

export interface CapabilityRegistry {
  register(adapter: Adapter): Promise<void>;
  /** Every capability registered on this node, regardless of any envelope. */
  list(): readonly CapabilityId[];
  get(id: CapabilityId): { readonly adapter: Adapter; readonly actionId: string } | null;
  /** Validates arguments against the action's `input_schema`. Throws `E_SCHEMA`. */
  validateArguments(id: CapabilityId, args: Readonly<Record<string, JsonValue>>): void;
  workspaces(): readonly Workspace[];
}
