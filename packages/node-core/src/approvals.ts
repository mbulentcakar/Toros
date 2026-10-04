/**
 * Operator approvals for high-impact actions (SPEC §8.1 rule 12).
 *
 * The shape of the thing matters more than the code. `approval_token` is an
 * approval REQUEST ID, not a bearer secret. Knowing the id authorises nothing —
 * the authority is the operator's decision recorded against that record, and
 * only the operator surface can record it. A secret handed back to the
 * coordinator would be a secret the coordinator can replay or keep, and this
 * gate exists precisely because the coordinator is not trusted to approve its
 * own actions.
 *
 * An approval is bound to one job, one capability and one exact set of
 * arguments; it expires; and it is spent on first use.
 *
 * It also CARRIES those arguments, in full, so the operator surface can show
 * what is actually being approved. A digest binds the decision but does not
 * inform it: with only a hash on screen, the only account of what the action
 * does comes from the coordinator that requested it, and the coordinator is the
 * untrusted party. Cryptographically the right bytes execute; practically the
 * human authorised something they never saw.
 *
 * Deliberately in memory. An approval is a human saying "yes, now" — it should
 * not outlive the process it was given to, and a restart means the operator's
 * context is gone. The AUDIT of approvals is persisted, as `approval.requested`
 * and `approval.resolved` events; this holds only the live decision, and the
 * arguments here never reach the durable log.
 */
import { randomUUID } from 'node:crypto';

import type { ApprovalBinding, ApprovalVerifier, JsonValue } from '@toros/contracts';

/** How long an operator decision stays spendable when config omits a value. */
export const APPROVAL_TTL_MINUTES = 60;
export const APPROVAL_TTL_MS = APPROVAL_TTL_MINUTES * 60 * 1000;

/** Validate the operator-file setting without silently clamping bad input. */
export function approvalTtlMinutes(value: unknown, source = 'config'): number {
  if (value === undefined) return APPROVAL_TTL_MINUTES;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error(`${source}: approval_ttl_minutes must be an integer from 1 to 1440`);
  }
  return value;
}

/**
 * Caps on live records.
 *
 * Both exist because a denied action never reaches `incrementActionsUsed`, so
 * asking for approval is free: the envelope's action budget does not bound how
 * many requests a coordinator can open.
 */
const MAX_LIVE_APPROVALS = 256;
const MAX_LIVE_APPROVALS_PER_JOB = 32;

export interface ApprovalRequest {
  readonly approval_id: string;
  readonly binding: ApprovalBinding;
  /**
   * The exact arguments the digest was taken over, for the operator to read.
   * Operator surface only — never appended to the event log.
   */
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly approved: boolean;
}

/** The ordinary tool family whose prepared invocation is retained in memory. */
export type ApprovalReplayTool =
  | 'invoke_app_action'
  | 'inspect_app'
  | 'start_cli'
  | 'send_cli'
  | 'read_cli'
  | 'interrupt_cli'
  | 'stop_cli';

/**
 * Everything the action pipeline needs to execute the request without asking
 * a model to reconstruct it. This is private Node Core state and is never
 * returned by the operator surface or written to the store.
 */
export interface ApprovalReplayAction {
  readonly tool: ApprovalReplayTool;
  readonly job_id: string;
  readonly capability: string;
  readonly action_id: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly workspace_id: string | null;
  readonly session_id: string | null;
  readonly session_adapter_id: string | null;
  readonly actor: string;
}

export interface ApprovalReplayRequest {
  readonly approval_id: string;
  readonly binding: ApprovalBinding;
  readonly action: ApprovalReplayAction;
}

export interface ApprovalRegistry extends ApprovalVerifier {
  /**
   * Record that an action is waiting on the operator, returning the id the
   * coordinator presents once it has been approved. Requesting again for the
   * same binding returns the SAME pending record rather than a second one, so a
   * coordinator that retries in a loop cannot flood the operator's queue with
   * duplicates of one decision.
   *
   * Returns null when the queue is full of decisions that may not be displaced.
   */
  request(
    binding: ApprovalBinding,
    args: Readonly<Record<string, JsonValue>>,
    action: ApprovalReplayAction,
    now: Date,
  ): ApprovalRequest | null;
  /** The record for an id, without deciding it. Null if unknown or expired. */
  find(approvalId: string, now: Date): ApprovalRequest | null;
  /** A granted exact replay record. Lookup never spends the approval. */
  replay(approvalId: string, jobId: string, now: Date): ApprovalReplayRequest | null;
  /**
   * Grant. Returns null if the id is unknown or expired, and the PREVIOUS
   * approved state so the caller can tell a fresh decision from a repeat.
   */
  approve(approvalId: string, now: Date): { readonly request: ApprovalRequest; readonly already_approved: boolean } | null;
  /** Withdraw a record entirely — used to unwind a request whose audit failed. */
  revoke(approvalId: string): void;
  /** Drop every live decision. A stopped node holds no approvals. */
  clear(): void;
  /** Everything still awaiting a decision. */
  pending(now: Date): readonly ApprovalRequest[];
}

