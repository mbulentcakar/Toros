# Spec AS — delegated desktop control: mission grants, cross-agent approval, MCP

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

**Status: proposed, revision 2 (2026-10-13). Not accepted.** Revision 2 answers the independent
spec review (`docs/reviews/AS-spec-review.md`, PR mbulentcakar/Toros#2): seven blockers
(B1–B7), four majors (M1–M4) and one minor (N1). Each section that changed names the finding it
closes. All fourteen operator decisions in Appendix A are preserved.

Admitting AS amends SPEC §2, §4.1, §6, §8.1 and §10 (same PR). It needs **contract amendment A7**
(`00-CONTRACTS.md` §10, proposed in the same PR). A7 is made by the architect with every consumer
in one diff, never by an implementation worker (B7). Until AS is accepted, Spec V stands
unchanged; on acceptance, the V clauses listed in "Relationship to Spec V" are overridden.

## Objective

Let a Claude or Codex session drive Windows applications through UI Automation, under three
layers of authorization, none of which is the driving model:

1. **The operator** authorizes a *mission*: one task, one driver, a time limit.
2. **The other agent** approves each application the driver wants to reach, and each individual
   click, text entry, or selection, one at a time.
3. **Node Core** enforces both. It classifies every target before any agent is asked, refuses
   what nobody may approve, and records every request, decision, and result in a real-time,
   timestamped log.

"Any application" means any application **whose surface Node Core can classify** (B1). Surfaces it
cannot classify go to the operator; surfaces it cannot classify safely are refused. AS does not
claim universal coverage of arbitrary UI Automation providers.

## Why the boundary moves

Spec V bound the target into the adapter id (`uia_outlook.invoke`) because "arguments are chosen by
the coordinator". That reasoning still holds. AS keeps the check and moves it: the target becomes
an argument chosen by the driver, and **every** such choice goes to a second, independent
decision-maker before it executes. The price is that the operator no longer makes each decision.
The rest of this spec keeps that second decision honest, its object exact, and its scope narrow.

## Actors and credentials

| Actor | Credential | May |
|---|---|---|
| Operator | `operator_token` (existing) | create, shorten, extend, revoke, resume missions; decide operator-tier requests |
| Driver | its agent token (`agents.claude.token` or `agents.codex.token`, new config) **plus** the mission's enrollment nonce (M2) | read within the mission; *request* app access and actions |
| Approver | **none.** Node Core runs it. | return one verdict, then exit |
| Hermes coordinator | `token` (existing) | nothing in this spec |

Node Core refuses to start unless `token`, `operator_token`, and every `agents.*.token` are
pairwise distinct and at least 32 characters (extending `core.ts:137`). Each credential is
accepted **only** on its own routes. An agent token on an operator or Hermes route, or the reverse,
is rejected before routing (M3).

### Cross-approval

The operator names the driver when creating a mission. **The approver is always the other agent**
(Claude drives → Codex approves, and the reverse). Node Core derives this from the mission; no
request field can change it.

What this closes, stated with its limits: **direct impersonation** of the approver is not possible
through any Toros interface, because no approver credential exists and the verdict is produced
only inside Node Core. It does **not** close:

- token theft by a driver with file access (accepted, decision 14);
- persuasion of the approver by crafted content (reduced by the fixed prompt and data labelling,
  and **contained** by the deterministic tiers, denial hold and budgets, never eliminated);
- a poisoned approver environment (closed by the approver profile, B6).

Hosted cockpit content is closed separately, by the absolute tier (B1).

## Mission

```jsonc
{
  "mission_id": "uuid",
  "generation": 1,                // bumped by every invalidation (B4)
  "job_id": "uuid",               // one mission ↔ one JobEnvelope; envelope digest recorded
  "envelope_digest": "hex",
  "objective": "string",          // the task, verbatim from the operator
  "driver": "claude" | "codex",   // approver is the other, derived
  "approver_profile": { "cli": "codex", "cli_version": "x.y.z", "model": "id" },  // pinned (B6)
  "desktop_key": { "session_id": 1, "desktop": "WinSta0\\Default" },             // M2
  "app_scope": { "kind": "any_not_denied" } | { "kind": "listed", "images": ["<canonical path>"] },
  "mode": "look" | "act",
  "budget": { "max_requests": 200, "max_approver_calls": 200 },                   // M1
  "state": "live" | "held" | "ended",
  "created_at": "RFC3339",
  "expires_at": "RFC3339"         // default created_at + 24h (decision 4)
}
```

- **Bound to one task.** A mission exists only with one job. Its objective goes to the approver
  with every request.
- **Effective expiry** (M2) for any authorization is the earliest of: mission `expires_at`, the
  job envelope's `expires_at`, the approval's TTL, and the app grant's end. Requests already
  pending are clamped to it too. The operator may set any mission expiry (decision 4). With no
  value given, it is 24 hours. No hard maximum exists, because only the operator can set it and
  every other bound still applies.
- **Scope intersection** (M2). A request must pass all of: mission scope, the envelope's
  `allowed_capabilities` (which must list the `desktop.*` ids used), the envelope's `forbidden`
  terms (applied to selector names, typed values and window names), and the classifier (B1).
  `any_not_denied` still requires a positive app admission per process. It is never the default
  for a surface the classifier cannot place.
- **Listed images** are canonicalized: final path from the process handle, case-folded, no
  `\\?\` prefix variance. They are revalidated (path **and** SHA-256) at admission and at every
  execution against the live process image.
- `mode: "look"` admits the three read actions; `act` also admits the mutation request path.
- Missions are created, extended, held, resumed and revoked only on the operator surface.

### Desktop ownership (M2)

- **One Node Core per machine may run desktop control.** It holds a named mutex
  (`Global\Toros-DesktopControl`). A second instance refuses to enable AS.
- **One live `act` mission per desktop key.** The key is the Windows session id plus the input
  desktop name, read from the OS by Node Core, never supplied by a caller.
- **Driver enrollment.** "Driver" means **one enrolled CLI instance**, not just an agent role. The
  first MCP connection that presents the mission's agent token calls `mission_enroll` and
  receives a random 256-bit nonce. Every later request must carry token and nonce together, and a
  second enrollment is refused while the first is live. The operator can reset enrollment from
  the cockpit if the driver session dies.
- Every lookup (`mission_status`, request status, results) is scoped to (mission, enrolled
  instance). An id belonging to anyone else returns the same `unknown request` as an id that does
  not exist. There is no oracle.

## Classification (B1)

Node Core classifies **every** target before any agent is asked: each app admission, each read's
returned elements, and each action. It **classifies again at execution**. Classification uses
OS-observed evidence only, never the driver's words or an element's self-description alone.

### Evidence collected per process and per element

- **Process identity:** pid plus creation time (pid-reuse guard); canonical image path; image
  SHA-256; Authenticode status and signer; the signed version resource (`OriginalFilename`,
  `InternalName`, `ProductName`), which survives renames and copies; token integrity level and
  elevation; session id; desktop.
- **Ancestry:** parent chain with each parent's creation time verified, so a recycled pid does not
  inherit an identity.
- **Element:** the element's **own** owning process id (UIA `ProcessId`). Hosted content such as
  WebView2, an embedded console or a Chromium frame is often owned by a different process from
  its window. The element's `FrameworkId`, class name, `IsPassword`, and the same properties for
  every ancestor up to the top-level window.

### Precedence

1. **Absolute** wins over everything.
2. **Operator-only** wins over delegate.
3. **Delegate** applies only to a *supported surface* (below) with no absolute or operator-only
   evidence.
4. **Unrecognized** evidence (unknown framework, unverifiable image, missing signature) →
   operator-only.
5. **Unobtainable** evidence (access denied, process gone, integrity read fails) → refused.

### Absolute: no one approves

- **The Toros family.** Node Core keeps an in-memory identity registry: (pid, creation time) for
  itself, the cockpit, the cockpit's WebView2 child processes, every MCP server it has seen
  enroll, every approver child and every automation worker. Any element whose own process, or any
  process on its verified ancestry, is in the registry is absolute. This covers hosted cockpit
  content, which a name test cannot. Generic runtime names such as `node.exe` and
  `msedgewebview2.exe` are never used to *identify* Toros; only the registry is.
- **Higher integrity than the worker.** The automation worker runs at medium integrity, is never
  elevated and never holds UIAccess. Node Core refuses to enable AS if it is itself elevated. Any
  target process at higher integrity than the worker is refused and recorded, rather than left to
  UIA failure ([UI Automation security overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- **The secure desktop** (UAC, Ctrl+Alt+Del): refused and recorded.
- **Secret entry** (decision 13):
  - `set_value` on an element whose own `IsPassword` is true, or that has any ancestor with
    `IsPassword`, or that sits inside a credential surface;
  - `set_value` on an element in a surface whose protection **cannot be established**: an
    unsupported framework, or any element whose name, automation id or class (lower-cased,
    including the Turkish `şifre` and `parola`) contains `password`, `passcode`, `pin`, `secret`,
    `token`, or `otp`. Names are untrusted, so they are used **only to deny**, never to allow;
  - any typed value that matches the secret patterns (B5).
- **Not actions at all:** `send_keys`, coordinates, screenshots, scripts (Spec V's bans).

**Residual risk, stated plainly:** a credential field that does not set `IsPassword`, has no
recognizable label, and sits outside a known credential surface cannot be identified. The secret
scan of the typed value is the backstop, and the approver prompt warns of exactly this case.

### Operator-only: an agent never approves, the operator may (decision 6)

Matched on signed version metadata, not basename, so a renamed or copied binary is still caught:

- **shells and terminals:** `OriginalFilename` of cmd, PowerShell, pwsh, Windows Terminal,
  conhost, OpenConsole, wsl, bash; and any element hosted by a console (`ConsoleWindowClass`,
  `PseudoConsoleWindow`, or a terminal control whose own process is one of these);
- **browsers and embedded web:** Chrome, Edge, Firefox, Brave, Opera by version metadata; **any**
  element whose `FrameworkId` is `Chrome`, or whose own process is a WebView2 or Chromium child,
  whatever app hosts it;
- **credential and security surfaces:** `CredentialUIBroker`, `LogonUI`, Windows Security, the
  Settings app's account pages, and password-manager images listed in config (by image hash or
  signer plus product name);
- **any read that would return an element marked `IsPassword`** (its existence, never its value);
- everything **unrecognized** (precedence rule 4).

Config can **add** to this tier, by signer plus product name or by image hash. It cannot remove a
built-in entry.

### Supported surfaces: the only ones that can reach delegate

A process whose image has verifiable identity (a valid Authenticode signature with version
metadata, or an image hash the operator listed in config), at medium integrity or lower, whose
elements report `FrameworkId` in `{Win32, WinForm, WPF, XAML, DirectUI}`. Anything else is
operator-only.

### Native adapter preference (M4)

If a registered Toros adapter covers the application (for example Excel through spec F), app
admission is refused with `E_CAP_NOT_ALLOWED`, naming the adapter. SPEC §4.3's preference order
stands; "any application" does not override it.

## Gate table (B2)

An app grant is a **prerequisite**, never a substitute, for operator-tier approval.

| Request | Delegate tier | Operator-only tier | Absolute |
|---|---|---|---|
| App admission (`desktop_request_app`) | approver decides | operator decides; admits the app **only**, no reads or actions | refused |
| `list_windows` | under grant, no per-call gate | operator, per call | refused |
| `find`, `inspect_tree` | under grant; every returned element is classified (below) | operator, per call | element omitted |
| `invoke`, `set_value`, `select` | approver, per action | operator, per action | refused |

**Per-element filtering on reads.** Every element a read would return is classified. Delegate
elements are returned. Operator-only elements are **quarantined**, returned only as
`{ "quarantined": true, "tier": "operator_only", "control_type": … }` with no name and no
children, until the operator approves that exact bounded read. Absolute elements are omitted
entirely. A subtree read below a harmless root therefore cannot leak a password control's
neighbourhood.

**No read ever returns a control value** (Spec AR's rule, kept). The read output is:

```jsonc
{ "control_ref": "opaque, mission-scoped", "control_type": "Button", "automation_id": "≤128",
  "name": "≤256, sanitized (B5)", "class_name": "≤128", "framework_id": "Win32",
  "enabled": true, "offscreen": false, "patterns": ["Invoke"], "tier": "delegate",
  "children": [ … ] }
```

Operator-approved reads are bound and single-use exactly like mutations (below).

## The approval record (B3)

Every gated request (an app admission, an operator-tier read, any mutation) produces one
**immutable approval record, prepared by Node Core**, never assembled from driver input:

```jsonc
{
  "record_version": 1,
  "mission_id": "…", "mission_generation": 3, "job_id": "…", "envelope_digest": "…",
  "driver": "claude", "driver_instance": "<nonce digest>",
  "desktop_key": { … }, "grant_id": "…",
  "process": { "pid": 4242, "created_at": "…", "image_sha256": "…", "signer": "…" },
  "target": {
    "selector": [ /* Spec V path from the window root */ ],
    "element": { "control_type": "…", "automation_id": "…", "name": "…", "class_name": "…",
                 "framework_id": "…", "enabled": true, "offscreen": false, "patterns": [] },
    "ancestors": [ { "control_type": "…", "automation_id": "…", "name": "…", "class_name": "…" } ],
    "window_name": "…",
    "selection_context": [ /* for each ancestor with SelectionPattern: selected item names */ ],
    "current_value_sha256": "…",   // set_value only; content never stored
    "is_selected": false            // select only
  },
  "action": "invoke" | "set_value" | "select" | "inspect_tree" | "find" | "list_windows" | "admit_app",
  "value": "…",                     // set_value only, after the secret scan (B5)
  "tier": "delegate" | "operator_only",
  "created_at": "…", "expires_at": "…"
}
```

- **Digest.** The record **is** the gated action's canonical argument object, so
  `arguments_digest = SHA-256(canonicalize(record))`. The existing `ApprovalBinding`
  (`job_id`, `capability`, `arguments_digest`) carries it unchanged. The approver, the operator,
  the audit event and AC replay all see **this same record**.
- **Element instance.** The UIA runtime id of the resolved element is held **in memory only** for
  the record's lifetime. It is never written to a receipt or used as a selector (Spec V's rule,
  with this one stated exception). Runtime ids can be reused
  ([AutomationElement.GetRuntimeId](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid)),
  so it is never trusted alone. It is combined with process creation time and full snapshot
  equality.
- **At execution**, inside one automation worker, the worker:
  1. revalidates the process (pid plus creation time, image hash);
  2. re-resolves the selector;
  3. requires the **same runtime id** and the **same snapshot** (every field of `target`,
     recomputed);
  4. reclassifies;
  5. then calls the pattern **on that same resolved element object, without another lookup**.

  Any difference is `E_APPROVAL_INVALID`. A replacement control with identical properties has a
  new runtime id and is refused. A switched document, recipient or selection changes
  `window_name`, `ancestors` or `selection_context` and is refused.

**What AS does not promise.** Generic UI Automation cannot bind arbitrary application state to an
effect atomically:

- A window of milliseconds remains between the final check and the pattern call.
- State outside the enumerated snapshot (for example which mail account is active, when nothing
  on screen shows it) is not covered.

AS binds the action to the **enumerated snapshot only**, never to the semantic effect. The
approver prompt says so, and tells the approver to deny when the effect depends on state the
record does not show. An application that needs a stronger guarantee needs its own adapter.

## Request lifecycle and invalidation (B4)

```text
received → validated → classified → awaiting_decision → approved → executing → executed
                │            │              │               │           └→ outcome_uncertain
                └→ rejected  └→ refused     └→ denied       └→ invalidated
```

- **Mission generation.** Revoke, expiry, the job reaching a terminal state, operator hold, a
  session lock or disconnect, and Node Core restart each **bump the generation**. They also void
  every app grant and every request not yet `executing`. A verdict that arrives for an old
  generation is recorded and **inert**.
- **One execution lock per desktop key.** Under that lock, and immediately before dispatching the
  worker, Node Core rechecks everything:
  - the live caller and enrollment;
  - mission state and generation;
  - job state and envelope digest;
  - effective expiry;
  - the grant and the process;
  - the tier;
  - and finally `ApprovalVerifier.consume`.

  Invalidation takes **the same lock**. So an invalidation lands either before dispatch, and the
  action never starts, or after it, and the action counts as started. There is no third case.
- **Child lifetime.** Approver children and automation workers run inside a **Windows Job Object
  owned by Node Core** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so they die with Node Core,
  including when Node Core is killed. Invalidation kills owned approver children at once. A
  worker already inside a UIA call is allowed to return, not retried, and its outcome is recorded.
- **Uncertain outcome.** A worker killed, timed out, or crashed after `executing` began produces
  `outcome_uncertain`. It is never retried, is shown in the log in a distinct colour, and puts
  the mission on **hold** (M1).
- **Audit-write ordering.** `requested`, `decided` and `executing` events must be durably appended
  **before** the worker is dispatched. A failed append refuses the action. A failed append
  **after** execution stops desktop control on the node: every mission is ended, and the cockpit
  shows the failure. Execution without a record is not possible.
- **Locked or disconnected session:** the generation is bumped, pending requests are invalidated
  and grants are voided. The mission itself survives, and new grants are needed after unlock.
- **Restart:** all missions end. Nothing is persisted that could resurrect authority.

## Secrets and sanitization (B5)

Order of operations for every incoming request, **before anything is persisted, published to the
cockpit, written to a parameter file, or shown to an approver**:

1. **Schema and size validation:** typed value ≤ 4 KiB, reason ≤ 500 chars, selector ≤ 32 steps
   of ≤ 256 chars each. Oversized or unparseable input is refused: it is never treated as clean.
2. **Secret detection** on **every** free-text field: typed value, reason, selector names.
   Detection uses the AG pattern set, **pinned by version id**, plus known-token detection of
   **every Toros credential**: `token`, `operator_token`, and every `agents.*.token`.
3. **On a match**, the request is refused (`E_SECRET_DETECTED`). The only thing recorded is a
   `desktop.request_rejected` event carrying request id, input digest, and detection kind. The raw
   value is never stored, never logged, and never echoed in the error.

Screen-derived strings (names, window titles, selection names) are untrusted and go through the
same redactor **before** they enter a record, an event, an approver prompt, or an MCP response.
The record that is shown, stored and digested is the **redacted** record. At execution the worker
recomputes the redacted form for comparison. Approver reasons and error details are scanned too:
**a verdict whose reason matches a secret pattern is a deny**, stored redacted.

Decision 9 (typed values logged in full) applies to **admitted** values, which by construction
passed this scan.

**Dependency:** AS cannot ship until spec AG is accepted and its pattern set carries a version id.
Every desktop event records the pattern-set version it was scanned with.

## The approver profile (B6)

The approver does **not** run through the CLI adapter's ordinary session path. AS3 adds a
dedicated **approver runner** in `adapters-cli`, reviewed as part of AS. Its requirements:

- **Clean, Node-owned working directory:** created empty per decision under Toros's runtime root,
  never a workspace, and deleted after the decision. Nothing the driver can write is reachable as
  instructions, config, hooks, resume state or MCP configuration.
- **Isolated CLI configuration:** a dedicated config home per CLI (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`) containing only that CLI's authentication material and a minimal config with:
  - **no MCP servers**;
  - **no hooks or notify commands**;
  - **no user or project instruction files**;
  - **no tool permissions**: Claude with no tools allowed; Codex in a read-only sandbox, with
    shell use denied.

  The operator's normal CLI configuration is never used; it may carry hooks, MCP servers, or
  notify executables. CLI authentication grants model access only and carries no Toros authority.
