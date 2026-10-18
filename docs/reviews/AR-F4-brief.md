# AR-F4 — action pipeline integrity: receipts, Core-level timeout, probe wrapper (implementation brief)

**Read `docs/specs/00-CONTRACTS.md` first.** `packages/contracts` is frozen and untouched here.

**Lane:** implementer from the deputy pool (sandboxed `deputize`); code review by Codex; the native
re-review after F1–F4 by a third lineage. The implementer is never the reviewer.

## Goal

1. Budget is never spent on an action that cannot start.
2. Every receipt that reaches `running` is always closed.
3. Node Core itself enforces each action's timeout and cancellation.
4. The desktop probe wrapper honours an already-aborted signal, bounds its output, and finishes
   its cleanup before returning.

## Why

- **AR-06 (Medium):** `packages/node-core/src/action-pipeline.ts` calls
  `store.incrementActionsUsed`, appends `action.started` and writes a `running` receipt, and
  **then** looks up the workspace. A missing workspace throws `E_WORKSPACE_DENIED` outside the
  adapter `try`/`catch`. Budget is spent, and the receipt stays `running` forever with no
  `ended_at` and no `action.finished`.
- **AR-07 (Medium):** the pipeline gives the adapter `new AbortController().signal`, which nothing
  ever aborts, and it does not race `adapter.invoke` against the declared timeout. In
  `packages/adapters-desktop/src/probe.ts`, `runPowerShell` registers an abort listener without
  first checking `signal.aborted`. The review showed a pre-aborted probe still returning data.
  Its cleanup (`fsPromises.rm`) is fire-and-forget with errors swallowed, and `maxBuffer` is
  64 MiB with no limit on the output file.

Both findings are `AS-inherited`: spec AS (PR mbulentcakar/Toros#1) runs through this pipeline.

## In scope

- `packages/node-core/src/action-pipeline.ts`.
- `packages/adapters-desktop/src/probe.ts`: **the TypeScript `runPowerShell` function only.** The
  embedded PowerShell script and the raw types belong to F2; do not edit them.
- `packages/node-core/test/**` and `packages/adapters-desktop/test/**`: new and updated tests.

## Out of scope

- The PowerShell script string, `adapter.ts` in adapters-desktop, and name or identity handling
  (F2, F3).
- `packages/adapters-machine/**` (AR-08 is F5).
- `packages/contracts/**`, `packages/policy/**`, the HTTP layer, `apps/**`.

## Required behaviour

**Pipeline (`action-pipeline.ts`)**

1. Resolve the workspace (and anything else that can fail before the adapter runs) **before**
   `incrementActionsUsed` and before `action.started`. If it fails, no budget is spent. The
   receipt is written once with `ended_at` set and outcome `failed`, `action.finished` records
   the error code, and the error is thrown with its existing code (`E_WORKSPACE_DENIED`).
2. After `action.started`, **every** exit path closes the receipt: success, adapter error,
   timeout, cancellation, and an exception thrown by pipeline code itself (for example a store
   failure while recording a session). Use one `try`/`finally`-style closing path. A receipt may
   end `failed` or `terminated`, but never stays `running` after the call returns or throws.
3. **Core-level timeout.** Per action, create an `AbortController`. Arm a timer for the action's
   timeout: `ActionSchema.timeout_ms`, else the manifest's `default_timeout_ms`. Pass its
   signal in `AdapterContext`, and race `adapter.invoke` (and `start` for `start_cli`) against
   it.
   - **On timeout:** abort the signal and fail with `E_TIMEOUT` (outcome `terminated`). A late
     adapter result is ignored and cannot overwrite the closed receipt.
   - **On success or failure:** clear the timer.
   - **Job cancellation:** if the pipeline already has a hook for the job being cancelled, wire
     it to the same controller (`E_CANCELLED`). If it has none, do not invent one; say so in the
     PR.

**Probe wrapper (`runPowerShell` only)**

4. If `signal.aborted` is already true on entry, reject immediately (cancelled), before creating
   the temp directory or spawning anything.
5. **Output bound:** `maxBuffer` at most 1 MiB. Before reading `output.json`, `stat` it; over
   4 MiB → reject with an output-limit error that the adapter maps to `E_OUTPUT_LIMIT`. Never
   read an oversized file into memory.
6. **Cleanup is awaited:** resolve or reject only after the temp directory removal completes. A
   removal error is logged once with the directory's basename only, and does not change the
   action's result.

## Acceptance

1. A pathless action without `workspace_id` → `E_WORKSPACE_DENIED`; `actions_used` is unchanged;
   the receipt has `ended_at` and outcome `failed`; `action.finished` exists; no `running` receipt
   remains.
2. A store failure injected after `action.started` → the receipt is closed (`failed`) and the
   error propagates.
3. A fixture adapter that never resolves → `E_TIMEOUT` at the declared timeout, receipt
   `terminated`, and the adapter's signal is observed aborted. A late resolution does not change
   the receipt.
4. A fixture adapter that resolves quickly → no timer left armed (the test process exits
   promptly).
5. `runPowerShell` with a pre-aborted signal → rejects without spawning (assert that no child
   process and no temp directory were created).
6. An output file over the limit → output-limit error, mapped to `E_OUTPUT_LIMIT`, file never
   read whole.
7. After every probe outcome (success, timeout, abort, error), the temp directory no longer
   exists **when the promise settles**.
8. The full suite passes natively with **zero skips**.

## Verify (native Windows, record counts in the PR)

```
npm ci
npx tsc --build
node --test packages/node-core/dist/test/*.test.js packages/adapters-desktop/dist/test/*.test.js
npm test
```

## Constraints

- Worktree `_worktrees/Toros-f4-pipeline-integrity`, branch `fix/ar-f4-pipeline-integrity` from
  `public/main`. One agent per worktree.
- F2 runs in parallel and edits a different region of `probe.ts`. If a merge conflict appears,
  the second PR to merge rebases; resolve by region, never by dropping the other slice's change.
- Public repository: no secrets, local paths or hostnames.
- One PR into `main`, titled `fix(node-core): AR-F4 pipeline integrity`. Do not merge it.

## Round 2 — changes after review (2026-10-15)

Codex reviewed PR mbulentcakar/Toros#6 and requested changes. Fix all six findings (read the
review on the PR). Finding 2 was a decision for the operator, who chose **a guaranteed close at a
deadline**.

