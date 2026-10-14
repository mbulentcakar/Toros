# Local deploy

Phase 1 deploys to one machine and no further. Node Core listens on loopback, the cockpit is a
desktop app on the same host, and nothing in this document touches a server. If a step here ever
seems to need SSH, a remote host, or a GitHub mutation, it is out of scope — see `AGENTS.md`.

## Prerequisites, as installed on the reference node

| | Version | Notes |
|---|---|---|
| Node | 24.18.1 | `node:sqlite` and `node:test` are built in |
| Rust | 1.97.1 | cockpit only |
| MSVC Build Tools + Win11 SDK | installed | cockpit only |
| Excel | M365, Office16 | pilot desktop adapter |
| numbat | 0.1.2 (schema 0.2.0) | `%LOCALAPPDATA%\numbat\numbat.exe` |

## 0. Find out what this machine already has

```bash
node tools/orient.mjs
```

Orientation reports the toolchain, which CLI agents are installed and whether their
executables are ones the adapters will accept, whether a configuration exists and would
start a node, the capability inventory, and whether the real-binary test suites will run
or skip here. Add `--verify-agents` to make each agent actually complete one exchange
before you trust it — an agent that resolves is not necessarily an agent that works. It is read-only and prints no credential. The
paths below are examples; run this rather than copying them, because the ones this
document used to record went stale — the codex path it named no longer existed, and the
binary on `PATH` was a `.cmd` shim the adapter refuses.

## 1. Build and verify

```bash
npm install
npm run build
npm test
```

**Run this natively on Windows, not in the WSL sandbox.** Every adapter declares
`platforms: ['win32']`, and the defects that only appear here have been numerous enough to make
the rule non-negotiable — see `docs/specs/00-CONTRACTS.md` §3 item 5. A skipped test is a
finding, not a pass.

## 2. Configuration

`%LOCALAPPDATA%\Toros\config.json`, readable only by the operator account:

```jsonc
{
  "node_id": "oruc",
  "db_path": "C:\\.Code\\_toros\\toros.db",
  "port": 8787,
  "token": "<32 random bytes, hex>",
  "workspaces": [
    { "id": "sandbox", "root": "C:\\.Code\\_toros\\workspaces" }
  ],

  "adapters": {
    "chrome": {
      "allowed_domains": ["example.com"],
      "extension_dir": "%LOCALAPPDATA%\Toros\chrome-worker-extension"
    },
    "claude": {
      "executable": "<absolute path to claude.exe - `npm run orient` finds it>",
      "args": ["--settings", "<absolute path to your Claude settings file>"]
    },
    "codex": {
      "executable": "<absolute path to codex.exe - `npm run orient` finds it>",
      "args": []
    },
    "gemini": {
      "executable": "C:\\Windows\\System32\\wsl.exe",
      "launcher_args": ["-e", "/snap/bin/agy"],
      "args": []
    },
    "grok": {
      "executable": "<absolute path to grok.exe>",
      "args": []
    },
    "excel": {
      "executable": "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE"
    }
  },

  "approval_required": [],
  "operator_token": "<32 random bytes, hex, DIFFERENT from token>",
  // Optional: absolute path to the Hermes coordinator entry point.
  // Default: packages/coordinator/dist/src/main.js relative to the compiled
  // Node Core main. Only set this if you moved the coordinator build.
  "coordinator_entry": "C:\\.Code\\toros\\packages\\coordinator\\dist\\src\\main.js"
}
```

Generate each token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

Node Core always registers Claude with `sandbox: "read-only"`, which maps to Claude permission
mode `plan`. Adapter `args` may select the explicit Numbat settings file or a model, but security
switches such as `--permission-mode`, `--dangerously-skip-permissions`, `--sandbox`, and Codex
`-c` are refused at adapter initialization. Read-only here is Claude policy, not an OS sandbox;
SPEC §8.1's ordinary-process limitation still applies.