- **Pinned identity:** the CLI binary path (resolved real executable, never a `.cmd` shim), its
  version, and the model id are fixed in the mission's `approver_profile`. A mismatch at call time
  denies.
- **Bounded:** prompt ≤ 64 KiB, output ≤ 16 KiB, deadline 60 s by default.
- **Success means exactly:** the process exits 0, the stream shows a completed exchange, **no
  tool-use event appears**, and the final message is **exactly one** JSON object that validates
  against the verdict schema. Anything else is a deny, including an `approve` fragment followed by
  a crash, a timeout, or extra output.
- **No transcript retention:** the runner keeps nothing but the parsed verdict, its reason
  (redacted), the latency and the pinned identity. It never writes `exchange-N.jsonl` or a prompt
  file. The adapter's existing exchange writer is not used for approvals.
- **Verified against both real CLIs** at the pinned versions. The exact flags that realise this
  profile are recorded in `docs/finding-approver-profile.md` during AS3, because CLI flags drift
  between versions and the requirement, not the flag list, is normative.

### The prompt and verdict

The prompt is fixed and contains only:

- a fixed instruction block;
- the mission objective;
- the redacted approval record, as a fenced JSON data block labelled **untrusted application
  content**, with an explicit statement that it may contain instructions and that following them
  is a failure;