1. **Timeout must win (P1).** When the Core timer fires, it first marks the action timed out, so
   the race is decided as `E_TIMEOUT`/`terminated`, and only **then** aborts the adapter's
   signal. Neither an adapter that resolves in its abort listener nor one that rejects there may
   replace the outcome. Test both behaviours.
2. **`send_cli` guaranteed close (P2, operator decision).** The documented exchange-settlement
   design stays: the receipt stays `running` until a later `read_cli` settles it. Add a guaranteed
   close on top:
   - **Deadline:** when `send_cli` returns with its receipt open, Core arms a settlement deadline
     equal to that action's timeout (`ActionSchema.timeout_ms`, else the manifest's
     `default_timeout_ms`) **plus 30 seconds**.
   - **On the deadline:** if the receipt is still open, Core closes it as `terminated` with
     `exchange_state: "unsettled_deadline"` and appends `action.finished`.
   - **Idempotence:** a settlement arriving later (from `read_cli`) neither reopens nor rewrites a
     closed receipt.
   - **Restart:** at Core start, any `send_cli` receipt still `running` whose deadline has passed
     is closed the same way. Its deadline is derived from `started_at` plus the same timeout.
   - **Existing test:** update the test at `acceptance.test.ts:293` to the new rule. It still
     expects `running` right after the send; add the deadline close.
3. **One closing path from `action.started` (P2).** The whole post-start sequence lives inside the
   single closing path: the first receipt write, timeout setup, and path-argument resolution.
   Test a rejected first receipt write, both persisted-then-rejected and not persisted.
4. **Abort during setup (P2).** Install cancellation handling before the async setup in
   `runPowerShell`, or recheck `signal.aborted` after setup. If aborted, clean up (awaited) and
   reject **without spawning**. Test an abort timed to the moment the script write completes.
5. **Synchronous spawn failure (P2).** Catch a synchronous throw from the spawn seam and route it
   through `done`, with cleanup awaited and the returned promise rejected. No unhandled
   rejection. Test it.
6. **Basename-only logging (P3).** The cleanup failure log contains the directory basename and
   the error **code** only (for example `EACCES`), never the raw message or path.

Allowed paths are unchanged, plus `packages/node-core/test/acceptance.test.ts` for item 2 only.

## Round 3 — after the round-2 review (2026-10-15)

Codex: findings 1 and 3–6 are fixed. Two items remain.

