# Spec A — `@toros/envelope`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements **SPEC §5** (job contract) and the parts of §3.7 ("stop means stop") that are pure
arithmetic over an envelope.

## Objective

Turn untrusted JSON into either a `SealedEnvelope` or a refusal, and answer the four questions
policy asks of an envelope: is it expired, is the budget spent, are retries spent, does this
action's digest match.

This unit is where the specification's central claim becomes real. §5 says "the coordinator
cannot edit the envelope"; that is true only because this unit computes a digest at creation
and later refuses anything that does not match it. Everything downstream trusts that.

## Allowed paths

```
packages/envelope/package.json
packages/envelope/tsconfig.json
packages/envelope/src/**
packages/envelope/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

## Package setup

Copy the shape of `packages/contracts/package.json` and `tsconfig.json`. Name is
`@toros/envelope`. Add `"@toros/contracts": "*"` to `dependencies`, and a project reference to
`../contracts` in `tsconfig.json` (`"references": [{ "path": "../contracts" }]`).

## Public API — frozen

Export exactly this from `src/index.ts`:

```ts
import type { JobEnvelope, SealedEnvelope } from '@toros/contracts';

/**
 * Parses and validates untrusted input. On success the envelope is sealed with
 * its digest. Throws TorosError(E_ENVELOPE_INVALID) on any validation failure.
 */
export function sealEnvelope(input: unknown): SealedEnvelope;

/**
 * Recomputes the digest of `envelope` and compares it to `expected` in constant
 * time. Throws TorosError(E_ENVELOPE_DIGEST_MISMATCH) when they differ.
 */
export function assertDigest(envelope: JobEnvelope, expected: string): void;

/** True when `now` is at or after `expires_at`. */
export function isExpired(envelope: JobEnvelope, now: Date): boolean;

/** Throws TorosError(E_EXPIRED) when expired. */
export function assertNotExpired(envelope: JobEnvelope, now: Date): void;

/** Throws TorosError(E_BUDGET_EXHAUSTED) when actionsUsed >= max_actions. */
export function assertBudget(envelope: JobEnvelope, actionsUsed: number): void;

/**
 * Throws TorosError(E_RETRIES_EXHAUSTED) when retriesUsed >= max_retries AND
 * retriesUsed > 0. `retriesUsed` counts retries already made for the current
 * action, so 0 means "first attempt", and a first attempt is not a retry — a
 * bare `>=` would make `max_retries: 0` deny every action outright.
 */
export function assertRetries(envelope: JobEnvelope, retriesUsed: number): void;

/**
 * True when `term` appears in the envelope's `forbidden` list, matched
 * case-insensitively against whole tokens. See "Forbidden matching" below.
 */
export function isForbidden(envelope: JobEnvelope, term: string): boolean;

/**
 * Validates a coordinator reply. Throws TorosError(E_PARALLEL_ACTION) when the
 * reply carries an action for a non-`act` state or more than one action.
 */
