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
  type AppRule,
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

/** Lower-case hex SHA-256, exactly 64 characters. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Absolute path, as the envelope requires for an `image_path` rule. Accepts a
 * drive-qualified Windows path (`C:\…`, `C:/…`), a UNC path (`\\…`, `//…`), or
 * a POSIX root (`/…`). A bare `notepad.exe` or `.\foo` is relative and refused.
 *
 * Strict rather than liberal on purpose: a rule that names a relative path
 * could be satisfied by different files depending on the process working
 * directory, which is exactly the drift the allowlist exists to prevent.
 */
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/;

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
  'allowed_apps',
]);

// ---------------------------------------------------------------------------
// sealEnvelope
// ---------------------------------------------------------------------------

/**
 * Validate one `allowed_apps` rule (amendment A8). Each rule must be exactly one
 * of the three `AppRule` shapes — no fewer keys, no extra keys, no unknown keys
 * — because a rule that names two shapes at once is ambiguous and would let one
 * envelope authorise with a weaker shape than its author intended.
 */
function validateAppRule(value: unknown, index: number): AppRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}] must be an object`, { field: 'allowed_apps' });
  }
  const rule = value as Record<string, unknown>;

  for (const key of Object.keys(rule)) {
    if (key !== 'image_sha256' && key !== 'signer' && key !== 'product_name' && key !== 'image_path') {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}] unknown property: ${key}`, { field: 'allowed_apps' });
    }
  }

  const hasSha = 'image_sha256' in rule;
  const hasSigner = 'signer' in rule;
  const hasProduct = 'product_name' in rule;
  const hasPath = 'image_path' in rule;

  if (hasSha) {
    if (hasSigner || hasProduct || hasPath) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}] must have exactly one rule shape`, { field: 'allowed_apps' });
    }
    const sha = rule['image_sha256'];
    if (typeof sha !== 'string' || !SHA256_PATTERN.test(sha)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}].image_sha256 must be 64 lower-case hex characters`, { field: 'allowed_apps' });
    }
    return { image_sha256: sha };
  }

  if (hasSigner || hasProduct) {
    if (!hasSigner || !hasProduct || hasPath) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}] signer and product_name must appear together`, { field: 'allowed_apps' });
    }
    const signer = rule['signer'];
    const product = rule['product_name'];
    if (typeof signer !== 'string' || signer.length === 0 || signer.length > 512) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}].signer must be a non-empty string ≤ 512 characters`, { field: 'allowed_apps' });
    }
    if (typeof product !== 'string' || product.length === 0 || product.length > 512) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}].product_name must be a non-empty string ≤ 512 characters`, { field: 'allowed_apps' });
    }
    return { signer, product_name: product };
  }

  if (hasPath) {
    const p = rule['image_path'];
    if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}].image_path must be a non-empty string ≤ 512 characters`, { field: 'allowed_apps' });
    }
    if (!ABSOLUTE_PATH_PATTERN.test(p)) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}].image_path must be absolute`, { field: 'allowed_apps' });
    }
    return { image_path: p };
  }

  throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `allowed_apps[${index}] must have exactly one rule shape`, { field: 'allowed_apps' });
}

/**
 * Validate the optional `allowed_apps` field, returning undefined when absent
 * so the digest omits it entirely (an envelope without the field must seal to
 * the same digest it always did). Returns the rules as a frozen array.
 */
function validateAllowedApps(value: unknown): readonly AppRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, 'allowed_apps must be an array', { field: 'allowed_apps' });
  }
  const rules = value.map((rule, index) => validateAppRule(rule, index));
  return Object.freeze(rules);
}

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
    // A term such as `"--"` produces no alphanumeric word, so it could never
    // match a candidate (see `isForbidden`). Refuse it at seal time rather than
    // let an operator write a forbidden term that is silently inert.
    if (tokenize(term).length === 0) {
      throw new TorosError(ErrorCode.E_ENVELOPE_INVALID, `forbidden[${i}] must contain at least one alphanumeric word`, { field: 'forbidden' });
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

  // --- allowed_apps (optional, amendment A8) ---
  const allowed_apps = validateAllowedApps(record['allowed_apps']);

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
    ...(allowed_apps === undefined ? {} : { allowed_apps }),
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
  const base = {
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
  // `allowed_apps` participates in the digest only when present, so an envelope
  // without it seals to exactly the digest it did before amendment A8.
  const value: JsonValue = envelope.allowed_apps === undefined
    ? base
    : { ...base, allowed_apps: envelope.allowed_apps.map((rule) => ({ ...rule })) };
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
 * Split `text` into lower-case alphanumeric words: lower-case it, split on runs
 * of characters that are not `[a-z0-9]`, and drop empty tokens. Both the
 * forbidden term and the candidate it is matched against go through this, so a
 * term and candidate spelled with different separators still agree
 * (`desktop.inspect`, `desktop_inspect`, and `desktop inspect` all tokenise to
 * `['desktop', 'inspect']`).
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when `needle`'s words appear as a contiguous run in `haystack`'s words.
 */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * True when any forbidden term's words appear as a contiguous run in `term`'s
 * words, case-insensitively (RR-01, token-sequence matching).
 *
 * The old behaviour lower-cased each forbidden entry whole and compared it
 * against each single token of the candidate, so a multi-word term
 * (`powershell.exe`, `Microsoft Windows`) never matched — `microsoft windows`
 * is not one token. Matching on token sequences fixes that while keeping a
 * single-word term exactly as before and still refusing substrings: `deploy`
 * does not match `redeploy`, and `power` does not match `powershell`.
 */
export function isForbidden(envelope: JobEnvelope, term: string): boolean {
  if (envelope.forbidden.length === 0) return false;

  const candidateTokens = tokenize(term);

  for (const forbidden of envelope.forbidden) {
    // A sealed envelope refuses zero-token entries, but `isForbidden` also runs
    // against hand-built envelopes in tests; an empty term list is simply inert.
    if (containsRun(candidateTokens, tokenize(forbidden))) return true;
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