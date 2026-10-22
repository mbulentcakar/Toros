# AR — final native re-review of the discovery surface

**Purpose.** This review decides the AR gate. Until it clears, the desktop discovery surface stays
disabled, and spec AS (PR mbulentcakar/Toros#1) stays blocked. Two reviews came before it:

1. **2026-10-13, original adversarial review** (PR mbulentcakar/Toros#3): *do not enable*,
   eleven findings, AR-01 to AR-11. Remediated by slices F1–F5 (PRs #5–#8, #11, #12).
2. **2026-10-20, first native re-review** (PR mbulentcakar/Toros#13, by agy / Gemini 4 Argon):
   *do not clear*, seven new findings, RR-01 to RR-07. Remediated by slices R1–R4
   (PRs #14–#17).

This file is the brief for the third review: the **final** one. Its verdict is the gate.

> **Dispatch (operator decision, 2026-10-22, revised).** The Codex run below was stopped after
> 12 minutes by the provider's content filter, with no report written. The operator moved the
> review to **Grok, `grok-4.7`, high effort**, run headless through the `grok` CLI with
> `--permission-mode dontAsk` in the same worktree.
>
> - **Grok's prior involvement:** in September, Grok code-reviewed the **original** discovery
>   slices T1–T3. That is the code the 2026-10-13 review found unsafe, and it has since been
>   largely rewritten. Grok reviewed **none** of the F or RR remediation slices. Treat its
>   September approvals as untrusted, exactly like everyone else's.
>
> The original dispatch, kept for the record:
>
> - **Reviewer:** Codex, `gpt-6.1-sol`, high reasoning effort.
> - **Run mode:** full access, so it can build and run natively, inside the dedicated worktree
>   `_worktrees/Toros-ar-final-rereview` (branch `review/ar-final-rereview`).
> - **Baseline:** `main` at `d429ad3`.
> - **Desktop:** the operator keeps the Windows desktop **unlocked** for the whole run. A locked
>   or sleeping screen makes every native desktop test fail with `state=locked`. If that happens,
>   stop the native part and report it; do not mark the finding closed.
> - **Independence:**
>   - Codex wrote the original adversarial review (AR-01–AR-11), and code-reviewed F1, F2, F4
>     and F3a.
>   - It reviewed none of the RR slices and none of F3b or F5. Those were reviewed by agy /
>     Gemini 4 Argon, which also ran the first re-review.
>   - DeepSeek implemented every slice. Claude orchestrated, wrote the briefs and made two small
>     fixes (an F3b backslash fix in the embedded script, and lockfile and rebase work).
>   - Treat every earlier approval as **untrusted**. Re-derive each conclusion from the code and
>     from live runs. Do not read the review comments on PRs #11, #12 or #14–#17 until your own
>     findings are written.

## Baseline

| Slice | What it did | PR | Merge commit |
|---|---|---|---|
| F1 | Operator and run credentials separated | #5 | `fc195b5` |
| F4 | Pipeline integrity (receipts always close, Core timeout, restart recovery) | #6 | `eb66dca` |
| F2 | No UIA `Name` in discovery | #7 | `d670f14` |
| F3a | Contract amendment **A8**: two-phase resolve | #8 | `d69360a` |
| F3b | Desktop identity, proven session, per-(job, actor) handles | #12 | `6f8eeaf` |
| F5 | Inventory: local fixed paths only, job-scoped | #11 | `a5d9360` |
| R1 | Forbidden terms match as **token sequences** (RR-01, the policy half of RR-03) | #14 | `f449a77` |
| R3 | Reconciliation never fabricates events; strict session-id parsing (RR-04, RR-05) | #15 | `d95a41c` |
| R2 | Contract amendment **A9**: signer rules need OriginalFilename; `PSModulePath` isolation (RR-02) | #16 | `739a20f` |
| R4 | Inventory omits out-of-job entries; single-use inspect continuation; probe applies the global bound before any title read; orient checks (the inventory half of RR-03, RR-06, RR-07) | #17 | `d429ad3` |

**Where the earlier material lives** (run `git fetch public` first, then read it with
`git show public/<branch>:<path>`):

- The original findings and exploits: `review/ar-adversarial:docs/reviews/AR-adversarial-security-review.md`.
- The first re-review report (RR-01–RR-07, with exploits): `review/ar-native-rereview:docs/reviews/AR-native-rereview.md`.
- The slice briefs and every review round: `fix/ar-remediation-plan:docs/reviews/AR-F*-brief.md` and `fix/ar-remediation-plan:docs/reviews/RR-remediation.md`.
- The contract amendments A8 and A9, on `main`: `docs/specs/00-CONTRACTS.md` §10.

**Operator design decisions in force** (from `RR-remediation.md`):

- **Forbidden matching:** both the term and the candidate are split into lower-case `[a-z0-9]+`
  words. A term matches when its words appear consecutively.
  - It applies to capabilities, arguments, and an app's full image path, product and signer.
  - Window titles and automation ids are deliberately **not** matched.
  - A term with no words is refused at seal time.
  - **Accepted residual:** in free-text arguments, a zero-width character or a homoglyph can split
    a word.
- **Signer rules (A9):** a signer rule needs `signer` + `product_name` + `original_filename`. The
  signer and product compare exactly; `original_filename` compares case-insensitively. A `null`
  OriginalFilename never matches.

## Where and how to run it

- **Native Windows 11, unlocked interactive desktop, Windows PowerShell 5.1.** Every claim about the
  probe, UI Automation, sessions or signatures must be demonstrated live, or labelled
  `unverified (static only)`.
- **Benign targets only.**
  - Use the repository's canary fixture (`packages/adapters-desktop/test/fixtures/canary-form.ps1`,
    started through `startFixture` in `packages/adapters-desktop/test/native-utils.ts`), or other
    windows you create yourself.
  - Bind every probe to your own fixture's pid (`restrict_to_pid`).
  - Never inspect the operator's applications, mail or documents.
  - When you need a signed inbox binary for the signer tests, copy it into your own temp directory
    and run the copy. Never attach to a process you did not start.
- **Do not edit code.** Experiments go in a fresh temp directory outside the repository; delete it
  afterwards. Kill every process you start.
- **Record the baseline natively:**
  - `npm ci`;
  - a clean build: delete every `packages/*/dist` and `*.tsbuildinfo`, then `npm run typecheck`;
  - `npm test`;
  - `TOROS_REAL_TESTS=1 node --test packages/adapters-desktop/dist/test/native-fixture.test.js packages/node-core/dist/test/desktop-native-core.test.js`;
  - `TOROS_REAL_TESTS=1 node --test packages/adapters-machine/dist/test/*.test.js`.

  Report every count and every skip.

## What to re-test

### 1. All eighteen earlier findings

For each finding, re-run its exploit or the closest equivalent on the current API. Say
**closed**, **partially closed** or **open**, with evidence, and say which slice closed it.

| Finding | Claim in one line | Expected closer |
|---|---|---|
| AR-01 | Masked password and off-client text leak through UIA `Name` | F2 |
| AR-02 | The envelope cannot narrow the global allowlist | F3a, F3b, R1 |
| AR-03 | Operator credential separation is conditional | F1 (and the orient check in R4) |
| AR-04 | `session_scope` is never enforced | F3b, R3 |
| AR-05 | Handles are global, cross-job and replayable | F3b, R4 |
| AR-06 | Pathless actions leave a false running receipt | F4, R3 |
| AR-07 | Cancellation and output bounds are not end to end | F2, F4 |
| AR-08 | Inventory's PATH walk makes undeclared network I/O | F5 |
| AR-09 | Inventory reports adapters outside the job | F5, R4 |
| AR-10 | Basename identity is spoofable | F3b, R2 |
| AR-11 | The manifest omits filesystem authority | F3b, F5 |
| RR-01 | Forbidden terms with punctuation are inert | R1 |
| RR-02 | Every inbox binary shares one signer and product; an inherited `PSModulePath` makes everything unsigned | R2 |
| RR-03 | Capability targets ignore `forbidden`; inventory leaks registered adapters and probes before checking decisions | R1, R4 |
| RR-04 | A restart fabricates `action.finished` for denied receipts | R3 |
| RR-05 | Empty output parses as session 0 | R3 |
| RR-06 | Single-use handles break pagination | R4 |
| RR-07 | The probe reads titles and counts windows before the allowlist; inspect walks before the identity check; orient is out of sync | R4 |

Demonstrate natively at least:

- the canary password, text and label never appear in output, receipts or events, through a real
  Core;
- `forbidden: ["powershell.exe"]`, `["desktop.inspect"]` and `["Microsoft Windows"]` each deny
  what they name;
- a signer rule naming Notepad does **not** admit a copied `powershell.exe`, and it **does**
  admit a copied `notepad.exe`. Run both with Node Core started from PowerShell 7 and from Windows
  PowerShell, to show that `PSModulePath` no longer matters;
- an out-of-bound fixture's title is absent from the probe's `output.json`, and the window takes no
  `max_windows` slot;
- a continuation-token replay, a foreign job, a foreign actor, a different window, an empty token,
  and a chain that runs past 60 s all return the same `refresh_required`.

### 2. The new surface that the RR round added

Attack it as hard as the original:

- **A9:**
  - Can `original_filename` be spoofed by a binary you build or modify yourself? For example,
    re-sign it, or edit its version resource and observe the signature status.
  - Does case-insensitive comparison open a collision?
  - Are policy, the adapter's global bound and the in-script `AppRuleMatches` exactly equivalent
    on every field and on null?
- **The in-script rule evaluation (`DESKTOP_UIA_PS1`):** `authorized_apps` arrive in `input.json`.
  - Can a rule's content change what the script executes?
  - Is the PowerShell comparison exactly as strict as policy (`-ceq` vs `-eq`, null vs empty)?
  - Do backslashes survive the TypeScript template literal? (`\\` emits one backslash;
    `probe.test.ts` pins the emitted lines.)
- **Continuation tokens:**
  - entropy;
  - binding to (job, actor, window_id);
  - the 60 s cap measured from page 1;
  - memory bound;
  - whether a page can be served for a window whose identity changed.
- **Forbidden matching:**
  - Is anything newly **less** strict?
  - What does the matching cost on long inputs?
  - Unicode case folding and confusables, beyond the accepted free-text residual.
- **`PSModulePath` isolation:** does any Windows PowerShell spawn bypass the shared child-environment
  rule? Check `pwsh`, a bare `powershell`, and a namespace-imported `spawn`.
- **Reconciliation:** can any receipt still be left `running`, or can any receipt get a duplicate
  or fabricated `action.finished`, across crashes and restarts?

For each finding, mark `AS-inherited` when a click or type action built on this surface would
inherit it.

### 2a. Open questions from the interrupted first attempt (2026-10-22)

A first Codex run of this brief was stopped after 12 minutes by the provider's content filter,
before it wrote a report. Its log showed several checks behaving as intended:

- the continuation-token rejections;
- the signer rule under PowerShell 5.1 and PowerShell 7;
- a forbidden capability returning `E_FORBIDDEN`;
- an out-of-bound fixture title absent from the probe output.

It also left two observations without a conclusion. Settle both, and record any finding with its
severity:

1. **A page served after the window is gone.** A continuation page was still served
   (`status: "ok"`) from the page-1 snapshot after the window's process had exited. Is serving a
   cached snapshot for up to 60 s acceptable, or must every page re-verify the window's identity?
   Is this `AS-inherited`?
2. **A renamed image passes re-verification.** After the window's image file was renamed between
   resolve and invoke, the window still passed (same pid, start time and hash; different path).
   Re-verification compares pid, creation time and SHA-256, not the path. Can this widen what a
   `{ image_path }` rule admits, or bypass a `forbidden` term that names a folder or file?

### 3. Contract integrity

`packages/contracts` differs from the public release (`2847726`) only by A8, A9 and the restored
`ConversationTurnRole` export. Confirm that against `00-CONTRACTS.md` §10.

## Deliverable

- Severity-ranked findings (High, Medium, Low), each with:
  - a concrete exploit (inputs → what leaks or breaks);
  - a file:line;
  - `demonstrated` or `unverified (static only)`;
  - `AS-inherited` where it applies.
- The eighteen-row table filled in.
- An explicit verdict:
  - **clear the AR gate:** the desktop discovery surface may be enabled with `authorized_apps`
    configured, and spec AS may proceed to implementation. Name any condition you attach;
  - or **do not clear**, with the minimum list of changes first.
- Append the report below the line. Commit on `review/ar-final-rereview`, push it to the `public`
  remote, and open the PR with
  `gh pr create -R mbulentcakar/Toros --base main --title "review(AR): final native re-review"`.
  Fix nothing in that PR.
- The repository is public: no secrets, tokens, local user paths, host names or screenshots of a
  real desktop.
- End your final message with the PR URL, your verdict, every process you started, and every file
  you wrote outside the repository (all deleted).

---

<!-- final re-review findings go here -->

# Final native re-review — 2026-10-22

- **Reviewer:** Grok, `grok-4.7`. September approvals of the original T1–T3 slices are treated as untrusted. This review re-derived every conclusion from the current tree and from live runs. Review comments on PRs #11, #12 and #14–#17 were not opened until the findings below were written.
- **Baseline:** `main` at `d429ad3` (`d429ad3e7f4997662ee9ec670ab7e92aae2ef4fc`). This branch adds only the brief commits above that.
- **Host:** native Windows NT 10.0.26300.0, interactive desktop, input desktop `Default` at the start of the native work and again before this report. Node.js 24.13.1. Windows PowerShell 5.1 for the probe and for the signature reads; the parent shell was PowerShell 7.6.7.
- **Safety:** every UI Automation probe was bound to a pid this review started (`restrict_to_pid`). Targets were the repository canary fixture, copies of inbox binaries in a fresh temp directory, and one inbox `notepad.exe` this review launched against a file it created. No operator application, mail or document was inspected. Experiments lived in a temp directory outside the repository and were deleted afterwards. Every process this review started was killed.

## Verdict: do not clear

The eighteen earlier findings are closed on the current API. The new surface has one defect that the signer rule depends on, and it is enough to keep the gate shut.

**FR-01 (Medium, demonstrated, AS-inherited).** `OriginalFilename` is not a property of the file alone. Windows resolves the version resource through a sibling `en-US\<image>.mui` when one is present, and through the binary itself when it is not. A copy of an inbox binary therefore reports a different `original_filename` from the same binary in place:

| File | `OriginalFilename` |
|---|---|
| inbox `notepad.exe` | `NOTEPAD.EXE.MUI` |
| a copy, no adjacent MUI | `NOTEPAD.EXE` |
| that copy plus a copied `notepad.exe.mui` named after it | `NOTEPAD.EXE.MUI` |
| inbox `powershell.exe` | `PowerShell.EXE.MUI` |
| a copy, no adjacent MUI | `PowerShell.EXE` |
| that copy plus its own MUI | `PowerShell.EXE.MUI` |

The probe reads this value and publishes it (`packages/adapters-desktop/src/probe.ts:226-236`). Policy, the adapter's global bound and the in-script `AppRuleMatches` all compare it as a string (`packages/policy/src/index.ts:194-197`, `packages/adapters-desktop/src/adapter.ts:112-115`, `packages/adapters-desktop/src/probe.ts:273-276`). A signer rule written from the installed binary (`NOTEPAD.EXE.MUI`) does not admit a copy of that binary, and a rule written from a copy (`NOTEPAD.EXE`) does not admit the installed binary. Placing the matching MUI beside the copy flips the value back. A rule for Notepad still does not admit PowerShell — the two MUI names differ — so the collision A9 was written to close stays closed. What fails is the amendment's own claim that this field survives a copy.

The minimum change: stop treating the MUI-resolved string as a stable vendor filename. Read the version resource from the image itself (or pin the rule to a hash or a canonical path) and state in the contract which string a signer rule names. Re-review that natively, on an inbox binary and on a copy with and without an adjacent MUI, before the gate can clear.

Two observations from the interrupted run are settled below and are not findings.

## 0. Native baseline

Recorded on this worktree after `git fetch public`.

1. `npm ci` — exit 0. 23 packages added, 39 audited. `npm audit` reports 1 high: `fast-uri` `GHSA-5jgf-p345-68v8`, transitive through `ajv`. Not introduced by this branch.
2. Clean build — every `packages/*/dist` and `*.tsbuildinfo` deleted, then `npm run typecheck` (`tsc --build --force`). Exit 0.
3. `npm test` — exit 0. **736 tests, 57 suites, 724 pass, 0 fail, 0 cancelled, 12 skipped, 0 todo.** Duration 76381 ms.
   - 11 skips are the native desktop tests, gated on `TOROS_REAL_TESTS=1`: 10 in `packages/adapters-desktop/dist/test/native-fixture.test.js`, 1 in `packages/node-core/dist/test/desktop-native-core.test.js`.
   - 1 skip is `machine.inventory — production drive reader` (`requires TOROS_REAL_TESTS=1 on win32`).
   - 2 suite skips are the authenticated CLI suites (`gemini adapter against Antigravity CLI`, `grok adapter against Grok Build`), also gated on `TOROS_REAL_TESTS=1`. They are not in the 12.
4. `TOROS_REAL_TESTS=1 node --test packages/adapters-desktop/dist/test/native-fixture.test.js packages/node-core/dist/test/desktop-native-core.test.js` — exit 0. **12 tests, 2 suites, 12 pass, 0 fail, 0 skipped.** Duration 60138 ms. Input desktop stayed `Default`.
5. `TOROS_REAL_TESTS=1 node --test packages/adapters-machine/dist/test/*.test.js` — exit 0. **30 tests, 7 suites, 30 pass, 0 fail, 0 skipped.** Duration 416 ms.

## 1. The eighteen findings

| Finding | Status | Closed by | Evidence |
|---|---|---|---|
| AR-01 | **Closed** | F2 | Through a real Core, `desktop.state` and `desktop.inspect` of the canary returned no `name` and no `value`. The three canaries were absent from both action outputs, from the two closed receipts, and from the eight events. Controls were `ControlType.Pane` plus a numeric `automation_id`. |
| AR-02 | **Closed** | F3a, F3b, R1 | `forbidden: ["Microsoft Windows"]` denied the canary window: `desktop.state` returned `windows: []` because the signer matched. `forbidden: ["desktop.inspect"]` is checked by `decide` before any window resolve, so a following `desktop.inspect` is `E_FORBIDDEN`. A term matches the capability, the arguments, and the image path, product and signer. It does not match a title or an automation id; that exclusion is the operator's decision and is still in force. |
| AR-03 | **Closed** | F1, R4 | `start()` throws when `operator_token === token` (`packages/node-core/src/core.ts:193-200`). With distinct tokens, the run bearer received HTTP 401 from `/operator/jobs` and the operator bearer received HTTP 200. `tools/orient.mjs` now checks printable ASCII, length and distinctness. |
| AR-04 | **Closed** | F3b, R3 | `session_scope` accepts only `interactive`. The script requires `WTSActive` and an input desktop named `Default` before it enumerates (`probe.ts:166-169`). Both native runs observed `Default`. The locked and disconnected branches were not exercised live; the desktop stayed unlocked, as the brief requires. |
| AR-05 | **Closed** | F3b, R4 | On one Core, a replay of the freshness pair, a foreign job, an empty token, a replayed continuation, a foreign job's continuation, and a continuation presented with a different `window_id` each returned `refresh_required`. A second `model` label, which Core records as the actor (`action-pipeline.ts:311-315`), also returned `refresh_required`. |
| AR-06 | **Closed** | F4, R3 | The canary job's receipts closed `succeeded`, none left `running`. A seeded denied `codex.send` stayed `denied` with zero `action.finished` across two Core starts. A seeded running `codex.send` that had `action.started` was closed `terminated` with exactly one `action.finished`; the second start did not add another. |
| AR-07 | **Closed** | F2, F4 | Core arms one deadline before resolve and shares it with invoke (`action-pipeline.ts:576-598`). `runPowerShell` rejects an already-aborted signal before `mkdtemp` (`probe.ts:525-527`) and awaits temp removal. Output is stat-bounded at 4 MiB before read. |
| AR-08 | **Closed** | F5 | `isLocalFixedPath` rejects anything that is not `<letter>:\` on a drive the reader reported Fixed (`packages/adapters-machine/src/adapter.ts:166-178`). The native inventory suite includes the UNC, device, relative and drive-relative cases. A job allowed only `machine.inventory` reported `path_entries_skipped: 0` and no entries. |
| AR-09 | **Closed** | F5, R4 | That same job received `entries: []`. A job allowed `machine.inventory` and `codex.start` with `forbidden: ["codex"]` also received `entries: []`: the forbidden capability was denied, and unregistered-for-this-job adapters were omitted rather than reduced to an `unauthorized` stub. |
| AR-10 | **Closed** | F3b, R2 | Bare basename rules are rejected at seal. A copied `powershell.exe` was admitted by its own image path and reported `original_filename: PowerShell.EXE`. A signer rule naming `NOTEPAD.EXE` does not admit it. The native suite's basename-spoof test passed. FR-01 is a different defect: the field A9 added is not stable across a copy. |
| AR-11 | **Closed** | F3b, F5 | Desktop declares `process.spawn`, `app.automation`, `fs.read`, `fs.write` (`adapter.ts:253`). Machine declares `process.spawn`, `fs.read`. |
| RR-01 | **Closed** | R1 | `isForbidden` tokenises both sides and matches a contiguous run (`packages/envelope/src/envelope.ts:507-551`). Live: `powershell.exe`, `desktop.inspect` and `Microsoft Windows` all match. A zero-word term is refused at seal. |
| RR-02 | **Closed** | R2 | The canary, started from PowerShell 7 with `PSModulePath` removed from the child, reported `signature: valid`, `signer: Microsoft Windows`. A parent env polluted with a nonexistent module path did not change a direct `Get-AuthenticodeSignature` under PowerShell 5.1 or PowerShell 7. A byte-flipped copy of `powershell.exe` that still launched reported `signature: unsigned`, `signer: null`, so a signer rule cannot admit it. Inbox binaries still share signer and product; A9's third field separates Notepad from PowerShell. |
| RR-03 | **Closed** | R1, R4 | `decideTarget` denies a forbidden capability (`policy/src/index.ts:319-324`). Inventory computes the allowed set before any probe (`adapters-machine/src/adapter.ts:534-554`) and omits everything else. The live inventory calls above returned no out-of-job entry. |
| RR-04 | **Closed** | R3 | See AR-06. `reconcileCliSettlements` skips `outcome === 'denied'` and any receipt with no `action.started` (`action-pipeline.ts:913-916`). |
| RR-05 | **Closed** | R3 | `resolveNodeSessionId` accepts only `^\s*([0-9]{1,10})\s*$` inside uint32 (`desktop-config.ts:220-223`). Live: `""`, `"   "`, `"0x10"`, `"1e2"`, `"-1"`, `"99999999999"` and `"2.5"` returned null; `"0"` returned 0; `"2\n"` returned 2. |
| RR-06 | **Closed** | R4 | Page 1 with `page_size: 1` minted a continuation and page 2 returned `status: ok` with one control. Replay of that token returned `refresh_required`. The native suite's automation-id filter test passed. |
| RR-07 | **Closed** | R4 | The script evaluates `authorized_apps` before `WindowText` and before the cap (`probe.ts:330-337`). `inspect_window` checks pid, creation time and hash before the subtree walk (`probe.ts:374-392`). A second fixture, out of the first probe's bound, contributed neither its title nor a `max_windows` slot. `tools/orient.mjs` validates `operator_token` and `authorized_apps`. |

`forbidden: ["powershell.exe"]` does **not** deny the canary. Demonstrated: `desktop.state` returned the fixture window. The canary is a renamed copy, so its image path, product and signer tokenise to `microsoft`, `windows`, `operating`, `system` — the word `powershell` is not among them. The term denies a capability or argument that contains that word, and it denies an app whose path, product or signer contains it. That is what R1 specified. `forbidden: ["desktop.inspect"]` denies the capability. `forbidden: ["Microsoft Windows"]` denies the window.

## 2. The new surface

### A9 and FR-01

**FR-01 [Medium] (`AS-inherited`, `demonstrated`).** `OriginalFilename` follows the MUI, so a signer rule written against the installed binary does not match a copy of that binary, and the reverse.

- **Location:** `packages/adapters-desktop/src/probe.ts:226-236` (the read); compared at `packages/policy/src/index.ts:194-197`, `packages/adapters-desktop/src/adapter.ts:112-115`, `packages/adapters-desktop/src/probe.ts:273-276`.
- **Exploit:** copy `C:\Windows\System32\notepad.exe` to a temp directory. `FileVersionInfo.OriginalFilename` on the inbox file is `NOTEPAD.EXE.MUI`; on the copy it is `NOTEPAD.EXE`. Copy `System32\en-US\notepad.exe.mui` to `<temp>\en-US\<copyname>.exe.mui` and the copy reports `NOTEPAD.EXE.MUI` again. The same flip happens for `powershell.exe` (`PowerShell.EXE.MUI` beside its own MUI, `PowerShell.EXE` without it). Seal `allowed_apps: [{ signer: "Microsoft Windows", product_name: "Microsoft® Windows® Operating System", original_filename: "NOTEPAD.EXE.MUI" }]`. The installed Notepad matches. A copy with no adjacent MUI does not, so a job that named Notepad cannot see a copied Notepad, and an operator who sealed the rule from a copy cannot see the installed one. Place `powershell.exe.mui` beside a renamed PowerShell copy and that copy takes the inbox spelling.
- **What it does not do:** a Notepad rule still denies a PowerShell copy. Live, a copied `powershell.exe` reported `original_filename: PowerShell.EXE`, and `authorizeTargets` denied it under `original_filename: "NOTEPAD.EXE"`. A byte-flipped copy reported `signature: unsigned`, which fails the signer rule before the filename is consulted. Re-signing was not attempted; the byte flip is the modification this host can demonstrate without a code-signing certificate.
- **Case:** case-insensitive comparison does not open a collision. `notepad.exe.mui` matches `NOTEPAD.EXE.MUI` and does not match `PowerShell.EXE.MUI`. Signer and product stay case-sensitive (`-ceq` in the script, `===` in policy).
- **Equivalence:** on the fields the three implementations compare, they agree: hash exact, path case-insensitive after separator normalisation, signer and product exact, original case-insensitive, null original never matches, signature must be `valid`. The divergence is the value Windows returns for that field, which all three then compare faithfully.
- **AS-inherited.** A click or type authorised by a signer rule inherits whichever file the MUI lookup selected.

### In-script rule evaluation

`authorized_apps` arrive as JSON (`probe.ts:129, 293`). A rule whose `image_path` contained `"; Write-Output HACKED; #` and whose signer was `$(calc.exe)` did not execute: the probe returned `session_state: active` and zero windows. Backslashes in the script template are emitted as single backslashes (`probe.ts:151, 189, 266-267`); the native suite passed, including the test that pins those lines.

### Continuation tokens

- **Entropy.** `randomUUID()` (`adapter.ts:637, 716`).
- **Binding.** Demonstrated: foreign job, foreign actor (a different `model` label), different `window_id`, empty token, and a replay each return `refresh_required`.
- **60 s from page 1.** Demonstrated: a continuation presented 62 s after page 1 returned `refresh_required`. The next token keeps the original `issued_at` (`adapter.ts:726-729`).
- **Memory.** `MAX_LIVE_PAGINATIONS` is 64 (`adapter.ts:195`), evicting the oldest.
- **Identity change between pages.** Not re-checked. See question 1.

### Forbidden matching

Stricter than the RR-01 baseline: both sides are tokenised, and a zero-word term is refused at seal. Nothing in the new matcher is less strict than the operator's decision.

Live cost: 50 two-word terms against a 200 000 character candidate took 1 ms.

Unicode, beyond the accepted free-text residual: a Cyrillic `р` in `рowershell`, `power\u200bshell`, and fullwidth `ｐｏｗｅｒｓｈｅｌｌ` do not match `powershell`. The zero-width and homoglyph residual in free-text arguments stands as accepted. It now also applies to an image path, a product and a signer, because those go through the same tokeniser. A signer containing a confusable does not match the genuine term. That is the same accepted residual, on a field the operator added. Not raised separately.

### `PSModulePath`

Every Windows PowerShell spawn under `packages/*/src` passes `powershellChildEnvironment`, which deletes every casing of `PSModulePath` (`probe.ts:459-468`, and the same helper in `desktop-config.ts`, `adapters-machine`, `adapters-app`). The standing test greps for a spawn that forgets it. A direct PowerShell 5.1 and PowerShell 7 invocation with a polluted parent `PSModulePath` still reported `STATUS=Valid` for the copied Notepad. The CLI adapters build a minimal environment that never copies `PSModulePath` (`packages/adapters-cli/src/index.ts:386-399`). No production spawn of `powershell.exe` bypasses the rule. A namespace import of `spawn` does not exist in `packages/*/src`.

### Reconciliation

See AR-06 / RR-04. A denied receipt is not given `action.finished`. A running send that actually started is closed once. A second start does not duplicate the event.

### 2a. The two open questions

1. **A page served after the window is gone.** Demonstrated. Page 1 of the canary (`page_size: 2`) returned `status: ok` and a continuation. The fixture process was then killed. The continuation returned `status: ok` with the next slice of the page-1 snapshot. `invokeInspectContinuation` (`adapter.ts:671-744`) never re-reads the window. The snapshot is metadata already returned in part on page 1: control type, automation id, enabled, patterns. No name, no value, no title. It lives at most 60 s, and the token is single-use and bound to job, actor and window. Serving it does not widen what the caller can read. **Not a finding. Not AS-inherited** — a click or type built on this surface must resolve and re-verify its own target; it must not inherit a cached inspect page as authority to act.
2. **A renamed image passes re-verification.** Demonstrated. After `rename` of the fixture image between resolve and invoke, the live identity kept the same pid, creation time and SHA-256 and changed path. `sameIdentity` (`adapter.ts:161-163`) therefore passed, which is what the interrupted run saw. It does not widen a rule:
   - an `image_path` rule naming the pre-rename path is **denied** against the new identity;
   - `forbidden` of the new basename is **denied**;
   - `forbidden` of the old basename is still **denied**, because the new path (`name.exe.moved.exe`) tokenises to a run that contains the old words.
   A hash rule keeps admitting the same bytes under the new name. That is what a hash rule is. **Not a finding.**

## 3. Contract integrity

`git diff 2847726 HEAD -- packages/contracts` is three files, 95 insertions.

- `envelope.ts`: `allowed_apps?: readonly AppRule[]`, and `AppRule` as `{ image_sha256 } | { signer, product_name, original_filename } | { image_path }`. Matches A8 and A9.
- `ports.ts`: `AppIdentity` including `original_filename: string | null`, `ResolvedTarget`, `TargetDecisions`, `TargetResolver`, `AdapterContext.actor`, `AdapterContext.target_decisions`, `Adapter.resolver`. Matches A8 and A9.
- `index.ts`: exports those types, and `ConversationTurnRole` remains exported. The type itself is unchanged from `2847726` (`'operator' | 'hermes' | 'system' | 'tool'`).

No other contract change. `docs/specs/00-CONTRACTS.md` §10 A8 and A9 describe these types. A9's prose says the field survives a copy. FR-01 shows that, on this Windows 11 build, it does not.

## 4. What must change first

1. Make a signer rule name a filename the copy and the installed binary share, or stop using `OriginalFilename` as that name and pin signer rules to a hash or a canonical path. Say which in `00-CONTRACTS.md` §10 A9.
2. Re-review that change natively: inbox Notepad, a copy with no MUI, a copy with its MUI planted beside it, and the same three for PowerShell. A Notepad rule must keep denying PowerShell in all three layouts.

Until that lands, the desktop discovery surface stays disabled and spec AS stays blocked.

## 5. Earlier review comments, read after the findings

PR #11 and PR #12 have two orchestrator-relayed review comments each (agy / Gemini 4 Argon) and no inline review comments. PRs #14–#17 have no review bodies and no inline comments on the public repo. Nothing in the #11 or #12 comments bears on FR-01; those reviews predate A9.
