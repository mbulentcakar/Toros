# Toros — status

What is true right now. Claims about the project live here and nowhere else; the README
points at this file rather than repeating it. Per-machine operator records are kept outside the
repository.

## Where the project is — 2026-09-21

- **Phase 1 is live on two Windows nodes.** Node Core runs as a limited, single-instance logon
  task on loopback; the SPEC §10 acceptance list passes against the running service on both.
- **Four supervised CLI workers are verified end to end**: Claude Code (read-only reviewer),
  Codex, Grok Build, and Antigravity (Gemini) through WSL. `node tools/orient.mjs
  --verify-agents` is the readiness gate; each worker's verified protocol and its sharp edges
  are in `docs/finding-cli-*.md`.
- **The Hermes coordinator runs against an OpenAI-compatible endpoint** (OpenRouter in the
  reference setup) and has completed a bounded job that drives a worker and reports back.
- **The cockpit, Chrome worker, and desktop discovery adapter exist and are tested**, but are
  optional on a tool node, and the desktop data surface is not production-enabled until its
  adversarial review clears (`docs/reviews/`).

## Open known issues

- A CLI worker whose exchange ends without an answer (Grok `stopReason: cancelled`, Antigravity
  `denied_actions`) still produces a `succeeded` receipt; the outcome is only visible in the raw
  exchange log. Tracked as the next adapter slice.
- Antigravity 1.2.x headless workers need an operator-installed read grant in the CLI's own WSL
  settings and a brief that names the absolute WSL workspace path; neither is enforced by Toros
  (`docs/finding-cli-gemini.md`).
- The fixed Stage Graph still needs independent review and a live four-stage run.
- The Chrome worker's real-site acquisition acceptance is outstanding.
- Adversarial vulnerability testing beyond the two recorded reviews has not begun.

## Next

Public-readiness: install and usage guides written against a fresh machine, then the
`succeeded`-receipt fix above. Phase 2 (a second node with pull-based transfer) remains planned.
