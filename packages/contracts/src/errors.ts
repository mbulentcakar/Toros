/**
 * Error codes are part of the frozen contract. Node Core's deny path is
 * observable through these values, the cockpit renders them, and the bakeoff
 * harness asserts on them — so a code is an API, not a log string.
 *
 * Add codes by amending the contract deliberately. Never repurpose one.
 */
export const ErrorCode = {
  /** The envelope failed schema validation, or a required field is absent. */
  E_ENVELOPE_INVALID: 'E_ENVELOPE_INVALID',
  /**
   * The action's `envelope_digest` does not match the digest stored for the
   * job (SPEC §5). Distinct from E_ENVELOPE_INVALID: the envelope parsed, but
   * it is not the envelope this job was authorised under.
   */
  E_ENVELOPE_DIGEST_MISMATCH: 'E_ENVELOPE_DIGEST_MISMATCH',
  /** The capability is not in `allowed_capabilities`. */
  E_CAP_NOT_ALLOWED: 'E_CAP_NOT_ALLOWED',
  /** The capability is not registered on this node at all. */
  E_NOT_REGISTERED: 'E_NOT_REGISTERED',
  /** The workspace is not in `allowed_workspaces`. */
  E_WORKSPACE_DENIED: 'E_WORKSPACE_DENIED',
  /**
   * A path resolved outside its workspace root. Raised after symlink and
   * junction resolution, never on the literal string.
   */
  E_PATH_ESCAPE: 'E_PATH_ESCAPE',
  /** `expires_at` has passed. */
  E_EXPIRED: 'E_EXPIRED',
  /** `max_actions` is exhausted. */
  E_BUDGET_EXHAUSTED: 'E_BUDGET_EXHAUSTED',
  /** `max_retries` is exhausted for this action. */
  E_RETRIES_EXHAUSTED: 'E_RETRIES_EXHAUSTED',
  /** Action arguments failed the capability's action schema. */
  E_SCHEMA: 'E_SCHEMA',
  /** The action named a term in the envelope's `forbidden` list. */
  E_FORBIDDEN: 'E_FORBIDDEN',
  /** The process exceeded its timeout and was terminated. */
  E_TIMEOUT: 'E_TIMEOUT',
  /** The process exceeded its output limit and was terminated. */
  E_OUTPUT_LIMIT: 'E_OUTPUT_LIMIT',
  /** The operator or policy cancelled the run. */
  E_CANCELLED: 'E_CANCELLED',
  /** Secret-pattern scanning matched; relay capsule creation refused. */
  E_SECRET_DETECTED: 'E_SECRET_DETECTED',
  /** A configured high-impact action needs human approval that has not been given. */
  E_APPROVAL_REQUIRED: 'E_APPROVAL_REQUIRED',
  /**
   * An approval was presented but does not authorise this action: unknown,
   * expired, already spent, still awaiting the operator, or issued for
   * different arguments.
   *
   * Distinct from `E_APPROVAL_REQUIRED` on purpose. That one is the gate doing
   * its job on a caller that has not asked yet; this one is a caller presenting
   * something that does not hold, which is the shape a bypass attempt takes and
   * should be legible as such in the log.
   */
  E_APPROVAL_INVALID: 'E_APPROVAL_INVALID',
  /**
   * A run credential was unknown, revoked, or issued to a run that has ended.
   *
   * Distinct from a schema error: presenting a token that names no live run is
   * how an attempt to read another run's conversation appears, and it should
   * read that way in the log rather than as a malformed request.
   */
  E_RUN_INVALID: 'E_RUN_INVALID',
  /**
   * The run's mode does not permit this tool. An advisory run can talk and
   * propose; it cannot touch the machine.
   *
   * The refusal is Node Core's, not the prompt's. A system prompt that says
   * "you may only propose" is a request; this is the answer to a coordinator
   * that asked anyway.
   *
   * Amendment A11 (spec AT): the agent surface is a mode too. It permits only
   * `desktop.state`, `desktop.inspect` and `machine.inventory`, and `desktop.*`
   * only while `desktop_control.ar_gate_cleared` is set; anything else is
   * refused with this code.
   */
  E_MODE_DENIED: 'E_MODE_DENIED',
  /**
   * Amendment A11 (spec AT): an agent call has no live grant, its grant was
   * revoked, or a grant cannot be issued for this job (no discovery capability,
   * or not exactly one workspace).
   *
   * Distinct from `E_RUN_INVALID`, which is a coordinator run credential, and
   * from `E_CAP_NOT_ALLOWED`, which means the capability is not in the
   * envelope's `allowed_capabilities`.
   */
  E_GRANT_INVALID: 'E_GRANT_INVALID',
  /** The coordinator emitted more than one action in a turn (SPEC §5). */
  E_PARALLEL_ACTION: 'E_PARALLEL_ACTION',
  /** An action arrived for a job in a terminal state (SPEC §3.7, "stop means stop"). */
  E_JOB_TERMINAL: 'E_JOB_TERMINAL',
  /** The event log's hash chain failed verification. */
  E_CHAIN_BROKEN: 'E_CHAIN_BROKEN',
  /** The session id is unknown, or belongs to a different job. */
  E_SESSION_UNKNOWN: 'E_SESSION_UNKNOWN',
  /** An adapter failed in a way that is not the caller's fault. */
  E_ADAPTER_FAILURE: 'E_ADAPTER_FAILURE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_CODE_VALUES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_VALUES.has(value);
}

/**
 * The single error type crossing package boundaries. Carrying the code
 * separately from the message keeps deny reasons machine-checkable: tests and
 * the bakeoff assert on `code`, humans read `message`.
 */
export class TorosError extends Error {
  readonly code: ErrorCode;
  /** Structured context. Must never contain secrets or raw transcripts. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TorosError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}
