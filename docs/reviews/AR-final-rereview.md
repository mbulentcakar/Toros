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
