# U — Cockpit transport through Rust

**Read `00-CONTRACTS.md` first.** `packages/contracts` is frozen.

## What this is

The installed cockpit cannot reach Node Core. It renders, then every request
fails with `0 Unavailable: Failed to fetch`. See
`docs/finding-cockpit-transport.md` for the full diagnosis; the short version:

- The WebView runs on a Tauri origin, so every call to `http://127.0.0.1:<port>`
  is **cross-origin**.
- Node Core **rejects any request carrying an `Origin` header** with 403. A
  browser sets that header and the page cannot opt out.
- Node Core sends **no CORS headers**, so even a success would be discarded by
  the browser — hence `status 0` rather than a readable HTTP error.

This unit moves the transport into Rust. The WebView asks the Rust side to make
a request; Rust makes it and returns the result.

## Allowed paths

- `apps/cockpit/src-tauri/src/main.rs`
- `apps/cockpit/src-tauri/Cargo.toml`
- `apps/cockpit/src/api.ts`
- `apps/cockpit/src/App.test.tsx`
- `apps/cockpit/src/components/**` — only if a call site must change shape
- `docs/DEPLOY.md` — only if a step changes

**Do not modify `packages/`.** In particular **do not touch Node Core.** Its
Origin rejection is a specified control with an acceptance test behind it, and
keeping it intact is the reason this unit exists rather than the cheaper
alternative.

## Why not just allow the origin

Rejected deliberately. Allowing a Tauri origin and emitting CORS headers would
delete a tested control, require preflight `OPTIONS` against a surface that is
POST-only by design, and leave the bearer token inside the WebView. If you
think this is the better trade, implement the spec as written and say so in
your final message.

## The security win, which is the point

Today `read_node_core_config` hands **both bearer tokens to JavaScript**. After
this unit **the WebView never receives either one.** That is a real improvement
over the current cockpit and it is not optional — a diff that keeps tokens in
the WebView has not implemented this unit.

## The Rust side

Replace `read_node_core_config` with two commands.

```rust
#[tauri::command]
fn cockpit_status() -> Result<CockpitStatus, String>
// { approvals_configured: bool }
```

Reads the same fixed path, `%LOCALAPPDATA%\Toros\config.json`. Returns **only**
whether `operator_token` is present and non-empty. No port. No tokens. Nothing
else. The UI needs this one fact to distinguish "approvals are not configured on
this node" from "nothing is pending", and it needs nothing more.

```rust
#[tauri::command]
async fn node_core_request(operation: String, body: serde_json::Value)
    -> Result<ProxyResponse, String>
// ProxyResponse { status: u16, body: serde_json::Value }
```

Rules, all of them load-bearing:

1. **The caller names an operation, never a URL.** `operation` is matched
   against a fixed allowlist and mapped to a path. Anything not on the list is
   an error and no request is made.

   - Tools: `job_status`, `job_complete`, `job_block`, `list_capabilities`,
     `list_sessions`, `list_activity`, `create_checkpoint`, `create_local_relay`
     → `POST /tools/<operation>`
   - Operator: `operator_approvals` → `POST /operator/approvals`,
     `operator_approve` → `POST /operator/approve`, and `operator_findings` →
     `POST /operator/findings`

   The cockpit is a read-and-approve surface; it does not drive work. Do not add
   the session or app-action tools to this list.

2. **Rust chooses the credential, from the operation.** Operator operations use
   `operator_token`; everything else uses `token`. The caller cannot select a
   credential and cannot supply one. If an operator operation is requested and
   `operator_token` is absent, return an error without making a request.

3. **No `Origin` header is set**, and none is added by an HTTP client that is
   not a browser. This is what makes the whole thing work.

4. **Loopback only.** The URL is built from `127.0.0.1` and the port in the
   config. The port never comes from the caller.

5. **Any HTTP status is `Ok`.** 401, 403, 404, 400 are answers, and the client
   needs to tell them apart. Reserve `Err` for the request not completing at
   all — connection refused, timeout, config unreadable.

6. **Never log or return a token**, including in an error string.

Add whatever minimal HTTP client dependency you need to `Cargo.toml`
(`reqwest` with `rustls-tls`, or `ureq`; pick one and say which). Keep the
runtime already present — the app is `tokio`-based through Tauri.

## The client side

`api.ts` keeps its exported function names and return types. Only the transport
changes: every `fetch` becomes `invoke('node_core_request', { operation, body })`.

- `ApiError` keeps its shape and is thrown for non-2xx, exactly as now.
- A transport failure — the `Err` case — must surface as clearly distinct from
  an authentication failure. A stopped Node Core must not look like a 401.
- `resolveConfig`, `setConfig` and `ConfigUnavailableError` exist to manage a
  port and tokens the client no longer has. Remove or reduce them to what is
  still true; do not keep a `Config` object carrying credentials that are always
  absent.
- Approvals availability now comes from `cockpit_status().approvals_configured`.
  `listPendingApprovals` and `grantApproval` must still refuse to call when
  approvals are unconfigured, and the panel must still render its distinct
  unconfigured state.

## Acceptance

Every item is a test in `App.test.tsx`. The existing 26 tests must keep their
intent — only the transport double changes, from `fetch` to `invoke`. A test
whose assertion is weakened to make it pass is a defect.

1. Every API call goes through `invoke('node_core_request', …)` and **no test
   stubs `fetch`**, because nothing calls it any more. Assert this: a stubbed
   `fetch` that throws if called must not be called during a full render of
   each view.
2. **No token appears in anything the WebView receives.** Assert against the
   resolved value of `cockpit_status` and the arguments of every `invoke` call:
   neither the coordinator bearer nor the operator bearer occurs anywhere.
3. An operator action requests an `operator_*` operation; a job read requests a
   tool operation. Assert the operation name, since credential selection now
   follows from it.
4. A non-2xx response raises `ApiError` carrying the status.
5. A transport failure renders as unavailable, and **not** as an authentication
   error.
6. With `approvals_configured: false`, the unconfigured state renders and **no
   `node_core_request` is made**.
7. The existing HTML-escaping test for approval arguments still passes
   unchanged — argument values remain attacker-influenced and rendered.

## Verification, and what you cannot do

Run and report: `npm run build` and `npm test` in `apps/cockpit`, and
`npm run build` at the repo root.

**You cannot verify the thing that actually broke.** The defect was invisible to
26 passing jsdom tests and appeared the moment a human opened the packaged
application. You are in a sandbox that cannot run a Tauri window against a live
Node Core, so:

- **Do not claim the transport works.** Say plainly in your final message that
  the running application was not exercised.
- The reviewer runs `npx tauri build`, installs, and opens it against a live
  node. That is the only check that counts here, and it is not yours to make.

State also: which HTTP client you added and why, anything in this spec you found
wrong, and anything you could not do.
