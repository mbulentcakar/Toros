# Spec AT — agent discovery over MCP: read-only desktop and machine discovery for Claude and Codex

**Read `00-CONTRACTS.md` first.** It is short and it is binding. AT needs **no contract
amendment**: it uses A8's `ctx.actor`, A8/A9's `allowed_apps`, and the existing error codes.

**Status: proposed (2026-10-26). Not accepted.** Drafted by Claude as the first, small step toward
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

- Node Core refuses to start unless `token`, `operator_token` and every configured
  `agents.*.token` are pairwise distinct and at least 32 characters. This is the same rule AS
  states, so AS inherits it unchanged.
- Each credential is accepted **only** on its own routes. An agent token on `/tools/*` or
  `/operator/*`, or a `token`/`operator_token` on `/agent/*`, is `401 Unauthorized`, compared in
  constant time like the existing bearers.
- **The `agent:` actor prefix is reserved.** Today the tools surface records a caller-supplied
  model label as the receipt actor and reserves only `operator` (`coordinatorActor`). A label
  starting with `agent:` (any case, after trimming) is recorded as `coordinator`. Only the agent
  routes produce `agent:claude` or `agent:codex`, so a coordinator can never reuse an agent's
  handles, which F3b binds to `(job, actor)`.

## Grants

A **grant** binds one agent to one job: `{ grant_id, agent, job_id, created_at, expires_at,
revoked_at }`.

- It lives in a Node Core-owned table in the node database, as the stage-graph tables do.
- Operator routes:
  - `agent_grant_create { job_id, agent, expires_in_hours? }` → the grant. It defaults to 8 hours.
    The effective expiry is the earlier of this and the job's `expires_at`.
  - `agent_grant_revoke { grant_id }`.
  - `agent_grants {}` → the list.
- **One live grant per agent.** Creating a second one for the same agent revokes the first, in
  the same transaction.
- A grant is refused (`E_CAP_NOT_ALLOWED`) unless the job's `allowed_capabilities` lists at least
  one of the three AT capabilities. The job's envelope still bounds everything else: workspaces,
  `allowed_apps`, `forbidden`, `max_actions`, expiry.
- A terminal, expired or archived job ends its grants. Revocation is immediate: the next agent
  call is refused with `E_EXPIRED`.

## Agent routes

All are `POST` with a JSON body, loopback-only, and carry the agent bearer.

| Route | Body | Result |
|---|---|---|
| `/agent/status` | `{}` | `{ agent, grant: { grant_id, job_id, expires_at } \| null, objective, allowed_capabilities, desktop_enabled }` |
| `/agent/invoke` | `{ capability, parameters }` | the ordinary `invoke_app_action` result |

`/agent/invoke`:

- `capability` must be one of `desktop.state`, `desktop.inspect` or `machine.inventory`, **and**
  listed in the granted job's envelope. Anything else is `E_CAP_NOT_ALLOWED`, recorded as a
  denied receipt.
- The agent never names a job, workspace, URL, path or token. Node Core takes the job from the
  grant, and the workspace from the envelope's first `allowed_workspaces` entry.
- Calls run through the **ordinary action pipeline**: budgets, A8 two-phase resolve and
  `authorizeTargets`, `forbidden` (token sequences, RR-01), receipts, timeouts. The only
  difference is `actor = agent:<name>`.
- `desktop.*` additionally needs the node flag `desktop_control.ar_gate_cleared === true` (strict,
  fail-closed like `coordinator_enabled`). When it is not set, the route answers
  `E_CAP_NOT_ALLOWED` with `detail.reason = "ar_gate"`. AS uses the same flag, which AT introduces.
- One action at a time per agent (`E_PARALLEL_ACTION`, 409), as on the tools surface.

## MCP server: `packages/mcp-discovery`

- **Transport:** a local stdio MCP server, protocol revision **2025-06-18**, with zero runtime
  dependencies. It implements `initialize` with version negotiation, `notifications/initialized`,
  `ping`, `tools/list`, `tools/call`, and JSON-RPC errors. stdout carries protocol frames only;
  diagnostics go to stderr.
