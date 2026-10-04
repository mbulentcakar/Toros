import type { JsonValue } from './canonical.js';

/**
 * SPEC §5. The immutable authority for a single run.
 *
 * Every field is readonly because the envelope's whole purpose is that nobody
 * downstream can adjust it. `readonly` is a compile-time guard only; the
 * runtime guarantee is the digest (SPEC §5), which is why validation returns a
 * digest alongside the parsed value.
 */
/*
 * Declared as a type alias, not an interface. TypeScript infers an implicit
 * index signature for a type alias but not for an interface, so an interface
 * here would not be assignable to `JsonValue` — and `digest(envelope)` is the
 * single most important call in the system. Making that require a cast would
 * defeat the purpose of typing the envelope at all.
 */
export type JobEnvelope = {
  /** UUID. Identifies the job for its whole life, including across relay. */
  readonly job_id: string;
  /** A bounded outcome, in prose. Not machine-interpreted. */
  readonly objective: string;
  /** Capability ids this job may invoke. Absent from this list means denied. */
  readonly allowed_capabilities: readonly string[];
  /** Workspace ids this job may touch. Absent from this list means denied. */
  readonly allowed_workspaces: readonly string[];
  /** Human-checkable acceptance criteria. Not machine-interpreted. */
  readonly acceptance: readonly string[];
  /**
   * Terms that must never appear as an action's capability or arguments —
   * "push", "deploy", "read-secrets". A belt-and-braces layer over
   * `allowed_capabilities`, not a replacement for it: the allowlist is what
   * actually decides, and this catches a capability whose id is permitted but
   * whose arguments name a forbidden operation.
   */
  readonly forbidden: readonly string[];
  /** Hard ceiling on executed actions. Reaching it ends the job. */
  readonly max_actions: number;
  /** Retries permitted per failing action, not per job. */
  readonly max_retries: number;
  /** RFC 3339 timestamp. Past it, every action is denied. */
  readonly expires_at: string;
}

/** A validated envelope paired with the digest that binds it (SPEC §5). */
export interface SealedEnvelope {
  readonly envelope: JobEnvelope;
  /** Lowercase hex SHA-256 over the canonical JSON form. */
  readonly envelope_digest: string;
}

/**
 * SPEC §5. The coordinator's structured reply. Exactly one action per turn;
 * parallel tool calls are disabled.
 *
 * `action` is present when and only when `state` is `act` — enforced at
 * validation, not merely documented, because "the model emitted two actions"
 * is one of the §12.5 hard-failure cases.
 */
export type CoordinatorResponse =
  | {
      readonly state: 'act';
      readonly reason: string;
      readonly action: CoordinatorAction;
    }
  | {
      readonly state: 'ask' | 'complete' | 'blocked';
      readonly reason: string;
      readonly action?: undefined;
    };

export interface CoordinatorAction {
  /** A registered tool name from the §6 surface. */
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

/** SPEC §7. The explicit lifecycle of a work item. */
export const WorkItemState = {
  /** Active local work. */
  WORKING: 'working',
  /** Resumable local snapshot. */
  CHECKPOINT: 'checkpoint',
  /** Capsule available for another node. */
  RELAY: 'relay',
  /** The worker claims acceptance criteria are met. Where `job_complete` stops. */
  PROPOSED: 'proposed',
  /**
   * A human or authorised independent review accepted the result. Unreachable
   * from the Hermes tool surface by construction (SPEC §6, §7).
   */
  ACCEPTED: 'accepted',
  /** Cannot continue within the envelope. */
  BLOCKED: 'blocked',
  /** Operator or policy terminated the work. */
  CANCELLED: 'cancelled',
} as const;

export type WorkItemState = (typeof WorkItemState)[keyof typeof WorkItemState];

/**
 * States from which no further action may execute (SPEC §3.7, "stop means stop").
 * `checkpoint` and `relay` are deliberately absent — both are resumable.
 */
export const TERMINAL_STATES: ReadonlySet<WorkItemState> = new Set([
  WorkItemState.PROPOSED,
  WorkItemState.ACCEPTED,
  WorkItemState.BLOCKED,
  WorkItemState.CANCELLED,
]);

export function isTerminal(state: WorkItemState): boolean {
  return TERMINAL_STATES.has(state);
}
