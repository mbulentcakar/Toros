# AT2 — implementation brief: `packages/mcp-discovery` (spec AT)

**Spec:** `docs/specs/AT-agent-discovery-mcp.md` (accepted by the operator 2026-10-27), section
"MCP server: `packages/mcp-discovery`" and acceptance tests 9 and 10. Read the whole spec first;
it is binding. AT1 is merged (`/agent/status` and `/agent/invoke` exist in
`packages/node-core/src/routes-agent.ts`). This brief adds code pointers and settles the choices
the spec leaves open. Where the two disagree, the spec wins; say so in your report.

## Allowed paths

- `packages/mcp-discovery/**` (new package).
- Root `tsconfig.json`: one `references` entry for the new package. The spec names the root
  `package.json` workspace entry, but `workspaces` is already the glob `packages/*`, so
  `package.json` needs no change; the build reference is what is really needed.
- `package-lock.json`: only the workspace link entries `npm install` adds for the new package.

Nothing else. **Zero runtime dependencies**: `dependencies` stays empty. Test-only
`devDependencies` on workspace packages (`@toros/node-core`, `@toros/contracts`,
`@toros/envelope`, `@toros/store`) are allowed,
with matching `references` in the package's `tsconfig.json`. No package from the npm registry.

## Package shape

Copy the layout of `packages/adapters-machine` (`package.json`, `tsconfig.json` with
`rootDir: "."`, entrypoints under `dist/src/`, read its `_comment_entrypoints`). Modules:

- `src/protocol.ts`: the JSON-RPC framing, the MCP handlers and the tool table. It holds no I/O
  of its own. It exports `createMcpServer(options)`, where `options` carries:
  - `call(route, body, signal)`: performs one POST to Node Core;
  - `write(frame)`: writes a frame;
  - `log(line)`: writes a diagnostic line;
  - `deadline_ms`: default `45_000`.
  The function returns `{ receive(line), close() }`.
- `src/core-client.ts`: the HTTP client to Node Core.
  - `node:http` `request` to `127.0.0.1:<port>`, `agent: false`, so that each request has its
    own socket.
  - It sends the header `Authorization: Bearer <token>`.
  - It enforces the 1 MiB result cap while reading, then destroys and refuses.
  - On abort it destroys that request's socket.
- `src/config.ts`: reads `%LOCALAPPDATA%\Toros\config.json` once. Use the same path rule as
  `configPath()` in `packages/node-core/src/main.ts:101-106` **without** the argv override.
  - Strip a BOM, as `loadConfig` does.
  - Read `port`, and the token at `agents.<agent>.token`.
  - A missing file, a missing or non-string token, or a bad port is a start-up failure. Its
    message names the field and never the value.
- `src/main.ts`, the launch entry, in this order:
  1. Validate argv. It must be **exactly** `['--agent', 'claude' | 'codex']`. Anything else
     writes one stderr line and exits with code 2, **before** reading any config.
  2. Read the config.
  3. Wire stdin line-reading to `receive`, and `write` to stdout.
- `src/index.ts`: re-exports for tests.

stdout carries frames only: no `console.log` anywhere in the package. Diagnostics go to stderr
through `log`.

## Protocol (MCP 2025-06-18, stdio)

- **Framing.** Use newline-delimited JSON, one message per line, UTF-8. Measure the frame cap of
  1 MiB in bytes **before** `JSON.parse`. A longer line is a JSON-RPC error `-32600` with
  `id: null`. It must not grow an unbounded buffer: discard the rest of an oversized line up to
  the next newline. A frame that does not parse is `-32700`, and one that is not a single JSON
  object (an array/batch, a string, a number, null) is `-32600`. Both use `id: null`.
- **`initialize`.** `params.protocolVersion` must be a string of the form `YYYY-MM-DD`. Version
  negotiation follows the MCP rule: the server always answers `protocolVersion: "2025-06-18"`.
  If the client asked for another version, it is the client's to accept or disconnect.
  - A missing, non-string or malformed `protocolVersion` is refused with `-32602`. That is how
    this brief reads the spec's "refuses an unknown major revision". The reason: a dated version
    has no major number, and refusing every other date would break real clients that ask for a
    newer revision. Say in your report whether you agree.
  - The answer carries `capabilities: { tools: { listChanged: false } }` and
    `serverInfo: { name: "toros-discovery", version: <package version> }`.
  - It also carries `instructions`: one short paragraph saying this server is read-only
    discovery bounded by an operator grant.
- **Lifecycle.** Before `initialize`, every request except `ping` gets `-32002` (server not
  initialized). Accept the `notifications/initialized` notification. Ignore other notifications.
  A second `initialize` is `-32600`.
