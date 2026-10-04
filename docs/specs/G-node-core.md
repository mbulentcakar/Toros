# Spec G — `@toros/node-core`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements **SPEC §4.2** (Node Core) and **§6** (the Hermes tool surface). This is the unit that
composes every other one.

## Objective

The headless local service. It owns the loop that every action passes through: validate,
decide, execute, record — in that order, with no path around it.

Read SPEC §3 and §4.2 before starting. The single design rule here is that **the tool surface
is the only way in**. There is no generic `shell`, `execute`, `read_file`, `write_file`, or
click tool, and no argument on any of the fifteen tools that becomes one.

## Allowed paths

```
packages/node-core/package.json
packages/node-core/tsconfig.json
packages/node-core/src/**
packages/node-core/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package's source
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts`, `@toros/envelope`, `@toros/store`, `@toros/registry`,
`@toros/policy`, `@toros/adapters-cli`, `@toros/adapters-app`, `@toros/observer`,
`@toros/relay`. HTTP is `node:http` — no express, no fastify.

## Public API — frozen

```ts
export interface NodeCoreOptions {
  readonly node_id: string;
  readonly db_path: string;
  readonly workspaces: readonly Workspace[];
  /** Loopback only. Binding anything else is a defect — see below. */
  readonly port: number;
  /** Bearer token. Read from config by the caller, never generated here. */
  readonly token: string;
  readonly adapters: readonly Adapter[];
  // AMENDED 2026-08-05 (00-CONTRACTS §10 A5): also accepts a factory, because a
  // correlating observer cannot be built before the thing it correlates against.
  readonly observer: SecurityObserver | ((deps: ObserverDeps) => SecurityObserver) | null;
  readonly approval_required: readonly CapabilityId[];
  // AMENDED 2026-08-05 (00-CONTRACTS §10 A5). Bearer for the operator surface,
  // which issues approvals. Required when a capability is gated, and MUST differ
  // from `token` — the coordinator holds `token`, and a gate the gated party can
  // open is not a gate. `start()` refuses otherwise.
  readonly operator_token?: string;
}

export interface NodeCore {
  start(): Promise<{ readonly port: number }>;
  stop(): Promise<void>;
}

export function createNodeCore(options: NodeCoreOptions): NodeCore;
```

## The action pipeline — normative

Every tool call that reaches an adapter follows exactly this sequence. No tool may skip a step,
and no step may be reordered.

1. **Authenticate** the request (bearer token, constant-time compare).
2. **Load** the job and its stored envelope and digest from the store.
3. **Append** `action.requested` to the event log.
4. **Decide** via `policy.decide(...)`, passing the stored envelope and digest.
5. **Append** `action.decided` with the verdict.
6. **Write a receipt** with `outcome: 'denied'` and return the error **if denied. Stop here.**
7. **Increment** `actions_used` — atomically, before execution.
8. **Append** `action.started`; write the receipt with `outcome: 'running'`.
9. **Invoke** the adapter.
10. **Append** `action.finished`; update the receipt with the outcome and artifacts.
    Adapter-specific values go under `Receipt.adapter_fields` and only when the
    key is declared in `AdapterManifest.receipt_fields`. An undeclared
    `ActionResult.receipt_extra` key fails with `E_ADAPTER_FAILURE`; it is never
    silently dropped.

Two consequences worth stating because they are easy to get wrong under time pressure:

- **A denied action still produces a receipt and two events.** §8.1 requires receipts for
  request, decision, execution and result; a denial that leaves no trace is exactly the gap an
  audit exists to close. Denials are the most interesting rows in the log.
- **The budget is spent at step 7, before the adapter runs.** If it were spent after, a job
  could exceed `max_actions` by launching concurrent actions that each see the old count.

## The fifteen tools

Implement the surface in SPEC §6 exactly. Notes where behaviour is not obvious:

- `job_complete(job_id, summary)` sets state to **`proposed`**. Never `accepted`. There must be
  no code path, argument, or tool sequence by which a caller reaches `accepted` — that
  transition belongs to the operator and is not on this surface at all.
- `job_block(job_id, reason)` sets `blocked`. Both are terminal: subsequent actions get
  `E_JOB_TERMINAL`.
- `list_capabilities()` returns capabilities **filtered by the job's `allowed_capabilities`**,
  not everything the node has. A coordinator does not need to know what it may not use, and
  showing it invites attempts.
