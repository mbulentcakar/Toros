/**
 * @toros/envelope — Parse untrusted JSON into a SealedEnvelope, and answer the
 * four questions policy asks of an envelope.
 *
 * This is where SPEC §5's central claim becomes real: "the coordinator cannot
 * edit the envelope" is true only because this unit computes a digest at
 * creation and later refuses anything that does not match it. Everything
 * downstream trusts that.
 *
 * Every function is pure; no I/O, no state, no policy decisions.
 */

import { timingSafeEqual } from 'node:crypto';

import {
  type JsonValue,
  type JobEnvelope,
  type SealedEnvelope,
  type CoordinatorResponse,
  type CoordinatorAction,
  digest,
  ErrorCode,
  TorosError,
} from '@toros/contracts';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 3339 with an explicit offset or Z. Date.parse accepts bare local
 * timestamps and guesses; this pattern rejects them.
 *
 * Matches: 2026-08-02T10:00:00Z, 2026-08-02T10:00:00+05:30, 2026-08-02T10:00:00.123-00:00
 * Rejects: 2026-08-02T10:00:00 (no offset), 2026-08-02 (date only)
 */
const RFC3339_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The same grammar as RFC3339_OFFSET_PATTERN, with the components captured. */
const RFC3339_PARTS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * True when the supplied timestamp names the same calendar instant it parses
 * to — that is, nothing was normalised away.
 *
 * Renders the parsed value back to the caller's own wall clock, using the
 * offset the caller stated, and compares each component. `2026-02-30` parses to
 * 2 March, whose day-of-month is 2 rather than 30, so it is refused.
 */
function roundTripsExactly(text: string, parsedMs: number): boolean {
  const parts = RFC3339_PARTS_PATTERN.exec(text);
  if (parts === null) return false;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = parts;

  let shiftMinutes = 0;
  if (sign !== undefined && offsetHours !== undefined && offsetMinutes !== undefined) {
    shiftMinutes = (Number(offsetHours) * 60 + Number(offsetMinutes)) * (sign === '-' ? -1 : 1);
  }
  const wall = new Date(parsedMs + shiftMinutes * 60_000);

  return (
    wall.getUTCFullYear() === Number(year) &&
    wall.getUTCMonth() + 1 === Number(month) &&
    wall.getUTCDate() === Number(day) &&
    wall.getUTCHours() === Number(hour) &&
    wall.getUTCMinutes() === Number(minute) &&
    wall.getUTCSeconds() === Number(second)
  );
}

/**
 * The nine allowed field names from JobEnvelope.
 * Used to reject unknown properties.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'job_id',
  'objective',
  'allowed_capabilities',
  'allowed_workspaces',
  'acceptance',
  'forbidden',
  'max_actions',
  'max_retries',
  'expires_at',
]);

// ---------------------------------------------------------------------------
// sealEnvelope
// ---------------------------------------------------------------------------

/**
 * Parses and validates untrusted input. On success the envelope is sealed with
 * its digest.
 *
 * Validation order: reject unknown props first, then check each field. The
 * digest is computed only after every rule passes.
 */