- **`ping`.** It answers `{}`.
- **`tools/list`.** It lists exactly the four tools below. Each has an `inputSchema` with
  `type: "object"` and `additionalProperties: false`. There is no pagination; `nextCursor` is
  absent.
- **`tools/call`.**
  - An unknown tool name is `-32602`.
  - Arguments that fail the tool's schema (extra keys, wrong types) are `-32602`, and nothing is
    sent to Node Core. That is acceptance test 10. Write a small validator for exactly the
    schema features used here (object, string, integer, minimum/maximum, required,
    additionalProperties false); do not write a general JSON Schema engine.
- **Other methods.** They are `-32601`.
- **Outstanding ids.** At most 4 requests may be in flight. Count requests that have an `id` and
  no response yet. A 5th is answered at once with a JSON-RPC error `-32000` (message:
  "too many outstanding requests") and does not count. A request reusing an id that is still
  outstanding is `-32600`.
- **Deadline.** Each `tools/call` gets `deadline_ms`, 45 000 by default.
  - On expiry, abort the HTTP request (its socket is destroyed) and answer that id with a
    JSON-RPC error `-32001` (message: "Node Core did not answer within 45 s").
  - A late HTTP answer after that is dropped.
  - Export the constant and keep it strictly above Core's 30 s action ceiling
    (`packages/node-core/src/main.ts:213-216`, `:302`).
- **Result cap.** A Node Core response body over 1 MiB is refused, not truncated. The answer is a
  JSON-RPC error `-32603` (message: "result exceeds 1 MiB").

## Tools → routes (a constant table; the server holds no policy)

| Tool | Input schema (`additionalProperties: false`) | Call |
|---|---|---|
| `toros_status` | `{}` | `POST /agent/status` with body `{}` |
| `desktop_state` | `{}` | `POST /agent/invoke` with body `{ capability: "desktop.state", parameters: {} }` |
| `desktop_inspect` | `window_id` string, `freshness_token` string, `depth` integer 1–10, `continuation_token` string; none required at schema level | `POST /agent/invoke` with body `{ capability: "desktop.inspect", parameters: <args> }` |
| `machine_inventory` | `{}` | `POST /agent/invoke` with body `{ capability: "machine.inventory", parameters: {} }` |

- `desktop_inspect` has two valid shapes. Page 1 is `window_id` + `freshness_token` (+ `depth`);
  page N+1 is `continuation_token` alone. The adapter's own schema has the same split
  (`packages/adapters-desktop/src/adapter.ts:220-240`). Enforce "exactly one of the two shapes"
  in the server as `-32602`, and say so in the tool description.
- Do **not** send `session_scope`: the route injects it.
- The tool table maps a tool name to a route and a capability constant. No tool argument can name
  a route, URL, port, header, token, path or executable.
- **Mapping the answer.**
  - **HTTP 200:** `result: { content: [{ type: "text", text: <body JSON> }],
    structuredContent: <body>, isError: false }`.
  - **HTTP 4xx/409/413 with a JSON body `{ error, message, reason? }`:** the same shape with
    `isError: true`. These are tool errors the agent should read, such as `E_GRANT_INVALID`,
    `E_MODE_DENIED`/`ar_gate`, `E_TIMEOUT` or `E_PARALLEL_ACTION`. They are **not** JSON-RPC
    errors.
  - **HTTP 401:** `isError: true` with text "Node Core refused the agent token (401)". Never echo
    the token or a header.
  - **A connection error** (Core not running): `isError: true` with a short text. A JSON-RPC
    error is used only for the deadline and the result cap.
- **Descriptions.** Each tool description says plainly what the agent will and will not see:
  - no control names or values;
  - window titles only for allowed apps;
  - handles are single-use: re-run `desktop_state` on `refresh_required`;
  - a locked desktop returns `session: "unavailable"`;
  - everything is bounded by the operator's grant: `toros_status` shows it.

## Tests (write them; do NOT run native ones)

`packages/mcp-discovery/test/*.test.ts`, with `node:test`. Two layers.

**Protocol layer**, `createMcpServer` against a fake `call`:
- `initialize`:
  - with `2025-06-18` it answers `2025-06-18`;
  - with another well-formed date it answers `2025-06-18`;
  - a missing or malformed version gives `-32602`;
  - a second `initialize` gives `-32600`;
  - a request before `initialize` gives `-32002`, and `ping` before `initialize` works.
