# AR — native re-review of the remediated discovery surface

**Purpose.** The adversarial review of 2026-10-13 (PR mbulentcakar/Toros#3) gave the read-only
discovery surface the verdict *do not enable*, with eleven findings, AR-01 to AR-11. Slices F1–F5
of the remediation plan (PR mbulentcakar/Toros#4, `docs/reviews/AR-remediation-plan.md`) are now
merged on `main`. The plan's gate says that the surface stays disabled, and spec AS (PR
mbulentcakar/Toros#1) stays blocked, until **a native re-review by a third lineage clears them**.
This file is that re-review's brief. Its verdict is the gate.

## Reviewer requirement

An independent lineage, never one that wrote this code:

- **Not DeepSeek.** DeepSeek implemented every slice.
- **Not Claude.** Claude orchestrated the slices, wrote the briefs, and made one fix in F3b.

The slice code reviews were done by GPT-6.1 Sol (Codex: F1, F2, F4, F3a) and by Gemini 4 Argon
(agy: F3b, F5). The operator picks the re-reviewer; the dispatch block below records the choice.

> **Dispatch (operator decision, 2026-10-20).**
>
> - **Reviewer:** agy running Gemini 4 Argon (`gemini-4-argon-high`).
> - **Run mode:** full access, so it can build and run natively, inside the dedicated worktree
>   `_worktrees/Toros-ar-rereview` (branch `review/ar-native-rereview`).
> - **Baseline:** `main` at `a5d9360`.
> - **Conflict to manage:** Argon approved F3b (#12) and F5 (#11) as their code reviewer. Treat
>   those approvals as **untrusted**. Re-derive every conclusion from the code and live runs, and
>   attack F3b and F5 as hard as the slices you did not review. Do not read the earlier review
>   comments on #11 or #12 until your own findings are written.

## Baseline

- Repository: the public `mbulentcakar/Toros`, `main` at `a5d9360` or later.
- Merged slices:

  | Slice | PR | Merge commit |
  |---|---|---|
  | F1 | #5 | `fc195b5` |
  | F4 | #6 | `eb66dca` |
  | F2 | #7 | `d670f14` |
  | F3a (contract amendment A8) | #8 | `d69360a` |
  | F3b | #12 | `6f8eeaf` |
  | F5 | #11 | `a5d9360` |

- Each slice's brief, and every review round, is in `docs/reviews/AR-F*-brief.md` on PR #4.
- The original findings, with their exploits, are in `docs/reviews/AR-adversarial-security-review.md`
  on PR #3. The copy on `main` holds only the prompt.

## Where and how to run it

- **Native Windows 11, unlocked interactive desktop, Windows PowerShell 5.1.** A sandbox or WSL run
  cannot exercise UI Automation. Every claim about `probe.ts`, UI Automation or session behaviour
  must be demonstrated live, or labelled `unverified (static only)`.
- **Benign targets only.** Use windows you create yourself; the repository's canary fixture
  (`packages/adapters-desktop/test/fixtures/canary-form.ps1`) is the model. Never inspect the
  operator's applications, mail or documents. Bind every probe to your own fixture's pid
  (`restrict_to_pid`), as the native tests do.
- **Use a dedicated worktree on `main`.** Do not edit code. Experiments go in throwaway files
  outside the repository.
- **Record the baseline natively:**
  - `npm ci`;
  - a clean build: delete every `packages/*/dist` and `*.tsbuildinfo`, then `npm run typecheck`;
  - `npm test`;
  - `TOROS_REAL_TESTS=1 node --test packages/adapters-desktop/dist/test/native-fixture.test.js packages/node-core/dist/test/desktop-native-core.test.js`.

  Report every count. A skip is a finding.

## What to re-test

### 1. Every original finding, AR-01 to AR-11

For each finding: re-run the original exploit, or its closest equivalent on the new API. Say
**closed**, **partially closed** or **open**, with evidence, and say which slice closed it.

| Finding | Original claim | Closed by | Re-test |
|---|---|---|---|
| AR-01 | Masked password and off-client text leak through UIA `Name` | F2 | The canary fixture's password, text and label canaries appear nowhere in output, receipts or events, through the real Core |
| AR-02 | The envelope cannot narrow the global allowlist | F3a + F3b | A job whose `forbidden` names the fixture, or whose `allowed_apps` omits it, sees neither its title nor its controls |
| AR-03 | Operator credential separation is conditional | F1 | The ordinary token never reaches `/operator/*`, under any configuration |
| AR-04 | `session_scope` is never enforced | F3b | Only `interactive`; a locked or disconnected session returns nothing (demonstrate the locked case, if you can, safely) |
| AR-05 | Handles are global, cross-job and replayable | F3b | Replay across jobs, across actors, after use and after 60 s → `refresh_required`, all with one indistinguishable shape |
| AR-06 | Pathless actions leave a false running receipt | F4 | Every started receipt closes on every error path |
| AR-07 | Cancellation and output bounds are not end to end | F2 + F4 | A pre-aborted signal, the Core timeout (resolve plus invoke share one deadline), the output caps, awaited cleanup |
| AR-08 | Inventory's PATH walk makes undeclared network I/O | F5 | UNC, device, relative and non-fixed entries are never touched |
| AR-09 | Inventory reports adapters outside the job | F5 | Out-of-job entries are `{id, readiness: 'unauthorized'}` only, including when decisions are absent |
| AR-10 | Basename identity is spoofable | F3b | A renamed or copied binary under an allowlisted basename, with a different hash, is denied |
| AR-11 | The manifest omits filesystem authority | F3b, F5 | Manifests declare what each adapter actually does |

### 2. The new surface the remediation added

Attack it as hard as the original:

- **Contract amendment A8** (two-phase resolve):
  - Can an adapter's resolve output smuggle anything past Core's validator, such as odd paths,
    timestamps, prototype keys or huge payloads?
  - Can any path reach `invoke` without decisions?
  - Can identity strings be used to bypass a `forbidden` term?
- **Identity and session code in `DESKTOP_UIA_PS1`** and `NODE_SESSION_ID_PS1`:
  - injection (no caller or UI value may reach `Add-Type`, a command line or a path);
  - what an `identity_unavailable` window can still disclose;
  - handle hygiene;
  - PowerShell 5.1 behaviour.
- **Config:** can an `AppRule[]` config be written so that it matches more than the operator
  intended?
- **Spec AS inheritance.** For each remaining finding, mark it `AS-inherited` when a click or type
  action built on this surface would inherit it.

### 3. Contract integrity

`packages/contracts` differs from the public release only by A8 and the restored
`ConversationTurnRole` export. Confirm that against `00-CONTRACTS.md` §10.

## Deliverable

- Severity-ranked findings (High, Medium, Low), each with a concrete exploit (inputs → what leaks
  or breaks), a file:line, `demonstrated` or `unverified (static only)`, and `AS-inherited` where
  it applies.
- The AR-01–AR-11 table filled in.
- An explicit verdict: **clear the AR gate** (the desktop discovery surface may be enabled with
  `authorized_apps` configured, and spec AS may proceed to implementation), or **do not clear**,
  with what must change first.
- Append the report below the line. Commit on `review/ar-native-rereview`, push, and open a PR
  titled `review(AR): native re-review of F1–F5`. Fix nothing in that PR.
- The repository is public, so record no secrets, tokens, local user paths, host names or
  screenshots of a real desktop.

---

<!-- re-review findings go here -->

# Native Adversarial Re-Review Report (Slices F1–F5)

- **Date:** 2026-10-20
- **Reviewer:** agy / Gemini 4 Argon (`gemini-4-argon-high`), independent native re-review
- **Baseline:** `main` at `a5d9360` (`6f8eeaf` F3b, `a5d9360` F5, `d69360a` F3a, `d670f14` F2, `eb66dca` F4, `fc195b5` F1)
- **Environment:** Native Windows 11 (`Microsoft Windows NT 10.0.26300.0`), unlocked interactive desktop (`Default`), Windows PowerShell `5.1.26100.9711`, Node.js `v24.13.1`
- **Safety compliance:** Every live desktop probe used a self-created benign WinForms canary fixture (`packages/adapters-desktop/test/fixtures/canary-form.ps1` via `startFixture`) with `restrict_to_pid` bound to the fixture's PID. No operator windows, applications, or documents were inspected. All fixture processes and temporary files outside the repository were terminated and deleted.

---

## Verdict: **DO NOT CLEAR**

The remediated discovery surface (`F1`–`F5`) closes several structural vulnerabilities from the original review (**AR-03**, **AR-07**, **AR-08**, **AR-11**, and the core mechanisms of **AR-01**, **AR-04**, **AR-05**, **AR-06**, and **AR-10**), but **cannot be cleared** for production enablement or Spec AS implementation due to **1 High**, **3 Medium**, and **3 Low** findings demonstrated on native Windows 11:

1. **RR-01 (High — `AS-inherited`, `demonstrated`):** `isForbidden` (`packages/envelope/src/envelope.ts:499-513`) splits candidate target strings on `/[^a-z0-9]+/` into alphanumeric tokens and checks `token === forbidden.toLowerCase()` without tokenizing `forbidden`. **Every `envelope.forbidden` entry containing a dot, space, hyphen, underscore, or non-ASCII character is 100% inert (`isForbidden` always returns `false`).** Consequently, `forbidden` entries naming real executable basenames (`"powershell.exe"`, `"notepad.exe"`, `"toros-fixture-<id>.exe"`), hyphenated names (`"toros-fixture"`), real Authenticode signers (`"Microsoft Windows"`, `"Microsoft Corporation"`), real product names (`"Microsoft® Windows® Operating System"`), or dotted capabilities (`"desktop.inspect"`) never match in `authorizeTargets` or `decide`. In addition, `PolicyImpl.decideTarget` (`packages/policy/src/index.ts:335`) checks only `path.win32.basename(identity.image_path)` (ignoring directory segments such as `C:\Program Files\KeePass\app.exe`), and neither `desktop.state` nor `desktop.inspect` checks window `title` or control `automation_id` against `envelope.forbidden`. (**AR-02 remains partially open / bypassable.**)
2. **RR-02 (Medium — `AS-inherited`, `demonstrated`):** `runPowerShell` (`packages/adapters-desktop/src/probe.ts:467-478`) spawns Windows PowerShell 5.1 (`powershell.exe`) without sanitizing `process.env.PSModulePath`. When Node Core is started from PowerShell 7 (`pwsh`), Windows PowerShell 5.1 fails to autoload `Microsoft.PowerShell.Security` (`CouldNotAutoloadMatchingModule`), and `ReadIdentity` (`probe.ts:199`) catches the exception and **silently misreports every signed binary on the machine as `signature: "unsigned", signer: null`**, breaking all `{ signer, product_name }` rules. Conversely, when `PSModulePath` is clean, Windows 11 catalog-signed inbox binaries (`notepad.exe`, `powershell.exe`, `cmd.exe`, `explorer.exe`)—even when copied to `%TEMP%\anything.exe`—all report the exact same `{ signature: "valid", signer: "Microsoft Windows", product_name: "Microsoft® Windows® Operating System" }`, so a `{ signer, product_name }` rule intended for Notepad simultaneously authorizes `powershell.exe`, `cmd.exe`, and `explorer.exe`. (**AR-10 partially open / new native defects.**)
3. **RR-03 (Medium — `AS-inherited`, `demonstrated`):** `PolicyImpl.decideTarget` (`packages/policy/src/index.ts:313-315`) checks only `envelope.allowed_capabilities.includes(target.capability)` for `capability` targets and **completely omits `isForbidden(envelope, target.capability)`**. A job with `allowed_capabilities: ['machine.inventory', 'codex.start']` and `forbidden: ['codex']` has `codex.start` marked `'allowed'` by `authorizeTargets`, leaking the full unredacted `codex` inventory entry. In addition, `machine.inventory` (`packages/adapters-machine/src/adapter.ts:500-602`) still reveals which non-probed adapters (`desktop`, `chrome`) are registered on the node via `{ id, readiness: "unauthorized" }` entries and executes all filesystem probes (`resolveFixedDrives` + `detectPresent`) before checking `ctx.target_decisions`. (**AR-09 partially open.**)
4. **RR-04 (Medium — `demonstrated`):** On every Node Core startup, `reconcileCliSettlements` (`packages/node-core/src/action-pipeline.ts:882-910`) enters its `else` branch for every policy-denied `.send` receipt (`receipt.outcome === 'denied'`) and calls `closeUnsettledCliReceipt`, **appending a fabricated `action.finished` event (`outcome: "denied", exchange_state: "unsettled_deadline"`) to the hash-chained audit log** for an action that never started. Because `hasSettledCliSendFinishedEvent` (`action-pipeline.ts:832-842`) does not recognize `exchange_state: "unsettled_deadline"` on non-`failed` events, every subsequent Node Core restart appends another duplicate `action.finished` event for the same denied receipt. (**AR-06 regression.**)
5. **RR-05 (Low — `AS-inherited`, `demonstrated`):** `resolveNodeSessionId` (`packages/node-core/src/desktop-config.ts:174-179`) evaluates `const parsed = Number(stdout.trim()); if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;`. Because `Number("") === 0` in JavaScript, empty or whitespace-only stdout resolves to Windows Session `0` instead of `null` (fail-closed), and hex strings (`"0x10"`) are accepted.
6. **RR-06 (Low — `AS-inherited`, `demonstrated`):** `invokeInspect` (`packages/adapters-desktop/src/adapter.ts:477`) marks a `window_id` handle consumed (`entry.consumed = true`) on page 1, making `desktop.inspect` pagination (`page: 2` using the same `window_id` and `freshness_token`) impossible—`page: 2` always returns `status: "refresh_required"`. In addition, on Windows PowerShell 5.1 WinForms (`canary-form.ps1`), `Control.Name` does not populate out-of-process UIA `Current.AutomationId` (which reports the decimal HWND string), and `native-fixture.test.ts:272-298` tested `control_filter` only by type (`'Pane'`) and never by `automation_id`.
7. **RR-07 (Low — `AS-inherited`, `demonstrated`):** `DESKTOP_UIA_PS1` (`packages/adapters-desktop/src/probe.ts:250-285`) reads `WindowText` and enforces `max_windows` (64) across all desktop windows **before** `authorized_apps` filtering (writing unauthorized window titles to `%TEMP%\toros-desktop-*\output.json` and allowing 64 unauthorized windows to truncate away authorized windows); `inspect_window` (`probe.ts:310-353`) walks the UIA subtree before checking `sameIdentity`; and `tools/orient.mjs` (`validateNodeConfig`, lines 47–105) was not updated for F1 (`operator_token` printable ASCII) or F3b (`adapters.desktop.authorized_apps` validation).

---

## 0. Native Baseline

Recorded on native Windows 11 (`10.0.26300.0`), unlocked interactive desktop:

1. **`npm ci`:**
   - Exit code: `0` (39 packages installed/audited).
   - Note: `npm audit` reports 1 high-severity advisory in transitive dependency `fast-uri` (`<=3.1.0`, `GHSA-269g-789c-8674`) under `ajv`.
2. **Clean build (`packages/*/dist` and `packages/*/*.tsbuildinfo` deleted, then `npm run typecheck`):**
   - Exit code: `0`, `0` TypeScript errors across all workspace packages.
3. **`npm test` (default environment, `TOROS_REAL_TESTS` unset):**
   - Exit code: `0` (`duration_ms: 85837.14`).
   - Counts: **677 tests, 54 suites, 668 pass, 0 fail, 0 cancelled, 9 skipped, 0 todo.**
   - **Skip accounting (every skip is reported as required by the brief):**
     - **8 test-level skips** in `packages/adapters-desktop/dist/test/native-fixture.test.js`: the 8 native UIA canary fixture tests are gated by `{ skip: !RUN_REAL }` (`process.env['TOROS_REAL_TESTS'] === '1'`).
     - **1 test-level skip** in `packages/node-core/dist/test/desktop-native-core.test.js`: the native end-to-end Core + desktop adapter canary test is gated by `{ skip: !RUN_REAL }`.
     - **3 suite-level (`describe.skip`) skips** not reflected in the 9 test-level skip count when `TOROS_REAL_TESTS` is unset:
       - `packages/adapters-cli/dist/test/gemini-real.test.js` (`gemini CLI — real binary verification`)
       - `packages/adapters-cli/dist/test/grok-real.test.js` (`grok CLI — real binary verification`)
       - `packages/adapters-machine/dist/test/inventory.test.js:953` (`machine.inventory — production drive reader`)
4. **Native desktop suites (`TOROS_REAL_TESTS=1 node --test packages/adapters-desktop/dist/test/native-fixture.test.js packages/node-core/dist/test/desktop-native-core.test.js`):**
   - Exit code: `0` (`duration_ms: 22115.60`).
   - Counts: **9 tests, 2 suites, 9 pass, 0 fail, 0 skipped.**
5. **Native machine inventory suites (`TOROS_REAL_TESTS=1 node --test packages/adapters-machine/dist/test/*.test.js`):**
   - Exit code: `0` (`duration_ms: 388.29`).
   - Counts: **28 tests, 7 suites, 28 pass, 0 fail, 0 skipped.**

---

## 1. Re-Test of Original Findings (AR-01 to AR-11)

| Finding | Original claim | Closed by | Status | Re-test summary & evidence |
|---|---|---|---|---|
| **AR-01** | Masked password and off-client text leak through UIA `Name` | F2 (`#7`, `d670f14`) | **Closed (with native test gap RR-06b)** | `DESKTOP_UIA_PS1` never reads `Current.Name` or `NameProperty`. Canary strings (`CANARY_PW_9f3a_DO_NOT_LEAK`, `CANARY_TXT_7b2e_SECRET`, `CANARY_LBL_4d1c_HIDDEN`, `CANARY_OFFSCREEN_8e5a`) appear nowhere in outputs, receipts, or events through real `createNodeCore`. However, `Current.AutomationId` is still emitted verbatim (1–128 printable ASCII), and `native-fixture.test.ts` never tested `control_filter` by `automation_id` on native Windows. |
| **AR-02** | The envelope cannot narrow the global allowlist | F3a (`#8`, `d69360a`) + F3b (`#12`, `6f8eeaf`) | **Partially closed (bypassed by RR-01)** | Narrowing via `envelope.allowed_apps` works when `allowed_apps` omits the fixture. Narrowing via `envelope.forbidden` **fails** for every term containing `.`, `-`, `_`, space, or `®` (`"powershell.exe"`, `"toros-fixture"`, `"Microsoft Windows"`, `"Microsoft® Windows® Operating System"`), ignores directory segments of `image_path`, and never filters window `title` or control `automation_id`. |
| **AR-03** | Operator credential separation is conditional | F1 (`#5`, `fc195b5`) | **Closed (minor tool drift RR-07c)** | `core.ts:190-211` unconditionally enforces printable ASCII (`0x21–0x7E`), length `>= 32`, and `operator_token !== token` whenever `operator_token` is non-empty; `http.ts:449-478` rejects `token` on `/operator/*` even if `operator_token` is unset (`401`). (`tools/orient.mjs` was not updated to check printable ASCII.) |
| **AR-04** | `session_scope` is never enforced | F3b (`#12`, `6f8eeaf`) | **Closed in probe (minor parser bug RR-05)** | `session_scope` is fixed to `'interactive'`. `DESKTOP_UIA_PS1` verifies `ProcessIdToSessionId(currentPid)` has `WTSConnectState == WTSActive (0)` and `InputDesktopName() == 'Default'`, returning `status: 'unavailable'` (`session_state: 'locked' | 'disconnected'`) with zero windows/controls otherwise. However, `resolveNodeSessionId` (`desktop-config.ts:175`) parses empty stdout as Session `0` (`Number("") === 0`). |
| **AR-05** | Handles are global, cross-job and replayable | F3b (`#12`, `6f8eeaf`) | **Closed (causes pagination regression RR-06a)** | Handles are scoped per `(job_id, actor)`, capped at 32 live enumerations (FIFO eviction), expire after 60 s, and are single-use (`consumed = true` before policy check). Replay across jobs, actors, after use, or after TTL returns `{ status: 'refresh_required', controls: [] }`. However, single-use consumption breaks `desktop.inspect` `page >= 2` pagination. |
| **AR-06** | Pathless actions leave a false running receipt | F4 (`#6`, `eb66dca`) | **Partially closed (new audit log bug RR-04)** | Pre-execution workspace check runs before writing the `'running'` receipt (`action-pipeline.ts:515-525`), and post-start errors settle the receipt via `failReceiptSafe` (`action-pipeline.ts:461-497`). However, `reconcileCliSettlements` (`action-pipeline.ts:882-910`) appends a fabricated `action.finished` event (`exchange_state: 'unsettled_deadline'`) on every restart for every policy-denied `.send` receipt. |
| **AR-07** | Cancellation and output bounds are not end to end | F2 (`#7`, `d670f14`) + F4 (`#6`, `eb66dca`) | **Closed** | Core shares a single `AbortController` and deadline across `resolve` and `invoke` (`action-pipeline.ts:547-618`, setting `didTimeOut = true` before `controller.abort()`), `runPowerShell` checks `signal.aborted` before `mkdtemp` and `spawn`, enforces `MAX_OUTPUT_BYTES` (4 MiB) via `fs.stat` before `fs.readFile`, and awaits process kill + temp dir removal. |
| **AR-08** | Inventory's PATH walk makes undeclared network I/O | F5 (`#11`, `a5d9360`) | **Closed** | `isLocalFixedPath` + `filterPathEntries` (`packages/adapters-machine/src/adapter.ts:167-204`) and `detectPresent` (`adapter.ts:361-399`) restrict all `PATH` and `file` probes on `win32` to drive letters returned by `[System.IO.DriveInfo]::GetDrives()` with `DriveType -eq 'Fixed'`. UNC, device, relative, drive-relative, and non-fixed drive paths are skipped before `fs.access` and counted in `path_entries_skipped`. |
| **AR-09** | Inventory reports adapters outside the job | F5 (`#11`, `a5d9360`) | **Partially closed (bypassed by RR-03)** | Out-of-job probed adapters are reduced to `{ id, readiness: 'unauthorized' }` before `capability_filter`, and absent `ctx.target_decisions` fails closed. However, `PolicyImpl.decideTarget` ignores `envelope.forbidden` on `capability` targets (exposing forbidden adapters in full), non-probed registered adapters (`desktop`, `chrome`) still leak their registration presence, and all filesystem probes run before checking `ctx.target_decisions`. |
| **AR-10** | Basename identity is spoofable | F3b (`#12`, `6f8eeaf`) | **Partially closed (undermined by RR-02)** | Bare basename strings in `authorized_apps` and `allowed_apps` are rejected; identity uses `QueryFullProcessImageName`, SHA-256 of the image on disk, `StartTime`, `FileVersionInfo.ProductName`, and `Get-AuthenticodeSignature`, with TOCTOU re-verification on `pid`, `created_at`, and `image_sha256`. However, `PSModulePath` inheritance under `pwsh` breaks `Get-AuthenticodeSignature` silently, and Windows inbox binaries share identical `{ signer, product_name }` even when copied to `%TEMP%`. |
| **AR-11** | The manifest omits filesystem authority | F3b (`#12`, `6f8eeaf`) + F5 (`#11`, `a5d9360`) | **Closed** | `desktop` manifest declares `['process.spawn', 'app.automation', 'fs.read', 'fs.write']` (`packages/adapters-desktop/src/adapter.ts:205`); `machine` manifest declares `['process.spawn', 'fs.read']` (`packages/adapters-machine/src/adapter.ts:421`). |

---

## 2. Severity-Ranked Findings (New & Remaining)

### RR-01 [High] (`AS-inherited`, `demonstrated`): `isForbidden` tokenizes target strings on `/[^a-z0-9]+/` without tokenizing `envelope.forbidden`, making every `forbidden` term with `.`, `-`, `_`, space, or `®` 100% inert; directory segments of `image_path` and window/control labels are also unchecked

- **Locations:**
  - `packages/envelope/src/envelope.ts:499-513` (`isForbidden`)
  - `packages/policy/src/index.ts:331-354` (`PolicyImpl.decideTarget`)
  - `packages/adapters-desktop/src/adapter.ts:361-428`, `450-544` (`invokeState`, `invokeInspect`)
- **Status:** `demonstrated` (live on native Windows 11 against `createNodeCore`, `createDesktopAdapter`, and `canary-form.ps1`)
- **Spec AS impact:** `AS-inherited`
- **Mechanism:**
  In `packages/envelope/src/envelope.ts:499-513`:
  ```ts
  export function isForbidden(envelope: JobEnvelope, term: string): boolean {
    const tokens = term
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0);
    for (const forbidden of envelope.forbidden) {
      const normalized = forbidden.toLowerCase();
      for (const token of tokens) {
        if (token === normalized) {
          return true;
        }
      }
    }
    return false;
  }
  ```
  `term` is split on `/[^a-z0-9]+/` into purely alphanumeric words (`[a-z0-9]+`), while `forbidden` is only lowercased (`const normalized = forbidden.toLowerCase()`). Whenever an entry in `envelope.forbidden` contains **any** non-`[a-z0-9]` character—such as `.` in an executable name or capability ID (`"powershell.exe"`, `"notepad.exe"`, `"desktop.inspect"`), `-` or `_` in a binary or action name (`"toros-fixture"`, `"read-secrets"`), a space in a real Authenticode signer or product name (`"Microsoft Windows"`, `"Microsoft Corporation"`), or `®` (`"Microsoft® Windows® Operating System"`)—`token === normalized` can **never** be true for any `term`.
- **Exploit 1 (Punctuated and multi-word `envelope.forbidden` entries are completely inert):**
  1. Launch the native WinForms canary fixture via `startFixture()` (`image_path: "<TEMP>\\toros-fixture-<dir>\\toros-fixture-<hex>.exe"`, `product_name: "Microsoft® Windows® Operating System"`, `signer: null` under `pwsh` or `"Microsoft Windows"` under clean `PSModulePath`).
  2. Configure Node Core with `authorized_apps: [{ image_sha256: fixture.imageSha256 }]`.
  3. Submit a job envelope with `allowed_apps: [{ image_sha256: fixture.imageSha256 }]` and:
     ```json
     "forbidden": [
       "toros-fixture-<hex>.exe",
       "toros-fixture",
       "Microsoft Windows",
       "Microsoft Corporation",
       "Microsoft® Windows® Operating System",
       "desktop.inspect"
     ]
     ```
  4. Execute `desktop.state` and `desktop.inspect` through `core.executeAction`.
  5. **Observed result:** Both actions succeed (`outcome: "succeeded"`). `authorizeTargets` returns `'allowed'` for the fixture window, and `desktop.state` returns `windows: [{ title: "Toros Native Fixture Window", ... }]`. Even `"desktop.inspect"` in `envelope.forbidden` fails to block `desktop.inspect` in `PolicyImpl.decide` (`packages/policy/src/index.ts:132`) because `isForbidden(envelope, "desktop.inspect")` splits `"desktop.inspect"` into `["desktop", "inspect"]` and compares each token to `"desktop.inspect"`, returning `false`!
  6. Note: The F3a brief (`docs/reviews/AR-F3-brief.md`) explicitly required testing `forbidden: ['notepad.exe']`, but `packages/policy/test/authorize-targets.test.ts:138-152` substituted single-word `forbidden: ['notepad']`, `'widgets'`, and `'evilcorp'`, which hid the bug.
- **Exploit 2 (`image_path` directory segments are ignored by `decideTarget`):**
  In `packages/policy/src/index.ts:335`, `decideTarget` checks `isForbidden(envelope, path.win32.basename(identity.image_path))` instead of `isForbidden(envelope, identity.image_path)`. If an unsigned or generically named executable lives at `C:\Program Files\KeePass\app.exe` (`product_name: null, signer: null`, authorized by hash or path), a job with `forbidden: ["keepass"]` does not match `basename` (`"app.exe"`) and is `'allowed'`.
- **Exploit 3 (Window `title` and control `automation_id` are never checked against `envelope.forbidden`):**
  When an application is authorized (e.g., a multi-purpose editor, browser, or terminal), `invokeState` (`packages/adapters-desktop/src/adapter.ts:361-428`) and `invokeInspect` (`adapter.ts:450-544`) never check `w.title` or `c.automation_id` against `envelope.forbidden`. A job with `forbidden: ["secret", "password"]` still receives windows whose `title` contains `"Secret"` and controls whose `automation_id` contains `"password"`.
- **Required Fix:**
  1. In `isForbidden(envelope, term)`, tokenize `forbidden` with the exact same `/[^a-z0-9]+/` tokenizer and match contiguous token sequences (sub-array match of `forbiddenTokens` within `termTokens`), so both single-token (`"notepad"`) and multi-token (`"notepad.exe"`, `"Microsoft Windows"`, `"desktop.inspect"`, `"C:\\Program Files\\KeePass"`) forbidden entries match reliably without substring false positives.
  2. In `PolicyImpl.decideTarget`, pass the full `identity.image_path` (not just `path.win32.basename(identity.image_path)`) to `isForbidden`.
  3. Either include `title` in the `app` target or filter/redact windows and controls whose `title` or `automation_id` matches `envelope.forbidden`.

---

### RR-02 [Medium] (`AS-inherited`, `demonstrated`): `DESKTOP_UIA_PS1` silently reports `signature: "unsigned", signer: null` for all binaries when `PSModulePath` is inherited from `pwsh`; and when `PSModulePath` is clean, Windows inbox binaries (`notepad.exe`, `powershell.exe`, `cmd.exe`, `explorer.exe`) share identical `{ signer, product_name }` even when copied to `%TEMP%`

- **Locations:**
  - `packages/adapters-desktop/src/probe.ts:199`, `467-478` (`ReadIdentity`, `runPowerShell`)
  - `packages/policy/src/index.ts:288-295` (`matchesAppRule`)
  - `packages/node-core/src/desktop-config.ts:43-99` (`validateDesktopAuthorizedApps`)
- **Status:** `demonstrated` (live on native Windows 11)
- **Spec AS impact:** `AS-inherited`
- **Exploit / Failure Scenario A (`PSModulePath` pollution from `pwsh` silently breaks all Authenticode checks):**
  1. `runPowerShell` (`packages/adapters-desktop/src/probe.ts:467-478`) spawns `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` without cleaning `process.env.PSModulePath`.
  2. When Node Core (or the test runner) is launched from PowerShell 7 (`pwsh`), `process.env.PSModulePath` begins with PowerShell 7's module directories (`...\PowerShell\Modules;...\powershell\7\Modules;...`).
  3. Inside `DESKTOP_UIA_PS1` (`probe.ts:199`):
     ```powershell
     try { $sig = Get-AuthenticodeSignature -LiteralPath $imagePath -ErrorAction Stop } catch { $sig = $null }
     ```
     Windows PowerShell 5.1 attempts to autoload `Microsoft.PowerShell.Security` from the PS7 module path, throws `The 'Get-AuthenticodeSignature' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded`, and the `catch` block silently sets `$sig = $null`.
  4. **Observed native result:** Every binary on the host (`notepad.exe`, `powershell.exe`, `cmd.exe`, `explorer.exe`, `node.exe`) is reported by `ReadIdentity` as `signature: "unsigned", signer: null`. Any `{ signer, product_name }` rule in `authorized_apps` or `allowed_apps` fails to match every window on the system. This went undetected because `native-fixture.test.ts` and `desktop-native-core.test.ts` only tested `{ image_sha256 }` and `{ image_path }` rules and never tested `{ signer, product_name }` natively.
- **Exploit / Failure Scenario B (Windows inbox binaries share `{ signer, product_name }`, including copies in `%TEMP%`):**
  1. When `PSModulePath` is clean (or `Microsoft.PowerShell.Security` is imported from `$PSHome\Modules`), `Get-AuthenticodeSignature` on Windows 11 validates catalog-signed OS binaries by looking up their SHA-256 hash in the Windows system catalog database (`IsOSBinary = true, Status = Valid`).
  2. **Observed native result:** On Windows 11, all of the following binaries produce the **exact same** `(signature, signer, product_name)` tuple:
     - `C:\Windows\System32\notepad.exe`
     - `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
     - `C:\Windows\System32\cmd.exe`
     - `C:\Windows\explorer.exe`
     - A renamed copy of `powershell.exe` in `<TEMP>\toros-fixture-<dir>\toros-fixture-<hex>.exe`
     Each reports:
     ```json
     {
       "signature": "valid",
       "signer": "Microsoft Windows",
       "product_name": "Microsoft® Windows® Operating System"
     }
     ```
  3. Consequently, an operator who configures `authorized_apps: [{ signer: "Microsoft Windows", product_name: "Microsoft® Windows® Operating System" }]` (for example, to authorize Notepad) inadvertently authorizes `powershell.exe`, `cmd.exe`, `explorer.exe`, and any copy of those executables anywhere on a local fixed drive.
- **Required Fix:**
  1. In `runPowerShell` (`packages/adapters-desktop/src/probe.ts:467-478`) and `resolveNodeSessionId` (`packages/node-core/src/desktop-config.ts:162`), sanitize the child environment so `PSModulePath` points only to `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`, and explicitly load `Import-Module "$PSHome\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop` at the top of `DESKTOP_UIA_PS1`. Add a native test in `native-fixture.test.ts` exercising `{ signer, product_name }` matching.
  2. Reject or require `image_path` / `image_sha256` pinning when `product_name` is the generic OS umbrella `"Microsoft® Windows® Operating System"` (or require `{ signer, product_name }` rules to also pin `original_filename` / `image_path`), and document in `docs/INSTALL.md` that `"Microsoft® Windows® Operating System"` matches all Windows inbox shells (`powershell.exe`, `cmd.exe`, `explorer.exe`) and must never be used in `{ signer, product_name }` rules.

---

### RR-03 [Medium] (`AS-inherited`, `demonstrated`): `PolicyImpl.decideTarget` ignores `envelope.forbidden` on `capability` targets, and `machine.inventory` leaks non-probed registered adapter IDs and runs all filesystem probes before checking `ctx.target_decisions`

- **Locations:**
  - `packages/policy/src/index.ts:313-315` (`PolicyImpl.decideTarget`)
  - `packages/adapters-machine/src/adapter.ts:500-608` (`createMachineAdapter.invoke`)
- **Status:** `demonstrated` (live against `PolicyImpl`, `createMachineAdapter`, and `createNodeCore`)
- **Spec AS impact:** `AS-inherited`
- **Mechanism & Exploits:**
  1. **`decideTarget` omits `isForbidden` for `capability` targets (`packages/policy/src/index.ts:313-315`):**
     ```ts
     if (target.kind === 'capability') {
       return envelope.allowed_capabilities.includes(target.capability) ? 'allowed' : 'denied';
     }
     ```
     Whereas `PolicyImpl.decide` checks `isForbidden(envelope, request.capability)` before `allowed_capabilities` so that `forbidden` always wins, `decideTarget` never calls `isForbidden`.
     - **Live demonstration:** A job with `allowed_capabilities: ['machine.inventory', 'codex.start']` and `forbidden: ['codex']` has `codex.start` denied by `core.decide` (`code: 'E_FORBIDDEN'`), but `core.authorizeTargets` marks `{ kind: 'capability', key: 'codex.start', capability: 'codex.start' }` as `'allowed'`. When the job calls `machine.inventory`, the `codex` entry is returned in full (`readiness`, `platforms`, `backs_adapter`, `reason` with filesystem paths) instead of `{ id: 'codex', readiness: 'unauthorized' }`.
  2. **Registered non-probed adapter IDs leak to unauthorized jobs (`packages/adapters-machine/src/adapter.ts:567-602`):**
     Static probes always produce 5 entries (`git`, `codex`, `claude`, `gemini`, `grok`), while non-probed adapters (`desktop`, `chrome`) are appended to `internalEntries` only when present in `registered_adapter_ids()`. Even though they are reduced to `{ id: 'desktop', readiness: 'unauthorized' }`, their presence or absence in `entries` reveals to an unauthorized job which non-probed adapters are registered on the node.
  3. **Filesystem probes run before `ctx.target_decisions` is consulted (`packages/adapters-machine/src/adapter.ts:500-590`):**
     `invoke` executes `resolveFixedDrives` and `detectPresent` (`fs.access`) for all 5 static probes before checking `ctx.target_decisions` at line 590. A job authorized only for `machine.inventory` still triggers `fs.access` probes across `PATH` for `git`, `codex`, `claude`, `gemini`, and `grok`.
- **Required Fix:**
  1. In `PolicyImpl.decideTarget` (`packages/policy/src/index.ts:313-315`), check `if (isForbidden(envelope, target.capability)) return 'denied';` before checking `envelope.allowed_capabilities`.
  2. In `createMachineAdapter.invoke` (`packages/adapters-machine/src/adapter.ts`), evaluate `ctx.target_decisions` per probe *before* calling `detectPresent` (skipping `fs.access` for unauthorized adapters, and skipping `resolveFixedDrives` entirely if no probed adapter is authorized), and either omit unauthorized non-probed adapters or emit a fixed canonical catalog of adapter IDs regardless of registration.

---

### RR-04 [Medium] (`demonstrated`): `reconcileCliSettlements` fabricates a duplicate `action.finished` audit event (`exchange_state: "unsettled_deadline"`) on every Node Core restart for every policy-denied `.send` receipt

- **Locations:**
  - `packages/node-core/src/action-pipeline.ts:832-842` (`hasSettledCliSendFinishedEvent`), `882-910` (`reconcileCliSettlements`)
- **Status:** `demonstrated` (live against `createNodeCore` and `SqliteStore`)
- **Mechanism & Exploit:**
  1. When a `.send` capability (`codex.send`, `claude.send`, `gemini.send`, `grok.send`) is denied by policy (e.g., `E_FORBIDDEN` or `E_CAPABILITY_DENIED`), `executeAction` writes a receipt with `outcome: 'denied'` and emits `policy.denied`. By contract (`00-CONTRACTS.md`), denied actions never start and never emit `action.started` or `action.finished`.
  2. On the next Node Core startup (`core.start()`), `reconcileCliSettlements` (`packages/node-core/src/action-pipeline.ts:882-910`) inspects every `.send` receipt lacking a settled `action.finished` event:
     ```ts
     if (receipt.outcome === 'running') {
       ...
     } else {
       void closeUnsettledCliReceipt(receipt.receipt_id, store);
     }
     ```
  3. Because `receipt.outcome === 'denied'` is not `'running'`, `reconcileCliSettlements` calls `closeUnsettledCliReceipt(receipt.receipt_id, store)`, which appends a fabricated `action.finished` event `{ receipt_id, outcome: 'denied', exchange_state: 'unsettled_deadline', exchange_error: null }` to the hash-chained event log.
  4. Furthermore, `hasSettledCliSendFinishedEvent` (`action-pipeline.ts:832-842`) only treats non-`failed` `action.finished` events as settled when `exchange_state === 'settled'` or `'unsettled_timeout'`. Because the fabricated event has `outcome: 'denied'` and `exchange_state: 'unsettled_deadline'`, `hasSettledCliSendFinishedEvent` returns `false` on the next restart as well—so **every subsequent restart of Node Core appends another duplicate `action.finished` event** for the same denied `.send` receipt.
- **Required Fix:**
  In `reconcileCliSettlements` (`packages/node-core/src/action-pipeline.ts:882`) and `closeUnsettledCliReceipt` (`action-pipeline.ts:851`), skip receipts with `receipt.outcome === 'denied'` (which never started and must never have an `action.finished` event).

---

### RR-05 [Low] (`AS-inherited`, `demonstrated`): `resolveNodeSessionId` parses empty or whitespace stdout as Session `0` (`Number("") === 0`) and accepts non-decimal strings

- **Location:**
  - `packages/node-core/src/desktop-config.ts:162-181` (`resolveNodeSessionId`)
- **Status:** `demonstrated`
- **Spec AS impact:** `AS-inherited`
- **Mechanism & Exploit:**
  In `packages/node-core/src/desktop-config.ts:174-179`:
  ```ts
  const parsed = Number(stdout.trim());
  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  return null;
  ```
  In JavaScript, `Number("".trim()) === 0` and `Number("0x10") === 16`. If the PowerShell helper exits `0` with empty or whitespace-only stdout, `resolveNodeSessionId` returns `0` (Windows Session `0`, the non-interactive services session) instead of `null` (fail-closed).
- **Required Fix:**
  Validate `const trimmed = stdout.trim(); if (!/^\d+$/.test(trimmed)) return null;` before `Number.parseInt(trimmed, 10)`.

---

### RR-06 [Low] (`AS-inherited`, `demonstrated`): Single-use handle consumption on page 1 breaks `desktop.inspect` control pagination (`page >= 2` always returns `refresh_required`), and `native-fixture.test.ts` never tested `control_filter` by `automation_id` on native Windows

- **Locations:**
  - `packages/adapters-desktop/src/adapter.ts:461-477`, `520-528` (`invokeInspect`)
  - `packages/adapters-desktop/test/native-fixture.test.ts:272-298`
  - `packages/adapters-desktop/test/fixtures/canary-form.ps1:27-68`
- **Status:** `demonstrated` (live on native Windows 11)
- **Spec AS impact:** `AS-inherited`
- **Mechanism & Exploit:**
  1. **Pagination broken by single-use handle consumption:**
     `desktop.inspect` slices controls into pages of `MAX_CONTROLS_PER_PAGE = 200` and emits `next_page: page + 1` (`packages/adapters-desktop/src/adapter.ts:520-528`). However, `invokeInspect` sets `entry.consumed = true` (`adapter.ts:477`) on the first `desktop.inspect` call (`page: 1`). When the caller requests `page: 2` using the same `(window_id, freshness_token)`, `entry.consumed` is `true` and `invokeInspect` returns `{ status: 'refresh_required', controls: [] }`. The unit test at `packages/adapters-desktop/test/adapter.test.ts:421-447` masked this by requesting `page: 2` directly after `desktop.state` without ever requesting `page: 1`.
  2. **Native test gap on `automation_id` in `canary-form.ps1`:**
     When `canary-form.ps1` runs under Windows PowerShell 5.1 (`System.Windows.Forms`), WinForms controls do not expose `$ctrl.Name` (`"pwdBox"`, `"okButton"`, etc.) as the out-of-process UIA `Current.AutomationId`; instead, UIA reports `Current.ControlType.ProgrammaticName = "ControlType.Pane"` and `Current.AutomationId = "<decimal HWND>"`. Because of this, `native-fixture.test.ts:272-298` (`"acceptance 4: control_filter matches by type and automation_id"`) only tested `control_filter: 'Pane'` and never tested filtering by `automation_id` on native Windows.
- **Required Fix:**
  Either remove pagination if handles are strictly single-use, or bind pagination to the single enumeration handle / issue a per-page continuation token. In `canary-form.ps1` and `native-fixture.test.ts`, assert `control_filter` matching against an actual native `automation_id` returned by page 1.

---

### RR-07 [Low] (`AS-inherited`, `demonstrated`): `DESKTOP_UIA_PS1` reads `WindowText` and enforces `max_windows` (64) across all desktop windows before `authorized_apps` filtering; `inspect_window` walks the UIA subtree before checking `sameIdentity`; and `tools/orient.mjs` config validation is out of sync with F1/F3b

- **Locations:**
  - `packages/adapters-desktop/src/probe.ts:250-285` (`enumerate_windows`), `300-353` (`inspect_window`)
  - `tools/orient.mjs:47-105` (`validateNodeConfig`)
- **Status:** `demonstrated`
- **Spec AS impact:** `AS-inherited`
- **Mechanism & Exploit:**
  1. **Unfiltered window titles written to temp `output.json` and pre-filter `max_windows` truncation (`probe.ts:250-285`):**
     `enumerate_windows` calls `[TorosNative]::WindowText($h)` (`GetWindowText`) and enforces `max_windows` (64) across **every** top-level window on the desktop with a readable process identity before `resolveState` (`adapter.ts:304`) filters by `authorized_apps`. Consequently, up to 64 unauthorized window titles are written to `%TEMP%\toros-desktop-*\output.json` on every `desktop.state` call, and if 64 unauthorized windows sit above an authorized window in Z-order, the authorized window is truncated away before `authorized_apps` filtering runs.
  2. **`inspect_window` walks the UIA subtree before checking `sameIdentity` (`probe.ts:310-353`):**
     In `inspect_window`, `$identity = ReadIdentity($winPid)` is computed at line 310, then `FindAll(TreeScope.Subtree, TrueCondition)` walks up to 501 controls of the target HWND (lines 319–340), and only at line 341 does the script check `if (-not (sameIdentity $identity $req.expect_identity))`. If a PID/HWND was recycled (TOCTOU), the foreign window's UIA subtree is traversed before the identity mismatch is rejected.
  3. **`tools/orient.mjs` config validation drift (`tools/orient.mjs:47-105`):**
     `validateNodeConfig` in `tools/orient.mjs` was not updated in F1 or F3b: it does not enforce printable ASCII (`0x21–0x7E`) on `operator_token`, and it does not validate `adapters.desktop.authorized_apps` (allowing bare-string `authorized_apps: ["notepad.exe"]` to pass `orient.mjs` preflight checks and then fail `node-core` startup).
- **Required Fix:**
  1. Pass `authorized_apps` into `enumerate_windows` (or filter by `authorized_apps` in `DESKTOP_UIA_PS1` before calling `WindowText` and counting toward `$maxw`).
  2. In `inspect_window` (`probe.ts:310-318`), check `if (-not (sameIdentity $identity $req.expect_identity))` immediately after `ReadIdentity($winPid)`, before calling `FindAll`.
  3. Update `validateNodeConfig` in `tools/orient.mjs` to match `core.ts` (`operator_token` printable ASCII) and `desktop-config.ts` (`validateDesktopAuthorizedApps`).

---

## 3. Attack on the New Remediation Surface (§2)

### 3.1 Contract Amendment A8 (Two-Phase Resolve)
- **Core validator (`validateResolvedTargets` in `packages/node-core/src/action-pipeline.ts:242-345`):**
  - Verified live and by unit tests against malformed resolver outputs:
    - Prototype keys (`__proto__`, `constructor`, `toString`) are rejected by `FORBIDDEN_TARGET_KEYS` (`action-pipeline.ts:207`).
    - Duplicate keys, empty keys, keys `> 256` chars, and target arrays `> 64` entries fail closed with `E_ADAPTER_FAILURE`.
    - `app` targets with relative paths, UNC paths (`\\server\share\a.exe`), device paths (`\\?\`, `\\.\`), forward slashes, trailing dots/spaces in path segments, 8.3 short names (`~1`), bad SHA-256 hex, non-UTC timestamps, or mismatched `signature`/`signer` pairs all fail closed with `E_ADAPTER_FAILURE` before `authorizeTargets` or `invoke`.
    - Resolvers that throw or exceed the shared action timeout fail closed (`E_ADAPTER_FAILURE` / `E_TIMEOUT`).
- **Can any path reach `invoke` without decisions?**
  - In `executeAction` (`action-pipeline.ts:550-618`), if `adapter.resolver` is defined, `resolve` and `core.authorizeTargets` always run before `adapter.invoke`, passing `target_decisions: decisionsMap`. If `invoke` is called directly with `ctx.target_decisions === undefined`, both `createDesktopAdapter` (`packages/adapters-desktop/src/adapter.ts:384`, `480`) and `createMachineAdapter` (`packages/adapters-machine/src/adapter.ts:590`) fail closed (`windows: []` / `'unauthorized'`).
- **Can identity strings or capability targets bypass `envelope.forbidden`?**
  - **Yes — demonstrated in RR-01 and RR-03:**
    1. Any `envelope.forbidden` string containing `.`, `-`, `_`, space, or `®` is bypassed by `isForbidden` (RR-01).
    2. Directory segments of `identity.image_path` are not passed to `isForbidden` by `PolicyImpl.decideTarget` (RR-01).
    3. `PolicyImpl.decideTarget` does not check `isForbidden` at all for `capability` targets (RR-03).

### 3.2 Identity & Session Code in `DESKTOP_UIA_PS1` and `NODE_SESSION_ID_PS1`
- **Injection analysis:**
  - Neither `DESKTOP_UIA_PS1` (`packages/adapters-desktop/src/probe.ts:51-358`) nor `NODE_SESSION_ID_PS1` (`packages/node-core/src/desktop-config.ts:114-127`) interpolates any caller or UI value into PowerShell source, `Add-Type` C# source, or command-line arguments. Probe inputs are serialized as JSON to `input.json` in a private `fs.mkdtemp` directory and passed via `-File script.ps1 input.json output.json` with `shell: false`.
- **What an `identity_unavailable` window can still disclose:**
  - When `ReadIdentity($winPid)` returns `$null`, `enumerate_windows` (`probe.ts:266-272`) increments `$unavailable++` and `continue`s before calling `WindowText`. Thus only the aggregate integer count `identity_unavailable` is disclosed in `desktop.state` output and `receipt_extra`.
  - However, for windows whose identity *is* readable by the current user (`ReadIdentity($winPid) != $null`) but **not** in `authorized_apps`, `enumerate_windows` (`probe.ts:276-280`) still calls `WindowText` and writes their titles into `%TEMP%\toros-desktop-*\output.json` before `resolveState` filters them out in Node (RR-07a).
- **Handle hygiene:**
  - In `TorosNative` (`probe.ts:56-135`), `OpenProcess` is paired with `CloseHandle` in `finally`, `OpenInputDesktop` with `CloseDesktop` in `finally`, `WTSQuerySessionInformation` with `WTSFreeMemory` in `finally`, and `File.OpenRead` / `SHA256.Create` use `using (...)` blocks.
  - On Windows 11, renaming a running executable on disk (`fs.renameSync(imagePath, imagePath + '.running.exe')`) causes `QueryFullProcessImageName` (`GetProcessImage`) to return the renamed path, which `sameIdentity` in `DESKTOP_UIA_PS1` detects (`image_path` mismatch) and rejects.
- **Session enforcement (`AR-04`) and PowerShell 5.1 behavior:**
  - `DESKTOP_UIA_PS1` checks `SessionConnectState() -eq 'active'` (`WTSActive == 0` on `ProcessIdToSessionId(Process.GetCurrentProcess().Id)`) and `InputDesktopName() -eq 'Default'`. On the unlocked interactive desktop, this succeeds natively; unit tests (`probe.test.ts:182-222`) verify that `locked` and `disconnected` states return `{ status: 'unavailable', windows: [] }`.
  - Under PowerShell 7 (`pwsh`), inherited `PSModulePath` breaks `Get-AuthenticodeSignature` in Windows PowerShell 5.1 (`RR-02a`).
  - `resolveNodeSessionId` (`desktop-config.ts:174-179`) misparses empty stdout as Session `0` (`RR-05`).

### 3.3 Configuration (`AppRule[]`)
- `validateDesktopAuthorizedApps` (`packages/node-core/src/desktop-config.ts:43-99`) rejects bare strings, empty objects, relative/UNC/device/8.3 paths, and extra keys.
- However, as demonstrated in **RR-02b**, `{ signer: "Microsoft Windows", product_name: "Microsoft® Windows® Operating System" }` is accepted by `validateDesktopAuthorizedApps` and matches `notepad.exe`, `powershell.exe`, `cmd.exe`, `explorer.exe`, and any copy of those binaries in `%TEMP%`.

---

## 4. Contract Integrity (§3)

Verified via `git diff 2847726..HEAD -- packages/contracts`:

1. `packages/contracts/src/common.ts`: Adds `ConversationTurnRole` (`'user' | 'assistant'`) used by `ConversationTurn`.
2. `packages/contracts/src/envelope.ts`: Adds `AppRule` (`{ image_sha256 } | { image_path } | { signer, product_name }`) and optional `allowed_apps?: readonly AppRule[]` on `JobEnvelope` (Amendment A8).
3. `packages/contracts/src/policy.ts`: Adds `AppIdentity`, `ResolvedTarget`, `TargetDecisions`, and `authorizeTargets?(envelope, targets): Promise<TargetDecisions>` on `PolicyEngine` (Amendment A8).
4. `packages/contracts/src/adapter.ts`: Adds `TargetResolver`, `actor: string` and `target_decisions?: TargetDecisions` on `AdapterContext`, and `resolver?: TargetResolver` on `Adapter` (Amendment A8).
5. `packages/contracts/src/index.ts`: Exports only the Amendment A8 types and the restored `ConversationTurnRole` type.

`packages/contracts` matches `docs/specs/00-CONTRACTS.md` §10 Amendment A8 with zero unauthorized contract drift.

---

## 5. Audit of Earlier Review Comments on PRs #11 and #12

After completing and recording our independent code and native analysis above, we inspected the earlier Argon review comments on PR `#11` (F5) and PR `#12` (F3b):

- **What the earlier reviews caught and fixed:**
  - On `#11` (F5): Caught 5-minute caching of drive-reader failures/timeouts, `ctx.target_decisions === undefined` failing open, missing `TOROS_REAL_TESTS=1` coverage for the production drive reader, and incomplete unauthorized-entry redaction test coverage.
  - On `#12` (F3b): Caught the `Add-Type` C# `int`/`uint` compile error, PowerShell read-only `$PID` variable collision, PowerShell 5.1 `0u` syntax error in `NODE_SESSION_ID_PS1`, wrong `WTS_CONNECTSTATE_CLASS` enum mapping in `SessionConnectState`, missing 8.3 path validation, and dropped `truncated` propagation.
- **What the earlier reviews on `#11`, `#12`, and `#8` (F3a) missed:**
  - **RR-01:** Missed that `isForbidden` splits `term` on `/[^a-z0-9]+/` without splitting `forbidden`, rendering punctuated/multi-word `forbidden` entries (`"powershell.exe"`, `"Microsoft Windows"`, etc.) completely inert, and missed that `decideTarget` only checks `basename(image_path)`.
  - **RR-02:** Missed that `runPowerShell` inherits `PSModulePath` from `pwsh` (causing `Get-AuthenticodeSignature` to throw and silently report every binary as `unsigned`), and missed that Windows inbox binaries (`notepad.exe`, `powershell.exe`, `cmd.exe`, `explorer.exe`) share identical `{ signer, product_name }` even when copied to `%TEMP%`.
  - **RR-03:** Missed that `PolicyImpl.decideTarget` ignores `envelope.forbidden` on `capability` targets, that non-probed registered adapter IDs (`desktop`, `chrome`) still leak in `machine.inventory`, and that filesystem probes execute before `ctx.target_decisions` is checked.
  - **RR-05:** Missed `Number(stdout.trim()) === 0` on empty stdout in `resolveNodeSessionId`.
  - **RR-06:** Missed that single-use handle consumption on page 1 breaks `desktop.inspect` pagination (`page: 2`), and that `native-fixture.test.ts` never tested `control_filter` by `automation_id`.
  - **RR-07:** Missed pre-filter `WindowText` writes / `max_windows` truncation in `enumerate_windows` and pre-`sameIdentity` UIA subtree traversal in `inspect_window`.

---

## 6. Required Changes Before Clearing the AR Gate

To clear the AR gate and unblock Spec AS (`mbulentcakar/Toros#1`), the following changes must be implemented and verified natively:

1. **Fix `isForbidden` and `decideTarget` for `app` targets (RR-01):**
   - Tokenize `forbidden` entries in `isForbidden` (`packages/envelope/src/envelope.ts:499-513`) using `/[^a-z0-9]+/` and match contiguous token sequences against `term` tokens so punctuated and multi-word entries (`"notepad.exe"`, `"toros-fixture"`, `"Microsoft Windows"`, `"desktop.inspect"`) match.
   - Check the full `identity.image_path` (not just `basename`) against `isForbidden` in `PolicyImpl.decideTarget` (`packages/policy/src/index.ts:335`).
   - Check window `title` and control `automation_id` against `envelope.forbidden` (or include `title` in target authorization and filter matching controls).
2. **Fix Authenticode module loading and `{ signer, product_name }` over-matching (RR-02):**
   - Sanitize `PSModulePath` in `runPowerShell` (`packages/adapters-desktop/src/probe.ts:467-478`) and `resolveNodeSessionId` (`packages/node-core/src/desktop-config.ts:162`) to Windows PowerShell 5.1's `$PSHome\Modules`, and explicitly import `Microsoft.PowerShell.Security` in `DESKTOP_UIA_PS1`. Add a native test in `native-fixture.test.ts` verifying `{ signer, product_name }` when launched under `pwsh`.
   - Prevent `{ signer, product_name }` rules with the generic OS umbrella `"Microsoft® Windows® Operating System"` from authorizing all Windows inbox shells (`powershell.exe`, `cmd.exe`, `explorer.exe`).
3. **Fix `decideTarget` for `capability` targets and `machine.inventory` pre-decision probing / adapter leak (RR-03):**
   - Check `if (isForbidden(envelope, target.capability)) return 'denied';` in `PolicyImpl.decideTarget` (`packages/policy/src/index.ts:313-315`).
   - Check `ctx.target_decisions` in `createMachineAdapter.invoke` (`packages/adapters-machine/src/adapter.ts:500-602`) before running `resolveFixedDrives` and `detectPresent`, and stop leaking registration of non-probed adapters (`desktop`, `chrome`) to unauthorized jobs.
4. **Fix `reconcileCliSettlements` on denied `.send` receipts (RR-04):**
   - Skip receipts with `receipt.outcome === 'denied'` in `reconcileCliSettlements` (`packages/node-core/src/action-pipeline.ts:882-910`) and `closeUnsettledCliReceipt`.
5. **Close Low-severity defects (RR-05, RR-06, RR-07):**
   - Require `/^\d+$/` before parsing stdout in `resolveNodeSessionId` (`packages/node-core/src/desktop-config.ts:174-179`).
   - Fix `desktop.inspect` pagination with single-use handles (`packages/adapters-desktop/src/adapter.ts:461-477`) and add a native `automation_id` filter assertion in `native-fixture.test.ts`.
   - Check `sameIdentity` before walking the UIA subtree in `inspect_window` (`packages/adapters-desktop/src/probe.ts:310-341`), filter `authorized_apps` before reading `WindowText` / applying `max_windows` in `enumerate_windows`, and bring `tools/orient.mjs` (`validateNodeConfig`) into sync with F1 and F3b.

