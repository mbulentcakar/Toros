# S — Hermes coordinator runtime

**Read `00-CONTRACTS.md` first.** `packages/contracts` is frozen; if you cannot implement this
without changing it, stop and say so, naming the exact type and what is missing.

## What this is

Toros currently has a control plane with no pilot. Node Core exposes the fifteen-tool surface a
coordinator calls, and `packages/bakeoff` scores candidate models on fixed cases — but nothing
runs the loop that turns a job into work. This unit is that loop.

**One job, one process, one exit.** `hermes <job_id>` drives an existing job until it reaches a
terminal state, exhausts its budget, or hits a wall it cannot pass, then exits. It is not a
daemon, not a queue, and not a scheduler.

> **Amended by spec Y.** The process model above is unchanged — still one-shot, still not a
> daemon — but the process is no longer stateless. A run rehydrates its model context from the
> job's durable conversation and from the receipts of actions already executed, and persists each
> of its own turns before the next model request. The fifteen-tool surface is now seventeen:
> `list_turns` and `append_turn` are addressed by a per-run credential Node Core issues over
> stdin, never by conversation id, so a run reaches its own history and no other. Rule 1 stands
> unchanged: the coordinator still touches nothing but HTTP.

## Allowed paths

- `packages/coordinator/**` (new package, `@toros/coordinator`)
- `docs/DEPLOY.md` — one new section, §6, for installing and running it

Nothing else. Do not modify Node Core, policy, contracts, or any existing package.

## The security shape — read this before designing anything

The coordinator is **the untrusted party**. Every control in this system exists because the model
driving it might do the wrong thing. Three rules follow, and a diff that breaks any of them is
rejected regardless of how well the loop works:

1. **HTTP only.** The coordinator's sole affordance is `POST http://127.0.0.1:<port>/tools/<name>`
   with the coordinator bearer. It MUST NOT open the SQLite store, read the event log, or import
   `@toros/store`. If you find yourself needing state the tool surface does not expose, that is a
   finding to report, not a shortcut to take.

2. **It never holds the operator token.** `%LOCALAPPDATA%\Toros\config.json` contains
   `operator_token`, which grants approvals. The coordinator must never read that file. It reads
   its own config at `%LOCALAPPDATA%\Toros\coordinator.json`, which contains no operator
   credential. This separation is the reason the approval gate means anything: a coordinator that
   could read `config.json` could approve its own actions.

3. **No credential reaches model context.** Not the node bearer, not the model API key, not file
   contents that happen to contain either. The system prompt and every transcript entry are
   built from job state and tool results only.

## Configuration

`%LOCALAPPDATA%\Toros\coordinator.json`, ACL-restricted to the operator account:

```jsonc
{
  "port": 8787,                                  // Node Core's loopback port
  "token": "<the coordinator bearer from config.json>",
  "model": "openai/gpt-5.6-sol",                 // provider-qualified id
  "base_url": "https://openrouter.ai/api/v1",
  "api_key": "<provider key>",
  "temperature": 0,
  "max_turns": 40
}
```

Every field is required except `temperature` (default `0`) and `max_turns` (default `40`).
Refuse to start on a missing or empty `token`, `model`, `base_url`, or `api_key` — the same
posture `main.ts` takes for the node token. Never log any of them.

## The loop — normative

```
1.  job_status(job_id)                      → current state and envelope
2.  if the job is already terminal          → exit 0, report the state, do nothing else
3.  list_capabilities(job_id)               → the tools this envelope actually permits
4.  build the system prompt (below)
5.  loop, at most max_turns times:
      a. ask the model for one CoordinatorResponse
      b. parse it with parseCoordinatorResponse from @toros/envelope
      c. dispatch on response.state:
           act      → invoke response.action exactly once, append the result, continue
           complete → job_complete(job_id, summary), exit 0
           blocked  → job_block(job_id, reason), exit 0
           ask      → exit 3 (see "ask has nowhere to go")
6.  if the loop runs out of turns          → job_block(job_id, "turn limit reached"), exit 4
```

**Exactly one action per turn.** SPEC §5: "Only one action is permitted per coordinator turn;
parallel tool calls are disabled." If the model returns anything that would produce two actions,
that is a parse failure, not a thing to iterate over.

**Use `parseCoordinatorResponse`.** It exists in `@toros/envelope` and already enforces the
response contract. Do not write a second parser. A response that fails to parse is fed back to
the model once as an error result; a second consecutive parse failure ends the run with exit 5.

## The system prompt

Built fresh each run, from:

- the job's `objective` and `acceptance` criteria, verbatim from the envelope;
- the capability list returned by `list_capabilities`, which is already envelope-filtered;
- the tool names and their argument shapes;
- the response contract (`state`, `reason`, `action`), stated as the only acceptable output;
- the standing constraints: one action per turn, `accepted` is not a state it can set, a denial
  is final and must not be reformulated.