The `gemini` adapter runs the fleet's Antigravity (`agy`) CLI through WSL and appears in Cockpit
as **Gemini (AGY)**. The `grok` adapter runs Grok Build directly on Windows. Both register the
same bounded `start`, `send`, `read`, `interrupt`, and `stop` lifecycle as Claude and Codex; their
verified protocol and sandbox behavior are recorded in `docs/finding-cli-gemini.md` and
`docs/finding-cli-grok.md`. Paths and optional model arguments are operator configuration, not
hard-coded defaults. Before enabling Gemini, verify the WSL prerequisite from PowerShell with
`wsl.exe -e <agy path> --version`; a missing executable is a deployment blocker rather than a
reason to substitute a native Windows AGY binary. The path is per machine: `/snap/bin/agy` on
one machine, `~/.local/bin/agy` (a user install) on another — run `wsl.exe -e bash -lc 'which agy'` rather than
copying either. Antigravity 1.2.x also needs a read grant in the CLI's own settings inside WSL
before a headless worker can read its workspace; `docs/finding-cli-gemini.md` records the rule
and why it must be the only one.

`operator_token` is required for the cockpit's findings view even when no capabilities require
approval, because findings deliberately live on the operator surface rather than `/tools`.

Whenever `operator_token` is set — gated or not — it must be at least 32 characters, different
from `token`, and, like `token`, contain only printable ASCII (`0x21`–`0x7E`): no spaces, tabs,
line breaks or other whitespace, and no leading or trailing whitespace. Node Core refuses to start
otherwise, even with nothing gated, and the start-up error names the rule: `… must contain only
printable ASCII characters (0x21–0x7E) …`, `operator_token must be at least 32 characters…`, or
`operator_token must differ from token…`. The shape rule is checked first because HTTP strips
surrounding whitespace from a bearer header, so a token that differed from another only by
whitespace would be indistinguishable on the wire. This is unconditional because a short or shared
operator bearer is a gate the ordinary bearer can open; it is rejected at start-up rather than the
first time an approval is needed.

`coordinator_entry` is optional. Node Core verifies that the file exists once at startup and
refuses to start if it is missing or misconfigured, naming the path in the error.

**The token never enters model context.** Node Core reads it from this file; the cockpit reads it
from the same file. It is not passed on a command line, where it would be visible in the process
list, and not in an environment variable inherited by child agents — §8.1 forbids credentials
reaching a worker, and the CLI adapters pass a minimal environment precisely so this holds.

## 2A. Chrome worker

Builds stage the extension from `apps/chrome-worker-extension`. Copy that directory
to the configured `extension_dir`; on Oruc the installed copy is:

```text
%LOCALAPPDATA%\Toros\chrome-worker-extension
```

The initial Chrome attachment requires four operator gestures:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**,
   and select the directory above.
2. Open the allowed target site in the tab Toros should use.
3. In Cockpit, open **Web capture** and choose **Create pairing code**.
4. Open the Toros Chrome Worker popup, enter that code, and choose
   **Grant this site and pair**. Chrome asks for the current origin only.

Pairing codes are single-use and expire after ten minutes. The extension keeps
the raw worker token in `chrome.storage.local`; Node Core persists only its
SHA-256 digest and the paired extension id. The worker does not expose arbitrary
JavaScript or clicks and cannot read cookies, local storage, passwords, or browser
history. Add a domain to `allowed_domains` only when an acquisition genuinely
needs it; a redirect outside the allowlist pauses rather than broadening access.

For the first live test, use two product URLs and leave the default 8–15 second
pacing in place. Confirm the run reaches **Completed**, each requested document
has a SHA-256 and byte count, and the workspace manifest matches Cockpit. A 429
should enter **Waiting**; login, consent, challenge, 403, or missing permission
should enter **Paused / needs attention**.
## 2.1 Approvals (only if you gate a capability)

List any capability that must not run without a human in `approval_required`. If that list is
non-empty — or any registered adapter action declares `always_requires_approval` — **Node Core
refuses to start** unless `operator_token` is present, at least 32 characters, and **different from
`token`**.

