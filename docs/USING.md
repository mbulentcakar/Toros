# Using a Toros node

> **Draft skeleton.** Sections marked `TODO` must be written against a running node, with
> real command output pasted in. Nothing here should be written from memory.

Toros runs work as **jobs**. A job is a sealed envelope (objective, allowed capabilities,
allowed workspaces, acceptance criteria, forbidden actions, action and retry budgets, expiry)
that Node Core validates on every call. Two things can drive a job: **you**, through the
loopback tools API, or the **Hermes coordinator**, a model that is given only the typed tools
and the envelope.

## 1. Vocabulary

- **Capability** — one typed action an adapter registers, e.g. `grok.send`, `excel.read_range`.
  A job can only call capabilities its envelope lists.
- **Workspace** — a directory root a job may touch. Path arguments outside it are denied
  (`E_PATH_ESCAPE`), never silently corrected.
- **Session** — one CLI worker conversation inside a job; it owns one session directory under
  the workspace, where the worker's raw exchange logs (`exchange-N.jsonl`) are written.
- **Receipt** — the durable record of one action: what was asked, whether policy allowed it,
  when it started and ended, and the outcome. Receipts chain with hashes; `verify-chain`
  proves the chain is unbroken.
- **Checkpoint / relay capsule** — resumable evidence of unfinished work. Not a commit, not a
  review, not an acceptance.

## 2. Your first job, by hand

TODO: an end-to-end worked example on a running node:

1. seal and store an envelope (the store API today; a `tools/` helper is the intended path);
2. `start_cli` → session id (it is the receipt id);
3. write the brief into the session directory;
4. `send_cli` with a message; `read_cli` with a cursor until `exchange_state` leaves `running`;
5. `stop_cli`;
6. read the receipts back and `verify-chain`.

With the exact JSON of each call and response.

## 3. Writing a brief a worker can act on

- Name the workspace path the worker will see. For Antigravity that is the **absolute WSL
  path** of the session directory; without it the model may assume its scratch directory is
  the workspace.
- Say what the worker may not do (write files, run the shell, leave the workspace). A
  read-only Grok has no shell tool at all; Claude runs in `plan` mode.
- Put the source in the session directory (a git worktree under `./code` is the pattern that
  has worked) and say so.
- Ask for a final section with a fixed title. A worker that ends without one has not finished,
  whatever its receipt says (see known issues in [STATUS.md](STATUS.md)).

TODO: one brief that has produced a complete review from each of the four workers.

## 4. Reading what happened

- `list_activity` / `job_status` / receipts: what was allowed and denied, with error codes
  (`E_CAP_NOT_ALLOWED`, `E_PATH_ESCAPE`, `E_EXPIRED`, `E_APPROVAL_REQUIRED`, …).
- The session directory's `exchange-N.jsonl`: the worker's raw stream. This is where a
  "succeeded" exchange that never answered shows its real ending (`stopReason: cancelled`,
  `denied_actions`).
- `verify-chain`: the receipt chain is intact and anchored.

TODO: an annotated receipt and an annotated exchange log.

## 5. Running a job through the Hermes coordinator

```bash
node packages/coordinator/dist/src/main.js <job_id>
```

Exit codes: `0` done/proposed/blocked, `3` operator question (answer over stdin with
`--operator-message-stdin`), `4` turn limit, `5` malformed model output twice, `6` an approval
is needed (`--approval <id>` on the re-run), `7` Node Core or the model endpoint unreachable.
Approvals are granted on the operator surface with `operator_token`, never by the coordinator.

TODO: a transcript of one coordinator run, including what the model saw and what it could not.

## 6. Approvals

Any capability listed in `approval_required` denies with `E_APPROVAL_REQUIRED` and an
`approval_id`; you read the exact arguments on the operator surface and grant once. The grant
is bound to that job, capability, and argument digest, and expires. See [DEPLOY.md §2.1](DEPLOY.md).

## 7. What Toros does not do

It does not confine a CLI worker at the OS level (SPEC §8.1). It does not commit, push,
deploy, or merge. It does not let the coordinator approve its own actions. It does not run on
macOS or Linux.

## 8. Agent discovery over MCP (Claude Code, Codex)

### 8.1 What it is

An operator-granted Claude Code or Codex session can call the three read-only discovery
capabilities `desktop.state`, `desktop.inspect` and `machine.inventory` itself (spec AT). It
calls them through the local stdio MCP server `packages/mcp-discovery`, inside exactly one job
the operator created and assigned to that agent. Nothing in AT can click, type, select, launch
or write — the agent sees exactly what spec AR shows a job: structure only, no UIA names or
values, window titles only for apps both the node and the job allow, opaque single-use handles,
and nothing while the desktop is locked.

### 8.2 Configure the node

In `%LOCALAPPDATA%\Toros\config.json`:

- `agents.claude.token` / `agents.codex.token`: each at least 32 printable-ASCII characters and
  distinct from every other bearer (`token`, `operator_token`, and each other). Generate one
  with the same one-liner `orient` prints:

  ```sh
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  ```

