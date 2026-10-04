# Finding: Grok Build CLI worker

Verified on Windows on 2026-09-04 against Grok Build 1.0.13.

Grok headless mode requires its prompt as an argument or file; it does not read
the prompt from stdin. Toros therefore writes one transient prompt file inside
the session directory, invokes `--prompt-file`, and deletes the file as soon as
the process exits. `--output-format streaming-json` emits NDJSON `text` events
and an `end` event carrying `sessionId`. A later process resumes context with
`--resume <sessionId>`.

Toros pins `--permission-mode plan --sandbox read-only` for review work and
`--permission-mode dontAsk --sandbox workspace` for workspace-writing work. It
also disables subagents and automatic updates. Operator arguments cannot
override those controls. Grok documents kernel sandbox enforcement for Linux
and macOS, not Windows, so on this host its flags are policy hints rather than
an OS containment boundary; SPEC §8.1 remains the accurate security statement.

Live verification covered fresh and resumed exchanges, plus a workspace-mode
file write under `dontAsk`.

## Addendum — Grok Build 1.0.40, JanBot, 2026-09-21

1.0.40 streams the reply as one `text` event per token (`"P"`, `"ONG"`) with
`thought` events before it, where 1.0.13 emitted one `text` event per reply.
The adapter had appended a newline per event, so a reply arrived as one token
per line and `orient --verify-agents` reported "completed, but did not
answer". The Grok framing now appends fragments verbatim and closes the line
at the `end` event, which both versions emit last. Argument surface, `end`
event, `sessionId`, and `--resume` are unchanged between the two versions.

Two credential notes from the same install: Grok reads a stored credential
from `grok login`, and an `XAI_API_KEY` set only in the operator's shell does
not reach a Toros worker, because the adapter deliberately passes a minimal
environment (SPEC §8.1). A worker that answers from the operator's shell and
reports "Not signed in" from Toros is therefore configured correctly and
needs `grok login --device-code`, not an environment variable.

## Addendum — headless cancellation and the worker environment, JanBot, 2026-09-21

Two more findings from the first real Grok job on this node (a read-only review of an SDS
worktree, 14 turns, 79 tool calls):

1. **A headless Grok in `plan` mode ends the whole turn on the first shell command.** Every
   `run_terminal_command` asks for approval in `plan` mode; with nobody to ask, the CLI records
   "User cancelled the execution for tool `run_terminal_command`" and emits `end` with
   `stopReason: "cancelled"` — no final answer, even though the exchange receipt reads
   `succeeded`. `--allow "Bash(...)"` prefix rules do not make this robust, because the model
   improvises commands the rules did not anticipate (a `Get-Command git` probe, here) and the
   turn dies on those instead. The adapter now passes `--disallowed-tools run_terminal_cmd` for
   the read-only role: `read_file`, `grep`, and `list_dir` never ask, and the reviewer completes.
   Workspace mode keeps the shell under `dontAsk`, which auto-approves ordinary commands.

2. **`PATHEXT` must reach the worker.** Under the five-variable minimal environment, Grok's
   PowerShell reported "Git isn't on PATH" with `C:\Program Files\Git\cmd` on PATH, because
   PowerShell resolves `git` to `git.exe` through `PATHEXT`. Adding that one variable fixed
   resolution (`git -C code log -1 --oneline` → `372dafb seed`); `SystemDrive` and `COMSPEC`
   were not needed. `E-adapters-cli.md` now lists `PATHEXT`; it names no credential.

