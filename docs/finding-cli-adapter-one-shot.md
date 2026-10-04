# The CLI adapter models a REPL that neither CLI provides

**Date:** 2026-08-08 · First live run of the Hermes coordinator against the deployed Node Core
on Oruc. Job `8feacb63-d25b-4611-9204-bb6e14d3234d`, 10 actions, 43 events, 10 receipts.

The coordinator worked. The adapter under it cannot drive the CLI it is named after, and neither
can its sibling. **SPEC §10 Phase 1 acceptance criterion 1 does not pass**, and did not fail for
any reason a unit test was positioned to see.

## What the run established, before the failure

Worth stating first, because the defect below is not a verdict on the loop:

- Every action ran the full `action.requested` → `action.decided` → `action.started` →
  `action.finished` sequence, with one receipt id threaded through all four.
- Policy allowed each one on its own terms — `"The action satisfies the policy controls"` — and
  the envelope held: only `codex.*` capabilities were ever proposed, only inside `sandbox`.
- At 10 of 20 allowed actions the coordinator stopped the session and moved the job
  `working → blocked` rather than continuing to retry. §3 principle 7, observed in the wild.

## The defect: `send` waits for output that a batch command cannot produce

`packages/adapters-cli/src/index.ts:203` writes `${message}\n` to the child's stdin and then
blocks until `session.bytes_total` increases. That is a line-oriented interactive REPL contract:
one line in, some output out, connection stays open.

`codex exec` is not that. It is a one-shot batch command that **reads stdin to EOF** before doing
anything — it announces exactly this and then waits:

```
$ codex exec "Reply with the single word OK and do nothing else."
Reading additional input from stdin...
```

The adapter never closes stdin except in `interrupt`, so codex never begins, never writes a byte,
and `send` blocks for the full `timeout_ms` (120 s) and returns `E_TIMEOUT`. Every subsequent
`read` fails the same way against a process that is still waiting on the same EOF. In the live
run that is 4 of the 10 actions, and the reason nothing reached the sandbox: both session
directories are empty and `hello-toros.md` was never created.

## A second, independent blocker in the same path

Even with stdin closed, codex refuses to run where Toros puts it:

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

The per-session working directory under `workspaces/sandbox/<session-id>` is not a git repository
and is not on codex's trusted list. This is independent of the EOF problem — fixing one leaves the
other.

Both are confirmed by direct test, same binary, same sandbox, stdin closed and the flag supplied:

```
$ "Reply with the single word OK and do nothing else." | codex exec --skip-git-repo-check
codex
OK
elapsed: 7s  exit=0
```

Seven seconds against 120 s of timeout. The CLI is healthy; the adapter's contract is wrong.

## The claude adapter shares the defect, three ways over

It was checked because a defect in a shared abstraction is rarely single-tenant. It is worse off
than codex, not better:

1. **It is not deployed at all.** `%LOCALAPPDATA%\Toros\config.json` declares only `codex` and
   `excel`. `buildAdapters` registers `claude` only when `adapters.claude` is present, so the
   Phase 1 deliverable "Claude and Codex CLI adapters" is half-installed on Oruc, and has been
   since 2026-08-02.
2. **The obvious executable is rejected before it can fail.** `claude` on PATH resolves to
   `claude.ps1` (beside `claude.cmd`), and `init()` refuses anything that is not a real `.exe` or
   `process.execPath`. So the natural configuration fails registration with
   `CLI executable must be a real .exe file`. A real binary does exist —
   `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, which the shim itself
   invokes — so this is a config trap, not a dead end. The `.exe` rule is right and should stay:
   it is the same class of trap recorded in the shim lesson elsewhere in this fleet.
3. **The default invocation is a full-screen TUI**, which fits the adapter's line contract no
   better than a batch command does. Claude Code has exactly one line-oriented mode —
   `--print --input-format stream-json --output-format stream-json` — and that mode expects
   newline-delimited **JSON messages** on stdin, not the raw `${message}\n` the adapter writes.

So the adapter's session model is satisfiable for claude, but only in a framing the adapter does
not implement.

## Options, deliberately not decided here

1. **Per-exchange one-shot with session continuation.** `send` spawns the CLI, writes the message,
   closes stdin, captures output to completion; continuation across turns uses the CLI's own
   resume (`codex exec resume`, `claude --continue`). Keeps the tool surface and the session
   abstraction intact and changes only what a "session" is made of. Largest behavioural change
   inside the adapter, smallest outside it.
2. **Per-CLI framing.** Keep the long-lived child, and make each adapter speak its CLI's actual
   protocol — stream-json for claude, and for codex whatever survives the EOF requirement. Honest
   about the CLIs being different, at the cost of the two adapters no longer sharing a body.
3. **Narrow the criterion** to CLIs that genuinely offer a line REPL, and say which ones those
   are. Cheapest, and worth stating only so it is visibly rejected: criterion 1 exists to prove
   Toros can supervise the agents it actually intends to supervise.

Whichever is chosen, `--skip-git-repo-check` (or a trusted-directory registration for the session
root) is needed regardless, and is not a substitute for any of them.

## Why this was not found earlier

The coordinator was proven on 2026-08-06 against `packages/bakeoff`, and the scratch harness from
2026-08-07 ran it against `echo-cli.mjs` — a line-oriented stub that reads a line and echoes it.
The stub matches the adapter's assumption exactly. Both sides of the contract agreed with each
other, and neither had ever met the CLI the contract was written for.

The unit suite is not at fault for missing it: it proves the units. This is what `DEPLOY.md` §7
means by "run these against the deployed service" — the first time the real binary was on the
other end of the pipe, it took one action to expose.