interface ApprovalState {
  readonly approval_id: string;
  readonly binding: ApprovalBinding;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly action: ApprovalReplayAction;
  readonly requested_at: string;
  readonly expires_at_ms: number;
  approved: boolean;
  spent: boolean;
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function sameBinding(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return a.job_id === b.job_id
    && a.capability === b.capability
    && a.arguments_digest === b.arguments_digest;
}

function toRequest(state: ApprovalState): ApprovalRequest {
  return {
    approval_id: state.approval_id,
    binding: snapshot(state.binding),
    arguments: snapshot(state.arguments),
    requested_at: state.requested_at,
    expires_at: new Date(state.expires_at_ms).toISOString(),
    approved: state.approved,
  };
}

export function createApprovalRegistry(ttlMs: number = APPROVAL_TTL_MS): ApprovalRegistry {
  const byId = new Map<string, ApprovalState>();

  function sweep(now: Date): void {
    const nowMs = now.getTime();
    for (const [id, state] of byId) {
      if (state.spent || state.expires_at_ms <= nowMs) byId.delete(id);
    }
  }

  function live(nowMs: number): ApprovalState[] {
    return [...byId.values()].filter((s) => !s.spent && s.expires_at_ms > nowMs);
  }

  function findPending(binding: ApprovalBinding, nowMs: number): ApprovalState | null {
    for (const state of live(nowMs)) {
      if (sameBinding(state.binding, binding)) return state;
    }
    return null;
  }

  /**
   * Make room for one more, or report that we cannot.
   *
   * An APPROVED record is the operator's decision and is never displaced. The
   * previous version evicted the Map's oldest entry whatever its state, which
   * handed the untrusted coordinator a lever: 257 free requests with distinct
   * arguments would push out the very approval the operator had just granted,
   * or the pending one they were about to look at. Only unapproved records give
   * way, and only to make room for another request from the same pressure.
   */
  function makeRoom(jobId: string, nowMs: number): boolean {
    const all = live(nowMs);
    const forJob = all.filter((s) => s.binding.job_id === jobId);
    const evictable = (pool: ApprovalState[]): ApprovalState | undefined => pool.filter((s) => !s.approved)[0];

    if (forJob.length >= MAX_LIVE_APPROVALS_PER_JOB) {
      const victim = evictable(forJob);
      if (victim === undefined) return false;
      byId.delete(victim.approval_id);
      return true;
    }
    if (all.length >= MAX_LIVE_APPROVALS) {
      const victim = evictable(all);
      if (victim === undefined) return false;
      byId.delete(victim.approval_id);
      return true;
    }
    return true;
  }

  return {
    request(
      binding: ApprovalBinding,
      args: Readonly<Record<string, JsonValue>>,
      action: ApprovalReplayAction,
      now: Date,
    ): ApprovalRequest | null {
      sweep(now);
      const existing = findPending(binding, now.getTime());
      if (existing !== null) return toRequest(existing);
      if (!makeRoom(binding.job_id, now.getTime())) return null;
      const state: ApprovalState = {
        approval_id: randomUUID(),
        binding: snapshot(binding),
        arguments: snapshot(args),
        action: snapshot(action),
        requested_at: now.toISOString(),
        expires_at_ms: now.getTime() + ttlMs,
        approved: false,
        spent: false,
      };
      byId.set(state.approval_id, state);
      return toRequest(state);
    },

    find(approvalId: string, now: Date): ApprovalRequest | null {
      sweep(now);
      const state = byId.get(approvalId);
      return state === undefined ? null : toRequest(state);
    },

    replay(approvalId: string, jobId: string, now: Date): ApprovalReplayRequest | null {
      sweep(now);
      const state = byId.get(approvalId);
      if (state === undefined || !state.approved || state.spent || state.binding.job_id !== jobId) return null;
      return {
        approval_id: state.approval_id,
        binding: snapshot(state.binding),
        action: snapshot(state.action),
      };
    },

    approve(approvalId: string, now: Date) {
      sweep(now);
      const state = byId.get(approvalId);
      if (state === undefined) return null;
      const alreadyApproved = state.approved;
      state.approved = true;
      return { request: toRequest(state), already_approved: alreadyApproved };
    },

    revoke(approvalId: string): void {
      byId.delete(approvalId);
    },

    clear(): void {
      byId.clear();
    },

    consume(token: string, binding: ApprovalBinding, now: Date): boolean {
      const state = byId.get(token);
      if (state === undefined) return false;
      if (state.spent) return false;
      if (!state.approved) return false;
      if (state.expires_at_ms <= now.getTime()) return false;
      // The binding is re-checked at spend time rather than trusted from issue
      // time: the id travels out through the coordinator, and the whole point
      // is that presenting it for a different action must not work.
      if (!sameBinding(state.binding, binding)) return false;
      state.spent = true;
      byId.delete(token);
      return true;
    },

    pending(now: Date): readonly ApprovalRequest[] {
      sweep(now);
      return [...byId.values()].filter((state) => !state.approved).map(toRequest);
    },
  };
}