- `desktop_control.ar_gate_cleared: true` — the boolean, and only the boolean. Without it, only
  `machine.inventory` works; the strict `=== true` gate matches `coordinator_enabled`
  (`packages/node-core/src/agent-config.ts`), so `false` or the string `"true"` leave the gate
  closed.

- Restart Node Core, then run `node tools/orient.mjs` and expect the new findings: `agents.*.token
  present and distinct`, `desktop discovery open to agents`, and the `agent driver profile cannot be
  confirmed` warning (§8.6).

### 8.3 Create a job and grant it

Create the job on the operator surface (`POST /operator/create_job` with `operator_token`). The
envelope shape (from `packages/envelope/src/envelope.ts`) is:

```json
{
  "objective": "…",
  "allowed_capabilities": ["desktop.state", "desktop.inspect", "machine.inventory"],
  "allowed_workspaces": ["<exactly one workspace id>"],
  "acceptance": ["…"],
  "forbidden": [],
  "max_actions": 1000,
  "max_retries": 2,
  "allowed_apps": []
}
```

The job must name **exactly one** entry in `allowed_workspaces` (the workspace is never a
choice), at least one of the three AT capabilities in `allowed_capabilities`, and `allowed_apps`
for desktop (an absent `allowed_apps` denies every `app` target fail-closed).

Grant it to an agent:

```json
POST /operator/agent_grant_create   { "job_id": "…", "agent": "claude" | "codex", "expires_in_hours": 8 }
```

`expires_in_hours` defaults to 8 and is capped by the envelope's `expires_at` (the effective
expiry is the earlier of the two). Inspect with `agent_grants` and revoke with
`agent_grant_revoke { "grant_id": "…" }`. A new grant for the same agent replaces the old one —
there is one live grant per agent. Refused grants (from
`packages/node-core/src/routes-operator.ts`): `E_GRANT_INVALID` with reason
`no_discovery_capability` or `workspace_count`, and `E_JOB_TERMINAL` for a terminal job.

### 8.4 Connect the client

Claude Code:

```sh
claude mcp add toros-discovery -- node <repo>/packages/mcp-discovery/dist/src/main.js --agent claude
```

Codex, in `~/.codex/config.toml` (the `mcp_servers.toros-discovery` table from
`packages/mcp-discovery/README.md`):

```toml
[mcp_servers.toros-discovery]
command = "node"
args = ["<repo>/packages/mcp-discovery/dist/src/main.js", "--agent", "codex"]
default_tools_approval_mode = "approve"   # only for non-interactive `codex exec`
```

Neither writes a credential into the client's config: the server reads the token from the node
config. The four tools and their substance (from `packages/mcp-discovery/src/protocol.ts`):

- `toros_status` — the granted session: job, objective, allowed capabilities, whether desktop is
  enabled.
- `desktop_state` — top-level windows; titles only for allowed apps, no control names/values.
- `desktop_inspect` — the structure of one window, without names. Page 1 is `window_id` +
  `freshness_token` (optionally `depth` 1–10); page N+1 is `continuation_token` alone.
- `machine_inventory` — which adapters and tools are ready on the node.

Handles are single-use: re-run `desktop_state` on `refresh_required`. A locked desktop returns
`session: "unavailable"`.

### 8.5 What the agent sees when refused

A tool error result (`isError: true`) carries `{ error, message, reason? }`
(`packages/node-core/src/routes-agent.ts`):

- `E_GRANT_INVALID`, reason `no_grant` or `revoked`;
- `E_EXPIRED`;
- `E_JOB_TERMINAL`;
- `E_MODE_DENIED`, reason `not_discovery_capability` or `ar_gate`;
- `E_CAP_NOT_ALLOWED`;
- `E_PARALLEL_ACTION`;
- `E_TIMEOUT`.

Every call and refusal leaves a receipt with actor `agent:claude` or `agent:codex`.

### 8.6 The driver-profile requirement and what AT cannot enforce

An agent token is a credential in the Toros config file, and the config file is not confinement:
an agent CLI that can read `%LOCALAPPDATA%\Toros` can read the other bearers directly. The
agent's CLI must therefore run under a profile that cannot read that directory (a separate
Windows user, or a deny ACL on the Toros config directory). `tools/orient.mjs` warns whenever an
agent token is configured — it cannot confirm the profile, so the warning is unconditional.

What AT cannot enforce, stated plainly (spec AT):

- AT bounds what Node Core **returns**. It cannot stop an agent from reading the screen some
  other way — a screenshot tool of its own CLI, or its shell where the CLI has one.
  Toros-supervised workers run read-only; an agent the operator runs interactively is outside
  Toros's control.
- A window title of an allowed app may contain document names. Choosing which apps a job allows
  is the operator's decision; the node allowlist (`adapters.desktop.authorized_apps`) is the
  upper bound.
