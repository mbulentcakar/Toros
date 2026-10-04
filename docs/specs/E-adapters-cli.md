# Spec E — `@toros/adapters-cli`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements the Claude and Codex CLI adapters (**SPEC §12.3**), the process-supervision half of
**§8.1**, and the `*_cli` tools of **§6**.

## Objective

Two `SessionAdapter` implementations that supervise CLI **conversations**. A conversation
owns a working directory, rendered output, raw per-exchange JSONL, and the CLI's continuation
id. Each `send` is one bounded child process; no process lives between exchanges.

This unit is where Toros touches a real process for the first time. Every path that spawns an
exchange must synchronously reap it on success, timeout, cancellation, interrupt, stop, and
dispose.

## Allowed paths

```
packages/adapters-cli/package.json
packages/adapters-cli/tsconfig.json
packages/adapters-cli/src/**
packages/adapters-cli/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts` only.

## Public API — frozen

```ts
import type { SessionAdapter } from '@toros/contracts';

export type SandboxMode = 'read-only' | 'workspace-write';

export interface CliAdapterOptions {
  /** Absolute path to a real executable. */
  readonly executable: string;
  /** Test-only leading arguments, used for `node fixture.js`. */
  readonly launcher_args?: readonly string[];
  /** Operator additions such as model or settings selection. */
  readonly args: readonly string[];
  readonly timeout_ms: number;
  readonly output_limit_bytes: number;
  /** Worker policy, pinned explicitly; defaults to workspace-write. */
  readonly sandbox?: SandboxMode;
}

export function createClaudeAdapter(options: CliAdapterOptions): SessionAdapter;
export function createCodexAdapter(options: CliAdapterOptions): SessionAdapter;
```

Security-policy arguments are reserved and refused at `init()`: operator additions cannot
override Claude's permission mode or Codex's sandbox/approval policy.

Nothing else. Both return the `SessionAdapter` interface from contracts, unchanged.

## Manifests

Both declare `platforms: ['win32']` for Phase 1, `required_permissions: ['process.spawn', 'fs.read', 'fs.write']`,
and `cancellation: 'kill'` — neither CLI offers a documented graceful-stop protocol, and
claiming `graceful` when the implementation sends a kill would make the manifest lie.

Actions, identical for both: `start`, `send`, `read`, `interrupt`, `stop`. Give each a real
`input_schema`; `read` takes `{ cursor: integer >= 0 }`, `send` takes `{ message: string }`.

`receipt_fields`: `['exit_code', 'signal', 'bytes_read', 'truncated']`.

## Spawning — the rules that matter

**Never spawn through a shell.** Use `child_process.spawn` with an argument array and
`shell: false`. This is not a style preference: on Windows, `spawn` with `shell: true` routes
through `cmd.exe`, where an argument containing `&`, `|`, or `^` becomes a command separator.
The child's arguments include job text that a model produced, so a shell here is a command
injection with extra steps.

Related, and specific to this machine: if the executable is a `.cmd` or `.bat` shim, Node
launches it via `cmd.exe` **even with `shell: false`**, and argument quoting is not safe. Both
CLIs here are real `.exe` files, so: **verify the resolved executable ends in `.exe` at
`init()` and refuse otherwise** with `E_ADAPTER_FAILURE`. Do not attempt to make shim launching
safe.

Other spawn requirements:

- `cwd` is the workspace root from `AdapterContext`. Never `process.cwd()`.
- Pass a **minimal environment**: `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `USERPROFILE`,
  and nothing else. `PATHEXT` is the Windows table of executable suffixes (`git` -> `git.exe`);
  a worker shell without it cannot resolve a bare native executable name, whatever `PATH`
  contains, though cmdlets, aliases, and suffixed names still work (Grok 1.0.40 reported "Git
  isn't on PATH" with Git on PATH, JanBot 2026-09-21). It names no credential and no location. Inheriting `process.env` hands the child every credential in the supervisor's
  environment, which SPEC §8.1 forbids ("no credentials in model context").

  **Windows adds some variables back, and that is expected.** `CreateProcess` injects
  `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, and `USERNAME` into
  every child regardless of the environment block supplied — measured on this machine, not
  assumed. They are fixed identity values, not secrets, and nothing else leaks: a variable
  planted in the parent environment does **not** reach the child.

  So the test must assert the property, not an exact key set. Asserting
  `deepStrictEqual(keys, allowlist)` can never pass on the target platform and says nothing
  about safety anyway. Assert instead that (a) no key outside the allowlist plus that fixed
  Windows set is present, and (b) a distinctive value placed in `process.env` before spawning
  is absent from the child. The second is the control §8.1 actually asks for.
