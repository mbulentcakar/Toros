# AT1 — implementation brief: agent credentials, grants, `/agent/*` routes (spec AT)

**Spec:** `docs/specs/AT-agent-discovery-mcp.md` (accepted by the operator 2026-10-27). Read it in
full first; it is binding. This brief adds code pointers and the implementation choices the spec
leaves open. Where the two disagree, the spec wins; say so in your report.

**Already done (do not redo):** amendment **A11** is committed by the architect
(`packages/contracts/src/errors.ts`: `E_GRANT_INVALID` added, `E_MODE_DENIED` documented;
`docs/specs/00-CONTRACTS.md` §10 A11; `packages/contracts/test/errors.test.ts`). Do not edit
`packages/contracts/**` further. If you believe you need to, stop and say why in the report.

## Allowed paths

- `packages/node-core/src/**`, `packages/node-core/test/**`
- `packages/store/src/migrations/007_agent_grants.ts` (new) and the one line in
  `packages/store/src/store.ts` that registers it in `MIGRATIONS`. Nothing else in the store.
- `docs/SPEC.md`: only the two bullets in AT's "Amendments to SPEC".

Nothing else. No new dependencies.

## What to build

### 1. Configuration (`packages/node-core/src/main.ts`, `core.ts`)

- `FileConfig` gains `agents?: { claude?: { token: string }; codex?: { token: string } }` and
  `desktop_control?: { ar_gate_cleared?: unknown }`.
- `NodeCoreOptions` gains `agent_tokens?: { claude?: string; codex?: string }` and
  `desktop_ar_gate_cleared?: boolean`. `main.ts` sets the flag with strict `=== true`, exactly like
  `coordinator_enabled` (`main.ts:259`).
- **Start-up checks** in `core.ts`, next to the existing ones (`core.ts:184-200`):
  1. every configured agent token goes through `assertPrintableAscii` (`core.ts:27-40`);
  2. then each is at least 32 characters;
  3. then `token`, `operator_token` (when set) and every agent token are pairwise distinct.
  Each failure throws with a message naming the offending field. Never put the value in the message.

### 2. The reserved `agent:` prefix (`action-pipeline.ts`)

- In `coordinatorActor` (`action-pipeline.ts:311-316`), a label whose trimmed, lower-cased form
  starts with `agent:` is recorded as `coordinator`, just as `operator` is today. Update its doc
  comment.

### 3. Grants storage

- **Migration** `packages/store/src/migrations/007_agent_grants.ts`, following the style of
  `006_*`:

  ```sql
  CREATE TABLE agent_grants (
    grant_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL CHECK (agent IN ('claude','codex')),
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX agent_grants_one_live ON agent_grants(agent) WHERE revoked_at IS NULL;
  ```

  Register it as version 7 in `MIGRATIONS` (`store.ts`). This is the only store change: the
  frozen `Store` interface (`packages/contracts/src/ports.ts:173`) does **not** change.
- **Access** from a new module `packages/node-core/src/agent-grants.ts`. It opens its own
  `DatabaseSync` (`node:sqlite`) on `db_path` (opened after the store, so the migration has run),
  with a busy timeout like the store's. Functions:
  - `create(agent, job_id, expires_at)`: one `BEGIN IMMEDIATE` transaction that sets
    `revoked_at` on the agent's live row, if any, then inserts the new row;
  - `revoke(grant_id)`;
  - `live(agent)`: the row with `revoked_at IS NULL`, or null;
  - `list()`.
  It closes with Core.

### 4. Operator routes (`routes-operator.ts`)

Add `agent_grant_create`, `agent_grant_revoke` and `agent_grants` to the routes table
(`routes-operator.ts:336-363`):

