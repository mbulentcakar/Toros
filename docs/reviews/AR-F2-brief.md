# AR-F2 — no UIA `Name` from desktop discovery (implementation brief)

**Read `docs/specs/00-CONTRACTS.md` first.** `packages/contracts` is frozen and untouched here.

**Lane:** implementer from the deputy pool (sandboxed `deputize`); code review by Codex; the native
re-review of the AR surface after F1–F4 by a third lineage. The implementer is never the reviewer.

## Goal

`desktop.inspect` and `desktop.state` never disclose application content through UI Automation
`Name`. Control output is structure only, and every collection step is bounded **before**
serialization.

## Why

AR-01 (High, `docs/reviews/AR-adversarial-security-review.md`) demonstrated on native Windows that
`desktop.inspect` returned the exact contents of a genuinely masked password field. A WinForms
`TextBox` with `UseSystemPasswordChar` had its text exposed as a `Pane` element's `Name`, with
`IsPassword=false`. The same probe also returned off-client label text with `IsOffscreen=false`.
Checking control type, `IsPassword` or `IsOffscreen` does not prevent this; the review says so
explicitly. The only safe rule is to **not read control names at all**. Spec AS
(PR mbulentcakar/Toros#1) builds on this surface and assumes F2.

AR-07 also found that enumeration and sibling collection happen before the caps are applied.
F2 rewrites that loop, so it bounds the collection there too (F4 bounds the TypeScript side).

## In scope

- `packages/adapters-desktop/src/probe.ts`: **the embedded PowerShell script (`DESKTOP_UIA_PS1`)
  and the `RawWindow`/`RawControl` types only.** The TypeScript `runPowerShell` function belongs
  to F4; do not edit it.
- `packages/adapters-desktop/src/adapter.ts`: the public output shape, `control_filter`, the
  title source.
- `packages/adapters-desktop/test/**`: updated and new tests, plus a native fixture script under
  `test/fixtures/`.
- `docs/specs/AR-read-only-discovery.md`: amend the `desktop.inspect` output and the "name
  follows the in-scope rule" text to the new rule.

## Out of scope

- `runPowerShell` and anything else in `probe.ts` outside the script string and the raw types
  (F4).
- Handle binding, session scope, identity beyond process name (F3); manifest permissions (F5).
- `packages/contracts/**`, `packages/node-core/**`, `packages/policy/**`, every other package,
  `apps/**`.

## Required behaviour

1. **Controls:** the script **never reads `Current.Name`** (or `NameProperty`) for any control
   element. The public control output is exactly:
   `{ control_id, type, automation_id, enabled, patterns }`.
   `automation_id` is included only if it is 1–128 printable ASCII characters; otherwise it is
   omitted. No `name` field exists in raw or public control types.
2. **`control_filter`** matches `type` and `automation_id` only, never a name.
3. **Window titles** (`desktop.state`, in-scope apps only, as today) come from the native window
   text (`GetWindowText` on the top-level handle), **not** from UIA `Name`. They are capped at 256
   characters and omitted when the window has no native handle.
4. **Bounded collection in the script.** The script receives `max_windows` and `max_controls`
   and stops enumerating at the cap. It never collects all siblings and then truncates. It sets
   `truncated` when it stops early. The adapter passes its existing limits.
5. Everything else stays: opaque ids, freshness tokens, in-scope rules, the `locked` path, and
   no value reads.

## Acceptance

1. Inspecting a native fixture (a WinForms form started by the test, containing a
   `UseSystemPasswordChar` text box with a synthetic canary, a normal text box with a second
   canary, and a label positioned outside the client area with a third) returns **none of the
   three canaries anywhere** in the output, the receipt, or the events.
2. A static test asserts that the script source contains no `Current.Name` and no
   `NameProperty`.
3. Control output objects contain exactly the five keys of required behaviour 1; an over-long or
   non-ASCII `automation_id` is omitted.
4. `control_filter` matches by type and automation id; a canary used as the filter matches
   nothing.
5. An in-scope window's title equals its native window text, truncated to 256; an out-of-scope
   window has no title (existing rule kept).
6. A fixture with more windows or children than the caps → the script stops at the cap and
   reports `truncated`. Assert via a count of what the script emitted, not only the adapter
   slice.
7. The full adapters-desktop suite and the native fixture test pass with **zero skips** on an
   interactive, unlocked Windows desktop. A locked or headless run is reported as such, never as
   a pass.

## Verify (native Windows, record counts in the PR)

```
npm ci
npx tsc --build
node --test packages/adapters-desktop/dist/test/*.test.js
npm test
```

## Constraints

- Worktree `_worktrees/Toros-f2-no-uia-names`, branch `fix/ar-f2-no-uia-names` from `public/main`.
  One agent per worktree.
- **Fixtures use synthetic canaries and windows the test creates itself. Never inspect the
  operator's real applications.**
- Public repository: no secrets, local paths, hostnames or screenshots.
- Never interpolate anything into the script source; keep the JSON parameter-file pattern.
- One PR into `main`, titled `fix(adapters-desktop): AR-F2 no UIA names from discovery`. Do not
  merge it.

## Round 2 — changes after review (2026-10-15)

Codex reviewed PR mbulentcakar/Toros#7 and requested changes, all in the native fixture test.
The no-`Name` implementation itself passed. Round 1 was written by a different implementer; this
round may be too. Fix the three findings on the PR, under these rules.

**Safety rules for every native test (non-negotiable):**
- **Never enumerate, read or touch any window or process the test did not create.** No
  desktop-wide enumeration whose results include other processes' window text, and no
  allowlisting of a generic process name such as `powershell`.
- **Never terminate, signal or alter a process the test did not start.** Remove the
  `taskkill /F /IM scrnsave.scr` call entirely.
- **A locked or non-interactive desktop fails the test** with a clear message naming the
  precondition. It is neither skipped nor "fixed" by touching other processes.

1. **Bind to the fixture before any text is read (P1).** Add a **test-only** restriction to the
   probe: an option on `createPowerShellUiaProbe`, for example `restrict_to_pid`, passed into the
   script's `input.json`.
   - **In the script:** when the option is set, the script skips every top-level window whose
     owning process id differs, **before** reading its native text or descending into it.
   - **Who can set it:** it is reachable only through that factory option. It is never an action
     input and never a configuration field. Its doc comment says it exists for tests.
   - **The fixture test:** spawns the fixture, takes its PID from the spawned child (and the HWND
     the fixture reports), passes the PID to the factory, and asserts that every returned window
     belongs to that PID and HWND.
   - **Authorization in the test:** the test's `authorized_apps` entry must match only the
     fixture.
   - **Scope note:** this edits the script and the probe factory, both F2 territory. Leave
     `runPowerShell` alone.
2. **Receipts and events through real Core (P2).** Add a native integration test:
   - construct a real Core with the desktop adapter, using the fixture-bound probe, and a
     temporary store;
   - run `desktop.state` and `desktop.inspect` through the action pipeline;
   - assert that none of the three canaries appears in the action output, any persisted
     receipt, or any event row.
3. **Bound the title assertions to the fixture (P2).** The out-of-scope title assertion must
   target the fixture's own window, run under an `authorized_apps` that excludes it. Add a native
   check where the fixture sets its own window title to more than 256 characters; the title
   returned in scope is exactly the first 256.

**Reporting:** state pass, fail and skip counts. **Also state** that the real-CLI suites
(`real-gemini`, `real-grok`) are disabled unless `TOROS_REAL_TESTS=1`, and are therefore not
covered.

## Round 3 — after the round-2 review (2026-10-15)

Codex refused to run the native tests: the process binding could fail open. Fix both findings
(see the review on PR mbulentcakar/Toros#7).

1. **The restriction cannot fail open, and the process id comes from the spawned child (P1).**
   - **In the script:** when `restrict_to_pid` is present in `input.json`, it must parse as a
     positive integer. If it does not, the script emits an error and **enumerates nothing**. An
     unparseable value never means "no restriction".
   - **In `createPowerShellUiaProbe`:** reject (throw) a `restrict_to_pid` that is not a positive
     safe integer, before PowerShell starts.
   - **In the test helpers:** the fixture id is `child.pid` of the process the test spawned. The
     READY line's reported id must **equal** `child.pid`, or the helper fails before any probe
     runs. A missing or non-integer `child.pid` also fails.
   - **Tests:**
     - static or unit checks that the script and factory refuse malformed values;
     - the helper rejects a mismatched READY id.

     These run without a window.
2. **No generic process name in authorization (P2).**
   - **Fixture host:** the fixture runs from a **renamed copy of the Windows PowerShell
     executable**, placed in a fresh temp directory with a unique name (for example
     `toros-fixture-<random>.exe`), so its process name is unique to the test run.
   - **Authorization:** `authorized_apps` contains only that unique name.
   - **Cleanup:** the copy and its directory are removed afterwards. The test kills only the
     process it started.

The implementer must **not** run native tests. The independent reviewer reads the code, confirms
that the binding cannot fail open, and only then runs the native suites.

## Round 4 — after the round-3 review (2026-10-15)

1. **An explicit `null` or `undefined` must not turn the restriction off (P1).** Only the
   **absence** of the `restrict_to_pid` property selects the unrestricted production path. Test
   for absence with `'restrict_to_pid' in options` (or `Object.hasOwn`), not `??`. A present
   value that is `null`, `undefined`, or anything other than a positive safe integer makes the
   factory **throw** before PowerShell starts. Update `restrict-pid.test.ts`: explicit `null` and
   explicit `undefined` → throw. Absence → allowed.
2. **The precondition check is bound to the fixture too (P2).** Remove `selfProbe()` and the
   runner-pid probe. Each native suite's locked-desktop check runs **after** the fixture starts,
   using `fixtureProbe(fixture)`. A locked desktop still fails the suite with the same clear
   message, then cleans up the fixture it started.

The implementer still must not run native tests. The reviewer gates them.