- **Launch:** `node packages/mcp-discovery/dist/src/main.js --agent claude|codex`. The token is read
  once from the fixed Toros config path (`%LOCALAPPDATA%\Toros\config.json`,
  `agents.<agent>.token`), and Node Core's port from the same file. No tool argument may name a
  URL, port, credential, path or executable.
- **Bounds:**
  - a frame is at most 1 MiB;
  - at most 4 JSON-RPC ids may be outstanding;
  - each tool call has a 60 s deadline;
  - a result is at most 1 MiB, refused rather than truncated.
- **Holds no policy.** Each tool maps to one route in a constant table. Node Core enforces
  everything even when the server is bypassed and the routes are called directly. The acceptance
  tests do exactly that.

| Tool | Input | Route |
|---|---|---|
| `toros_status` | `{}` | `/agent/status` |
| `desktop_state` | `{ session_scope? }` | `/agent/invoke` → `desktop.state` |
| `desktop_inspect` | `{ window_id, freshness_token, depth? }` | `/agent/invoke` → `desktop.inspect` |
| `machine_inventory` | `{}` | `/agent/invoke` → `machine.inventory` |

Tool descriptions say plainly what the agent will and will not see: no control names or values;
titles only for allowed apps; handles are single-use (re-run `desktop_state` on
`refresh_required`); and a locked desktop returns `session: "unavailable"`.

**Client configuration** (documented, not automated): `claude mcp add toros-discovery -- node
<path>/main.js --agent claude`, and the Codex `mcp_servers` table equivalent. Neither writes a
credential into the client's config.

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
| AT1 | `agents.*` config and start-up checks, reserved `agent:` prefix, grants table and operator routes, agent routes, `desktop_control.ar_gate_cleared`, receipts | `packages/node-core/src/**` + tests |
| AT2 | `packages/mcp-discovery` | `packages/mcp-discovery/**`, root `package.json` workspace entry |
| AT3 | `docs/USING.md` agent section, `tools/orient.mjs` (agent tokens present/distinct, flag state), STATUS | `docs/**`, `tools/orient.mjs` |

Reviews (workspace invariant 3: auth and MCP surfaces): AT1 and AT2 each get an independent code
review, and the MCP surface gets an **independent MCP review** by a lineage other than the
implementer's. Native tests run on a real, unlocked Windows desktop, and skip counts are findings.

## Acceptance tests

1. Start-up refuses: an agent token shorter than 32 characters; one equal to `token`,
   `operator_token`, or the other agent's token.
2. Each bearer is refused on every other surface (`/agent/*` with `token` or `operator_token`;
   `/tools/*` and `/operator/*` with an agent token): 401, constant-time compare.
3. A tools-surface call with `model: "agent:claude"` (and `" AGENT:Codex "`) records the actor as
   `coordinator`, and its handle is refused (`refresh_required`) when the agent presents it, and
   the reverse.
4. No grant → `/agent/invoke` is `E_CAP_NOT_ALLOWED`; a revoked or expired grant → `E_EXPIRED`;
   a second grant for the same agent revokes the first atomically.
5. A capability outside the three, even one the job lists (e.g. `excel.read_range`), is refused
   with a denied receipt. One of the three that the job does not list is refused too.
6. `desktop.*` with the flag unset, `false`, or `"true"` (a string) → `E_CAP_NOT_ALLOWED`
   (`ar_gate`); `machine.inventory` still works.
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
   - oversized frames, more than 4 outstanding ids, and unknown tools are JSON-RPC errors;
   - stdout carries only frames.
10. The server reads no URL, path or credential from any tool argument (schema-level
    `additionalProperties: false`, plus a test with smuggled fields).
11. Interoperability: real Claude Code and real Codex, at pinned versions, each connect, list the
    tools and complete `toros_status` and `desktop_state` against a native node.

## Relationship to spec AS

- AS's actor table, its credential rule, `/agent/*` routes, `desktop_control.ar_gate_cleared` and
  its `desktop_state` tool are the ones AT introduces. AS adds missions, `/agent/mission/*` and
  `/agent/desktop/*`.
- AS4 grows `packages/mcp-discovery` (renamed `packages/mcp-desktop` at that point), rather than
  writing a second server.
- An AT grant is not a mission. When AS ships, a mission's job may carry an AT grant for its
  driver, but AS's own rules decide every AS route.