It must NOT contain the bearer token, the API key, the contents of `coordinator.json`, or any
path outside the job's allowed workspaces.

## Tool results, and what goes back into context

Feed the model the tool's JSON response, truncated to 4 KiB with a marker when truncated. Large
outputs are the norm — `read_cli` returns process output — and an unbounded transcript both costs
money and pushes the objective out of the window.

**A tool error is a result, not a crash.** `E_CAP_NOT_ALLOWED`, `E_PATH_ESCAPE`, `E_SCHEMA`,
`E_FORBIDDEN` and friends go back to the model as the outcome of its action, because learning
that an action was denied is how it picks a different one. Three exceptions end the run:

| Error | Exit | Why |
|---|---|---|
| `E_BUDGET_EXHAUSTED`, `E_RETRIES_EXHAUSTED`, `E_EXPIRED`, `E_JOB_TERMINAL` | 0 | The envelope is spent. Report and stop; do not attempt a narrower action. |
| `E_APPROVAL_REQUIRED` | 6 | Needs a human. Print the `approval_id` and the exact arguments, and stop. |
| Transport failure (connection refused, 5xx) | 7 | Node Core is not answering. Retrying blind is how a loop becomes a hammer. |

**`E_APPROVAL_REQUIRED` does not wait and does not poll.** Phase 1 has no channel for the
coordinator to learn that an approval was granted, and inventing one would put the coordinator in
the approval loop — exactly where it must not be. The operator grants it and re-runs the job.

**AMENDED 2026-08-06 — the re-run needs the id back.** As first written this was a dead end,
and the implementer said so: the coordinator reported the approval id and stopped, the operator
granted it, and the re-run asked for the same approval again because nothing carried the granted
id back. A gated action could never complete.

`hermes <job_id> --approval <approval_id>` closes it. The id is attached to every tool call in
that run, which is safe because Node Core checks the binding, not the coordinator: an ungated
capability never consults the verifier, and one gated on different arguments refuses it. The
coordinator still learns nothing about approval state and still cannot grant anything — the
operator remains the only party who decides, which is the property that mattered.

`E_APPROVAL_INVALID` ends the run at exit 6 rather than going back to the model. The id is
spent, expired, or bound to other arguments, and none of those is something the model can fix by
trying again.

## `ask` has nowhere to go

`CoordinatorResponse.state` includes `ask`, but Phase 1 has no operator-question channel: the
cockpit is read-only and there is no inbox. Print the model's `reason` as the question and exit 3.
Do not invent a channel, do not fall back to `blocked` — the two mean different things and an
operator reading the log needs to see which happened.

## Actor labelling

Pass `model: <the configured model id>` on every tool call, so each receipt records which model
acted. Node Core reserves the label `operator` and will rewrite it; do not try to send it.

## Acceptance

Every one of these is a test. None may require a live model or a live Excel.

1. A job whose first response is `complete` reaches `proposed` and the process exits 0.
2. A job whose first response is `blocked` reaches `blocked` and exits 0.
3. An `act` response invokes exactly the named tool, exactly once, with exactly the given
   arguments.
4. A response that would produce two actions is rejected without invoking anything.
5. A denied action (`E_CAP_NOT_ALLOWED`) is fed back to the model and the loop continues.
6. `E_APPROVAL_REQUIRED` exits 6 and prints the `approval_id`.
7. `E_BUDGET_EXHAUSTED` exits 0 without attempting another action.
8. A job already in a terminal state exits 0 having invoked no tool.
9. `max_turns` is honoured: the run ends with `job_block` and exit 4.
10. Two consecutive unparseable responses end the run with exit 5.
11. **The system prompt contains neither the bearer token nor the API key.** Assert against the
    actual string sent to the model, not against a helper's return value.
12. **The coordinator never opens the store.** Assert that `coordinator.json`'s directory is the
    only config path read, and that no `@toros/store` import exists in the package — a grep-style
    assertion in the test is acceptable and expected here.
13. Every tool call carries the configured model id as `model`.

Test the model with a stub: an injectable transport returning canned `CoordinatorResponse`
objects. `packages/bakeoff` already stubs `fetch` for the same reason — follow that pattern. Run
against a REAL Node Core started in-process with a mock adapter, exactly as
`packages/node-core/test/acceptance.test.ts` does; do not stub Node Core.

## What this unit does not do

- It does not create jobs. The operator seals an envelope and creates the job, as
  `tools/acceptance.mjs` does. The coordinator is handed a `job_id` that already exists.
- It does not accept work. `accepted` is not reachable from the tool surface and must not be
  attempted.
- It does not choose a model. That is SPEC §9's bakeoff, and the chosen id goes in the config.
- It does not run unattended. Phase 1 is one operator at one console.
