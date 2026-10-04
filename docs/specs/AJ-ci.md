# AJ — Continuous integration

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Every verification in this repository's history is a manually-run command
whose result was manually recorded in STATUS.md. The governance model —
review gates, "record verification commands and results in the PR" — has no
mechanical enforcement, and the documented parallelism flakes stay folklore
because nothing runs the suite on a machine nobody is typing on. Add CI.

## The workflow

One workflow, `.github/workflows/ci.yml`, on `push` to `main` and every pull
request. **Runner: `windows-latest`** — Windows is the deployment platform
(DEPLOY.md, the NSIS bundle, the scheduled task); a Linux run would test a
platform Toros does not run on and skip the path-containment code that is
Windows-specific by design.

Jobs:

1. **Root** — Node 24: `npm ci`, `npm run typecheck`, `npm test`.
2. **Cockpit** — `npm ci`, `npm run test -- --run`, `npm run build` in
   `apps/cockpit`.
3. **Rust** — `cargo test --locked` and `cargo check` in
   `apps/cockpit/src-tauri` (Tauri build deps via the standard action; the
   full NSIS bundle is NOT built in CI — it needs minutes and proves little
   beyond what `cargo check` + the frontend build already prove).

**Real-binary tests must self-skip.** The suites that drive real Codex,
Claude, and Excel currently assume an authenticated operator machine. Each
gains a preflight (binary present + credential present, or an explicit
`TOROS_REAL_TESTS=1`) and reports **skipped**, loudly, when unmet. This is a
prerequisite, not a compromise: a suite that fails on quota resets was
already unfit to gate anything. Skip counts appear in the job summary so a
silently-skipping suite is visible — the fleet lesson about green-looking
skips applies verbatim.

**Flake policy: no retries.** A test that fails intermittently under CI
parallelism is a finding to fix (the repo has two known candidates: the
adapters-cli timing fixture and the store lock test). Retry-until-green
would launder exactly the information CI exists to surface.

Branch protection on `main` requires the three jobs. `docs/PROTOCOL`-style
per-PR verification notes continue — CI supplements the written record, it
does not replace it.

## Non-goals

- No release/packaging pipeline, no deployment automation (AGENTS.md places
  deployment outside repository authority), no coverage gates, no lint step
  beyond what typecheck already enforces.

## Acceptance

1. Three consecutive green runs on `main` — the number is the point:
   one green run does not distinguish working from lucky.
2. A PR with a failing unit test shows a red check and cannot merge.
3. On a runner with no Codex/Claude credentials, real-binary suites report
   skipped (not passed), and the summary shows the skip count.
4. Total wall time under 15 minutes; if it exceeds that, the Rust job may
   cache, but correctness jobs may not shrink.
5. STATUS.md's next milestone links a CI run instead of a pasted count.
