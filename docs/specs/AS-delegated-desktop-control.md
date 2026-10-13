# Spec AS — delegated desktop control: mission grants, cross-agent approval, MCP

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

**Status: proposed, revision 3 (2026-10-13). Not accepted.** Revision 2 answered the independent
spec review (`docs/reviews/AS-spec-review.md`, PR mbulentcakar/Toros#2): blockers B1–B7, majors
M1–M4, minor N1. Revision 3 answers the re-review of revision 2: R2-B1, R2-B3, R2-B4, R2-B6,
R2-M4 and R2-D1 … R2-D6. It also rebases on the AR remediation plan (`docs/reviews/AR-remediation-plan.md`,
PR mbulentcakar/Toros#4). Each section that changed names the finding it closes. All operator
decisions in Appendix A are preserved; R2-B1 follows the operator's choice (a), 2026-10-13.

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
  `allowed_capabilities` (which must list the `desktop_uia.*` ids used, see "Capability ids"),
  the envelope's `forbidden`
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
  receives a nonce: the fixed prefix `tdn_` plus 256 random bits in base64url, so it is
  pattern-detectable (R2-D5). Every later request must carry token and nonce together, and a
  second enrollment is refused while the first is live. Node Core also records the enrolling
  process: the loopback peer's pid and creation time, read from the OS TCP table, never from the
  request. That process joins the Toros identity registry (R2-B1). The operator can reset
  enrollment from the cockpit if the driver session dies. A reset is an invalidation: it bumps the
  generation and replaces the nonce atomically, and the old nonce is refused from that moment.
- Every lookup (`mission_status`, request status, results) is scoped to (mission, enrolled
  instance). An id belonging to anyone else returns the same `unknown request` as an id that does
  not exist. There is no oracle.

## Classification (B1, R2-B1)

Node Core classifies **every** target before any agent is asked: each app admission, each element
a read would return, and each action. It **classifies again at execution**. Classification uses
OS-observed evidence only. A caller-supplied pid, `FrameworkId`, name or description is never
proof of anything.

Revision 3 separates two things revision 2 merged. A **recognized framework** is not a **verified
delegable surface**. Delegation needs *positive native evidence* about the specific control, not
just a signed application on a known framework (operator choice (a), 2026-10-13).

### Evidence collected per process and per element

- **Process identity:** pid plus creation time (pid-reuse guard); canonical image path; image
  SHA-256; Authenticode status and signer; the signed version resource (`OriginalFilename`,
  `InternalName`, `ProductName`), which survives renames and copies; token integrity level and
  elevation; session id; desktop.
- **Ancestry:** parent chain with each parent's creation time verified, so a recycled pid does not
  inherit an identity.
- **Element (UIA):** the element's **own** owning process id (UIA `ProcessId`), `FrameworkId`,
  class name, `IsPassword`, and the same for every ancestor to the top-level window.
- **Element (native):** for every element and ancestor that has a native window handle, read
  directly from Win32, never from the UIA provider: the window class name (`GetClassName`), the
  window style (`GetWindowLongPtr(GWL_STYLE)`), the owning thread's process
  (`GetWindowThreadProcessId`), and, for edit classes, `EM_GETPASSWORDCHAR`. The AR review showed
  a UIA provider reporting `IsPassword=false` and a non-Edit control type for a genuinely masked
  field whose native style was correct. Native evidence is therefore the authority wherever it
  exists.

### Precedence

1. **Absolute** wins over everything.
2. **Operator-only** wins over delegate.
3. **Delegate** applies only where the positive-evidence rules below are met.
4. **Unrecognized or missing positive evidence** → operator-only.
5. **Unobtainable** evidence (access denied, process gone, integrity or native read fails) →
   refused.

### The Toros identity registry, and how it is populated

The registry holds (pid, creation time, image hash) entries, populated **only from OS
observation**. Entries come from four sources:

- **Node Core itself** at start.
- **Children Node Core spawns** (approver runs, automation workers, the job supervisor): each is
  registered at creation, while still suspended, before it runs (R2-D4).
- **The cockpit:** the operator records the installed cockpit image path at install, and Node Core
  stores that image's SHA-256. Any running process whose canonical image path and hash match is
  registered as soon as it is observed. So are its verified descendants, including its WebView2
  children. **AS refuses to enable act missions until a cockpit process is registered.** A cockpit
  started later is registered on its first appearance in any enumeration, and the scan runs before
  every classification.
- **Every enrolled MCP server:** the loopback peer of the enrolling connection, read from the OS
  TCP table at enrollment. Its whole verified ancestry up to the driver CLI is registered too.

In addition, independently of the registry, **any process whose canonical image lies under the
Toros install directory or the Toros runtime root** is classified as Toros. This rule catches a
Toros process that started before registration.

### Absolute: no one approves

- **The Toros family:** any element whose own process, its window's process, or any process on
  the verified ancestry of either is in the registry or matches the install-directory rule.
- **Higher integrity than the worker.** The automation worker runs at medium integrity, is never
  elevated and never holds UIAccess. Node Core refuses to enable AS if it is itself elevated. Any
  target process at higher integrity than the worker is refused and recorded
  ([UI Automation security overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- **The secure desktop** (UAC, Ctrl+Alt+Del): refused and recorded.
- **Secret entry** (decision 13), refused for **any** `set_value` that is not positively proven
  safe. Revision 2's "residual risk" paragraph is withdrawn: an unmarked credential field is not
  an exception to decision 13, and it is not left to the approver's judgment. `set_value` is
  permitted (to either tier) **only** when every one of these holds:
  1. the element has a native window handle;
  2. its native class is a plain text-entry class: Win32 `Edit`, `RichEdit20W`, `RICHEDIT50W`, or
     a WinForms class whose native base is one of these;
  3. the native style lacks `ES_PASSWORD`;
  4. `EM_GETPASSWORDCHAR` returns 0;
  5. no ancestor is a credential surface (see operator-only) or carries `ES_PASSWORD`;
  6. the element's own name, automation id and class, lower-cased, contain none of `password`,
     `passcode`, `pin`, `secret`, `token`, `otp`, `şifre`, `parola`. Names are untrusted, so they
     are used **only to deny**;
  7. the typed value passes the secret scan (B5).

  Text fields without a native window handle (most WPF, UWP/XAML and custom-drawn fields) cannot
  meet rule 1, so **`set_value` on them is refused for everyone**. This is the price of decision 13
  under choice (a), and it is stated rather than hidden. Such fields need a native Toros adapter.
- **Not actions at all:** `send_keys`, coordinates, screenshots, scripts (Spec V's bans).

### Operator-only: an agent never approves, the operator may (decision 6)

- **Shells and terminals:** matched by signed version metadata (`OriginalFilename` of cmd,
  PowerShell, pwsh, Windows Terminal, conhost, OpenConsole, wsl, bash), so renamed or copied
  binaries are caught; and any element hosted by a console (`ConsoleWindowClass`,
  `PseudoConsoleWindow`, or a terminal control whose own process is one of these).
- **Browsers and embedded web:** browsers by version metadata. Also **any** element whose
  `FrameworkId` is `Chrome`, whose own process is a WebView2 or Chromium child, or whose native
  ancestry contains a Chromium, WebView2, MSHTML (`Internet Explorer_Server`) or CEF host class,
  whatever app hosts it (R2-b).
- **Credential and security surfaces:** `CredentialUIBroker`, `LogonUI`, Windows Security, the
  Settings app's account pages, and password-manager images listed in config (by image hash or
  signer plus product name).
- **Any read that would return an element marked as a password** by UIA *or* by native style (its
  existence, never its name or value).
- **Everything without positive evidence** (precedence rule 4).

Config can **add** to this tier. It cannot remove a built-in entry.

### Positive evidence: the only way to reach delegate

A request reaches the delegate tier only if all of these hold:

- **The process** has verifiable identity: a valid Authenticode signature with version metadata,
  or an image hash the operator listed in config. It runs at medium integrity or lower.
- **The target element and every ancestor up to the top-level window** have native window handles
  whose native classes are all in the **delegable class set**:
  - Win32 common controls: `Button`, `Edit`, `RichEdit20W`, `RICHEDIT50W`, `ComboBox`,
    `ComboBoxEx32`, `ListBox`, `SysListView32`, `SysTreeView32`, `SysTabControl32`, `msctls_*`,
    `ToolbarWindow32`, `#32770` dialogs, `#32768` menus, and `Static`;
  - WinForms classes whose native base is one of these;
  - plus the application's own top-level frame class, recorded at admission.
- **No absolute or operator-only evidence** appears anywhere on that chain.

An element **without a native window handle** (WPF, XAML and custom-drawn content) can be **read**
at the delegate tier when its nearest native ancestor qualifies, but **actions on it are
operator-only**. Its embedded function cannot be established natively. This closes R2-B1's
signed-app-hosts-a-terminal and hosts-a-web-view cases: those hosts are either a non-delegable
native class or a provider without native handles, so they never reach delegate.

The delegable class set is code, reviewed with AS2, and extendable only by a spec change.

### Native-interface preference (R2-M4)

Spec V's rule stands in full. **An application with a real automation interface must get its own
adapter instead of UIA**, whether or not that adapter is installed. Node Core ships a reviewed
catalog, `packages/adapters-uia/src/native-catalog.ts`, of applications known to have such an
interface, keyed by signer plus `ProductName` (for example the Microsoft Office applications).
Admitting a catalogued application through UIA is refused with `E_CAP_NOT_ALLOWED`. The detail
names the native route, or says that none is installed. The catalog is data in the repository,
changed only by a reviewed PR.

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

**No read ever returns a control value** (Spec AR's rule, kept). **Names are returned only where
native evidence shows the element is not a password surface** (AR-01, remediation F2). That means
an element with a native handle whose class and style pass the secret-entry checks. Every other
element's name is withheld (`"name": null, "name_withheld": "no_native_evidence"`) unless the
operator approves that exact read. The read output is:

```jsonc
{ "control_ref": "opaque, mission-scoped", "control_type": "Button", "automation_id": "≤128",
  "name": "≤256, sanitized (B5), or null", "name_withheld": "no_native_evidence | password | quarantined | null",
  "native_class": "≤128 or null", "framework_id": "Win32", "enabled": true, "offscreen": false,
  "patterns": ["Invoke"], "tier": "delegate", "children": [ … ] }
```

**Gated reads return a request, not data** (R2-D1). An operator-tier `list_windows`, `find` or
`inspect_tree` returns `{ request_id, state: "pending" }`. `desktop_await` later returns one of
`{ state: "denied", code }`, `{ state: "invalidated", code }` or `{ state: "done", result }`.
Operator-approved reads are bound and single-use exactly like mutations.

## The approval record (B3, R2-B3, R2-D1, R2-D2)

Every gated request produces one **immutable approval record, prepared by Node Core**, never
assembled from driver input. The record is a **discriminated union** on `kind` (R2-D1):

```jsonc
// common to every kind
{ "record_version": 2, "kind": "admission" | "read" | "mutation",
  "mission_id": "…", "mission_generation": 3, "job_id": "…", "envelope_digest": "…",
  "driver": "claude", "driver_instance": "<nonce digest>", "desktop_key": { … },
  "capability": "desktop_uia.invoke",           // exact registered capability id (R2-D3)
  "tier": "delegate" | "operator_only",
  "state_commitment": "<keyed commitment, below>",
  "created_at": "…", "expires_at": "…" }

// kind = "admission": no grant exists yet, so none is referenced
{ "candidate": { "pid": 4242, "created_at": "…", "image_path": "…", "image_sha256": "…",
                 "signer": "…", "product": "…", "integrity": "medium",
                 "windows": [ { "native_class": "…", "name": "…" } ] } }

// kind = "read": the complete normalized input and its effective bounds
{ "grant_id": "…", "process": { "pid": 4242, "created_at": "…", "image_sha256": "…" },
  "action": "list_windows" | "find" | "inspect_tree",
  "input": { /* normalized: root selector, depth, filters */ },
  "bounds": { "max_depth": 4, "max_elements": 200, "max_name_chars": 256 } }

// kind = "mutation"
{ "grant_id": "…", "process": { … },
  "action": "invoke" | "set_value" | "select",
  "input": { "selector": [ /* Spec V path */ ], "value": "…" /* set_value only, post-scan */ },
  "target": {
    "element": { "control_type": "…", "automation_id": "…", "name": "…", "native_class": "…",
                 "framework_id": "…", "enabled": true, "offscreen": false, "patterns": [] },
    "ancestors": [ { "control_type": "…", "automation_id": "…", "name": "…", "native_class": "…" } ],
    "window_name": "…",
    "selection_context": [ { "container_path": [ … ],
                             "selected": [ { "index": 2, "automation_id": "…", "name": "…" } ] } ],
    "is_selected": false } }
```

- **The worker input is derived only from the record** (R2-D1). **Every** request, including an
  ungated delegate read, becomes a record first. The worker receives the record and nothing else. `UiaWorkerRequest` no longer carries a separate `input`. A replay reconstructs the
  exact call, including depth, filters and bounds, from the record alone.
- **Digest.** The record **is** the gated action's canonical argument object:
  `arguments_digest = SHA-256(canonicalize(record))`. The existing `ApprovalBinding`
  (`job_id`, `capability`, `arguments_digest`) carries it unchanged. The approver, the operator,
  the audit event and AC replay all see this same record.
- **Displayed versus compared state** (R2-D2). The record shown, stored and digested carries
  **sanitized** strings. Redaction maps many inputs to one marker, so sanitized fields cannot
  prove state identity. Comparison therefore uses `state_commitment`:

  `HMAC-SHA256(K_mission, canonicalize(raw observed state))`

  The raw observed state is every target, ancestor, window and selection field, **before
  redaction**. `K_mission` is a random 256-bit key created with the mission, held **in memory
  only**, and destroyed when the mission ends or the generation bumps. Raw state is never
  persisted. The commitment is useless to anyone without the key, including a reader of the
  audit log who tries to guess low-entropy values. At execution the worker recomputes the
  commitment from the live raw state. A mismatch is `E_APPROVAL_INVALID`.

### Element continuity (R2-B3)

Runtime-id equality plus property equality does **not** prove that an element is the same one: UIA
runtime ids can be reused after an element is destroyed
([AutomationElement.GetRuntimeId](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid)).
Revision 3 drops that claim and requires a **live continuity guard**:

- **One long-lived automation worker per grant**, inside the job (below). It resolves the target
  when the record is prepared and **keeps that live element object** until execution or
  invalidation. Execution calls the pattern on **that same object**. There is no second
  resolution and no runtime-id lookup.
- **Before the record is prepared**, the worker subscribes to:
  - UIA `StructureChanged` on the element's parent and on each `selection_context` container;
  - `AutomationPropertyChanged` on the element (name, enabled, value, selection).

  Any child removal, invalidation, or change to a bound property **invalidates the record**. If
  the provider will not accept the subscription, continuity cannot be established, and the action
  is refused (`E_APPROVAL_INVALID`, detail `no_continuity`) for **every** tier.
- **Native handle continuity:** where the element has a native window handle, the worker also
  confirms the handle still belongs to the same thread and process, and that the window still
  exists (`IsWindow`). It holds a reference to the window's owning process for the grant's
  lifetime, so the pid cannot be recycled while the grant lives.
- **Selection items are bound by identity** (R2-B3): their live element objects are held and
  subscribed, as well as their index and label. Two items with the same label are distinct.
- **At the worker-ready boundary** (lifecycle, below) the worker revalidates:
  1. process image hash;
  2. continuity (no invalidating event received);
  3. `state_commitment`;
  4. tier, reclassified.

  Only then does it wait for the go token.

**What AS does not promise.** A window of milliseconds remains between the last check and the
pattern call. State the snapshot does not enumerate (for example which account is active, when
nothing on screen shows it) is not covered. AS binds the action to the enumerated, continuously
watched snapshot only, never to the semantic effect. The approver prompt says so and tells the
approver to deny when the effect depends on state the record does not show.

## Request lifecycle and invalidation (B4, R2-B4, R2-D4)

```text
received → validated → classified → awaiting_decision → approved → dispatched → ready → issued → executed
   │           │            │               │               │           │          │        └→ outcome_uncertain
   └→ rejected └→ refused   └→ refused      └→ denied       └→ invalidated (any of these, before `issued`)
```

**`issued` is the only irreversible point.** It is the instant the worker calls the UIA pattern.
Everything before it can be cancelled with no effect.

- **Invalidation causes.** Each of these bumps the mission generation, voids every app grant, and
  invalidates every request not yet `issued`:
  - operator revoke, Hold or Stop all;
  - mission, job or approval expiry;
  - the job reaching a terminal state;
  - **automatic holds**, on a delegate denial (M1) or an `outcome_uncertain`;
  - enrollment reset;
  - session lock or disconnect;
  - audit-write failure;
  - Node Core restart.

  A verdict arriving for an old generation is recorded and **inert**.
- **Go token at the worker-ready boundary** (R2-B4). A dispatched worker performs its checks
  (above), then reports `ready` and **blocks**. Under the per-desktop execution lock, Node Core
  rechecks:
  - caller and enrollment;
  - mission state, generation and effective expiry;
  - job state and envelope digest;
  - grant and process;
  - tier;
  - `ApprovalVerifier.consume` (on dispatch only, single-use).

  It then appends the `issued` event **durably** and sends the worker a single-use go token valid
  for 250 ms. The worker calls the pattern only on receiving it. Invalidation takes the same lock.
  So it either lands before the go token, in which case Node Core kills the worker and the action
  never happens, or after `issued`, in which case the call has been made and completes or ends
  `outcome_uncertain`.
- **Restart reconciliation** (R2-B4). At start, Node Core scans for requests whose last durable
  event is `issued` without a final result, and appends `desktop.outcome_uncertain`
  (`reconciled: true`). It replays nothing and restores no authority. Requests that never reached
  `issued` are recorded as `invalidated` (cause `restart`).
- **Audit-write ordering.** `received`, `decided`, `dispatched` and `issued` are durably appended
  before the step they describe. A failed append before `issued` refuses the action. A failed
  append after it ends every mission on the node and is shown in the cockpit.
- **MCP disconnect never cancels** anything; only the invalidation causes above do.
- **Locked or disconnected session:** an invalidation like the others. The mission survives,
  and new grants are needed after unlock.

### Child lifetime: the job supervisor (R2-D4)

The ordinary Node child-process API cannot create a process inside a Job Object. So:

- **The job supervisor** is a small fixed PowerShell host that Node Core starts at AS enable. It
  uses fixed `Add-Type` C# source and never interpolates anything into it.
  - It creates one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, without
    `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`, and with a non-inheritable handle.
  - It holds the **only** handle to the job.
  - It opens a handle to Node Core's process and exits the moment Node Core exits.
  - Its own exit closes the job, which kills every member.
- **Every approver run and automation worker is created through the supervisor:**
  1. `CreateProcess` with `CREATE_SUSPENDED`;
  2. `AssignProcessToJobObject`;
  3. registration in the Toros identity registry;
  4. `ResumeThread`.

  **If assignment fails, the child is terminated while still suspended**, and the action is
  refused. Children inherit no job handle. No child code runs outside the job.
- **Gap, stated:** between Node Core's death and the supervisor noticing it, a few milliseconds
  pass. No child can act in that gap, because a UIA call needs a go token that only a live Node
  Core can issue.
- Owned by AS1 (`packages/node-core/src/job-supervisor*.ts`) and reviewed with it.

## Secrets and sanitization (B5)

Order of operations for every incoming request, **before anything is persisted, published to the
cockpit, written to a parameter file, or shown to an approver**:

1. **Schema and size validation:** typed value ≤ 4 KiB, reason ≤ 500 chars, selector ≤ 32 steps
   of ≤ 256 chars each. Oversized or unparseable input is refused: it is never treated as clean.
2. **Secret detection** on **every** free-text field: typed value, reason, selector names.
   Detection uses the AG pattern set, **pinned by version id**, plus known-token detection of
   **every Toros-issued credential** (R2-D5):
   - `token`, `operator_token`, and every `agents.*.token`;
   - every enrollment nonce issued in the last 24 hours, live or invalidated, by exact match and
     by its `tdn_` pattern;
   - every other live Core-issued run credential (run tokens, go tokens).

   Node Core keeps only SHA-256 digests of past nonces for matching. A raw nonce never appears in
   an event, an error, a receipt or the cockpit.
3. **On a match**, the request is refused (`E_SECRET_DETECTED`). The only thing recorded is a
   `desktop.request_rejected` event carrying request id, input digest, and detection kind. The raw
   value is never stored, never logged, and never echoed in the error.

Screen-derived strings (names, window titles, selection names) are untrusted and go through the
same redactor **before** they enter a record, an event, an approver prompt, or an MCP response.
The record that is shown, stored and digested is the **redacted** record. State comparison never
uses the redacted strings. It uses the keyed `state_commitment` over the raw observed state
(R2-D2). Approver reasons and error details are scanned too:
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
- **No transcript retention, by the runner or the CLI** (R2-B6). The runner keeps nothing but
  the parsed verdict, its reason (redacted), the latency and the pinned identity. It never writes
  `exchange-N.jsonl` or a prompt file. The CLI's **own** persistence must also be off, configured
  before the process starts: session persistence, rollout and history files, debug logs and
  telemetry spools. Claude Code has a separate session-persistence switch
  ([CLI reference](https://code.claude.com/docs/en/cli-reference)); Codex has an `ephemeral` mode
  ([exec source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)). An isolated
  home or a read-only mode does not imply either.
  - **Per-decision wipe:** after every decision (success, deny, crash, timeout or cancel), the
    runner deletes everything in the dedicated config home except the authentication material,
    then restores the minimal config from a template held by Node Core.
  - **Fail closed:** if the pinned CLI version cannot disable its own persistence, the profile
    check fails and the approver is **unavailable**, so every request is denied.
  - **Canary verification:** at mission start, and after any CLI version change, the runner runs
    one decision on a synthetic canary record. It then searches **every** location the profile
    controls (config home, working directory, the CLI's temp dirs and `%LOCALAPPDATA%`
    subfolders named in the finding doc) **by canary content, not by filename**. Any hit fails
    the profile.
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

Reads in the operator tier return `{ request_id, state: "pending" }` instead of data (gate table).

### Capability ids (R2-D3)

The registry builds capability ids as `<manifest.id>.<actionId>`. The AS adapter's id is
`desktop_uia`, distinct from spec AR's `desktop` adapter, so the ids never collide. This table is
the single mapping. Envelopes, policy, receipts, approval bindings and records all use the
**registered capability id**, with no alias.

| MCP tool | Node route | Registered capability id |
|---|---|---|
| `mission_enroll`, `mission_status` | `/agent/mission/enroll`, `/agent/mission/status` | none: mission routes, not capabilities |
| `desktop_state` | `/agent/desktop/state` | `desktop.state` (spec AR) |
| `desktop_request_app` | `/agent/desktop/request_app` | `desktop_uia.admit_app` |
| `desktop_list_windows` | `/agent/desktop/list_windows` | `desktop_uia.list_windows` |
| `desktop_find` | `/agent/desktop/find` | `desktop_uia.find` |
| `desktop_inspect_tree` | `/agent/desktop/inspect_tree` | `desktop_uia.inspect_tree` |
| `desktop_invoke` | `/agent/desktop/invoke` | `desktop_uia.invoke` |
| `desktop_set_value` | `/agent/desktop/set_value` | `desktop_uia.set_value` |
| `desktop_select` | `/agent/desktop/select` | `desktop_uia.select` |
| `desktop_await` | `/agent/desktop/await` | none: a read of request state |

**Execution trigger.** Once a request is approved, **Node Core executes it** through the ordinary
action pipeline, the same mechanism AC uses for replay but without requiring `hermes_start`.
Execution is not tied to any waiter. `desktop_await` is an idempotent read: calling it twice
never executes twice, and a disconnect neither cancels nor executes anything. Only the
invalidation causes in "Request lifecycle" cancel a request.

**Interoperability checks** (AS4 acceptance): real Claude Code and real Codex each connect,
negotiate, list tools and complete one call, at pinned versions.

## Real-time log in the cockpit

Decision 8: a log, live, with timestamps. The cockpit **Desktop control** view:

- **A header per live mission:** objective, driver → approver, mode, scope, expiry countdown,
  budget left, and state. Buttons: **Revoke**, **Hold**, **Resume** (when held), and **Reset
  enrollment**.
- **A stream, newest first:** millisecond UTC timestamps rendered in local time. Each line shows
  the request id, stage (`received`, `rejected`, `classified`, `decided`, `dispatched`, `issued`,
  `executed`, `outcome_uncertain`, `invalidated`), the actor, the tier, the target summary, and the typed value
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
- `desktop.request_received`, `desktop.request_rejected`, `desktop.request_classified`,
  `desktop.request_dispatched`, `desktop.request_issued`, `desktop.request_invalidated`;
- `desktop.app_granted`, `desktop.app_denied`;
- `desktop.outcome_uncertain`.

Action-level decisions continue to use `approval.requested`/`approval.resolved` (payload gains
`decided_by: operator | agent:claude | agent:codex`, `tier`, `record_digest`, and the
pattern-set version, all JSON, no structural change) and `action.*`.

**Error mapping** (R2-D6). Every ordinary policy and pipeline code keeps its meaning and its
precedence (spec D decision order, spec AC). That includes `E_JOB_TERMINAL`,
`E_ENVELOPE_DIGEST_MISMATCH`, `E_RETRIES_EXHAUSTED`, `E_WORKSPACE_DENIED`, `E_PARALLEL_ACTION` and
the rest. AS requests pass through the ordinary pipeline, and policy runs first. The table below
covers **only the AS-specific preconditions** Node Core checks in addition. No AS condition may be
reported with a code outside this table or the ordinary set.

| AS-specific condition | Code |
|---|---|
| no live mission, caller not enrolled, out of mission scope, native interface catalogued | `E_CAP_NOT_ALLOWED` |
| absolute tier | `E_FORBIDDEN` |
| operator-tier decision pending | `E_APPROVAL_REQUIRED` |
| approver or operator said no; mission held after a denial | **`E_APPROVAL_DENIED` (new, A7)** |
| record no longer matches (continuity, commitment, process, tier); stale generation; **expired approval** | `E_APPROVAL_INVALID` (as in AC and `ApprovalVerifier`) |
| secret pattern or known credential in any input | `E_SECRET_DETECTED` (doc widened by A7) |
| **mission** expired (job expiry is the ordinary `E_EXPIRED` path) | `E_EXPIRED` |
| mission budget exhausted | `E_BUDGET_EXHAUSTED` |
| oversized or malformed AS input | `E_SCHEMA` |
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
resolution or fail; no runtime ids **as selectors** (AS holds live element objects in a worker,
never runtime ids, and never persists either); the PowerShell parameter-file mechanism and BOM stripping; the bans on `send_keys`,
coordinates, screenshots and scripts; native-API preference; never terminating an application
Toros did not start.

**AS adapter API (Node-internal, not in contracts):**

```ts
// Every request, gated or not, is turned into a record first; ungated delegate reads simply
// skip the approval step. The worker derives its whole call from the record (R2-D1).
export interface UiaWorkerRequest {
  readonly record: ApprovalRecord;          // discriminated: admission | read | mutation
  readonly timeout_ms: number;
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

1. Spec AR's adversarial security review (PR mbulentcakar/Toros#3, verdict *do not enable*) is
   remediated. Slices **F1–F4** of `docs/reviews/AR-remediation-plan.md` are merged, and a native
   re-review of the AR surface has cleared them. AS's classification and read rules assume F2 (no
   generic UIA names from discovery) and F3 (resolved identity visible to policy, OS session
   verified, handles bound to job and caller).
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
| AS1 | missions, enrollment, generations, execution lock and go token, budgets, hold, restart reconciliation, job supervisor, identity registry, operator routes, events | `packages/node-core/src/**` + tests |
| AS2 | classifier with native evidence, delegable class set, native catalog, long-lived continuity worker, record build, commitment and execution check | `packages/adapters-uia/**` |
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
28. Revoke after `issued`: the action completes or lands in `outcome_uncertain`; no retry occurs.
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
37. After a decision ends in success, deny, crash, timeout or cancel, a search **by synthetic
    canary content** of every profile-controlled location finds the prompt nowhere.
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

**Revision 3 (R2 findings)**
49. A fixture field that is genuinely masked (native `ES_PASSWORD`) while its UIA provider reports
    `IsPassword=false` and a non-Edit type → its name is withheld, and `set_value` is refused.
50. An unlabelled text field without a native handle → `set_value` refused for every tier.
51. A signed fixture app hosting its own terminal-like or web control in the same process → actions
    on it are operator-only.
52. A cockpit process started after Node Core is registered on first observation; its content is
    absolute before any classification of it completes.
53. An enrolled MCP server's process and ancestry are absolute targets.
54. A catalogued native-interface app → admission refused with `E_CAP_NOT_ALLOWED`, whether or not
    its adapter is installed.
55. A fixture destroys the target and creates a new one that reuses its runtime id and every
    property → the continuity guard invalidates the record (`E_APPROVAL_INVALID`).
56. Switching between two selection items with the same label → invalidated.
57. A provider refusing event subscription → `E_APPROVAL_INVALID`, detail `no_continuity`.
58. An approved read at depth 1 cannot run at depth 8; the replayed call equals the record exactly.
59. Two different screen strings with the same redaction marker → commitment mismatch, refused.
60. Invalidation while the worker is paused before `ready`, and while it waits for the go token →
    the worker is killed and the pattern is never called.
61. Node Core killed between `issued` and the result → at restart, `outcome_uncertain` with
    `reconciled: true`; nothing is replayed.
62. Node Core killed at each child-start boundary (suspended, assigned, registered) → no child runs
    outside the job; an assignment failure terminates the suspended child.
63. A direct-route request whose value or reason contains a live, an invalidated, or a past
    enrollment nonce → `E_SECRET_DETECTED`; the nonce appears in no event, error or cockpit view.
64. Envelope, registry, receipt and approval binding all carry the exact `desktop_uia.*` id; a
    `desktop.invoke` envelope entry admits nothing.
65. Ordinary pipeline denials (`E_JOB_TERMINAL`, `E_ENVELOPE_DIGEST_MISMATCH`, …) keep their codes
    and precedence for AS requests; an expired approval → `E_APPROVAL_INVALID`, an expired mission
    → `E_EXPIRED`.

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

Revision 3, **chosen by the operator on 2026-10-13**:

- R3-a. For R2-B1, choice **(a) strict**: the approver may approve typing only into a field
  native evidence proves is a plain, non-password edit control. Text fields without native
  evidence are refused for everyone (decision 13), and actions on elements without a native
  handle are operator-only. Delegation is narrower; decision 13 holds without exceptions.