- `agent_grant_create { job_id, agent, expires_in_hours? }`:
  - `expires_in_hours` is a positive integer, default 8. `expires_at` is the earlier of that and
    the job's envelope `expires_at`.
  - Refusals:
    - an unknown job → `E_ENVELOPE_INVALID`, as `job()` does;
    - a terminal job → `E_JOB_TERMINAL`;
    - the envelope lists none of the three AT capabilities → `E_GRANT_INVALID`
      (`reason: "no_discovery_capability"`);
    - `allowed_workspaces` has a length other than 1 → `E_GRANT_INVALID`
      (`reason: "workspace_count"`);
    - an agent other than `claude`/`codex`, or one with no configured token → `E_SCHEMA`.
- `agent_grant_revoke { grant_id }`.
- `agent_grants {}`: the list, with no secret fields.

### 5. Agent routes (`http.ts`, new `routes-agent.ts`)

- **Authentication.** In `handleHttp`, a branch for `parts[0] === 'agent'` comes **before** the
  tools-surface `authenticate`.
  - First, defence in depth, as the operator branch does (`http.ts:230-236`): a bearer equal
    (timing-safe) to `token` or `operator_token` is 401.
  - Then the bearer must equal (timing-safe, length-checked) a configured agent token. The match
    decides the agent name. No match is 401 `{ error: 'Unauthorized' }`.
  - Conversely, `authenticate()` for `/tools/*` and the `/operator/*` branch must refuse an agent
    token. They already refuse anything that is not their own bearer; add a test that proves it.
- **Body.** Read it with the same `readBody` and limits. After the body is read, **re-read the live
  grant** (as `http.ts:247-254` does for advisory runs). A grant revoked or replaced during the read
  refuses the call.
- **Per-agent lock.** A `Set<agent>` is taken before that re-read and held until the call
  returns. A second concurrent call for the same agent is `E_PARALLEL_ACTION` (409). The per-job
  lock in `runPrepared` still applies too.
- **`POST /agent/status`** →
  `{ agent, grant: { grant_id, job_id, expires_at } | null, objective, allowed_capabilities, desktop_enabled }`.
  When there is no grant, `objective` and `allowed_capabilities` are null. `desktop_enabled` is
  the flag.
- **`POST /agent/invoke { capability, parameters }`**:
  1. No live grant → `E_GRANT_INVALID` (`reason: "no_grant"`). A revoked one →
     `E_GRANT_INVALID` (`reason: "revoked"`): look up whether the agent's latest grant was revoked.
     The grant's `expires_at` passed → `E_EXPIRED`. A terminal job → `E_JOB_TERMINAL`.
  2. `capability` not one of the three → `E_MODE_DENIED`. `desktop.*` while the flag is off →
     `E_MODE_DENIED` (`reason: "ar_gate"`).
  3. **Mission hook point:** call `deps.missionHook(job_id, capability)`. It returns
     `{ allow: true } | { allow: false, code, reason }` and defaults to allow. AS1 fills it. Keep it
     one small, documented function.
  4. **Build the call yourself.** From `parameters`, keep only the keys the capability's
     registered `input_schema.properties` declares. For `desktop.*`, set
     `session_scope: "interactive"`, overriding any value. `job_id` comes from the grant;
     `workspace_id` is the envelope's single `allowed_workspaces` entry. Nothing else from the body
     is used.
  5. Run it through the pipeline with actor `agent:<name>`. Add a node-core-internal entry point to
     `ActionPipeline`, e.g. `executeAgent({ job_id, workspace_id, capability, parameters, actor })`.
     It builds the `ApprovalReplayAction` for `invoke_app_action` directly (the same shape
     `prepare` builds, `action-pipeline.ts:396-436`) and calls `runPrepared(prepared, null, false)`.
     It must **not** call `coordinatorActor`. Everything else (policy, `forbidden`, A8 resolve,
     budgets, receipts, timeouts) is the ordinary path. A capability the envelope does not list is
     therefore `E_CAP_NOT_ALLOWED` from policy, with a denied receipt.
  6. The response is what `invoke_app_action` returns on the tools surface.
- **Error writer** for `/agent/*`: `{ error, message, reason? }`, where `reason` is
  `e.detail.reason` when it is a string. Statuses follow `http.ts:257-264` (409 for
  `E_PARALLEL_ACTION`, 413 for body-too-large, else 400; auth is 401).

