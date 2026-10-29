# AT3 — implementation brief: agent docs, `orient` checks, STATUS (spec AT)

**Spec:** `docs/specs/AT-agent-discovery-mcp.md` (accepted 2026-10-27). Read it in full first; it
is binding. AT1 (`/agent/*` routes, grants, `agents.*.token`, `desktop_control.ar_gate_cleared`) and
AT2 (`packages/mcp-discovery`) are merged. AT3 is the last slice: it makes the feature usable and
checkable by an operator. Where this brief and the spec disagree, the spec wins; say so in the report.

## Allowed paths

- `tools/orient.mjs` and `tools/orient.test.mjs`.
- `docs/USING.md`.
- `docs/STATUS.md`.

Nothing else. No new dependencies. Do not touch `packages/**`.

## 1. `tools/orient.mjs`

### 1a. Config checks in `validateNodeConfig` (pure, testable)

These mirror Node Core's start-up checks exactly. Read them in `packages/node-core/src/core.ts:226-252`
and `packages/node-core/src/agent-config.ts`. A config that passes orient must start a node; a config
Core refuses must be a `BLOCK` here. Follow the style of the existing `token` / `operator_token` checks
(`orient.mjs:300-347`). Never print a value, only lengths and field names.

**`agents` structure:**
- When `agents` is present, it must be an object (not an array). Otherwise `BLOCK`, as
  `agentTokensFromConfig` throws.
- `agents.claude` and `agents.codex`, each when present, must be an object with a string `token`.
  Otherwise `BLOCK`.
- Any other key under `agents` is a `WARN`: Core ignores it. Name the key.

**Token checks, in Core's order.** For each configured agent token:
1. Printable ASCII `0x21–0x7E`, using the existing `PRINTABLE_ASCII`, else `BLOCK`.
2. At least 32 characters, else `BLOCK`.
3. Different from `token`, from `operator_token` (when set), and from the other agent's token. Each
   collision is its own `BLOCK`, naming both fields.

When a token passes all three, the finding is `OK`:
`` `agents.<name>.token` present and distinct `` with detail `<n> characters`.

**Desktop gate:**
- `desktop_control`, when present, must be an object. Otherwise `WARN`: Core treats it as gate
  closed.
