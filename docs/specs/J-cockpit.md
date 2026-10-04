# Spec J — `apps/cockpit`

**Read `00-CONTRACTS.md` first.** It is short and it is binding — with one exception noted below.

Implements **SPEC §4.1** (the Tauri cockpit) and the Windows Tauri deliverable of §10.

## Objective

A desktop window showing jobs, sessions, approvals, activity, checkpoints, relay state, and
security findings — reading Node Core's HTTP surface over loopback.

The governing constraint is one sentence of §4.1: *"It does not hold policy authority and does
not give Hermes a privileged UI backdoor."* The cockpit is a viewer with an approval button. It
must contain no code path that decides anything, and no endpoint that Node Core does not
already expose to any authenticated client.

## Dependency exemption

00-CONTRACTS §3 pins zero runtime dependencies. **`apps/cockpit` is explicitly exempt**
(SPEC §10): it carries Tauri v2, Vite, React, and their transitive dependencies. The rule
protects the policy-bearing code, and the cockpit is not policy-bearing.

Everything else in 00-CONTRACTS still applies, including the frozen-contracts rule.

## Allowed paths

```
apps/cockpit/**
```

## Forbidden paths

```
packages/**                    every package, including contracts
docs/**
tools/**
```

You may **read** `packages/contracts/src/*.ts` to mirror the types. Copy the type declarations
you need into `apps/cockpit/src/types.ts` with a comment naming the source — the cockpit builds
through Vite rather than the TypeScript project graph, and a project reference across that
boundary complicates both builds for no benefit. **Copy types only. Never copy logic**, and
never re-implement `canonicalize` or `chainHash` here.

## Scaffolding

The Tauri v2 shell (`src-tauri/`, `tauri.conf.json`, the Rust `main.rs`) is scaffolded already.
Do not restructure it. Your work is the frontend under `apps/cockpit/src/` plus whatever
`tauri.conf.json` changes the views genuinely require.

Frontend is React + TypeScript through Vite. Keep it plain: no state library, no component
framework, no CSS framework. Six read-mostly views do not need any of them, and each one is a
dependency in a security tool's UI.

## Views

| View | Shows |
|---|---|
| Jobs | job id, objective, state, actions used / max, expiry, envelope digest |
| Job detail | receipts in order, with capability, decision, outcome, timings |
| Sessions | adapter, workspace, pid, started, read cursor |
| Approvals | pending approval requests, with approve and deny |
| Activity | the event log with `seq`, kind, and chain verification status |
| Checkpoints & relay | checkpoints and capsules, with manifest contents |
| Findings | Numbat findings, severity, rule, **and correlation confidence** |

## Things the UI must get right

These are not styling preferences. Each one is a case where a plausible-looking UI would
misrepresent the system's state.

- **Show correlation confidence on every finding.** `exact`, `cited`, `session`, `none` must be
  visually distinguishable, with `session` and `none` clearly weaker. SPEC §8.2 records the
  route precisely so the operator is not misled; a UI that renders all four identically undoes
  that. A `session`-grade finding must not be displayed as attached to a specific action.
- **Never display `accepted` as an action the user can take from a job view.** §7 reserves it
  for independent review, and a button is an invitation.
- **Show chain verification honestly.** If `verifyChain` reports `anchor_matches: false` with
  `broken_at_seq: null`, that is tail truncation — say so, in those words. A green tick because
  the links happen to verify is exactly the failure the anchor was added to catch.
- **Show a denied action as prominently as a successful one.** Denials are the most
  security-relevant rows in the log; a UI that greys them out buries the signal.
- **Never render Node Core output as HTML.** Job objectives, receipt reasons, and finding titles
  all originate from a model or an external tool. React escapes by default — so do not reach
  for `dangerouslySetInnerHTML`, and do not add a markdown renderer.
- **Never display the bearer token**, in any view, log, or error state.

## Transport

Read the credentials and port from Tauri's config-managed store, not from a hardcoded value and
not from a URL parameter. The WebView never receives them. Rust uses the coordinator token for
tool operations and the operator token for approvals and job-scoped findings. All requests go
to `http://127.0.0.1:<port>` with an `Authorization` header.

Do **not** send an `Origin` header — Node Core rejects requests carrying one (Spec G). The Tauri
webview does not send one for `fetch` to a different origin unless it is configured to; if you
hit a 401 with the token correct, this is why.

Poll on a timer for updates. No websockets — Node Core does not offer one, and adding one means
a second code path into the service.

## Acceptance tests

Component and logic tests under `apps/cockpit/src/**/*.test.ts(x)`, run through Vite's test
setup. UI tests here are thin by design; the required ones all concern misrepresentation:

1. `renders the four correlation confidences distinguishably`
2. `does not present a session-grade finding as attached to an action`
3. `renders a truncated chain as truncated, not as valid`
4. `renders a denied action with the same prominence as a successful one`
5. `offers no control that sets accepted`
6. `escapes a job objective containing HTML`
7. `escapes a finding title containing HTML`
8. `never renders the bearer token`
9. `sends the Authorization header and no Origin header`
10. `surfaces a 401 as an authentication problem rather than an empty view`

Test 6 and 7: pass `<img src=x onerror=alert(1)>` as the value and assert the text renders
literally and no element was created.

## Verification

```
cd apps/cockpit
npm run build           # vite build must succeed
npm run test
npx tauri build         # produces the NSIS installer
```

`tauri build` requires the Rust toolchain and MSVC Build Tools, both installed on the target
machine. If `tauri build` fails for a toolchain reason, **say so plainly** — do not report a
pass on the strength of `vite build` alone.

## Out of scope

Any decision. The cockpit does not validate an envelope, evaluate a policy, compute a digest,
or verify a chain — it calls Node Core and displays what comes back. If you find yourself
writing a rule, it belongs in `packages/policy` and not here.