### 6. `docs/SPEC.md`

Add the two bullets from AT's "Amendments to SPEC" (§4.2 and §8.1), worded as there.

## Tests (write them; do NOT run native ones)

Put them in `packages/node-core/test/agent-surface.test.ts` (plus `main-config.test.ts` for
config). Follow the style of `operator-credential.test.ts` and `resolve-pipeline.test.ts`: a real
Core on port 0 with a temp db, and fake adapters registering `desktop.state`, `desktop.inspect`,
`machine.inventory` (and `excel.read_range` for the mode test).

Cover AT acceptance tests 1–6a and 8:

- **1. Start-up refusals:**
  - an agent token shorter than 32 characters;
  - one with a space, a tab, or `\n` (including `operator_token + " "`);
  - one equal to `token`, to `operator_token`, or to the other agent's token.
- **2. Cross-surface bearers:** 401 for `token` and `operator_token` on `/agent/*`, and for an
  agent token on `/tools/*` and `/operator/*`.
- **3. Reserved actor label:** `model: "agent:claude"` and `" AGENT:Codex "` on `/tools/invoke_app_action`
  and through in-process `tools.dispatch` record the actor `coordinator`. Read it back from the
  receipt.
- **4. Grant lifecycle**, each case asserting its own code and reason:
  - no grant;
  - a revoked grant;
  - an expired grant (set `expires_at` in the past through the grants module);
  - a terminal job;
  - two overlapping `agent_grant_create` calls (`Promise.all`) leave exactly one live row;
  - a revoke landing while the body is being read: send the request body slowly, revoke in
    between, then grant on a second job. The call is refused, and no receipt is created on
    either job under the old grant;
  - a job with 0 or 2 workspaces cannot be granted.
- **5. Capabilities:** `excel.read_range` listed in the job → `E_MODE_DENIED` with a denied
  receipt; `desktop.inspect` not listed → `E_CAP_NOT_ALLOWED` with a denied receipt.
- **6. Gate flag:** unset, `false`, and the string `"true"` → `E_MODE_DENIED` with
  `reason === "ar_gate"` in the body; `machine.inventory` still works.
- **6a. Smuggling:** a direct call with smuggled `job_id`, a foreign `workspace_id`, `model`,
  `actor`, `parameters.job_id` and `parameters.session_scope: "any"`:
  - it succeeds;
  - the receipt's job is the granted one and its actor is `agent:claude`;
  - its `arguments_digest` equals `digest()` of exactly the schema keys plus
    `session_scope: "interactive"`;
  - the fake adapter saw `session_scope: "interactive"`.
- **8. Budget:** agent calls spend `max_actions`. After the budget is spent →
  `E_BUDGET_EXHAUSTED`.
- **Parallel calls:** a second concurrent call for the same agent → 409 `E_PARALLEL_ACTION`.

**Acceptance test 7 (native):** add `packages/node-core/test/agent-native.test.ts`, gated exactly
like `desktop-native-core.test.ts` (skipped unless `TOROS_REAL_TESTS=1`). Through a real Core with
the real desktop adapter and the existing fixture window helper (`@toros/adapters-desktop/testing`)
it checks five things:
- an agent `desktop.state` returns the fixture window and nothing else;
- `desktop.inspect` returns structure without names;
- a reused handle gives `refresh_required`;
- a `forbidden: ["desktop inspect"]` job refuses inspect with `E_FORBIDDEN`;
- receipts carry `agent:claude`.

**Do not run it.** The orchestrator runs native tests on an unlocked desktop. Run `npm run build`
and the non-native `node --test` suites, and report the counts. Skips are findings: list each one
and its reason.

## Report

When done, write `.at1-report.md` in the worktree root (do not commit it) with:
- what you changed, per file;
- every choice you made that this brief did not fix;
- the exact build and test commands you ran, with counts;
- anything you could not do.

Commit your work on the current branch in coherent commits whose messages end with the line
`Co-Authored-By: DeepSeek V4 Pro <noreply@openrouter.ai>`. Do not push. Do not touch other
branches.
