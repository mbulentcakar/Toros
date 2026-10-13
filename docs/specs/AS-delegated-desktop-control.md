# Spec AS — delegated desktop control: mission grants, cross-agent approval, MCP

**Read `00-CONTRACTS.md` first.** It is short and it is binding. `packages/contracts` is frozen;
this spec is written to need no contract change, and if implementation proves otherwise the
answer is to stop and record an amendment (00-CONTRACTS §10), not to widen a type.

**Status: proposed (2026-10-13). Not accepted.** Admitting it amends SPEC §2, §4.1, §6, §8.1 and
§10 (same PR). It **supersedes Spec V's target-binding model** — one adapter instance per
operator-configured application — and keeps everything else in Spec V: the six actions, the
selector rules, the bans, the PowerShell parameter-file discipline, and the test list.

## Objective

Let a Claude or Codex session drive any Windows application through UI Automation, under three
layers of authorization, none of which is the driving model:

1. **The operator** authorizes a *mission*: one task, one driver, a time limit.
2. **The other agent** approves each application the driver wants to reach, and each individual
   click, text entry, or selection, one at a time.
3. **Node Core** enforces both, refuses what nobody may approve, and records every request,
   decision, and result in a real-time, timestamped log.

The operator's decisions behind this design (2026-10-13) are recorded in Appendix A. They are
requirements, not defaults.

## Why the boundary moves

Spec V bound the target into the adapter id (`uia_outlook.invoke`) because "arguments are chosen by
the coordinator", and a coordinator choosing its own target has no check. That reasoning still
holds. This spec does not drop the check; it moves it. The target becomes an argument chosen by
the driver, and **every** such choice goes to a second, independent decision-maker before anything
executes. Under Spec V an allowed control in an allowed application could be invoked with no
decision at all. Here, nothing mutates without one.

What that buys is breadth: any application, not only those configured in advance. What it costs
is that the operator is no longer making each decision. The independent agent is. The rest of
this spec exists to keep that agent's decision honest and its scope narrow.

## Actors and credentials

| Actor | Credential | May |
|---|---|---|
| Operator | `operator_token` (existing) | create, shorten, revoke missions; approve operator-only requests (§"Two deny tiers") |
| Driver (`claude` or `codex`) | its own `agents.<id>.token` (new config, not an envelope field) | read desktop state within the mission; *request* app access and actions |
| Approver | **none.** Node Core invokes it. | decide one request, then exit |
| Hermes coordinator | `token` (existing) | nothing in this spec. Missions run coordinator-optional (Spec AR T1). |

Node Core refuses to start unless `token`, `operator_token`, and every `agents.*.token` are
pairwise distinct and at least 32 characters, extending the existing check at `core.ts:137`.

### Cross-approval, and why the approver holds no token

The operator names the driver when creating a mission. **The approver is always the other
agent**: Claude drives → Codex approves, Codex drives → Claude approves. This is fixed by Node
Core, not chosen per request.

The approver is **not** a second interactive session listening on a channel. For each pending
request, Node Core runs the approver as a **fresh, one-shot, read-only CLI exchange** through the
existing CLI adapters (spec E), hands it a structured request, and parses a strictly schematized
verdict. Three properties follow:

- **No approver credential exists**, so a driver with filesystem access cannot impersonate the
  approver by reading a token. Only Node Core can produce a delegate verdict.
- **Each decision starts with no context**, so text the approver read in one request cannot steer
  its decision on the next. This is the operator's decision 3: the approver never sees the
  driver's conversation.
- **Self-approval is impossible by construction.** The approver identity is derived from the
  mission, never from a request field.

The approver's exchange runs read-only: no tools, no workspace writes, a short timeout (default
60 s). Timeout, malformed output, an adapter failure, or anything other than an explicit
`approve` counts as **deny**. Absence of a decision is never consent.

## Objects

### Mission (operator-issued)

```jsonc
{
  "mission_id": "uuid",
  "job_id": "uuid",              // one mission ↔ one JobEnvelope; the envelope digest binds it
  "objective": "string",         // the task, verbatim from the operator
  "driver": "claude" | "codex",  // approver is the other, derived
  "app_scope": { "kind": "any_not_denied" } | { "kind": "listed", "executables": ["C:\\...\\EXCEL.EXE"] },
  "mode": "look" | "act",
  "created_at": "RFC3339",
  "expires_at": "RFC3339"        // default created_at + 24h (operator decision 4)
}
```

- **Bound to one task.** A mission exists only together with one job and its envelope. The
  objective is shown to the approver with every request, so "does this click serve this task?" is
  something the approver can actually judge.