1. **The guaranteed close must survive a failed write (P2).** Keep a `send_cli` receipt's deadline
   armed until its closure is **durably recorded**.
   - **`read_cli` settlement:** `settleCliExchange` clears the deadline timer only **after** the
     terminal receipt write succeeds. If the write fails, the timer stays armed.
   - **The deadline callback:** if its closing write fails, it re-arms a bounded retry: 1 s, then
     5 s, then 30 s, then every 60 s. It never drops the receipt. Retries stop the moment the
     receipt is closed by any path.
   - **Startup reconciliation:** a failed closure for one receipt does not stop the scan. That
     receipt gets the same retry schedule, and the scan continues with the rest.
   - **Tests:** one-shot `putReceipt` failure in the `read_cli` settlement path, then storage
     recovers → the send still closes by its deadline without another read or a restart. One-shot
     failure in the deadline closure → closes on retry. Reconciliation with one failing receipt →
     the others still close, and the failing one closes on retry.
2. **Scope (P3), a brief correction.** `packages/node-core/src/core.ts` **is in scope**, limited to
   the minimal startup hook that keeps the pipeline reference and calls reconciliation at start.
   The round-2 brief should have said so.

## Round 4 — after the round-3 review (2026-10-15)

Codex confirmed that the one-shot receipt-write recovery works. Fix the four remaining findings
(see the review on PR mbulentcakar/Toros#6).

1. **The whole closure attempt is caught (P2).** `closeUnsettledCliReceipt` catches **every** step,
   including `store.getReceipt`. Any failure schedules the bounded retry. Nothing a `void`-ed
   caller awaits can reject. Regression: a one-shot `getReceipt` rejection on the deadline, retry
   and reconciliation paths → no unhandled rejection, and the receipt closes on retry.
2. **The finished event is recovered (P2).** Closure has two durable steps: the terminal receipt
   write, then `action.finished`. A retry checks **both**:
   - receipt still running → write the receipt, then append the event;
   - receipt closed but no `action.finished` for it → append the event only, without rewriting
     the receipt;
   - both present → stop.

   There must never be duplicate events. Apply the same rule to the `read_cli` settlement path:
   its deadline is cleared only after the receipt **and** its event are durable. Regression: a
   one-shot `action.finished` append failure after a successful receipt write → the event is
   appended on retry, exactly once.
3. **The read-settlement regression must actually fire (P2).** Fix the fixture manifest so the
   read result has no undeclared fields. Assert that the injected `putReceipt` failure fired
   exactly once, and assert the expected error code.
4. **No process-wide timing override (P3).** Remove `_testing_shortenDelays`. Pass the timing
   (grace and retry schedule) as an **instance-scoped, validated** option of the pipeline (finite,
   non-negative, non-empty schedule), defaulting to the immutable production values. Tests that
   need short delays construct their own pipeline or Core with that option. Add one test that
   asserts the production default schedule is 1 s, 5 s, 30 s, then 60 s.

## Round 5 — after the round-4 review (2026-10-15)

1. **Restart also recovers a missing finished event (P2).** Startup reconciliation must consider
   `send` receipts that are **closed but have no `action.finished` event**, as well as running
   ones. For those, it uses the existing event-only recovery path: no receipt rewrite and no
   duplicate events, with the same retry schedule on failure. Add restart regressions for both
   the deadline-closure path and the `read_cli` settlement path, where the terminal receipt
   landed but the event append failed and the process restarted before the retry.

## Round 6 — CI failure on round 5 (2026-10-19)

Native Windows runs passed round 5, but the CI `Root` job fails (576 tests, 1 failed):
`Round3: a failed putReceipt in read_cli settlement keeps the deadline timer armed and the receipt
still closes` sees `terminated` where it expects `running`. This is a race in the test, not a
production defect. The deadline is 80 ms timeout + 200 ms grace, so a slower runner can pass the
deadline during the `send_cli` → `read_cli` → "still running" steps, and the timer closes the
receipt first.

1. **The window under test must outlast a slow runner.** In that test, set the grace to at least
   5 s. Assert "still running" right after the failed settlement. Then wait for the deadline by
   **polling** the receipt (every 100 ms, up to 15 s) instead of a fixed 2 s sleep.
2. **Audit the same class across the F4 tests.** Any test that asserts an intermediate state
   (still `running`, not yet closed, no event yet) inside a window under 1 s gets the same
   treatment: widen the window, and poll for the later state. Tests that only assert the final
   state after a deadline also poll, with a bounded timeout, instead of a fixed sleep.
3. **No production change.** Production timing defaults, and the instance-scoped timing option
   from round 4, stay as they are.

Acceptance: `npm test` on Windows: 0 failed, and every skip is a `TOROS_REAL_TESTS` real-binary
skip. Then the CI `Root` job is green on the PR head.