- `tools/list` returns exactly the four names, each with `additionalProperties: false`.
- Errors:
  - a 1 MiB + 1 byte line gives `-32600`, and the next valid line still works;
  - non-object frames (an array, a number, a string, null) give `-32600`;
  - an unparsable line gives `-32700`;
  - an unknown tool and an unknown method give `-32602` and `-32601`;
  - a 5th outstanding request gives `-32000` while 4 are held open by a fake `call` that never
    resolves; once one resolves, a new request is accepted again.
- **Acceptance test 10:**
  - `desktop_state` with a smuggled `url`, `port`, `token`, `path`, `job_id` or
    `session_scope` gives `-32602`, and the fake `call` was never invoked;
  - `desktop_inspect` with both shapes, or neither, gives `-32602`.
- Deadline:
  - with `deadline_ms: 200` and a `call` that never resolves, the answer is `-32001` near 200 ms,
    the `AbortSignal` passed to `call` is aborted, and a late resolve writes nothing;
  - assert that `DEFAULT_DEADLINE_MS === 45_000` and that it is greater than `30_000`.
- Mapping: 200 gives `isError: false`; a 400 body with `reason` gives `isError: true` and keeps
  `reason`; a 401 gives the fixed text.
- stdout purity: every `write` is exactly one line that parses as a JSON-RPC message.

**Process + Core layer:**
- **Real child process, argv refusals.** Spawn `dist/src/main.js` with no argv, with
  `--agent x`, with `--agent claude extra`, and with `--agent=claude`. Each exits with code 2,
  writes nothing to stdout, and writes one line to stderr.
- **Real child process, the full path.** Spawn it with `--agent claude` and `LOCALAPPDATA`
  pointed at a temp dir holding a test `Toros/config.json`. The config uses a generated test
  token and the port of an in-test HTTP stand-in that records requests. Drive `initialize` →
  `tools/call toros_status` over stdin and stdout. Assert:
  - the stand-in saw `POST /agent/status` with that bearer;
  - stdout held only frames.
  Generate the token in the test (`randomBytes`). Never use a real config.
- **Stand-in never answers.** The stand-in accepts the request and never responds. Spawn with
  the real 45 s deadline: the result is a JSON-RPC error at 45 s, ±2 s, and the stand-in sees its
  socket close. This test is slow (~45 s); give it a 60 s timeout. **Do not gate it**, because
  skips are findings.
- **Against a real Node Core** (`createNodeCore` from `@toros/node-core`). Follow the fixtures
  of `packages/node-core/test/agent-surface.test.ts`: a temp db, port 0, fake adapters for
  `desktop.state`, `desktop.inspect` and `machine.inventory`, an operator-created job, and an
  `agent_grant_create`. Drive `createMcpServer` with the real `core-client` and assert:
  - `toros_status` shows the grant;
  - `desktop_state` succeeds;
  - `desktop_inspect` with a `continuation_token` that the fake adapter's page 1 returned
    reaches page 2;
  - with no grant, `machine_inventory` gives `isError: true`, `E_GRANT_INVALID`, `no_grant`.
  - **Timeout:** a fake adapter whose action hangs, with an action `timeout_ms` of 30 000
    (Core's ceiling), returns `isError: true` with `E_TIMEOUT` before 45 s, and the receipt in
    the store is `terminated`. This is ~30 s; give it a 50 s timeout; do not gate it.

  If `@toros/node-core` does not export what these tests need, stop and say so in the report. Do
  not edit node-core.

**Acceptance test 11 (real Claude Code and Codex).** Do not do it. The orchestrator runs it
natively, on the pinned versions Claude Code 2.1.310 and codex-cli 0.160.1.

Run `npm install --no-audit --no-fund`, `npm run build`, then
`node --test packages/mcp-discovery/dist/test/*.test.js`, plus the full root `npm test` once.
Report the counts. Skips are findings: list each one and its reason.

## Also put in the package

`packages/mcp-discovery/README.md` (short):
- the launch line;
- `claude mcp add toros-discovery -- node <path>/packages/mcp-discovery/dist/src/main.js --agent claude`;
- the Codex `~/.codex/config.toml` `[mcp_servers.toros-discovery]` equivalent (`command`,
  `args`);
- the driver-profile requirement from the spec, quoted in substance: the agent's CLI must not be
  able to read `%LOCALAPPDATA%\Toros`.

The README writes no credential anywhere.

## Report

When done, write `.at2-report.md` in the worktree root (do not commit it) with:
- what you changed, per file;
- every choice you made that this brief did not fix;
- the exact build and test commands you ran, with counts;
- anything you could not do.

Commit your work on the current branch in coherent commits whose messages end with the line
`Co-Authored-By: DeepSeek V4 Pro <noreply@openrouter.ai>`. Do not push. Do not touch other
branches.