That refusal is deliberate. `token` is the coordinator's bearer. If approvals were granted on the
same credential, the party being gated could open its own gate; and a node with a gate nobody can
open is a broken node that looks like a working one, because the only symptom is work quietly not
happening.

The flow, once a capability is gated:

1. The coordinator calls the action. Node Core denies it `E_APPROVAL_REQUIRED` and returns an
   `approval_id`, appending an `approval.requested` event. Retrying returns the same id rather than
   queueing a second decision.
2. You list what is waiting. **Read the `arguments` field** — that, not the coordinator's
   description of its own request, is what you are approving. The digest binds the decision;
   the arguments are what tell you whether to make it:

```powershell
curl.exe -s -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" http://127.0.0.1:8787/operator/approvals
```

3. You grant one:

```powershell
curl.exe -s -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" `
  -d '{\"approval_id\":\"<id>\"}' http://127.0.0.1:8787/operator/approve
```

4. The coordinator retries with `approval_token: "<id>"` and the action runs. The approval is then
   spent: it covers that one job, that one capability, and those exact arguments, once, and it
   expires after five minutes.

`approval_id` is **not a secret** — knowing it authorises nothing. The authority is your recorded
decision, and only `operator_token` can record one. Approvals live in memory: a restart clears
pending decisions, which is correct, because an approval is a person saying "yes, now". The audit
of them is durable, as `approval.requested` and `approval.resolved` events in the log — but note
the arguments themselves are **not** written to the log, only their digest, so the operator
surface is the only place they appear.

A grant is contingent on its audit entry being written: if the log cannot be appended, the
approval is not granted and the call fails. Repeating a grant is safe and records one decision.
The queue is bounded (256 live, 32 per job) and a decision you have already made is never
displaced to make room — if the queue fills with pending requests, new ones are refused rather
than pushing yours out.

The cockpit has an Approvals panel alongside the other views. It reads the operator token from
the local config and renders the full action arguments before an operator grants a request.

## 3. Register Node Core as a logon task

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
             -Argument "C:\.Code\toros\packages\node-core\dist\src\main.js" `
             -WorkingDirectory "C:\.Code\toros"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 `
             -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName "Toros Node Core" -Action $action -Trigger $trigger -Settings $set -RunLevel Limited
```

`-RunLevel Limited`, deliberately: Node Core supervises CLI agents and drives Excel, and neither
needs administrator rights. Running the policy authority elevated would widen the blast radius of
a path-containment bug from scratch data to the whole machine, for no benefit.

If Cockpit shows **Could not reach Node Core**, choose **Start Node Core** in that
panel. This also appears inside **Web capture**. The Rust shell invokes only the
fixed scheduled task `\Toros Node Core`; the WebView cannot choose a command,
executable, task name, or arguments. Cockpit waits for the configured loopback
port and then remounts the current view automatically.

The equivalent operator fallback is:

```powershell
Start-ScheduledTask -TaskName "Toros Node Core" -TaskPath "\"
```

If a forced restart is required, wait for the old process to release port 8787
before starting the task again. Starting the replacement immediately after
`Stop-ScheduledTask` can race the old process and make the new instance exit
with an address-in-use error.

## 4. Numbat hooks

```bash
numbat hook install --agent claude --emit all
numbat hook install --agent codex  --emit all
numbat hook install --agent grok   --emit all
numbat hook status
```

Monitor-only: no `--enforce`, no `--rules-dir`, no `enforce: true` override. §8.2 requires Numbat
not to become the enforcement boundary. Hooks must then be trusted inside each agent before they
fire, and `hook status` reports configuration rather than delivery — so the real check is step 7.

## 5. Cockpit

```bash
cd apps/cockpit
npm install
npm run build
npx tauri build          # NSIS installer under src-tauri/target/release/bundle/
The installed Cockpit has a **Hermes** tab. It uses the operator-authenticated
surface to:

1. choose advertised capability and workspace ids;
2. create a validated, immutable job envelope;
3. start and stop the one-job Hermes coordinator;
4. poll its bounded output, receipts, state, and pending approvals;
5. answer `state: ask` questions and resume after a granted approval; and
6. create an operator checkpoint.

Neither bearer token crosses into the WebView. Rust maps fixed operation names
to loopback paths and chooses the operator credential; Hermes still has only
the coordinator credential and cannot call these operations. Coordinator
messages are process-scoped and bounded in memory. Durable truth remains the
job, receipts, and append-only event chain; raw model transcripts are not
persisted.

```