- Set `windowsHide: true`.
- `detached: false`, so the child stays in the supervisor's process group and dies with it.

## Correlation — the cross-spec coupling

SPEC §8.2 route 1 correlates Numbat records to Toros sessions by `project_path`. That works
only if **each session gets its own directory**.

So: `start()` creates `<workspace.root>/<ctx.correlation_id>/` and uses **that** as the child's
`cwd`, not the workspace root itself. The directory name is the correlation id, which the
observer (Spec H) matches against. Two concurrent sessions in one workspace must not share a
directory, or their findings become indistinguishable.

Do not attempt to pass `ctx.correlation_id` to the child as a session id. Codex generates its
own and offers no flag to accept one — that is exactly why correlation goes through the path.

## One-shot exchange framing

`start()` creates the conversation and directory without spawning. `send()` spawns one real
CLI process, writes the message, closes stdin, consumes JSONL to exit, and records the CLI's
conversation id. The next exchange uses `codex exec resume <thread_id>` or Claude `--resume
<session_id>`. Raw output is retained as `exchange-N.jsonl`; rendered assistant text is what
`read()` serves. Both framing implementations require authenticated real-binary tests.

Claude maps `read-only` to `--permission-mode plan` and `workspace-write` to
`--permission-mode acceptEdits`. These are Claude policy modes, not OS confinement.

## Reading

`read(sessionId, cursor)` returns the bytes after `cursor` and the new cursor. Requirements:

- Buffer stdout and stderr **combined, in arrival order**, into one append-only buffer per
  session. Interleaving matters for diagnosis; two separate streams cannot be re-interleaved
  afterwards.
- `cursor` is a **byte** offset into that buffer, not a character offset. Slice on bytes and
  decode after, or a multi-byte character straddling the cursor is corrupted on every read.
- A cursor beyond the buffer end returns an empty chunk and the unchanged cursor. It is not an
  error — the coordinator polling a quiet session is normal.
- A **negative or non-integer** cursor is `E_SCHEMA`.

## Limits and lifecycle

- **Output limit** is cumulative across the conversation. Exceeding it kills the active
  exchange and throws `E_OUTPUT_LIMIT`; rendered partial output is never treated as success.
- **Timeout** applies per action. On expiry, kill and wait for the exchange to exit before
  throwing `E_TIMEOUT`.
- **`ctx.signal`** aborts in flight, kills and reaps the exchange, then throws `E_CANCELLED`.
- **`interrupt`** kills and reaps the active exchange but keeps the conversation open. It is a
  no-op while idle.
- **`stop`** closes the conversation. If an exchange is active, it kills the process tree and
  does not return until the child has exited.
- **`dispose()`** stops every conversation and reaps every active exchange.

Stopping and killing are idempotent. No timeout, cancellation, interrupt, stop, or dispose call
may settle while its child is still alive.

## Acceptance tests

`packages/adapters-cli/test/` has two evidence layers:

1. The hermetic Claude-shaped JSONL fixture covers cwd isolation, environment allowlisting,
   shell-free spawning, byte cursors, output bounds, timeout/cancellation, policy-override
   rejection, and immediate child death on interrupt/stop/dispose.
2. Authenticated real-binary suites cover Codex and Claude framing, assistant-text parsing,
   continuation across two exchanges, raw JSONL retention, and idle lifecycle operations.

A missing or unauthenticated real binary fails its suite rather than skipping. The fixture is
necessary for deterministic fault injection, but it may never be the only protocol evidence.

## Verification

```
npx tsc --build packages/adapters-cli
node --test packages/adapters-cli/dist/test/*.test.js
```

Clean, zero skips. These tests spawn real processes, so give them generous timeouts and make
sure each one reaps its fixture even on failure.

## Out of scope

Policy, persistence, receipts, the observer, and HTTP. This unit runs a process and reports
what happened. It never decides whether the process should have run.