- **Void after 24 hours unless the operator sets something else.** The operator may enter an
  explicit `expires_at`. The cockpit shows the expiry, and a countdown, for as long as the mission
  is live. Expiry, revocation, job reaching a terminal state, or Node Core restart (see Sessions)
  ends the mission and **every grant and approval under it at once**.
- `mode: "look"` admits only the three read actions; `act` admits the request path for mutations.
  Neither mode lets anything mutate without a per-action approval.
- Missions are created only through the operator surface. No agent route can create, extend, or
  widen one.

### App grant (approver-issued, per application)

The driver calls `desktop.request_app`. Node Core resolves the target to a **process**, not a
title (Spec V's "bind to the process" rule) and records:

`pid`, executable path, executable SHA-256, Authenticode signer (or `unsigned`), the process start
time (pid-reuse guard), and the window list at that moment.

The approver sees those facts plus the mission objective and the driver's stated reason, which is
labelled untrusted. If it approves, the grant admits **reading** that process's windows
(`list_windows`, `inspect_tree`, `find`). It does **not** admit any mutation. Each of those needs
its own approval (operator decision 7: both). The grant ends with the mission or when the process
exits. A new process of the same program needs a new grant.

### Action approval (approver-issued, per action)

`invoke`, `set_value`, and `select` declare `always_requires_approval: true` and `mutates: true`,
so they enter rule 12 (spec D) like every gated action. The pending request carries:

- the capability and **full arguments**, i.e. the selector path and, for `set_value`, the exact
  value to be typed;
- the resolved element's real properties at request time (control type, automation id, name,
  `IsPassword`, enabled, patterns), re-resolved from the selector, not the driver's description;
- the mission objective and the driver's stated reason (untrusted).

The approval is **single-use and bound to `arguments_digest`** through the existing
`ApprovalVerifier.consume` (00-CONTRACTS A2/A4). It follows the existing TTL, and Node Core
replays the exact approved action (spec AC), so the driver cannot approve one thing and run
another. At execution the adapter re-resolves the selector and **refuses if the element's
properties differ** from what the approver saw (`E_APPROVAL_INVALID`). A control that changed
underneath an approval is a different action.

## What the approver is shown, and how

The prompt is fixed, not composed by the driver. Every field derived from the screen (window
titles, element names, values already in fields) is wrapped as data and labelled **untrusted
application content**. The prompt tells the approver that content may contain instructions and
that following them is a failure.

The verdict schema:

```jsonc
{ "decision": "approve" | "deny", "reason": "≤ 300 chars" }
```

Validated by the registry's schema machinery. Anything else is a deny. The approver's raw
transcript is **not** stored (SPEC §12.4: no conversations); the verdict and reason are.

## Two deny tiers

Every request is classified by Node Core, deterministically, **before** any approver is asked.
Classification uses the resolved process and element, never the driver's words.

### Operator-only: an agent may never approve, the operator may

Operator decision 6. These go to the cockpit instead of the approver, are approved **per action
by the operator only** (never by a mission, never by an agent), and the task resumes once
approved:

- terminals and shells: `cmd.exe`, `powershell.exe`, `pwsh.exe`, `WindowsTerminal.exe`,
  `conhost.exe`, `OpenConsole.exe`, `wsl.exe`, `bash.exe`, and any process whose window class is a
  console host. These are the remote-shell door that SPEC §2 shuts.
- credential and sign-in surfaces: `CredentialUIBroker.exe`, `LogonUI.exe`, Windows Security
  (`SecHealthUI.exe`), the Settings app's account pages, and password-manager processes listed in
  config;
- browsers: `chrome.exe`, `msedge.exe`, `firefox.exe`, `brave.exe`, `opera.exe`. Browsers belong to
  the Chrome worker (spec AB), and its boundary is not this one;
- any element with `IsPassword = true`, for **read** actions (so the operator can let the driver
  see that a password field exists). Writing to one is absolute; see below.

The list is fixed in code and extendable by config. Config can add to it; it cannot remove from
it.

### Absolute: no one approves

These are refused with no prompt. Operator approval cannot open them, because the risk is the loop
itself, not the operator's judgment:

- **Any Toros process**: the cockpit, Node Core, or the MCP server. A driver that can press the
  cockpit's Approve button approves itself through the operator's own UI. The operator can do
  anything they would approve there by hand.
- `set_value` on an element with `IsPassword = true`, and any `set_value` whose value matches the
  secret-redaction patterns (spec AG): `E_SECRET_DETECTED`. Every typed value is logged in full
  (operator decision 9), so a typed secret would land in the log, and invariant 6 forbids that
  outright.
