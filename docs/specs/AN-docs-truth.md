# AN — Documentation truth pass

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

The repository's front door lies and its log sprawls:

- `README.md` says "The project is currently specification-only … No
  implementation, deployment, or server mutation has been performed" while
  STATUS.md records an installed, live system with 400+ passing assertions.
  The first document any reviewer reads is false.
- `STATUS.md` is ~450 lines with inconsistent heading levels and milestones
  out of chronological order (the 08-12 entries appear both above and below
  08-13/08-14 entries). It has become an append-log wearing a summary's
  name.

## README rewrite

The README becomes the front door and stops carrying status at all:

- what Toros is (the existing two paragraphs are good and stay);
- what exists: one paragraph naming the major surfaces (Node Core, cockpit,
  CLI/Excel/Chrome adapters, pipelines, conversations) with pointers to
  SPEC.md and STATUS.md — **no numbers, no dates**, nothing that goes stale;
- how to build and verify: the four root commands and where DEPLOY.md is;
- the rollout plan section updates to reflect that Oruc is live and Phase 2
  is planned (pointer to PHASE-2-PLAN.md).

Rule going forward, stated in the README itself: status claims live in
STATUS.md only. A README that cannot go stale is one nobody has to remember
to update.

## STATUS restructure

- `docs/STATUS.md` holds **current truth only**, one screen: what is
  installed and running, verification of the latest milestone, open known
  issues, what is next. Newest first, `##` headings only.
- Everything older moves verbatim to `docs/log/<yyyy-mm-dd>-<slug>.md`, one
  file per milestone, content unedited — history is moved, never rewritten.
  `docs/log/INDEX.md` lists them newest-first with one-line summaries.
- The ops activity ledger remains the audit authority (unchanged; STATUS.md
  already says so).

## Non-goals

- No rewriting of historical claims while moving them — a milestone entry
  that was wrong stays wrong in the archive, because the archive is a
  record of what was believed (the §8.2 retraction principle, applied to
  prose).
- No new documentation kinds, no ABOUT.md decision here.

## Acceptance

1. README contains no claim contradicted by STATUS.md, and no test count,
   date, or version that will go stale — reviewed line by line.
2. STATUS.md is ≤120 lines, chronologically consistent, `##` headings only.
3. Every removed STATUS section exists verbatim in exactly one
   `docs/log/` file; `git log --follow` or the PR diff makes the move
   auditable; INDEX.md lists all entries.
4. A newcomer following README alone reaches a passing `npm test` (or the
   documented real-binary skips) without opening any other doc.