export function sealEnvelope(input: unknown): SealedEnvelope {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'Input must be a non-null object', { field: '$' });
  }

  const record = input as Record<string, unknown>;

  // --- Reject unknown properties ---
  // Silently dropping a field means an envelope that says something Toros did
  // not understand is treated as though it never said it — and the digest
  // would then cover a different value than the caller signed off on.
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `Unknown property: ${key}`, { field: key });
    }
  }

  // --- job_id ---
  const job_id = record['job_id'];
  if (typeof job_id !== 'string') {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'job_id must be a string', { field: 'job_id' });
  }
  if (!UUID_PATTERN.test(job_id)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'job_id must be a valid UUID', { field: 'job_id' });
  }

  // --- objective ---
  const objective = record['objective'];
  if (typeof objective !== 'string') {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'objective must be a string', { field: 'objective' });
  }
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'objective must be non-empty after trimming', { field: 'objective' });
  }
  if (trimmed.length > 4096) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'objective must be ≤ 4096 characters', { field: 'objective' });
  }

  // --- allowed_capabilities ---
  const allowed_capabilities = record['allowed_capabilities'];
  if (!Array.isArray(allowed_capabilities)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'allowed_capabilities must be an array', { field: 'allowed_capabilities' });
  }
  const capSet = new Set<string>();
  for (let i = 0; i < allowed_capabilities.length; i++) {
    const cap = allowed_capabilities[i];
    if (typeof cap !== 'string') {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_capabilities[${i}] must be a string`, { field: 'allowed_capabilities' });
    }
    if (!CAPABILITY_ID_PATTERN.test(cap)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_capabilities[${i}] is malformed: ${cap}`, { field: 'allowed_capabilities' });
    }
    if (capSet.has(cap)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_capabilities contains duplicate: ${cap}`, { field: 'allowed_capabilities' });
    }
    capSet.add(cap);
  }

  // --- allowed_workspaces ---
  const allowed_workspaces = record['allowed_workspaces'];
  if (!Array.isArray(allowed_workspaces)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'allowed_workspaces must be an array', { field: 'allowed_workspaces' });
  }
  const wsSet = new Set<string>();
  for (let i = 0; i < allowed_workspaces.length; i++) {
    const ws = allowed_workspaces[i];
    if (typeof ws !== 'string' || ws.length === 0) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_workspaces[${i}] must be a non-empty string`, { field: 'allowed_workspaces' });
    }
    if (wsSet.has(ws)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_workspaces contains duplicate: ${ws}`, { field: 'allowed_workspaces' });
    }
    wsSet.add(ws);
  }

  // --- acceptance ---
  const acceptance = record['acceptance'];
  if (!Array.isArray(acceptance)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'acceptance must be an array', { field: 'acceptance' });
  }
  for (let i = 0; i < acceptance.length; i++) {
    if (typeof acceptance[i] !== 'string' || acceptance[i].length === 0) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `acceptance[${i}] must be a non-empty string`, { field: 'acceptance' });
    }
  }

  // --- forbidden ---
  const forbidden = record['forbidden'];
  if (!Array.isArray(forbidden)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'forbidden must be an array', { field: 'forbidden' });
  }
  const forbidSet = new Set<string>();
  for (let i = 0; i < forbidden.length; i++) {
    const term = forbidden[i];
    if (typeof term !== 'string' || term.length === 0) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `forbidden[${i}] must be a non-empty string`, { field: 'forbidden' });
    }
    if (forbidSet.has(term)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `forbidden contains duplicate: ${term}`, { field: 'forbidden' });
    }
    forbidSet.add(term);
  }

  // --- max_actions ---
  const max_actions = record['max_actions'];
  if (typeof max_actions !== 'number' || !Number.isInteger(max_actions) || max_actions < 0 || max_actions > 10000) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'max_actions must be an integer between 0 and 10000', { field: 'max_actions' });
  }

  // --- max_retries ---
  const max_retries = record['max_retries'];
  if (typeof max_retries !== 'number' || !Number.isInteger(max_retries) || max_retries < 0 || max_retries > 100) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'max_retries must be an integer between 0 and 100', { field: 'max_retries' });
  }

  // --- expires_at ---
  const expires_at = record['expires_at'];
  if (typeof expires_at !== 'string') {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'expires_at must be a string', { field: 'expires_at' });
  }
  if (!RFC3339_OFFSET_PATTERN.test(expires_at)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'expires_at must be RFC 3339 with explicit offset or Z', { field: 'expires_at' });
  }
  // The regex catches shape, not validity — and `Date.parse` is not the remedy,
  // because it NORMALISES rather than rejects. `2026-02-30T00:00:00Z` comes back
  // as 2 March and `2026-01-01T24:00:00Z` as the next day, both without error.
  //
  // That is a policy problem rather than a formatting one: an envelope whose
  // expiry silently means a different instant than it says makes
  // `assertNotExpired` answer about a moment the operator never wrote.
  const parsedMs = Date.parse(expires_at);
  if (Number.isNaN(parsedMs)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'expires_at must be a valid date', { field: 'expires_at' });
  }
  if (!roundTripsExactly(expires_at, parsedMs)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'expires_at is not a real calendar instant', { field: 'expires_at' });
  }

  // Build the validated envelope (mutable arrays for JsonValue compatibility).
  const envelope: JobEnvelope = {
    job_id,
    objective,
    allowed_capabilities: [...allowed_capabilities] as readonly string[],
    allowed_workspaces: [...allowed_workspaces] as readonly string[],
    acceptance: [...acceptance] as readonly string[],
    forbidden: [...forbidden] as readonly string[],
    max_actions,
    max_retries,
    expires_at,
  };

  // Compute the digest after validation. Never digest a value not accepted.
  const envelope_digest = computeDigest(envelope);

  return { envelope, envelope_digest };
}

// ---------------------------------------------------------------------------
// Digest helpers
// ---------------------------------------------------------------------------

/**
 * Build a plain JsonValue from a JobEnvelope so that `digest()` from contracts
 * receives a shape it can accept without readonly-vs-mutable type friction.
 */
function computeDigest(envelope: JobEnvelope): string {
  const value: JsonValue = {
    job_id: envelope.job_id,
    objective: envelope.objective,
    allowed_capabilities: [...envelope.allowed_capabilities],
    allowed_workspaces: [...envelope.allowed_workspaces],
    acceptance: [...envelope.acceptance],
    forbidden: [...envelope.forbidden],
    max_actions: envelope.max_actions,
    max_retries: envelope.max_retries,
    expires_at: envelope.expires_at,
  };
  return digest(value);
}

// ---------------------------------------------------------------------------
// assertDigest
// ---------------------------------------------------------------------------

/**
 * Recomputes the digest of `envelope` and compares it to `expected` in
 * constant time. A plain `===` would leak comparison time; timingSafeEqual
 * is the correct primitive even though this is a low-value target today.
 *
 * Throws E_ENVELOPE_DIGEST_MISMATCH when they differ.
 */
export function assertDigest(envelope: JobEnvelope, expected: string): void {
  const actual = computeDigest(envelope);

  if (actual.length !== expected.length) {
    throw new TorosError(
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
      'Digest length mismatch',
      { expected_length: expected.length, actual_length: actual.length },
    );
  }

  const actualBuf = Buffer.from(actual, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new TorosError(
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
      'Digest mismatch',
      {},
    );
  }
}

// ---------------------------------------------------------------------------
// isExpired / assertNotExpired
// ---------------------------------------------------------------------------

/** True when `now` is at or after `expires_at`. */
export function isExpired(envelope: JobEnvelope, now: Date): boolean {
  return now.getTime() >= new Date(envelope.expires_at).getTime();
}

/** Throws E_EXPIRED when expired. */
export function assertNotExpired(envelope: JobEnvelope, now: Date): void {
  if (isExpired(envelope, now)) {
    throw new TorosError(
      ErrorCode.E_EXPIRED,
      'Envelope has expired',
      { expires_at: envelope.expires_at, now: now.toISOString() },
    );
  }
}

// ---------------------------------------------------------------------------
// assertBudget / assertRetries
// ---------------------------------------------------------------------------

/**
 * Throws E_BUDGET_EXHAUSTED exactly at max_actions — the check is
 * `actionsUsed >= max_actions`, so the Nth action that would reach the
 * ceiling is denied rather than being the one that goes past it.
 */
export function assertBudget(envelope: JobEnvelope, actionsUsed: number): void {
  if (actionsUsed >= envelope.max_actions) {
    throw new TorosError(
      ErrorCode.E_BUDGET_EXHAUSTED,
      'Action budget exhausted',
      { max_actions: envelope.max_actions, actions_used: actionsUsed },
    );
  }
}

/**
 * Throws E_RETRIES_EXHAUSTED at max_retries — but never on a first attempt.
 *
 * `retriesUsed` counts retries already made for the current action, so zero
 * means "this is the first attempt", and a first attempt is not a retry. The
 * bare `retriesUsed >= max_retries` this originally used made
 * `max_retries: 0` — a perfectly ordinary envelope meaning "do not retry" —
 * deny *every* action outright, including the first, before the capability
 * allowlist was ever consulted. That surfaced during Node Core integration as
 * a denied action reporting E_RETRIES_EXHAUSTED where E_CAP_NOT_ALLOWED was
 * expected.
 *
 * Contrast `assertBudget`, where the bare `>=` is right: `actionsUsed` counts
 * actions already spent, and the first action has spent none.
 */
export function assertRetries(envelope: JobEnvelope, retriesUsed: number): void {
  if (retriesUsed > 0 && retriesUsed >= envelope.max_retries) {
    throw new TorosError(
      ErrorCode.E_RETRIES_EXHAUSTED,
      'Retry budget exhausted',
      { max_retries: envelope.max_retries, retries_used: retriesUsed },
    );
  }
}

// ---------------------------------------------------------------------------
// isForbidden
// ---------------------------------------------------------------------------

/**
 * True when `term` appears in the envelope's `forbidden` list, matched
 * case-insensitively against whole tokens.
 *
 * The haystack (term) is split on characters that are not [a-z0-9]. Each token
 * is lowercased and compared against each forbidden entry (also lowered). This
 * means `forbidden: ["push"]` matches `git push`, `PUSH`, and `force-push`,
 * but NOT `pushover` — a substring match would deny unrelated actions and
 * teach operators to keep the list short, which is the opposite of what it
 * is for.
 */
export function isForbidden(envelope: JobEnvelope, term: string): boolean {
  if (envelope.forbidden.length === 0) return false;

  // Split the term on characters that are not [a-z0-9].
  const tokens = term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  for (const forbidden of envelope.forbidden) {
    const lowered = forbidden.toLowerCase();
    for (const token of tokens) {
      if (token === lowered) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// parseCoordinatorResponse
// ---------------------------------------------------------------------------

/**
 * Validates a coordinator reply per SPEC §5.
 *
 * - state must be one of `act`, `ask`, `complete`, `blocked`
 * - reason must be a non-empty string
 * - state: 'act' requires action with tool (non-empty string) and arguments (plain object)
 * - Any other state carrying an action is E_PARALLEL_ACTION
 * - An action whose value is an array is E_PARALLEL_ACTION
 */
export function parseCoordinatorResponse(input: unknown): CoordinatorResponse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'Response must be a non-null object', { field: '$' });
  }

  const record = input as Record<string, unknown>;

  // --- state ---
  const raw_state = record['state'];
  if (raw_state !== 'act' && raw_state !== 'ask' && raw_state !== 'complete' && raw_state !== 'blocked') {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'state must be one of: act, ask, complete, blocked', { field: 'state' });
  }
  // raw_state is now 'act' | 'ask' | 'complete' | 'blocked'
  const state = raw_state;

  // --- reason ---
  const reason = record['reason'];
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'reason must be a non-empty string', { field: 'reason' });
  }

  // --- action ---
  const action = record['action'];

  if (state === 'act') {
    if (action === undefined || action === null) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'act state requires an action', { field: 'action' });
    }
    if (Array.isArray(action)) {
      throw new TorosError(ErrorCode.E_PARALLEL_ACTION, 'action must be a single object, not an array', { field: 'action' });
    }
    if (typeof action !== 'object') {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'action must be an object', { field: 'action' });
    }

    const actRecord = action as Record<string, unknown>;
    const tool = actRecord['tool'];
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'action.tool must be a non-empty string', { field: 'action.tool' });
    }

    const args = actRecord['arguments'];
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'action.arguments must be a plain object', { field: 'action.arguments' });
    }

    const coordinatorAction: CoordinatorAction = {
      tool,
      arguments: args as Readonly<Record<string, JsonValue>>,
    };

    return { state, reason, action: coordinatorAction };
  }

  // Non-act state: action is not allowed.
  if (action !== undefined && action !== null) {
    if (Array.isArray(action)) {
      throw new TorosError(ErrorCode.E_PARALLEL_ACTION, 'Non-act state must not carry an action array', { field: 'action' });
    }
    throw new TorosError(ErrorCode.E_PARALLEL_ACTION, 'Non-act state must not carry an action', { field: 'action' });
  }

  return { state, reason };
}