- The secure desktop (UAC, Ctrl+Alt+Del). UIA cannot reach it anyway; the rule makes the refusal
  explicit and recorded.
- `send_keys`, coordinates, screenshots, and scripts. Spec V's bans stand. They are not actions,
  so there is nothing to approve.

## MCP surface (for the driver)

A local **stdio** MCP server, `packages/mcp-desktop`, launched by the driving Claude Code or Codex
session. It reads that agent's token from config at start and talks to Node Core over the existing
authenticated loopback HTTP. It holds **no policy**: every tool call becomes one Node Core request,
and Node Core decides. Zero runtime dependencies (SPEC §10); MCP's JSON-RPC over stdio is small
enough to implement against `node:` built-ins.

| Tool | Effect |
|---|---|
| `mission_status` | the caller's live mission: objective, mode, expiry, grants, pending requests |
| `desktop_state` | Spec AR `desktop.state`, scoped to the mission |
| `desktop_request_app` | ask for an app grant; returns `pending` with a `request_id` |
| `desktop_list_windows`, `desktop_inspect_tree`, `desktop_find` | read actions under a grant |
| `desktop_invoke`, `desktop_set_value`, `desktop_select` | create a pending action request |
| `desktop_await` | wait (bounded, ≤ 120 s) for a `request_id`'s verdict, then return the executed result or the denial |

There is no approve or decide tool on this surface. A denial ends that request. Asking again with
reworded arguments is a new request, and the approver sees the history of denials in the mission
(SPEC §5: "a denied action cannot be reformulated to bypass policy").

**This is an MCP surface, so it requires a second, independent reviewer** (workspace invariant 3)
in addition to the security review below.

## Real-time log in the cockpit

Operator decision 8: a log, live, with timestamps. A new cockpit view, **Desktop control**:

- a header per live mission showing objective, driver → approver, mode, scope, expiry countdown, and
  a **Revoke** button (revoke ends the mission and every grant immediately);
- a stream, newest first, one line per event, each with a millisecond UTC timestamp, rendered in
  local time:
  `requested` (driver, capability, target app, selector summary, value if `set_value`) →
  `classified` (delegate / operator-only / absolute) → `decided` (who, verdict, reason, latency) →
  `executed` / `refused` (result, error code);
- operator-only requests appear in the same stream with Approve / Deny controls, and in the
  existing approvals panel (spec T).

The stream is a view over the event log (§8.1 hash chain). There is no separate log store to keep
in sync or to tamper with. A **Stop all** control revokes every live mission on the node.

## Events and receipts

New event types: `mission.created|revoked|expired`, `desktop.app_requested|app_granted|app_denied`,
plus the existing `approval.requested`/`approval.resolved` for actions. `approval.resolved` gains
`decided_by: "operator" | "agent:claude" | "agent:codex"` and `tier`. If the event payload type in
`packages/contracts` cannot carry these, that is a contract gap. Record it as amendment A7 in the
same PR rather than smuggling the data elsewhere.

Receipt `adapter_fields` (declared in the manifest, A6): Spec V's list plus `mission_id`,
`approval_id`, `decided_by`, `exe_sha256`.

## Sessions and failure behaviour

- One live **act** mission per interactive desktop session (AR invariant 5).
- Locked or disconnected session: requests fail `E_ADAPTER_FAILURE` naming the lock. Pending
  requests are denied, not queued.
- Node Core restart **ends** all missions. Grants are not persisted across a restart, so a crash
  cannot silently resurrect authority. The operator re-issues.
- `stop` never terminates an application Toros did not start (Spec V).
- No blind retry: a failed execution is reported, and a retry is a new request with a new approval.

## What Toros cannot enforce, stated plainly

**A driver that also has a shell is not confined by any of this.** Claude Code and Codex can run
PowerShell themselves, and PowerShell can drive UI Automation directly with no Toros involved. The
same applies to reading `config.json`: a driver with file access can read `operator_token`, which
makes it the operator as far as Node Core can tell (the gap spec T noted, now sharper).

So Toros can only make *its own* desktop surface approved and audited. For the operator's intent
to hold, **the driving session must run with no shell and no file access outside its workspace**:

- Claude Code: launched with its tools limited to the `mcp-desktop` server (`--allowedTools`
  restricted to `mcp__toros-desktop__*`) and a deny rule for the Toros config directory;
- Codex: read-only sandbox, no network, and `mcp-desktop` as its only tool server.

`docs/USING.md` gets a "driver profile" section with the exact launch lines, and
`tools/orient.mjs` gains a check that **warns** when a mission's driver was not launched that way,
as far as it can tell. Real confinement (a separate Windows account for Node Core, so the token
file is unreadable by the driver) is a Phase 2 candidate, and this spec does not claim it.