export function parseCoordinatorResponse(input: unknown): CoordinatorResponse;
```

Do not export helpers beyond these. Do not add an `options` parameter to any of them.

## Validation rules

`sealEnvelope` rejects with `E_ENVELOPE_INVALID` when any of the following holds. The
`TorosError.detail` should carry `{ field }` so the cockpit can point at the problem.

| Field | Rule |
|---|---|
| `job_id` | present, string, a valid UUID (any version) |
| `objective` | present, string, non-empty after trimming, ≤ 4096 chars |
| `allowed_capabilities` | array of strings, each matching `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`, no duplicates. **May be empty** — an envelope that permits nothing is meaningful, not malformed |
| `allowed_workspaces` | array of strings, non-empty entries, no duplicates. May be empty |
| `acceptance` | array of non-empty strings. May be empty |
| `forbidden` | array of non-empty strings, no duplicates. May be empty |
| `max_actions` | integer, `≥ 0`, `≤ 10000` |
| `max_retries` | integer, `≥ 0`, `≤ 100` |
| `expires_at` | string, a valid RFC 3339 timestamp **with an explicit offset or `Z`** |
| — | no properties beyond the nine in `JobEnvelope` |

Three of these are worth stating plainly because the obvious implementation gets them wrong:

- **Unknown properties are a rejection, not something to strip.** Silently dropping a field
  means an envelope that says something Toros did not understand is treated as though it never
  said it — and the digest would then cover a different value than the caller signed off on.
- **A naked local timestamp is a rejection.** `2026-08-02T10:00:00` has no offset, so its
  meaning depends on the reader's clock. `Date.parse` accepts it and guesses; do not.
- **`max_actions: 0` is valid** and means every action is denied. It is not a missing value.

Validate before computing the digest. Never digest a value you have not accepted.

## Digest

Use `digest()` from `@toros/contracts` on the validated envelope object. Do not build the JSON
text yourself and do not sort keys yourself — `canonicalize` already does, and doing it twice
is how the two paths drift apart.

`assertDigest` must compare with `crypto.timingSafeEqual` over the two hex strings decoded to
buffers, after checking they are the same length. A plain `===` leaks comparison time. This is
a low-value target today; it is cheap to do correctly and expensive to retrofit once other
code copies the pattern.

## Forbidden matching

`isForbidden` exists so that an envelope can say "never push" even when the capability id
itself is allowed. Match rules:

- case-insensitive;
- match on whole tokens, splitting the haystack on characters that are not `[a-z0-9]`;
- so `forbidden: ["push"]` matches `git push`, `PUSH`, and `force-push`, but **not**
  `pushover` — a substring match would deny unrelated actions and teach operators to keep the
  list short, which is the opposite of what it is for.

## Coordinator response

`parseCoordinatorResponse` enforces SPEC §5's "only one action per turn".

- `state` must be one of `act`, `ask`, `complete`, `blocked`; anything else is
  `E_ENVELOPE_INVALID`.
- `reason` must be a non-empty string.
- `state: 'act'` **requires** `action`, with `tool` a non-empty string and `arguments` a plain
  object. Missing it is `E_ENVELOPE_INVALID`.
- Any other state carrying an `action` is `E_PARALLEL_ACTION` — the model proposed an action
  while claiming it was finished or blocked.
- An `action` whose value is an **array** is `E_PARALLEL_ACTION`, not a type error. This is the
  literal shape a model produces when it tries to emit two tool calls at once, and it is one of
  the §12.5 hard-failure cases, so it must be distinguishable in the receipts.

## Acceptance tests

`packages/envelope/test/envelope.test.ts`. Name them as written; the reviewer checks coverage
against this list.

1. `seals a valid envelope and returns a 64-hex digest`
2. `rejects each missing required field with E_ENVELOPE_INVALID and names the field in detail`
3. `rejects an unknown property rather than stripping it`
4. `rejects a timestamp with no offset`
5. `accepts max_actions: 0 and then denies the first action`
6. `rejects duplicate entries in allowed_capabilities`
7. `rejects a malformed capability id`
8. `produces the same digest regardless of JSON key order`
9. `assertDigest accepts the matching digest and throws E_ENVELOPE_DIGEST_MISMATCH otherwise`
10. `assertDigest throws rather than returning false on a length mismatch`
11. `isExpired is false one second before expiry and true at the instant of expiry`
12. `assertBudget throws E_BUDGET_EXHAUSTED exactly at max_actions, not after`
13. `assertRetries throws E_RETRIES_EXHAUSTED exactly at max_retries`
13a. `assertRetries allows a first attempt when max_retries is 0`
14. `isForbidden matches whole tokens case-insensitively and does not match substrings`
15. `parseCoordinatorResponse accepts act with one action`
16. `parseCoordinatorResponse rejects complete carrying an action with E_PARALLEL_ACTION`
17. `parseCoordinatorResponse rejects an action array with E_PARALLEL_ACTION`
18. `parseCoordinatorResponse rejects an unknown state`

Boundary tests 11, 12, and 13 are the point of the list — off-by-one here means a job runs one
action past its budget, which is a policy failure, not a rounding detail.

## Verification

```
npx tsc --build packages/envelope
node --test packages/envelope/dist/test/*.test.js
```

Both must be clean, with zero skipped tests.

## Out of scope

Persistence, policy decisions, receipts, adapters, and anything that touches the filesystem or
a process. This unit is pure functions over values. If you find yourself importing `node:fs`,
stop — you are building something else.
