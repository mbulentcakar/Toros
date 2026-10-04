# AI — Run outcome protocol and shared utilities

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Three pieces of duplicated knowledge, each a drift risk reviews keep paying
for:

1. **Exit codes as the run-outcome API.** The coordinator signals its end
   state by process exit code (0/3/4/5/6/7) and the supervisor maps the
   numbers back with inline magic (`code === 3 ? 'waiting_for_input' : …`).
   The NDJSON `done` record already carries the outcome in words.
2. **Two identical truncation functions.** `bounded()` in the supervisor and
   `boundedTurn()` in the coordinator are the same binary-search UTF-8
   truncation with the same surrogate-pair backoff, maintained twice.
3. **Two CLI-lifecycle-bundle implementations.** Node Core completes/asserts
   the start/send/read/stop bundle; HermesChat re-implements the same rule to
   warn in the proposal card. An acknowledged mirror — and a rule that will
   drift the first time only one side changes.

## The change

**1. The `done` record becomes the outcome authority.** The supervisor parses
the child's final stdout line; a well-formed `done` record's `outcome` (the
existing nine-member union, moved to `@toros/contracts` as `RunOutcome`)
determines the run's recorded state. Exit codes remain — as the *fallback*
when the process dies without a `done` (crash, kill, spawn error) and as a
cross-check: a `done` that contradicts the exit code is recorded with the
`done` outcome plus a `system` message noting the mismatch. The exit-code map
itself moves to contracts as named constants; no magic numbers remain at
either end.

The `ask` path today exits 3 with no `done` by design ("an ask is not an
outcome"). That stays: absence of `done` plus exit 3 is the defined
waiting-for-input signal, now stated once in contracts beside the constants.

**2. One truncation function.** `boundedUtf8(text, limitBytes, marker)` in
`@toros/contracts`; both call sites import it with their own limits and
markers. Property test: output byte length ≤ limit, output is valid UTF-8
(no lone surrogates), and text under the limit is returned identical.

**3. One lifecycle-bundle module.** The family/completion/assertion logic
moves to `@toros/contracts`; Node Core imports it; the cockpit adds a
dependency on `@toros/contracts` and imports the same functions. Contracts is
pure and zero-runtime-dependency, so this widens nothing — the cockpit
already mirrors contracts *types* by hand in `types.ts`; this is the first
step of retiring that mirror.

## Non-goals

- No change to the NDJSON channel vocabulary (`say`/`ask`/`act`/`done`), to
  when `done` is written, or to the one-`done`-per-ended-run invariant.
- No wholesale replacement of `apps/cockpit/src/types.ts` — only the
  lifecycle rule moves now; retiring the rest of the mirror is future work.

## Acceptance

1. A run ending in each of the nine outcomes records the state named by its
   `done` line; a child killed before writing `done` records the exit-code
   fallback. Both paths tested at the supervisor.
2. A fabricated mismatch (exit 0, `done.outcome: "error"`) records `error`
   and appends the mismatch note.
3. `grep -rn 'code === [0-9]'` over supervisor and coordinator returns
   nothing; both import the contracts constants.
4. One truncation implementation remains; the property test passes; both
   former call sites' existing tests pass unchanged.
5. The lifecycle rule exists once; Node Core and cockpit tests both exercise
   it through the shared import; the proposal-card warning behaves as before.
