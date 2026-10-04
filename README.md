# Toros

Toros is a capability-bounded control plane for AI-assisted work on your own Windows
machines. It lets a coordinating model — or you — run selected CLI coding agents (Claude
Code, Codex, Grok Build, Antigravity/Gemini) and a few registered desktop-app actions
**inside a sealed job**: an allowlist of capabilities and workspaces, an action budget, an
expiry, and an append-only receipt chain that records what actually ran. GitHub remains the
canonical code and review system; Toros checkpoints and relays are working exchanges, never
implicit commits or approvals.

**Windows only, by design.** Every adapter declares `platforms: ['win32']` and the
path-containment code is Windows-specific. Antigravity runs through WSL. There is no macOS or
Linux node today.

## Who it is for

Operators who run more than one coding agent, want each run bounded to a stated objective
and a stated workspace, and want a durable record of what was allowed, denied, and done —
rather than a chat transcript. If you only ever run one agent interactively, you do not need
Toros.

## Five-minute path

```bash
git clone <this repository> && cd toros
node tools/orient.mjs            # what this machine has, before installing anything
npm install && npm run build
node tools/orient.mjs --verify-agents   # each agent completes one real exchange, or says why not
```

Then follow [docs/INSTALL.md](docs/INSTALL.md) to configure and register a node, and
[docs/USING.md](docs/USING.md) to run your first bounded job and read its receipts.
Both are **drafts**: the sections marked `TODO` have not yet been written against a fresh
install, so expect gaps there and please open an issue when you hit one.

Orientation is read-only, opens no socket, and never prints a credential. It reports whether
this machine can build Toros, which CLI agents it can actually reach, whether the local
configuration is one Node Core would accept, and the capability inventory — derived from the
tree, so it does not go stale. **Presence is not the same as working**: `--verify-agents` is
the one flag that runs an agent, and it distinguishes "could not start", "started and never
came back", and "completed", because those have different fixes.

## What exists

A local **Node Core** — the loopback policy authority that validates every job envelope,
enforces the capability and workspace allowlists, supervises worker processes, and writes the
receipt chain. Adapters for **supervised CLI agents** (Claude Code, Codex, Grok Build,
Antigravity), a **pilot desktop application** (Excel, four actions), an **operator-attached
Chrome worker**, and **read-only machine and desktop discovery**. An optional **Hermes
coordinator** that drives one bounded job through an OpenAI-compatible model endpoint. An
optional **Tauri cockpit** for conversations, jobs, approvals, and findings. A **fixed stage
graph** that runs specification → implementation → code review → security review as separately
sealed jobs.

What is true right now lives in [docs/STATUS.md](docs/STATUS.md) and nowhere else. The system
contract is [docs/SPEC.md](docs/SPEC.md); per-slice contracts are under `docs/specs/`; what
each worker CLI actually does when driven headless is in `docs/finding-cli-*.md`. Read
[AGENTS.md](AGENTS.md) before changing anything.

## Build and verify

```bash
npm install
npm run typecheck
npm run build
npm test
```

Run these natively on Windows, not under WSL. `npm test` builds the workspace and runs the
root suite **including integration tests against the real agent binaries and Excel**. Those
tests do not silently skip an unavailable prerequisite: a missing or unauthenticated CLI,
unavailable Excel, or an exhausted provider quota is a verification failure, and the output
names the unmet prerequisite. Do not report a skipped or blocked real-binary test as passing.
The cockpit additionally needs Rust; a tool node does not need the cockpit.

## Security model, in one paragraph

Node Core is the authority; the model is never the policy boundary. Workers get a minimal
environment (no credentials from the supervisor), a pinned permission mode they cannot
override from operator arguments, and one workspace. "Read-only" for a CLI worker is that
CLI's own policy mode, not OS confinement — SPEC §8.1 says so plainly, and
[SECURITY.md](SECURITY.md) says which trust boundaries are real and how to report a
vulnerability privately.

## License

MIT — see [LICENSE](LICENSE). Contributions arrive under the same licence;
[CONTRIBUTING.md](CONTRIBUTING.md) says how.
