# Spec AT — agent discovery over MCP: read-only desktop and machine discovery for Claude and Codex

**Read `00-CONTRACTS.md` first.** It is short and it is binding. AT uses A8's `ctx.actor`, A8/A9's
`allowed_apps`, and existing error codes with their existing meanings. It needs one small
contract amendment, **A11** (round 3, below): a new code `E_GRANT_INVALID`, and a documentation
note on `E_MODE_DENIED`. A11 is made by the architect in AT1, with every consumer in the same diff.

**Status: accepted by the operator, 2026-10-27 (round 4 text, head 994fe2c).** Round 2 answered the independent review
of round 1 (Grok, 2026-10-26, findings 1–8); round 3 answers its round-2 re-review (error-code
meanings and A11, mission scoping, the MCP deadline, test 6a); round 4 answers its round-3
re-review (the mission rule stated once, in AS; the MCP deadline's behaviour). Drafted by Claude as the first, small step toward
spec AS. AS (PR mbulentcakar/Toros#1) lets an agent *act* on the desktop under missions and
cross-agent approval. Its dependency chain is long: A7, A10, AG, the approver profile, the
classifier, and an MCP review. AT ships the read half now, on what is already merged and natively
re-reviewed (spec AR, the AR remediation, the cleared AR gate of #18). AS later extends the same
MCP server and credentials instead of replacing them (see "Relationship to spec AS").

## Objective

Let a Claude Code or Codex session **call** Spec AR's read-only capabilities itself:
`desktop.state`, `desktop.inspect` and `machine.inventory`. It calls them through a local stdio MCP
server, inside a job the **operator** created and assigned to that agent. Today only the Hermes
coordinator or the operator can call them.

Nothing in AT can click, type, select, launch, or write. The agent sees exactly what Spec AR shows
a job: structure only, no UIA names or values, window titles only for apps both the node and the
job allow, opaque single-use handles, and nothing at all while the desktop is locked.

## Non-goals

- Any mutation, including the `desktop_uia.*` actions of AS.
- Missions, approvers, surface profiles, and the cockpit view: those are AS.
- Calling any capability other than the three listed, even if the job's envelope lists more.
- Remote agents. Loopback only, as for every Node Core route.

## Actors and credentials

| Actor | Credential | May |
|---|---|---|
| Operator | `operator_token` (existing) | create jobs; grant a job to an agent; revoke a grant |
| Agent (Claude or Codex) | `agents.claude.token` / `agents.codex.token` (new config) | read its grant; call the three capabilities in its granted job |
| Hermes coordinator | `token` (existing) | unchanged; nothing here |

- Node Core refuses to start unless every configured `agents.*.token` passes the same
  `assertPrintableAscii` check as `token` and `operator_token` (ASCII `0x21–0x7E` only;
  `core.ts:27-40`). The HTTP parser strips surrounding whitespace, so without that check
  `operator_token + " "` would arrive as `operator_token`. Only after that, `token`,
  `operator_token` and every agent token must be pairwise distinct and at least 32 characters.
  This is the rule AS states, so AS inherits it unchanged.
- Each credential is accepted **only** on its own routes. An agent token on `/tools/*` or
  `/operator/*`, or a `token`/`operator_token` on `/agent/*`, is `401 Unauthorized`, compared in
  constant time like the existing bearers.
- **The `agent:` actor prefix is reserved.** Today the tools surface records a caller-supplied
  model label as the receipt actor and reserves only `operator` (`coordinatorActor`,
  `action-pipeline.ts:311-316`). That function is the only place a caller-supplied label becomes
  an actor: in-process dispatch (`core.ts:237-240`) and replay of a stored actor (`:737-747`) both
  go through it or reuse its result. AT adds the rule **inside `coordinatorActor`**: a label
  starting with `agent:` (any case, after trimming) is recorded as `coordinator`.
- The agent routes set the actor to `agent:claude` or `agent:codex` **from the bearer that
  matched**. They never take it from the body and never call `coordinatorActor`. So a coordinator
  can never reuse an agent's handles or continuation tokens, which F3b binds to exact
  `(job, actor)` (`adapters-desktop/src/adapter.ts:154-157`, `:694-698`), and an agent can never
  reuse a coordinator's.

## Grants

A **grant** binds one agent to one job: `{ grant_id, agent, job_id, created_at, expires_at,
revoked_at }`.

- **Storage.** A table in the node database, added by a **store migration** (so AT1 also touches
  `packages/store/**`). It has a partial unique index on `agent WHERE revoked_at IS NULL`. The
  stage-graph sidecar JSON file is not a precedent here: it cannot enforce uniqueness.
- Operator routes:
  - `agent_grant_create { job_id, agent, expires_in_hours? }` → the grant. It defaults to 8 hours.
    The effective expiry is the earlier of this and the job's `expires_at`.
  - `agent_grant_revoke { grant_id }`.
  - `agent_grants {}` → the list.
- **One live grant per agent.** `agent_grant_create` runs in one `BEGIN IMMEDIATE` transaction:
  it revokes the agent's live grant, if any, then inserts the new one. The unique index makes a
  lost race fail, never produce two live grants.
- **Refused grants:**
  - unless the job's `allowed_capabilities` lists at least one of the three AT capabilities
    (`E_GRANT_INVALID`, reason `"no_discovery_capability"`);
  - unless the job's `allowed_workspaces` has **exactly one** entry (`E_GRANT_INVALID`, reason
    `"workspace_count"`), so the workspace is never a choice;
  - for a terminal job (`E_JOB_TERMINAL`).
- The job's envelope still bounds everything else: `allowed_apps`, `forbidden`, `max_actions`,
  expiry.
- **Error codes on agent calls:**
  - no live grant, or a revoked one: `E_GRANT_INVALID` (A11), reason `"no_grant"` or `"revoked"`;
  - the grant's or the envelope's `expires_at` has passed: `E_EXPIRED`;
  - the job is terminal: `E_JOB_TERMINAL`.

### A11 — `E_GRANT_INVALID`; `E_MODE_DENIED` on the agent surface (spec AT) — PROPOSED

| Contract type | Change |
|---|---|
| `ErrorCode` (`errors.ts`) | **Structural.** Add `E_GRANT_INVALID`: an agent call has no live grant, its grant was revoked, or a grant cannot be issued for this job (no discovery capability, or not exactly one workspace). Distinct from `E_RUN_INVALID` (a coordinator run credential) and from `E_CAP_NOT_ALLOWED` (the capability is not in `allowed_capabilities`). |
| `ErrorCode.E_MODE_DENIED` | **Documentation.** Besides an advisory run, the agent surface is a mode too: it permits only `desktop.state`, `desktop.inspect` and `machine.inventory`, and `desktop.*` only while `desktop_control.ar_gate_cleared` is set. A call outside that is `E_MODE_DENIED`. |

Consumers: contracts (`errors.ts`), node-core (agent routes), the cockpit's error rendering, and
`docs/specs/00-CONTRACTS.md` §10 (A11 is added there in AT1).
- **Concurrency.** Each agent call takes a **per-agent lock** before it re-reads its grant row, and
  holds it until the pipeline returns. It re-reads the row **after the request body is read**, as
  the run-credential path does (`http.ts:247-254`). So a revoke or replacement takes effect for
  the next call. A call already inside the adapter may finish; no further call starts, on that
  job or any other, under the old grant.

## Agent routes

All are `POST` with a JSON body, loopback-only, and carry the agent bearer.

| Route | Body | Result |
|---|---|---|
| `/agent/status` | `{}` | `{ agent, grant: { grant_id, job_id, expires_at } \| null, objective, allowed_capabilities, desktop_enabled }` |
| `/agent/invoke` | `{ capability, parameters }` | the ordinary `invoke_app_action` result |

`/agent/invoke`:

- `capability` must be one of `desktop.state`, `desktop.inspect` or `machine.inventory` (else
  `E_MODE_DENIED`), **and** listed in the granted job's envelope (else `E_CAP_NOT_ALLOWED`). Both
  refusals are recorded as denied receipts.
- **The route builds the call itself.** It constructs `{ job_id, workspace_id, app_id, action_id,
  parameters }` from the grant (job), the envelope's single `allowed_workspaces` entry, and the
  capability. From the body it takes only `capability` and `parameters`, and from `parameters`
  only the keys the capability's input schema declares. Every other field is dropped: `job_id`,
  `workspace_id`, `model`, `actor`, `app_id`, `action_id`, and any of these nested in
  `parameters`. This matters because the pipeline otherwise reads `job_id`, `workspace_id` and
  `model` from its arguments (`action-pipeline.ts:386`, `:400`, `:434`). The workspace does not
  scope what these actions return (their `path_fields` are empty); the desktop scope is
  `allowed_apps` through `authorizeTargets`.
- `desktop.*` calls always run with `session_scope: "interactive"`, injected by the route; any
  caller value is ignored.
- Calls run through the **ordinary action pipeline**: budgets, A8 two-phase resolve and
  `authorizeTargets`, `forbidden` (token sequences, RR-01), receipts, timeouts. The only
  difference is `actor = agent:<name>`.
- `desktop.*` additionally needs the node flag `desktop_control.ar_gate_cleared === true` (strict,
  fail-closed like `coordinator_enabled`). When it is not set, the route answers
  `E_MODE_DENIED` with `reason: "ar_gate"`. AS uses the same flag, which AT introduces.
- **Mission hook (owned by AS1).** When the granted job has an AS mission, AS decides `desktop.*`
  here as well. The rule, its ordered codes, and its window predicate are stated **once**, in
  spec AS revision 6 ("The mission hook in AT's `/agent/invoke`"). AT1 leaves a single hook
  point that AS1 fills. Without AS, the hook allows.
- One action at a time per agent (`E_PARALLEL_ACTION`, 409), as on the tools surface.
- **Error bodies** on `/agent/*` are `{ error, message, reason? }`. The existing tools error writer
  copies only `approval_id` (`http.ts:257-264`), so the agent routes use their own writer that
  includes `reason`.

## MCP server: `packages/mcp-discovery`

- **Transport:** a local stdio MCP server, protocol revision **2025-06-18**, with zero runtime
  dependencies. It implements `initialize` with version negotiation, `notifications/initialized`,
  `ping`, `tools/list`, `tools/call`, and JSON-RPC errors. stdout carries protocol frames only;
  diagnostics go to stderr.
- **Launch:** `node packages/mcp-discovery/dist/src/main.js --agent claude|codex`. The token is read
  once from the fixed Toros config path (`%LOCALAPPDATA%\Toros\config.json`,
  `agents.<agent>.token`), and Node Core's port from the same file. No tool argument may name a
  URL, port, credential, path or executable.
- **Strict input:** any argv other than exactly `--agent claude|codex` is refused at start, as is
  any frame that is not a single JSON object.
- **Bounds:**
  - a frame is at most 1 MiB;
  - at most 4 JSON-RPC ids may be outstanding;
  - each tool call has a 45 s deadline, set **above** Node Core's 30 s action ceiling for the
    desktop and machine adapters (`main.ts:200`, `:280`). Core's own timeout therefore always
    closes the receipt first (`terminated`, `E_TIMEOUT`). The MCP deadline guards a hung
    connection or a wait before the action timer is armed (the per-agent lock, a store wait):
    when it fires, the server returns a JSON-RPC error for that id and destroys that request's
    socket. AT adds no request-abort hook to the pipeline;
  - a result is at most 1 MiB, refused rather than truncated.
- **Holds no policy.** Each tool maps to one route in a constant table. Node Core enforces
  everything even when the server is bypassed and the routes are called directly. The acceptance
  tests do exactly that.

| Tool | Input | Route |
|---|---|---|
| `toros_status` | `{}` | `/agent/status` |
| `desktop_state` | `{}` | `/agent/invoke` → `desktop.state` |
| `desktop_inspect` | `{ window_id, freshness_token, depth?, continuation_token? }` | `/agent/invoke` → `desktop.inspect` |
| `machine_inventory` | `{}` | `/agent/invoke` → `machine.inventory` |

Tool descriptions say plainly what the agent will and will not see: no control names or values;
titles only for allowed apps; handles are single-use (re-run `desktop_state` on
`refresh_required`); and a locked desktop returns `session: "unavailable"`.

**Client configuration** (documented, not automated): `claude mcp add toros-discovery -- node
<path>/main.js --agent claude`, and the Codex `mcp_servers` table equivalent. Neither writes a
credential into the client's config.

**Driver profile requirement**, the same one AS states. The agent's CLI must run under a profile
that cannot read the Toros config directory (`%LOCALAPPDATA%\Toros`). Otherwise it could read the
other bearers directly; the config file is not confinement (`http.ts:172-174`). `tools/orient.mjs`
warns when an agent token is configured and this requirement cannot be confirmed.

## What AT cannot enforce, stated plainly

- AT bounds what Node Core **returns**. It cannot stop an agent from reading the screen some other
  way: by a screenshot tool of its own CLI, or by its shell where the CLI has one. Toros-supervised
  workers run read-only (Claude in `plan`); an agent the operator runs interactively is outside
  Toros's control.
- A window title of an allowed app may contain document names. Choosing which apps a job allows
  is the operator's decision. The node allowlist (`adapters.desktop.authorized_apps`) is the
  upper bound.

## Amendments to SPEC (same PR as AT1)

- §4.2 Node Core, one bullet added: "serving read-only discovery (Spec AR) to an operator-granted
  Claude or Codex session over the loopback `/agent/*` routes (Spec AT)".
- §8.1 Policy controls, one bullet added: "each bearer (`token`, `operator_token`, `agents.*.token`)
  is pairwise distinct, at least 32 characters, and accepted only on its own routes; the `operator`
  and `agent:` actor labels cannot be claimed over the tools surface".
- §2 Non-goals is unchanged. AT adds no clicker and no shell, and serves no remote caller.

## Delivery slices

| Slice | Content | Allowed paths |
|---|---|---|
| AT1 | amendment A11 (architect), `agents.*` config and start-up checks, reserved `agent:` prefix, grants migration and operator routes, agent routes with the AS mission hook point, `desktop_control.ar_gate_cleared`, receipts | `packages/contracts/src/errors.ts` + its consumers (A11 only), `docs/specs/00-CONTRACTS.md`, `packages/node-core/src/**`, `packages/store/src/**` (grants migration only) + tests |
| AT2 | `packages/mcp-discovery` | `packages/mcp-discovery/**`, root `package.json` workspace entry |
| AT3 | `docs/USING.md` agent section, `tools/orient.mjs` (agent tokens present/distinct, flag state), STATUS | `docs/**`, `tools/orient.mjs` |

Reviews (workspace invariant 3: auth and MCP surfaces): AT1 and AT2 each get an independent code
review, and the MCP surface gets an **independent MCP review** by a lineage other than the
implementer's. Native tests run on a real, unlocked Windows desktop, and skip counts are findings.

## Acceptance tests

1. Start-up refuses each of these agent tokens:
   - shorter than 32 characters;
   - with any character outside `0x21–0x7E`, including `operator_token + " "` and `token + "\n"`;
   - equal to `token`, `operator_token`, or the other agent's token.
2. Each bearer is refused on every other surface (`/agent/*` with `token` or `operator_token`;
   `/tools/*` and `/operator/*` with an agent token): 401, constant-time compare.
3. A label of `model: "agent:claude"` (and `" AGENT:Codex "`) is recorded as actor `coordinator`
   both over HTTP `/tools/*` and through in-process `tools.dispatch`. Its handle is refused
   (`refresh_required`) when the agent presents it, and the reverse.
4. Grant lifecycle, each case asserting its own code:
   - no grant → `E_GRANT_INVALID` (`no_grant`);
   - revoked → `E_GRANT_INVALID` (`revoked`);
   - grant or envelope past `expires_at` → `E_EXPIRED`;
   - terminal job → `E_JOB_TERMINAL`;
   - two **overlapping** `agent_grant_create` calls for one agent leave exactly one live grant;
   - a revoke landing while a call's body is being read, followed by a grant on a second job,
     lets no further call run under the old grant;
   - a job with zero or two `allowed_workspaces` cannot be granted (`E_GRANT_INVALID`,
     `workspace_count`).
5. A capability outside the three, even one the job lists (e.g. `excel.read_range`), is
   `E_MODE_DENIED` with a denied receipt. One of the three that the job does not list is
   `E_CAP_NOT_ALLOWED`, also with a denied receipt.
6. `desktop.*` with the flag unset, `false`, or `"true"` (a string) → `E_MODE_DENIED` with
   `reason === "ar_gate"` in the response body; `machine.inventory` still works.
6a. Direct `POST /agent/invoke` with smuggled `job_id`, `workspace_id` (a foreign one), `model`,
   `actor`, `parameters.job_id` and `parameters.session_scope: "any"`:
   - the call succeeds (the smuggled workspace is ignored, not refused);
   - the receipt's `job_id` is the granted job and its actor is `agent:<name>`;
   - its `arguments_digest` equals the digest of exactly the schema keys with
     `session_scope: "interactive"`, and nothing else.
6b. Once AS ships, the mission hook, with two fixture windows that both match the job's
   `allowed_apps`:
   - a held mission → `E_APPROVAL_DENIED`;
   - a live `listed` mission naming only the first → the first is returned **and** the second
     is not (an empty list fails the test).
   - with that mission, `desktop.inspect` of the second window is `denied` and its tree is not
     walked (the probe records no inspect for it).
7. Through the real pipeline on a native desktop, with a fixture window the job allows:
   - `desktop.state` returns it and nothing else;
   - `desktop.inspect` returns structure without names;
   - a reused handle gives `refresh_required`;
   - a `forbidden: ["desktop inspect"]` job refuses `desktop.inspect` with `E_FORBIDDEN`;
   - receipts carry `actor = agent:claude`.
8. Budgets: `max_actions` is spent by agent calls exactly as by coordinator calls.
9. MCP:
   - `initialize` negotiates 2025-06-18 and refuses an unknown major revision;
   - `tools/list` lists exactly the four tools;
   - oversized frames, more than 4 outstanding ids, non-object frames, and unknown tools are
     JSON-RPC errors;
   - any extra argv refuses to start;
   - an action that hangs past Core's 30 s ceiling returns `E_TIMEOUT` through MCP, before the
     45 s MCP deadline, and its receipt is `terminated`;
   - a Node Core stand-in that accepts the request and never responds gives a JSON-RPC error at
     45 s, and the request socket is closed;
   - `desktop_inspect` with a `continuation_token` reaches page 2;
   - stdout carries only frames.
10. The server reads no URL, path or credential from any tool argument (schema-level
    `additionalProperties: false`, plus a test with smuggled fields).
11. Interoperability: real Claude Code and real Codex, at pinned versions, each connect, list the
    tools and complete `toros_status` and `desktop_state` against a native node.

## Relationship to spec AS (ownership, stated once)

- **AT owns:**
  - the agent bearers and their start-up and route checks;
  - the reserved `agent:` prefix;
  - `/agent/status` and `/agent/invoke`;
  - `desktop_control.ar_gate_cleared`;
  - `packages/mcp-discovery`.
- **AS adds only** `/agent/mission/*` and `/agent/desktop/*`. AS4 **extends**
  `packages/mcp-discovery` with its tools; it does not add a second server. AS's `desktop_state`
  tool is AT's.
- **Missions take precedence**, through the mission hook (see "Agent routes"). Its rule is
  stated once, in spec AS revision 6 (PR mbulentcakar/Toros#1).
