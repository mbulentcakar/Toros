# Toros — status

What is true right now. Claims about the project live here and nowhere else; the README
points at this file rather than repeating it. Per-machine operator records are kept outside the
repository.

## Where the project is — 2026-10-28

- **Phase 1 is live on two Windows nodes.** Node Core runs as a limited, single-instance logon
  task on loopback; the SPEC §10 acceptance list passes against the running service on both.
- **Four supervised CLI workers are verified end to end**: Claude Code (read-only reviewer),
  Codex, Grok Build, and Antigravity (Gemini) through WSL. `node tools/orient.mjs
  --verify-agents` is the readiness gate; each worker's verified protocol and its sharp edges
  are in `docs/finding-cli-*.md`.
- **The Hermes coordinator runs against an OpenAI-compatible endpoint** (OpenRouter in the
  reference setup) and has completed a bounded job that drives a worker and reports back.
- **The cockpit, Chrome worker, and desktop discovery adapter exist and are tested.** The
  desktop discovery surface's adversarial review and native re-review are complete (the AR gate
  cleared in mbulentcakar/Toros#18); a node opens it to agents only with
  `desktop_control.ar_gate_cleared: true`.
- **Agent discovery over MCP (spec AT) is merged**: an operator-granted Claude Code or Codex
  session can call the read-only discovery capabilities through `packages/mcp-discovery`
  (`docs/USING.md` §8). Verified with real Claude Code 2.1.310 and codex-cli 0.160.1 against a
  native test node; not yet enabled on the production nodes.

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
Spec AS (agent desktop actions under missions, mbulentcakar/Toros#1) builds on AT's credentials
and MCP server; it awaits operator acceptance.