## Prerequisites, before `act` may be enabled

1. **Spec AR's adversarial security review has been run and cleared.** As of this writing its
   findings section (`docs/reviews/AR-adversarial-security-review.md`) is empty. This spec builds
   on that surface.
2. Criterion 6 is visible in the cockpit (the findings view exists; confirm it shows desktop
   events).
3. The CLI adapter for the approver agent passes `orient --verify-agents` on the node. An approver
   that cannot answer denies everything, which is safe but useless.
4. Independent code review, an independent MCP review, and a third-lineage adversarial review of
   this slice.

`look` missions may ship before 1–4 are all done. `act` may not.

## Delivery slices

| Slice | Content | Allowed paths (indicative, finalized at dispatch) |
|---|---|---|
| AS1 | missions + agent tokens + operator routes + events | `packages/node-core/src/**`, its tests |
| AS2 | `@toros/adapters-uia`: the six Spec V actions, mission/grant-scoped, two-tier classifier | `packages/adapters-uia/**` |
| AS3 | approver runner: one-shot CLI exchange, fixed prompt, verdict schema, deny-by-default | `packages/node-core/src/approver*.ts`, tests |
| AS4 | `packages/mcp-desktop` stdio server | `packages/mcp-desktop/**` |
| AS5 | cockpit Desktop control view: mission form, live log, revoke, operator-only approvals | `apps/cockpit/**` |
| AS6 | driver profile docs + orient check; reviews; STATUS | `docs/**`, `tools/orient.mjs` |

## Acceptance tests (in addition to Spec V's seventeen)

Missions
1. `no desktop action is accepted without a live mission for the caller`
2. `a mission expires at created_at + 24h when the operator gave no expiry`
3. `an operator-specified expiry is honoured`
4. `expiry, revoke, job termination, and restart each void every grant and pending request`
5. `an agent token cannot create, extend, or widen a mission`
6. `a mission bound to job A cannot authorize an action under job B`

Cross-approval
7. `the approver is always the non-driver agent; no request field can change it`
8. `an approver timeout, malformed verdict, or adapter failure is a deny`
9. `an app grant admits reads only; invoke under a grant with no action approval is E_APPROVAL_REQUIRED`
10. `an action approval is single-use and bound to arguments_digest`
11. `an element whose properties changed between approval and execution is refused E_APPROVAL_INVALID`
12. `the approver prompt contains no driver conversation and labels screen content untrusted`
13. `pid reuse: a new process with the granted pid is not covered by the grant`

Deny tiers
14. `a terminal, a credential surface, and a browser each route to the operator and never to the approver`
15. `the operator can approve an operator-only action and it executes once`
16. `no one, the operator included, can approve an action on a Toros process`
17. `set_value into an IsPassword element is refused, operator approval notwithstanding`
18. `set_value with a value matching a secret pattern is refused E_SECRET_DETECTED`
19. `config can add to the operator-only list but cannot remove a built-in entry`

Log and MCP
20. `every request, classification, decision, and execution appears as a timestamped event in order`
21. `the MCP server exposes no approve tool and holds no policy (a denied call is denied by Node Core)`
22. `agent tokens, operator_token, and token must be pairwise distinct or Node Core refuses to start`

All tests run natively on Windows with an interactive desktop. Fixtures are Notepad and
Calculator, as in Spec V. A skip is a finding.

## Out of scope

Mac or Linux desktops. More than one driver per mission. Agents other than Claude and Codex as
driver or approver (the lane map may change who plays them, not the two-role shape). Any vision
or coordinate fallback. Persisting missions across restarts. Letting the approver ask the driver
questions. A denial is final.

## Appendix A — operator decisions, 2026-10-13

1. A Claude or Codex session drives Toros directly; Hermes is not in the loop (coordinator-optional).
2. Cross-approval: Codex approves Claude's requests, and vice versa.
3. The approver sees a structured request with screen content marked untrusted, never the driver's
   conversation.
4. Any approval is void after 24 hours unless otherwise specified, and is bound to a specific task
   mission.
5. Agents act with their own scoped credentials, never the operator token.
6. The hard-deny targets can be approved by the operator personally so the task can continue.
   (This spec keeps two narrow exceptions absolute: Toros's own processes and secret entry. See
   "Two deny tiers" for why.)
7. Both per-app and per-action approval.
8. A real-time, timestamped log is the operator's visibility; no live per-action prompt.
9. Typed values are logged in full; secret-pattern values are refused.
10. MCP is the driver's interface.
11. Spec PR first; prerequisites before mutation is enabled.
