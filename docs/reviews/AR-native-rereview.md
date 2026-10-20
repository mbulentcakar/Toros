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