- `desktop_control.ar_gate_cleared === true` gives `OK` ("desktop discovery open to agents").
- Any other present value (`false`, the string `"true"`, `1`) gives `WARN` ("only the boolean `true`
  opens the gate; agents get `machine.inventory` only"). Show the value's **type**, not the value.
- Absent, with an agent token configured, gives `WARN` with the same text. Absent with no agent
  token emits nothing.

**Driver-profile requirement** (spec "Driver profile requirement"). When at least one agent token is
configured, emit one `WARN`:
- title: "agent driver profile cannot be confirmed";
- detail: "the agent's CLI must run under a profile that cannot read %LOCALAPPDATA%\\Toros; otherwise
  it can read the other bearers";
- fix: "run the agent CLI as a separate Windows user, or deny its profile read access to the Toros
  config directory".

orient cannot verify this, so the warning is unconditional while a token is configured. Do not try
to probe ACLs.

### 1b. Secret scrub (`collectConfiguration`, `orient.mjs:549-551`)

Register `agents.claude.token` and `agents.codex.token`, when they are non-empty strings, in
`secrets` next to `token` and `operator_token`. This must happen **before** anything renders.
`scrubOrThrow` (`:1066`) refuses output that contains a secret, so a missed registration is the one
real leak risk in this slice.

### 1c. MCP server presence (in `collectConfiguration` or `collectMap`; choose and say which)

When an agent token is configured:
- `OK` if `packages/mcp-discovery/dist/src/main.js` exists relative to the repo root (use the
  existing `REPO_ROOT`-style resolution in the file);
- otherwise `WARN` with fix `npm run build`.

## 2. `tools/orient.test.mjs`

Add tests in the existing style, through `validateNodeConfig`, plus one end-to-end test through
`main`/the CLI as the existing scrub tests do. Each test must fail if its rule is removed.
- Every `BLOCK` above, one case each:
  - short token;
  - a space inside;
  - a trailing `\n`;
  - `operator_token + " "`;
  - equal to `token`, to `operator_token`, or to the other agent;
  - `agents` an array;
  - `agents.claude` a string;
  - `agents.claude.token` a number.
- The `OK` path for each agent, asserting the finding text and that the detail holds the length, not
  the value.
- Unknown `agents.gemini` gives `WARN`.
- Gate:
  - `true` gives `OK`;
  - `false`, `"true"` and `1` each give `WARN`, with no value printed. Assert that the string
    `"true"` case's detail says `string`.
  - Absent with a token gives `WARN`; absent with no token gives no gate finding.
  - `desktop_control` an array gives `WARN`.
- The driver-profile `WARN` is present exactly once when one or two agent tokens are set, and absent
  when none is.
- **Scrub, end to end.** Write a temp `LOCALAPPDATA/Toros/config.json` with generated agent tokens.
  Run orient the way the existing collector tests do and assert that neither token appears in the
  output. Then prove the test is real: an agent token planted where it would render (e.g. as a
  workspace root path) makes `scrubOrThrow` refuse. Follow the existing scrub test for the pattern.
- MCP presence: `OK` / `WARN` from a temp repo root, if the function takes one; otherwise say in the
  report how you tested it.

## 3. `docs/USING.md`: new section "8. Agent discovery over MCP (Claude Code, Codex)"

Write it from the code and the spec, not from memory. USING.md's rule is that nothing is invented:
where a JSON shape is shown, take it from `packages/node-core/src/routes-agent.ts`,
`routes-operator.ts` or the tests, and label it "shape". Do not paste fabricated transcripts. Cover,
briefly:

1. **What it is.**
   - An operator-granted Claude Code or Codex session calls the three read-only discovery
     capabilities `desktop.state`, `desktop.inspect` and `machine.inventory`.
   - It calls them through the local stdio MCP server `packages/mcp-discovery`, inside one job the
     operator created.
   - Nothing can click, type or write.
2. **Configure the node.** In `%LOCALAPPDATA%\Toros\config.json`:
   - `agents.claude.token` / `agents.codex.token`: each at least 32 printable-ASCII characters and
     distinct from every other bearer. Generate one with the same `randomBytes(32)` one-liner orient
     prints.
   - `desktop_control.ar_gate_cleared: true`: the boolean only. Without it, only
     `machine.inventory` works.
   - Restart Node Core. Then run `node tools/orient.mjs` and expect the new findings.
3. **Create a job and grant it.**
   - Create the job on the operator surface: `POST /operator/create_job` with `operator_token`. Give
     it exactly one `allowed_workspaces` entry, the needed subset of the three capabilities, and
     `allowed_apps` for desktop.
   - Grant it: `POST /operator/agent_grant_create { job_id, agent, expires_in_hours? }` (default 8 h,
     capped by the envelope's expiry). Inspect grants with `agent_grants` and revoke one with
     `agent_grant_revoke { grant_id }`.
   - A new grant for the same agent replaces the old one: one live grant per agent.
   - List the refusals with their codes and reasons, from the code: `E_GRANT_INVALID`
     (`no_discovery_capability`, `workspace_count`) and `E_JOB_TERMINAL`.
4. **Connect the client.**
   - Claude Code: `claude mcp add toros-discovery -- node <repo>/packages/mcp-discovery/dist/src/main.js --agent claude`.
   - Codex: the `[mcp_servers.toros-discovery]` table from `packages/mcp-discovery/README.md`,
     including the `default_tools_approval_mode = "approve"` note for non-interactive `codex exec`.
   - Neither stores a credential: the server reads the token from the node config.
   - The four tools and what each returns. Copy the descriptions' substance:
     - no control names or values;
     - titles only for allowed apps;
     - single-use handles, so re-run `desktop_state` on `refresh_required`;
     - `session: "unavailable"` when the desktop is locked.
5. **What the agent sees when refused.** A tool error result (`isError: true`) carrying
   `{ error, message, reason? }`:
   - `E_GRANT_INVALID`, with reason `no_grant` or `revoked`;
   - `E_EXPIRED`;
   - `E_JOB_TERMINAL`;
   - `E_MODE_DENIED`, with reason `not_discovery_capability` or `ar_gate`;
   - `E_CAP_NOT_ALLOWED`;
   - `E_PARALLEL_ACTION`;
   - `E_TIMEOUT`.
   Every call and refusal leaves a receipt with actor `agent:claude` / `agent:codex`.
6. **The driver-profile requirement and what AT cannot enforce.** Restate the two bullets of the
   spec's "What AT cannot enforce", and the driver-profile requirement, in plain words.

Keep it to roughly 80–120 lines. Update §7 "What Toros does not do" only if a sentence there is now
false; nothing in it should be.

## 4. `docs/STATUS.md`

Make exactly these changes, and invent no other claims:
- The date heading becomes `2026-10-28`.
- Replace the bullet "**The cockpit, Chrome worker, and desktop discovery adapter exist and are
  tested** … until its adversarial review clears (`docs/reviews/`)" with two bullets:
  - "**The cockpit, Chrome worker, and desktop discovery adapter exist and are tested.** The
    desktop discovery surface's adversarial review and native re-review are complete (the AR gate
    cleared in mbulentcakar/Toros#18); a node opens it to agents only with
    `desktop_control.ar_gate_cleared: true`."
  - "**Agent discovery over MCP (spec AT) is merged**: an operator-granted Claude Code or Codex
    session can call the read-only discovery capabilities through `packages/mcp-discovery`
    (`docs/USING.md` §8). Verified with real Claude Code 2.1.310 and codex-cli 0.160.1 against a
    native test node; not yet enabled on the production nodes."
- Under "Next", add: "Spec AS (agent desktop actions under missions, mbulentcakar/Toros#1) builds on
  AT's credentials and MCP server; it awaits operator acceptance."

## Build, tests, report

- Run `node --test tools/orient.test.mjs` and the root `npm test` once. Report the counts.
  Skips are findings: list each one and its reason.
- Run `node tools/orient.mjs` once against a temp `LOCALAPPDATA` holding a test config with agent
  tokens. Paste the relevant findings (they are scrubbed) into the report. **Never** run it against
  the real `%LOCALAPPDATA%`.

Write `.at3-report.md` in the worktree root (do not commit it) with:
- the changes, per file;
- your choices;
- the commands you ran, with counts;
- anything you could not do.

Commit in coherent commits ending with `Co-Authored-By: DeepSeek V4 Pro <noreply@openrouter.ai>`.
Do not push. Do not touch other branches.