- `read_cli(job_id, session_id, cursor)` is incremental; persist the returned cursor.
- `list_activity(job_id)` returns receipts and events for that job — never another job's.
- Every tool taking a `job_id` must verify the session or artifact it names **belongs to that
  job**. A session id from job A supplied to job B is `E_SESSION_UNKNOWN`, not a successful
  cross-job read.

## Transport

`node:http`, bound to **`127.0.0.1` explicitly**. Not `0.0.0.0`, not the default, not a
hostname that might resolve to a routable interface. Binding beyond loopback exposes the entire
tool surface to the network, and it is one wrong argument away.

- Bearer token in `Authorization`. Compare with `timingSafeEqual` on equal-length buffers.
- Reject a request with no token, a wrong token, or a token of the wrong length — all with the
  same 401 and the same body. Distinguishing them is a length oracle.
- **Reject any request carrying an `Origin` header.** No browser page should reach this service;
  a request bearing an origin is a browser, and honouring it invites DNS rebinding against
  localhost. The cockpit is a Tauri app and does not send one.
- Cap request bodies (1 MiB is generous) and reject larger with 413.
- Never log the token, and never include it in an error body.

The operator surface uses the distinct `operator_token`. In addition to exact approval listing
and resolution, it exposes `POST /operator/findings` with a required `job_id`, returning only
that job's stored findings. This route is read-only and must remain outside `TOOL_NAMES`: the
coordinator bearer receives 401 and the coordinator cannot inspect findings. Reading findings
must not alter policy, approvals, receipts, job state, or adapter execution. The endpoint exists
for the cockpit and other authenticated operator clients only.

## One action per turn

SPEC §5 disables parallel tool calls. Node Core enforces it rather than trusting the model:
**serialise actions per job**. A second action for a job whose action is still in flight is
refused with `E_PARALLEL_ACTION`.

Do not implement this as a global lock — two different jobs must proceed concurrently. Per-job,
not per-process.

## Startup and restart

`start()` opens the store, applies migrations, registers every adapter, starts the observer if
present, and binds. Registration failure for one adapter is logged and skipped; the node starts
with the adapters it has. A missing Excel installation must not prevent CLI jobs from running.

**Checkpoint survival is a §10 acceptance criterion.** After restart, a job in `checkpoint`
state must be resumable, with its receipts, artifacts, and intact event chain. Verify the chain
at startup and log the result; do not refuse to start on a broken chain — an operator needs the
service running to investigate it — but make the failure loud.

## Acceptance tests

`packages/node-core/test/`. Use in-memory storage and mock adapters where possible; use the
real store for the restart tests.

**Pipeline**
1. `a denied action writes a receipt with outcome denied and both events`
2. `a denied action never reaches the adapter`
3. `actions_used increments before the adapter is invoked`
4. `a successful action writes request, decided, started and finished events in order`
5. `the receipt records the envelope digest the job was created with`

**Tool surface**
6. `job_complete sets proposed and never accepted`
7. `no tool sequence reaches the accepted state`
8. `an action against a completed job returns E_JOB_TERMINAL`
9. `list_capabilities returns only capabilities in allowed_capabilities`
10. `a session id from another job returns E_SESSION_UNKNOWN`
11. `list_activity returns only the requested job's rows`

**Transport**
12. `binds to 127.0.0.1 and not to another interface`
13. `rejects a missing token with 401`
14. `rejects a wrong token with 401 and an identical body`
15. `rejects a request carrying an Origin header`
16. `rejects a body over the size cap with 413`
17. `never includes the token in any response body`

**Concurrency**
18. `a second concurrent action for one job is refused with E_PARALLEL_ACTION`
19. `two different jobs act concurrently`

**Restart** — the §10 criterion
20. `a checkpointed job is resumable after stop and start`
21. `receipts, artifacts and the event chain survive a restart`
22. `startup verifies the chain and logs the result`
23. `startup succeeds when one adapter fails to register`

## Verification

```
npx tsc --build packages/node-core
node --test packages/node-core/dist/test/*.test.js
```

Clean, zero skips.

## Out of scope

The cockpit UI, the bakeoff harness, Phase 2 transport, and Hetzner. Node Core serves
localhost and nothing else.