## 6. Hermes coordinator

Create `%LOCALAPPDATA%\Toros\coordinator.json`, readable only by the operator account. Its
`token` is the coordinator bearer from `config.json`, **never `operator_token`** — the
coordinator must not be able to approve its own actions, and it never reads `config.json`.

```jsonc
{
  "port": 8787,
  "token": "<the coordinator bearer from config.json>",
  "model": "openai/gpt-5.6-sol",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key": "<provider key>",
  "temperature": 0,
  "max_turns": 40
}
```

After Node Core is running and the operator has created the bounded job, run one coordinator
process for that job:

```powershell
node packages/coordinator/dist/src/main.js <job_id>
```

Exit `0` means the job is proposed, blocked, already terminal, or its envelope is spent. Exit
`3` prints an operator question, `4` means the turn limit blocked the job, `5` means two model
responses failed the coordinator schema, and `7` means Node Core or the model transport was
unavailable.

Exit `6` means a gated action needs you. It prints the approval id and the exact arguments.
Grant it through §2.1 or the cockpit's Approvals panel, then re-run the same job **passing the
id back**:

For a direct CLI continuation after exit `3`, send the answer over stdin so it
does not appear in the process command line:

```powershell
'Use option B1.' | node packages/coordinator/dist/src/main.js <job_id> --operator-message-stdin
```

```powershell
node packages/coordinator/dist/src/main.js <job_id> --approval <approval_id>
```

Without `--approval` the re-run asks for the same approval again and never spends the one you
granted. The id is presented on every call in that run; a capability that is not gated ignores
it, and one gated on different arguments refuses it — the binding is checked by Node Core, not
by the coordinator.

## 7. Acceptance — the §10 list, end to end

Run these against the deployed service, not the test suite. The test suite proves the units; this
proves the install.

1. Start a bounded job; it starts one CLI, exchanges messages, reads incrementally, interrupts,
   and stops.
2. An out-of-scope capability, a path under `C:\.Code\sicil\`, and an expired envelope are each
   denied — with `E_CAP_NOT_ALLOWED`, `E_PATH_ESCAPE`, and `E_EXPIRED` respectively, from the
   live service rather than a unit test.
3. The Excel adapter exposes exactly its four registered actions and nothing else.
4. A checkpoint survives stopping and restarting Node Core **and** the cockpit.
5. A relay capsule contains only the explicitly selected files and passes secret scanning.
6. A Numbat finding reaches the findings store from a real adapter run and is visible in the
   cockpit **without blocking execution**.
7. `verify-chain` reports an unbroken chain, and `anchor_matches` is true.
8. Receipts reconstruct the action sequence with no conversation content stored.
9. The selected coordinator clears 18/20 with zero safety failures. **Met 2026-08-06:
   `openai/gpt-5.6-sol`, 18/20 and 19/20 across two runs, zero hard failures in both.
   See `docs/bakeoff-2026-08-06.md` — including why a single run at exactly 18 is not a
   reliable qualification, and why the Kimi result should not be read as a verdict.**
10. **No step above touched GitHub, a remote shell, Hetzner, or a Mac.**

Then log the landing to `ops/ACTIVITY.md`.

## Rollback

`Unregister-ScheduledTask -TaskName "Toros Node Core"`, uninstall the cockpit, and
`numbat hook uninstall --agent claude --agent codex`. The database under `C:\.Code\_toros\`
is left in place — it is the audit trail, and removing it to undo a deployment would destroy the
evidence of what the deployment did.

Per-machine deploy records (Oruc 2026-08-02, JanBot 2026-09-21) are kept outside this
repository; they carry user paths and toolchain versions that are operator detail, not procedure.
