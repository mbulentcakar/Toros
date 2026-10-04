import type { JsonValue } from './canonical.js';
import type { ErrorCode } from './errors.js';
import type { CapabilityId } from './capability.js';

/**
 * SPEC §8.1. The deterministic verdict. Produced by the policy engine only;
 * no adapter, observer, or model may construct one.
 */
export type PolicyDecision =
  | { readonly allow: true; readonly reason: string }
  | { readonly allow: false; readonly code: ErrorCode; readonly reason: string };

/**
 * SPEC §8.3, the minimum receipt.
 *
 * The exclusions are as much of the contract as the inclusions: no raw
 * secrets, no full private transcripts. Where arguments could carry either,
 * `arguments_digest` stands in for `arguments_normalized`.
 */
export interface Receipt {
  readonly receipt_id: string;
  readonly job_id: string;
  /** Which machine executed this. Meaningful once Phase 2 adds a second node. */
  readonly node_id: string;
  /** Present for adapter session actions; null for job-level ones. */
  readonly session_id: string | null;
  /** Who proposed the action: the coordinator model id, or `operator`. */
  readonly actor: string;
  readonly capability: CapabilityId;
  /**
   * Canonicalized arguments, or null when they are withheld. Exactly one of
   * this and `arguments_digest` is null.
   */
  readonly arguments_normalized: JsonValue | null;
  /** SHA-256 over the canonical arguments, used when the arguments are withheld. */
  readonly arguments_digest: string | null;
  readonly decision: PolicyDecision;
  /** Binds the receipt to the exact envelope that authorised it (SPEC §5). */
  readonly envelope_digest: string;
  /** RFC 3339. `ended_at` is null while the action is still running. */
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: ActionOutcome;
  /** Artifact ids produced, if any. */
  readonly artifact_refs: readonly string[];
  /** Numbat finding ids correlated to this action (SPEC §8.2). Advisory only. */
  readonly finding_refs: readonly string[];
  /**
   * Adapter-specific audit values, restricted by the adapter manifest's
   * `receipt_fields`. Node Core rejects undeclared keys before persisting
   * them, so this cannot become an arbitrary transcript or secret channel.
   */
  readonly adapter_fields: Readonly<Record<string, JsonValue>>;
}

export type ActionOutcome =
  /** Policy allowed it and the adapter completed it. */
  | 'succeeded'
  /** Policy denied it. The adapter was never reached. */
  | 'denied'
  /** Policy allowed it and the adapter failed. */
  | 'failed'
  /** Terminated by timeout, output limit, or cancellation. */
  | 'terminated'
  /** Allowed, started, not yet finished. */
  | 'running';

/**
 * SPEC §8.1. One row of the append-only log. `hash` and `prev_hash` make
 * "append-only" verifiable rather than merely intended.
 */
export interface EventRow {
  /** Monotonic within a node. Assigned by the store, never by a caller. */
  readonly seq: number;
  readonly node_id: string;
  readonly job_id: string | null;
  readonly kind: EventKind;
  /** RFC 3339, when the event was recorded. */
  readonly recorded_at: string;
  /** The hashed body. Must contain no secrets and no raw transcript. */
  readonly payload: JsonValue;
  /** `hash` of the previous row for this node, or GENESIS_HASH. */
  readonly prev_hash: string;
  /** `SHA-256(prev_hash || canonical_json(payload))`. */
  readonly hash: string;
}

/**
 * The four points SPEC §8.1 requires a receipt for — request, decision,
 * execution, result — plus the lifecycle events the cockpit renders.
 */
export type EventKind =
  | 'job.created'
  | 'job.state_changed'
  | 'action.requested'
  | 'action.decided'
  | 'action.started'
  | 'action.finished'
  | 'session.started'
  | 'session.stopped'
  | 'checkpoint.created'
  | 'relay.created'
  | 'relay.imported'
  | 'approval.requested'
  | 'approval.resolved'
  | 'finding.observed'
  | 'pipeline.created'
  | 'pipeline.stage_changed'
  | 'pipeline.state_changed'
  /**
   * A previously recorded correlation is withdrawn (SPEC §8.2). Appended, never
   * an edit: the log shows both what was believed and when it was retracted,
   * and the payload cites the finding whose attribution is being withdrawn.
   */
  | 'finding.correlation_retracted';

/**
 * SPEC §8.1. The anchor, stored outside the event table and updated in the
 * same transaction as each append.
 *
 * Without it, truncating the tail of the log leaves a shorter but internally
 * consistent chain that verification would accept. `row_count` is what makes
 * the truncation visible.
 */
export interface ChainHead {
  readonly node_id: string;
  /** `hash` of the most recent row, or GENESIS_HASH when the log is empty. */
  readonly head_hash: string;
  readonly row_count: number;
  readonly updated_at: string;
}

/** The result of walking the chain (SPEC §8.1). */
export interface ChainVerification {
  readonly ok: boolean;
  readonly rows_checked: number;
  /** The first row that failed, or null when the chain is intact. */
  readonly broken_at_seq: number | null;
  /**
   * Whether the recomputed head and row count match the stored anchor. False
   * with `broken_at_seq === null` is the truncation signature: every surviving
   * row links correctly, but rows are missing from the end.
   */
  readonly anchor_matches: boolean;
  readonly reason: string | null;
}