- the mission's prior denials (count and target keys).

It contains no driver conversation (decision 3). Verdict schema:
`{ "decision": "approve" | "deny", "reason": "≤ 300 chars" }`.

## Denial finality and budgets (M1)

- **A delegate denial puts the mission on hold.** Every further request is refused with
  `E_APPROVAL_DENIED` until the operator presses **Resume** in the cockpit, which is a logged
  operator event. Rewording, re-aliasing the selector, or retrying with a new reason cannot buy
  another verdict, because nothing is asked while the mission is held. An `outcome_uncertain`
  also holds the mission.
- **Budgets:** per mission, `max_requests` (every request: admissions, reads, actions, including
  failures and rejections) and `max_approver_calls`, both defaulting to 200 and set by the
  operator. Exhaustion ends the mission, as `E_BUDGET_EXHAUSTED`.
- **One request in flight per mission.** A second request while one is pending is refused, not
  queued. Mission denial history is capped at 200 entries; at the cap the mission ends rather
  than dropping history.

## MCP surface (M3)

A local stdio MCP server, `packages/mcp-desktop`, with zero runtime dependencies.

- **Protocol:** MCP revision **2025-06-18**
  ([lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
  [stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
  [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)). It implements
  `initialize` with version negotiation, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`, and JSON-RPC errors. stdout carries protocol frames only; diagnostics go to stderr.
- **One identity, fixed at launch:** `--agent claude|codex`. The token is read from the fixed Toros
  config path. No tool argument may name a URL, port, credential, config path, executable,
  command, or file.
- **Fixed routes:** each tool maps to exactly one Node Core route, in a constant table. The server
  validates protocol shape and bounds. It holds no policy, and Node Core enforces ownership and
  scope **even when the MCP server is bypassed** and the routes are called directly.
- **Bounds:** frame ≤ 1 MiB, ≤ 4 outstanding JSON-RPC ids, `desktop_await` waits ≤ 120 s.

| Tool | Input | Result |
|---|---|---|
| `mission_enroll` | `{}` | `{ mission_id, objective, mode, expires_at }`; the nonce stays inside the server |
| `mission_status` | `{}` | mission state, grants, the one pending request, remaining budgets |
| `desktop_state` | `{}` | Spec AR `desktop.state`, mission-scoped |
| `desktop_request_app` | `{ window_id, freshness_token, reason }` | `{ request_id, state }` |
| `desktop_list_windows` | `{ grant_id }` | windows of the granted process |
| `desktop_find` | `{ grant_id, automation_id?, name?, control_type? }` | read output (gate table) |
| `desktop_inspect_tree` | `{ grant_id, root?, depth ≤ 8 }` | read output (gate table) |
| `desktop_invoke` | `{ grant_id, selector, reason }` | `{ request_id, state }` |
| `desktop_set_value` | `{ grant_id, selector, value, reason }` | `{ request_id, state }` |
| `desktop_select` | `{ grant_id, selector, reason }` | `{ request_id, state }` |
| `desktop_await` | `{ request_id }` | the request's current or final state and result |

**Execution trigger.** Once a request is approved, **Node Core executes it** through the ordinary
action pipeline, the same mechanism AC uses for replay but without requiring `hermes_start`.
Execution is not tied to any waiter. `desktop_await` is an idempotent read: calling it twice
never executes twice, and a disconnect neither cancels nor executes anything. Revocation is the
only cancellation.

**Interoperability checks** (AS4 acceptance): real Claude Code and real Codex each connect,
negotiate, list tools and complete one call, at pinned versions.

## Real-time log in the cockpit

Decision 8: a log, live, with timestamps. The cockpit **Desktop control** view:

- **A header per live mission:** objective, driver → approver, mode, scope, expiry countdown,
  budget left, and state. Buttons: **Revoke**, **Hold**, **Resume** (when held), and **Reset
  enrollment**.
- **A stream, newest first:** millisecond UTC timestamps rendered in local time. Each line shows
  the request id, stage (`received`, `rejected`, `classified`, `decided`, `executing`, `executed`,
  `outcome_uncertain`, `invalidated`), the actor, the tier, the target summary, and the typed value
  for an admitted `set_value`.
- **Operator-tier requests** appear in the stream with **Approve** and **Deny** buttons and the full
  record, and also in the existing approvals panel (spec T).
- **Stop all** ends every mission on the node.

The stream is a view over the hash-chained event log (§8.1). There is no second store.

## Events, errors and receipts (B7)

**Event kinds** (A7 adds them to `EventKind`):

- `mission.created`, `mission.held`, `mission.resumed`, `mission.ended` (payload: reason =
  revoked | expired | job_terminal | restart | budget | audit_failure | stop_all);
- `mission.invalidated` (generation bump; payload: cause);
- `desktop.request_received`, `desktop.request_rejected`, `desktop.request_classified`;
- `desktop.app_granted`, `desktop.app_denied`;
- `desktop.outcome_uncertain`.

Action-level decisions continue to use `approval.requested`/`approval.resolved` (payload gains
`decided_by: operator | agent:claude | agent:codex`, `tier`, `record_digest`, and the
pattern-set version, all JSON, no structural change) and `action.*`.

**Error mapping.** No other code may be used:

| Condition | Code |
|---|---|
| no live mission, caller not enrolled, out of scope, native adapter exists | `E_CAP_NOT_ALLOWED` |
| absolute tier | `E_FORBIDDEN` |
| envelope `forbidden` term matched | `E_FORBIDDEN` |
| operator-tier decision pending | `E_APPROVAL_REQUIRED` |
| approver or operator said no; mission held after a denial | **`E_APPROVAL_DENIED` (new, A7)** |
| snapshot, runtime id, process or tier changed; stale generation | `E_APPROVAL_INVALID` |
| secret pattern or known token in any input | `E_SECRET_DETECTED` (doc widened by A7) |
| mission, job or approval expired | `E_EXPIRED` |
| budget exhausted | `E_BUDGET_EXHAUSTED` |
| oversized or malformed input | `E_SCHEMA` |
| locked session, worker failure, uncertain outcome | `E_ADAPTER_FAILURE` (detail names which) |

**Receipts.** `actor` is `agent:claude` or `agent:codex` for driver actions (A7 documents this).
`adapter_fields` (declared in the manifest): `process_id`, `control_type`, `automation_id`,
`pattern`, `elements_returned`, `truncated`, `mission_id`, `approval_id`, `decided_by`,
`record_digest`, `exe_sha256`, `tier`.

## Relationship to Spec V (M4, N1)

On acceptance of AS, these Spec V clauses are **overridden**:

- **Public API:** `UiaAdapterOptions.executable` and `deny_elements`, and one instance per
  application. These are replaced by the AS adapter API below.
- **`always_requires_approval: false` on all six actions.** Mutations become `true` with
  `mutates: true`; reads stay `false` and are gated by Node Core's tier rules.
- **Init executable verification, and `start` launching the application.** AS **never launches
  applications**: the operator starts them, and AS attaches to running processes only.
- **The six actions' input schemas.** Replaced by the MCP table plus the Node-side record.
- **Fixture-only tests.** Replaced by the matrix below.

These Spec V rules remain: selector paths from the window root; no coordinates; whole-path
resolution or fail; no runtime ids **as selectors** (the in-memory exception above is the only
one); the PowerShell parameter-file mechanism and BOM stripping; the bans on `send_keys`,
coordinates, screenshots and scripts; native-API preference; never terminating an application
Toros did not start.

**AS adapter API (Node-internal, not in contracts):**

```ts
export interface UiaWorkerRequest {
  readonly record: ApprovalRecord | null;   // null for ungated delegate reads
  readonly grant: GrantRef;                 // pid, created_at, image_sha256
  readonly action: 'list_windows' | 'find' | 'inspect_tree' | 'invoke' | 'set_value' | 'select';
  readonly input: JsonValue;                // validated MCP input
  readonly limits: { readonly timeout_ms: number; readonly max_elements: number; readonly max_depth: number };
}
export function createUiaAdapter(options: { readonly id: 'desktop_uia'; readonly timeout_ms: number;
  readonly max_elements: number; readonly classifier: Classifier }): Adapter;
```

## What Toros cannot enforce, stated plainly

**A driver with its own shell is not confined by any of this** (decision 14). Claude Code and Codex
can run PowerShell, and so drive UI Automation directly, or read `config.json` and become the
operator as far as Node Core can tell.

For the operator's intent to hold, **the driving session must run with no shell and no file
access outside its workspace**:

- **Claude Code:** tools limited to `mcp__toros-desktop__*`, with a deny rule for the Toros config
  directory;
- **Codex:** a read-only sandbox, no network, and `mcp-desktop` as its only tool server.

`docs/USING.md` gets the exact launch lines. `tools/orient.mjs` **warns** when it can tell a driver
was launched otherwise. A separate Windows account for Node Core is a Phase 2 candidate; AS does
not claim it.

## Prerequisites before `act` is enabled

1. Spec AR's adversarial security review has been run and cleared (in progress, branch
   `review/ar-adversarial`). Findings marked `AS-inherited` must be resolved.
2. Spec AG is accepted, with a versioned pattern set.
3. Contract amendment A7 is made, with every consumer in the same diff.
4. The approver profile is verified on the node for the pinned CLI and model
   (`docs/finding-approver-profile.md`).
5. Independent code review, independent MCP review (workspace invariant 3), and a third-lineage
   adversarial review of the implementation.

`look` missions may ship once 2–4 and the code and MCP reviews in 5 are done. `act` needs all five.

## Delivery slices

| Slice | Content | Allowed paths (finalized at dispatch) |
|---|---|---|
| AS0 | contract amendment A7 (architect only, all consumers in one diff) | `packages/contracts/**`, affected consumers, `docs/specs/00-CONTRACTS.md` |
| AS1 | missions, enrollment, generations, execution lock, budgets, hold, operator routes, events | `packages/node-core/src/**` + tests |
| AS2 | classifier, the AS UIA adapter, worker, record build and execution check | `packages/adapters-uia/**` |
| AS3 | approver runner and profile; profile finding doc | `packages/adapters-cli/src/approver*.ts` + tests, `docs/finding-approver-profile.md` |
| AS4 | `packages/mcp-desktop` | `packages/mcp-desktop/**` |
| AS5 | cockpit Desktop control view | `apps/cockpit/**` |
| AS6 | driver profile docs, orient warning, STATUS | `docs/**`, `tools/orient.mjs` |

## Acceptance tests (M4)

Every assertion below names an observable result: an error code, an event kind, or a file's
content. Tests run natively on Windows with an interactive desktop. A skip is a finding. Fault
fixtures are **controlled**: a small test-only WinForms or WPF application started by the test,
which can lie about `IsPassword`, swap a control, or change its selection; renamed copies of
signed system binaries; injectable clock, worker-kill and event-store-failure seams; fake approver
CLIs (scripts run through `process.execPath`) for malformed, partial, tool-using and slow
verdicts. Real Notepad and Calculator are used for smoke tests under a real mission.

**Missions and ownership (M2)**
1. No desktop request is accepted without a live mission → `E_CAP_NOT_ALLOWED`.
2. Default expiry is created_at + 24h; an operator expiry is honoured; the effective expiry is the
   earliest bound, and a pending request past it → `E_EXPIRED`.
3. Revoke, expiry, job termination, hold, lock and restart each bump the generation and void
   grants → `mission.invalidated` event; a later request → refused.
4. An agent token cannot create, extend, resume or widen a mission, or call an operator or Hermes
   route → rejected before routing.
5. A second enrollment for a live mission is refused; another instance's `request_id` returns
   `unknown request`.
6. A second Node Core cannot enable AS (mutex held).

**Classification (B1)**
7. A renamed copy of cmd.exe → operator-only.
8. A WebView2 surface inside an ordinary app → operator-only.
9. An embedded console → operator-only.
10. The cockpit's WebView2 content → absolute (`E_FORBIDDEN`), even with operator approval.
11. A process at higher integrity → refused and recorded; Node Core elevated → AS disabled.
12. An element whose own process differs from its window's process is classified by its own
    process.
13. Unsigned image → operator-only.
14. Unknown `FrameworkId` → operator-only.
15. Unreadable evidence → refused.
16. A fixture field that lies `IsPassword=false` but is named "Password" → `set_value` refused.
17. Classification runs again at execution: a target that changed tier between approval and
    execution → `E_APPROVAL_INVALID`.

**Gates (B2)**
18. An operator-approved app admission alone admits no read: `inspect_tree` →
    `E_APPROVAL_REQUIRED`.
19. A delegate-tier subtree containing a password control returns it quarantined, with no name.
20. No read returns a control value; a fixture field's content never appears in any response or
    event.

**Binding (B3)**
21. A replacement control with identical properties → `E_APPROVAL_INVALID`.
22. A switched selection or document under the same control → `E_APPROVAL_INVALID`.
23. A record from mission A, grant A, or generation N is not accepted under B or N+1.
24. PID reuse: a new process holding the granted pid → refused.
25. The digest in `approval.resolved` equals the digest of the record shown to the approver.

**Lifecycle (B4)**
26. Revoke while awaiting a verdict: the late `approve` is inert and the action never starts.
27. Revoke after approval, before dispatch: the action never starts.
28. Revoke after dispatch: the action completes or lands in `outcome_uncertain`; no retry occurs.
29. Killing Node Core kills the approver and worker children (Job Object).
30. Event-store failure before dispatch → refused; failure after → desktop control ends on the node.

**Secrets (B5)**
31. A synthetic secret in a typed value, a reason, or a selector name → `E_SECRET_DETECTED`; a
    full-text search of events, receipts, files and error bodies finds it nowhere.
32. An approver reason echoing a secret → deny, stored redacted.
33. Each Toros token is detected as a known token.
34. An oversized value → `E_SCHEMA`, never treated as clean.

**Approver (B6)**
35. A planted `CLAUDE.md`, `AGENTS.md` or MCP config in the driver's workspace does not reach the
    approver: its clean directory and config home contain only the profile.
36. Fake CLIs that attempt tool use, emit partial output then crash, emit two JSON objects, or
    time out → deny.
37. After a decision, no `exchange-*.jsonl` or prompt file remains anywhere under the Toros runtime
    root.
38. A pinned-version mismatch → deny.
39. Both real CLIs pass the profile check at their pinned versions.

**Finality and budgets (M1)**
40. After one denial, a reworded request, an aliased selector, and a new reason are each refused
    with `E_APPROVAL_DENIED` until the operator resumes.
41. A sequential flood exhausts `max_requests` → the mission ends with `E_BUDGET_EXHAUSTED`.
42. A second in-flight request → refused.

**MCP (M3)**
43. The handshake, `tools/list` and `tools/call` work against real Claude Code and real Codex.
44. No tool accepts a URL, path, credential or command field (schema check).
45. Calling `desktop_await` twice never executes twice; disconnecting mid-wait neither cancels nor
    executes.
46. Calling Node Core routes directly, bypassing MCP, enforces the same ownership and scope.
47. Oversized frames and too many outstanding ids → protocol error, no Node call.

**Log**
48. Every stage of a request appears as a timestamped event in order, and the cockpit stream
    renders it.

## Out of scope

Mac or Linux desktops. Launching applications. More than one driver per mission. Agents other than
Claude and Codex as driver or approver. Any vision or coordinate fallback. Persisting missions
across restarts. Letting the approver ask the driver questions. Semantic guarantees beyond the
enumerated snapshot.

## Appendix A — operator decisions, 2026-10-13

1. A Claude or Codex session drives Toros directly; Hermes is not in the loop (coordinator-optional).
2. Cross-approval: Codex approves Claude's requests, and vice versa.
3. The approver sees a structured request with screen content marked untrusted, never the driver's
   conversation.
4. Any approval is void after 24 hours unless otherwise specified, and is bound to a specific task
   mission.
5. Agents act with their own scoped credentials, never the operator token.
6. The hard-deny targets can be approved by the operator personally so the task can continue,
   with the two absolute exceptions confirmed in 13.
7. Both per-app and per-action approval.
8. A real-time, timestamped log is the operator's visibility; no live per-action prompt.
9. Typed values are logged in full; secret-pattern values are refused.
10. MCP is the driver's interface.
11. Spec PR first; prerequisites before mutation is enabled.

Confirmed by the operator on 2026-10-13, after drafting:

12. The approver runs one-shot, launched by Node Core per request, rather than as a second live
    session. The cost of one model call per decision is accepted.
13. Two targets stay absolute, outside even the operator's per-action approval: Toros's own
    processes, and typing into password fields or typing any secret-pattern value.
14. Toros cannot confine a driver that has its own shell. The driver profile in "What Toros cannot
    enforce" is a setup requirement, documented and warned about, not enforced by Toros.

Revision 2 behaviour, **confirmed by the operator on 2026-10-13**:

- R2-a. A delegate denial **holds** the mission until the operator presses Resume (M1). This is
  one operator action per denial, not a per-action prompt (decision 8 stands).
- R2-b. Unrecognized surfaces (unsigned apps, unknown UI frameworks, any embedded web content)
  route to the operator, not the approver (B1). Breadth of delegation is limited to surfaces Toros
  can classify.
- R2-c. AS never launches applications; the operator starts them (M4).
- R2-d. Default mission budget: 200 requests and 200 approver calls (M1).
