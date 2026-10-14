# Installing a Toros node

> **Draft skeleton.** Sections marked `TODO` must be written — and every section must be
> re-verified — by installing on a fresh machine while following only this document. Where a
> step made the author think, this document was wrong. The procedure-level detail currently in
> [DEPLOY.md](DEPLOY.md) is the source until this file replaces it.

This installs a **tool node**: Node Core plus the CLI worker adapters you have, on one
Windows machine, listening on loopback only. The cockpit, Chrome worker, Numbat observer, and
Hermes coordinator are optional and come after.

## 1. What to install

| Component | Required? | Version known to work | How to check |
|---|---|---|---|
| Windows 11 | yes | 10.0.26200 | — |
| Node.js | yes | 24.x (`node:sqlite`, `node:test` built in) | `node --version` |
| Git | yes | 2.5x | `git --version` |
| Claude Code CLI | for the `claude` worker | 2.1.x | `claude --version`, then `claude auth status` |
| Codex CLI | for the `codex` worker | 0.155+ (older refuses newer models) | `codex --version` |
| Grok Build | for the `grok` worker | 1.0.40 | `grok --version`; `grok login --device-code` |
| WSL + Antigravity (`agy`) | for the `gemini` worker | agy 1.2.7 in Ubuntu | `wsl.exe -e bash -lc 'which agy; agy --version'` |
| Microsoft Excel (M365) | for the `excel` pilot adapter and `tools/acceptance.mjs` | Office16 | — |
| Rust + MSVC + Win11 SDK | cockpit only | 1.97 | not needed for a tool node |

**Each worker must be authenticated in its own right.** A credential that lives only in your
shell environment (an `XAI_API_KEY` variable, for example) never reaches a worker: Toros passes
a minimal environment on purpose. The worker's own stored login is what counts, and it can be
expired even when the interactive tool works — the Claude Code desktop app and the standalone
CLI hold separate credentials.

TODO: per-worker readiness checklist with the exact failure text `orient --verify-agents`
prints for each known condition (expired OAuth, stale CLI, not signed in, `.cmd` shim on PATH).

## 2. Orient before you install

```bash
node tools/orient.mjs
```

Run this on the fresh clone, before `npm install`. It names the real executables the adapters
will accept (not the `.cmd` shims on `PATH`), which is what you will paste into the config.

## 3. Build and test

```bash
npm install
npm run build
npm test
```

Natively on Windows. Expect the real-binary suites to run, not skip; see README.

## 4. Configure

```bash
node tools/orient.mjs --init-config   # writes a starter %LOCALAPPDATA%\Toros\config.json, never overwrites
```

Then edit it: `node_id`, `db_path` and one workspace root on a real (non-virtualised) drive,
the `adapters` block with the executables orientation reported, `coordinator_enabled: false`
for now. Restrict the file to your account (`icacls ... /inheritance:r /grant:r "%USERNAME%:RW"`).
`orient` validates the result. Field reference: [DEPLOY.md §2](DEPLOY.md).

If you set `operator_token`, it must be at least 32 characters and different from `token`, and both
`token` and `operator_token` must contain only printable ASCII (`0x21`–`0x7E`) — no spaces, tabs,
line breaks or other whitespace, and no leading or trailing whitespace. Node Core refuses to start
otherwise even when no capability is gated, naming the rule at start-up (`… must contain only
printable ASCII characters (0x21–0x7E) …` / `operator_token must be at least 32 characters…` /
`operator_token must differ from token…`). The shape rule is checked first because HTTP strips
surrounding whitespace from a bearer header, so a token that differed from another only by
whitespace would be indistinguishable on the wire.

TODO: a complete minimal `config.json` for a tool node, with every field explained in one line.

**If you deploy from inside a sandboxed agent session**, verify the file exists from an
unsandboxed process before trusting it: some desktop-app sandboxes virtualise writes under
`%LOCALAPPDATA%`, and Node Core will report `ENOENT` for a file the session can read.

## 5. Per-worker prerequisites outside the repository

- **Antigravity**: headless 1.2.x auto-denies reads until the CLI's own WSL settings grant
  `read_file(<your workspace root as a WSL path>)`; grant reads only, never shell commands.
  See [finding-cli-gemini.md](finding-cli-gemini.md).
- **Grok**: `grok login`; a read-only Grok gets no shell tool, by adapter policy. See
  [finding-cli-grok.md](finding-cli-grok.md).
- **Claude**: `claude auth login` for the standalone CLI.
- **Codex**: keep the CLI at or above the version your configured model requires.

## 6. Register Node Core as a logon task

Limited run level, single instance, no execution ceiling. Exact PowerShell in
[DEPLOY.md §3](DEPLOY.md). Confirm it listens on `127.0.0.1:8787`.

## 7. Prove the install

```bash
node tools/acceptance.mjs            # SPEC §10 against the running service, expect 14/14
node tools/orient.mjs --verify-agents
```

`acceptance.mjs` currently requires the Excel adapter (it drives `excel.inspect_workbook`).
TODO: make the acceptance harness work on a node without Excel, or document the skip.

## 8. Optional: Hermes coordinator

Create `%LOCALAPPDATA%\Toros\coordinator.json` with the coordinator bearer (the `token` from
`config.json`, never `operator_token`), a model id from the bounded profile list, an
OpenAI-compatible `base_url`, and the provider key; then set `coordinator_enabled: true` and
restart the task. Field reference: [DEPLOY.md §6](DEPLOY.md).

TODO: the helper script that writes this file without the key touching a command line.

## 9. Optional: cockpit, Chrome worker, Numbat

Pointers to [DEPLOY.md §2A, §4, §5](DEPLOY.md). Not needed for a tool node.

## Rollback

`Unregister-ScheduledTask -TaskName "Toros Node Core"`. Leave the database: it is the audit
trail.
