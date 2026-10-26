# Spec AS — delegated desktop control: mission grants, cross-agent approval, MCP

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

**Status: proposed, revision 6 (2026-10-26). Not accepted.** Revision 6 rebases AS on what the AR
remediation actually shipped: contract amendments **A8** (two-phase resolve) and **A9** (signer
rules need `OriginalFilename`), token-sequence `forbidden` matching (RR-01), and the cleared AR gate
(PR mbulentcakar/Toros#18, 2026-10-24). It also closes a gap the AR native runs exposed: the two
initial profiles, Notepad and Calculator, are **packaged (MSIX) apps** on current Windows 11. An A9
signer rule cannot name Calculator (its image is unsigned) and cannot tell packaged Notepad from a
copy of its image run outside the package, so revision 6 proposes amendment **A10** (packaged-app
identity: family name, origin and package-relative path, all OS-read). Revision 6 round 2 answers
the independent review of revision 6 (Grok, 2026-10-26, findings 9–16).
Each changed section is marked *(rev 6)*. Revision 5 answered the re-review of
revision 4: R4-B4 (an outcome is decided by proof, never by silence), R4-N1 (A7's event list
matches the lifecycle) and R4-N2 (a normative profile schema and deterministic matcher). Revision
4: Revision 4 answers the re-review of
revision 3 (R3-B1, R3-B3, R3-B4, R3-B6, R3-N1–N3): delegation is limited to reviewed surface
profiles (operator decision R4-a), and the lifecycle, spend point, retention check, password veto
and AR gate are corrected. Earlier: revision 2 answered the independent
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

**Reach, stated plainly (R4-a).** The driver may *request* actions in any application. The
**approver** may approve only inside apps, surfaces and controls declared by a **reviewed surface
profile**. Everything else goes to the **operator**, and absolute targets are refused for everyone.
Generic UI Automation cannot prove what an arbitrary control does, or that it is still the same
control, so AS does not pretend that an agent can judge that.

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

Node Core refuses to start unless every `agents.*.token` passes the same `assertPrintableAscii`
check as `token` and `operator_token` (ASCII `0x21–0x7E`; the HTTP parser strips surrounding
whitespace, so `operator_token + " "` would otherwise arrive as `operator_token`), and then
`token`, `operator_token`, and every `agents.*.token` are pairwise distinct and at least 32
characters (extending `core.ts:192-200`; spec AT states the same rule). Each credential is
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
  "app_scope": { "kind": "any_not_denied" } | { "kind": "listed", "images": ["<canonical path>"],
                 "packages": [{ "package_family_name": "…", "package_relative_path": "…" }] },  // rev 6
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
  terms (applied to selector names, typed values and window names, with the token-sequence
  semantics of RR-01: lower-case `[a-z0-9]+` words, consecutive; a zero-word term is refused at
  seal time) *(rev 6)*, and the classifier (B1).
  `any_not_denied` still requires a positive app admission per process. It is never the default
  for a surface the classifier cannot place.
- **Listed images** are canonicalized: final path from the process handle, case-folded, no
  `\\?\` prefix variance. They are revalidated (path **and** SHA-256) at admission and at every
  execution against the live process image. A listed path or hash pins **one build**. *(rev 6)* A
  `listed` scope may instead name an A10 package rule (family name, plus origin and an optional
  `package_relative_path`), which survives Store updates.
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
  elevation; session id; desktop. This is A8's `AppIdentity`; `OriginalFilename` is read
  language-neutrally (A9, R5). *(rev 6)* For a packaged process, also (A10): its **package family
  name** (`GetPackageFamilyName` on the process handle); and, from the registered package found
  by `GetPackageFullName` on the handle and then `PackageManager.FindPackageForUser`, its
  **signature origin** (`SignatureKind`: store, system, enterprise, developer or none), its
  **package version** (`Id.Version`), and its **package-relative image path**. These are A10's
  four fields. The family name alone is not a
  signature binding: its publisher id is a hash of the publisher *subject string*, so a sideloaded
  or developer package signed by any trusted certificate with that subject gets the same family
  name. A10 therefore always pairs it with the origin.
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
3. **Delegate** applies only to an app, surface and control matched by a reviewed surface profile
   (below).
4. **Anything unprofiled** → operator-only.
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
  0. **no positive password indication anywhere** (R3-N1): neither the element nor any ancestor
     reports UIA `IsPassword = true`, native `ES_PASSWORD`, or a nonzero `EM_GETPASSWORDCHAR`.
     **Any** one of these is an unconditional veto. Native evidence can expose a lying provider; it
     never cancels a positive password signal from either source;
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
  Settings app's account pages, and password-manager images listed in config (by any A8/A9/A10
  rule: image hash, signer plus product name plus `OriginalFilename`, path, or package family
  name) *(rev 6)*.
- **Any read that would return an element positively identified as a password** (by UIA, native
  style, or password character): its **existence** only. Its name and value are **never** released,
  not even to an operator-approved read (R3-N1).
- **Everything unprofiled** (precedence rule 4).

Config can **add** to this tier. It cannot remove a built-in entry.

### Surface profiles: the only way to reach delegate (R3-B1, operator decision R4-a)

Revision 3 tried to prove a control's *function* from native evidence about the control itself.
The re-review showed this cannot work: a signed app can build a terminal from genuine `Edit` and
`Button` controls, and nothing in Windows says "this is a terminal". **Function is not
observable through generic UI Automation.** So revision 4 stops inferring it. A function is
**declared in a reviewed profile**, and the approver may approve only what a profile declares.

**A surface profile** is a TypeScript data module under
`packages/adapters-uia/src/profiles/<profile_id>.ts`. It is static data, never fetched or
generated at runtime, and changed only by a reviewed PR.

#### Schema (R4-N2), normative

```ts
type Selector = readonly SelectorStep[];   // Spec V path from the surface root, no coordinates
interface SelectorStep { readonly control_type: string; readonly automation_id: string | null;
                         readonly name: string | null; readonly index: number }

interface SurfaceProfile {
  readonly profile_id: string;               // ^[a-z][a-z0-9_]{1,40}$
  readonly version: number;                  // integer ≥ 1; bumped on any change
  readonly app: SignedApp | PackagedApp;     // (rev 6) exactly one form
  readonly surfaces: readonly SurfaceDef[];
  readonly review: { readonly reviewed_in: string; readonly fixture_test: string };  // PR ref, test path
}

interface SignedApp {                         // a classic, Authenticode-signed image
  readonly kind: 'signed';
  readonly signer: string;                   // Authenticode subject CN, exact
  readonly product: string;                  // version-resource ProductName, exact
  readonly original_filename: string;        // language-neutral OriginalFilename (A9), case-insensitive
  readonly file_version: { readonly min: string; readonly max: string };  // inclusive, dotted quad
}

interface PackagedApp {                       // (rev 6, A10) an MSIX/AppX process
  readonly kind: 'packaged';
  readonly package_family_name: string;      // e.g. Microsoft.WindowsNotepad_8wekyb3d8bbwe, case-insensitive
  readonly package_relative_path: string;    // A10 AppIdentity.package_relative_path, case-insensitive
  // origin is always required to be 'store' or 'system' (matcher, rev 6); not configurable here
  readonly package_version: { readonly min: string; readonly max: string };  // inclusive, dotted quad,
                                             // compared numerically per component with A10 AppIdentity.package_version
}

interface SurfaceDef {
  readonly surface_id: string;               // ^[a-z][a-z0-9_]{1,40}$, unique in the profile
  readonly root: {
    readonly native_class: string;           // top-level window class, exact (GetClassName)
    readonly control_type: string;           // UIA ControlType programmatic name, exact
    readonly automation_id: string | null;   // exact; null = must be empty
  };
  readonly title: TitleRule;
  readonly state_independent: boolean;       // true only if no control's function depends on state
  readonly context: readonly ContextPredicate[];  // must be non-empty unless state_independent
  readonly controls: readonly ControlDef[];
}

type TitleRule =                              // native GetWindowText of the root, never UIA Name
  | { readonly kind: 'any' }
  | { readonly kind: 'equals' | 'prefix'; readonly value: string };

interface ContextPredicate {
  readonly predicate_id: string;
  readonly path: Selector;                   // must resolve to exactly one element
  readonly test:
    | { readonly kind: 'exists' }
    | { readonly kind: 'absent' }            // the path must resolve to nothing
    | { readonly kind: 'enabled'; readonly expect: boolean }
    | { readonly kind: 'selected'; readonly expect: boolean }
    | { readonly kind: 'toggle'; readonly expect: 'on' | 'off' }
    | { readonly kind: 'name_equals'; readonly one_of: readonly string[] };
}

interface ControlDef {
  readonly control_id: string;
  readonly selector: Selector;               // must resolve to exactly one element
  readonly control_type: string;             // exact
  readonly native_class: string;             // exact; a control without a native handle cannot be
                                             // profiled (R5-N1, R3-a): actions on it stay operator-only
  readonly actions: readonly ('invoke' | 'set_value' | 'select')[];  // non-empty
  readonly typing: boolean;                  // true requires native_class in the plain-edit set
  readonly function_category: FunctionCategory;
  readonly function: string;                 // human description, ≤ 120 chars; never parsed
}

type FunctionCategory =                       // closed; anything else fails to load
  | 'enter_text' | 'confirm_local_save' | 'open_local_file_dialog' | 'navigate_view'
  | 'select_item' | 'toggle_option' | 'compute' | 'dismiss_dialog';
```

The forbidden functions have **no category**, so a profile cannot express them:
- command or script execution;
- sending anything off the machine;
- payment;
- credential, account or security changes;
- installation;
- deletion without a recycle step.

Adding a category is a spec change. The **loader** checks the schema, the closed category set,
`typing` against the plain-edit class set, and that no surface's root class or app identity falls
in an operator-only or absolute class. Whether `function` and `function_category` are *true* for
the app is a **human review** claim, proven by the profile's native fixture test, never by an
automatic semantic check.

#### Matcher (R4-N2), deterministic

Evaluated by Node Core. Any step that cannot be read, or resolves ambiguously, is **no match**,
and the request falls to the operator tier.

1. **App** *(rev 6)*, by the profile's form:
   - `signed`: signer equal; product equal; language-neutral `OriginalFilename` equal
     (case-insensitive); file version within `[min, max]`. A process with package identity never
     matches a `signed` profile;
   - `packaged`: the process's package family name (A10, OS-read) equal (case-insensitive); its
     package signature origin `store` or `system`; its `package_relative_path` equal
     (case-insensitive); package version within `[min, max]`. A process without package identity,
     or with any other origin (`developer`, `enterprise`, `none`, or an unreadable one), never
     matches a `packaged` profile.
   - **Signature (rev 6, clarifies R2-b).** A process matched by a `packaged` profile counts as
     *signed by its package*: its origin is `store` or `system`, so Windows verified the package
     signature at install. R2-b's "unsigned apps go to the operator" still holds for every
     unpackaged unsigned image and for every packaged process that matches no profile.
     **Operator confirmation needed:** this reading of R2-b is what lets the Calculator profile
     reach the approver.
2. **Surface root:**
   - the top-level window's native class equal;
   - its UIA control type equal;
   - its automation id equal (`null` means empty);
   - the title rule holds on the native window text.
3. **Context:** every predicate's path resolves to **exactly one** element (except `absent`, which
   requires none), and its test holds.
   - A surface with `state_independent: false` and an empty `context` fails to load.
   - **Paths alone suffice only when `state_independent: true`**, which the review must justify.
4. **Control:**
   - its selector resolves to exactly one element inside the matched root;
   - control type equal;
   - native class equal. An element without a native handle never matches a `ControlDef`, so an
     action on it can **never** reach delegate, even inside a matched surface (R5-N1, R3-a).
   - the requested action is listed.
5. **Re-run at execution:** the whole match runs again; any failure is `E_APPROVAL_INVALID`.

The approval record's `profile` block carries `context_observed`: for each predicate, its id, its
test, and the **sanitized** observation. The approver sees the context in which the declared
function applies, and the raw values are covered by `state_commitment`.

- **Delegate tier = profiled and nothing else.** The approver may decide:
  - app admission, only for an app that matches a profile;
  - delegate reads, only within matched surfaces;
  - an action, only on a matched control listing that action.

  Every other window, surface and control **of any app** is **operator-only**, profiled apps
  included. Absolute rules still win. A custom terminal built from ordinary controls has no
  profile, so it never reaches the approver.
- **What a profile may not declare** (enforced by the closed `FunctionCategory` set above, and
  re-checked in human review). No control may have a function that is:
  - executing commands or scripts;
  - sending a message or payment outside the machine;
  - changing credentials, accounts or security settings;
  - installing software;
  - deleting data without a recycle step.

  Those stay operator-only by construction. A profile also may not cover any operator-only or
  absolute surface (shells, browsers, embedded web, credential surfaces).
- **The approver sees the declared function** (`function`, `surface_id`, `profile_id@version`)
  in the record, next to the observed state. It judges whether that declared function serves the
  mission objective. It is no longer asked to infer function from screen text.
- **Typing (R3-a, R3-N1 kept).** A profile control may set `typing: true` only if it is a native
  plain edit that passes every secret-entry rule. Those rules are checked live at every request,
  and a profile cannot override them.
- **Every profile ships with a native fixture test.** It launches the real app, matches every
  surface and control, and proves that a non-matching look-alike surface is **not** matched. The
  initial profiles are `notepad` and `calculator`, which the acceptance tests use. *(rev 6)* On
  current Windows 11 both are packaged apps (`Microsoft.WindowsNotepad_8wekyb3d8bbwe`,
  `Microsoft.WindowsCalculator_8wekyb3d8bbwe`). Packaged `Notepad.exe` is Authenticode-signed and
  an A9 signer rule can name it, but the same rule also matches a copy of `Notepad.exe` run
  without package identity. `CalculatorApp.exe` carries no Authenticode signature at all, so no A9
  rule can name it. `System32\notepad.exe` is a different, separately signed file. Both initial
  profiles therefore use the `packaged` form, pinned to `package_relative_path`
  `Notepad\Notepad.exe` and `CalculatorApp.exe`, with `package_version` bounds
  `[11.2607.14.0, 11.65535.65535.65535]` and `[11.2607.0.0, 11.65535.65535.65535]` (the versions
  observed 2026-10-26, open within major version 11; a new major version needs a re-reviewed
  profile). Each fixture attaches to the packaged process.
  More profiles are separate reviewed slices, at the operator's request.

**Operator approvals outside profiles.** The operator may still approve any non-absolute action on
an unprofiled surface (decision 6). The approval card states plainly that **for unprofiled
controls Toros can bind only the observed state, not the control's identity or function**
(R3-B3, below). The operator accepts that residual by approving. The approver never sees these.

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
| App admission (`desktop_request_app`) | approver decides, **profiled app only** | operator decides; admits the app **only**, no reads or actions | refused |
| `list_windows` | under grant, no per-call gate | operator, per call | refused |
| `find`, `inspect_tree` | under grant, **inside a matched profile surface**; every returned element is classified (below) | operator, per call | element omitted |
| `invoke`, `set_value`, `select` | approver, per action, **only on a matched profile control listing that action** | operator, per action | refused |

**Per-element filtering on reads.** Every element a read would return is classified. Delegate
elements are returned. Operator-only elements are **quarantined**, returned only as
`{ "quarantined": true, "tier": "operator_only", "control_type": … }` with no name and no
children, until the operator approves that exact bounded read. Absolute elements are omitted
entirely. A subtree read below a harmless root therefore cannot leak a password control's
neighbourhood.

**No read ever returns a control value** (Spec AR's rule, kept). **Names are returned only where
native evidence shows the element is not a password surface** (AR-01, remediation F2). That means
an element with a native handle whose class and style pass the secret-entry checks. Every other
element's name is withheld (`"name": null, "name_withheld": "no_native_evidence"`). The operator
may release such names by approving that exact read, **except** for elements positively
identified as passwords, whose names are never released (R3-N1). The read output is:

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
                 "package_family_name": "…" | null, "package_signature_kind": "store" | … | null,
                 "package_relative_path": "…" | null,
                 "windows": [ { "native_class": "…", "name": "…" } ] } }

// kind = "read": the complete normalized input and its effective bounds
{ "grant_id": "…", "process": { "pid": 4242, "created_at": "…", "image_sha256": "…" },
  "action": "list_windows" | "find" | "inspect_tree",
  "input": { /* normalized: root selector, depth, filters */ },
  "bounds": { "max_depth": 4, "max_elements": 200, "max_name_chars": 256 } }

// kind = "mutation"
{ "grant_id": "…", "process": { … },
  "profile": { "profile_id": "notepad", "version": 1, "surface_id": "save_dialog",
               "control_id": "save", "function_category": "confirm_local_save",
               "function": "Confirm Save",
               "context_observed": [ { "predicate_id": "…", "test": { … }, "observed": "…sanitized…" } ]
             } | null,   // null = unprofiled, operator tier

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

### Element continuity (R2-B3, R3-B3)

Revision 3 relied on UIA events to prove a control was not replaced. The re-review is right that
this proves nothing. Providers need not raise every event
([UIA events for clients](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-events-for-clients)),
and window handles are recycled ([IsWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindow)).
**Generic UI Automation cannot prove that a control is the same object over time.** Revision 4
stops claiming it and changes what an approval binds to.

- **On a profiled control (delegate tier), an approval binds to a declared function in an
  observed context, not to an object instance.** The profile declares that, within a matched
  surface, the control at that selector performs that function. The record commits to:
  - the profile id and version;
  - the surface's `context` paths;
  - the control's selector;
  - the keyed `state_commitment` (R2-D2) over the raw state of the control, its ancestors and
    every context path.

  At execution the worker re-resolves the selector inside a re-matched surface and recomputes
  the commitment. If the profile still matches and the commitment is equal, then an
  indistinguishable replacement, or a change-and-return, is **by the profile's reviewed claim the
  same function in the same context**. Clicking it is the approved action, so instance identity
  is not required. If anything differs, the request is `E_APPROVAL_INVALID`.
- **Events are an early invalidation signal only.** The worker still holds the live element and
  subscribes, as in revision 3, and any received removal or property change invalidates at once.
  But **the absence of an event is never treated as evidence**. Correctness rests on re-matching
  and the commitment, never on a missing callback.
- **Native handles** are checked only as additional mismatch evidence: the same class, owning
  thread and process, and `IsWindow`. A match is never treated as proof of identity.
- **On an unprofiled control (operator tier only)**, the same re-resolution, commitment and
  event checks run, but no function claim exists. The binding is therefore **observed state
  only**. The operator's approval card says so, and test 66 pins that this wording appears.
- **Selection** is bound by the selected items' committed state (label, index, automation id,
  and their context paths), with live objects held for early invalidation only.

**What AS does not promise.** A window of milliseconds remains between the final check and the
pattern call. State outside the profile's `context` paths, or outside the observed snapshot for
unprofiled controls, is not covered. A profile whose declared function is wrong is a profile
defect, and is caught by its review and its native fixture test, not at runtime.

## Request lifecycle and invalidation (B4, R2-B4, R3-B4, R3-N2)

```text
received → validated → classified → awaiting_decision → approved → replayed → policy_allowed
  → worker_ready → authorized → [pattern call] → reported → executed | outcome_uncertain | outcome_unknown
```

The states, kept distinct as R3-B4 asks:

- **`authorized`** is a durable **permission**: Node Core has granted this one record, at this
  generation, a go token. It is **not** a claim that any call happened.
- **The pattern call** is the only irreversible point. Nothing records it in advance.
- **`reported`** means the worker sent `called` (immediately after the pattern returned or threw)
  and then its result. Silence is never a report: a missing report after `authorized` is
  `outcome_unknown` (R4-B4).

Anything before the pattern call can be cancelled with no effect.

### The single spend point (R3-N2)

There is exactly **one** call to `ApprovalVerifier.consume`: **policy rule 12 in the ordinary
pipeline**, when Node Core replays the approved record (spec AC). The normative sequence:

1. **Request:** build the record → ordinary policy runs → `E_APPROVAL_REQUIRED` creates the
   pending approval (existing behaviour).
2. **Decision:** the approver or operator decides. An approve marks the approval granted.
3. **Replay:** Node Core replays the record through the ordinary pipeline. Policy rules 1–11
   re-run, and rule 12 **consumes** the approval (the single spend). This is the full ordinary
   recheck after the wait, so nothing is skipped. A denial here ends the request with the
   ordinary code.
4. **Adapter:** the pipeline invokes the AS adapter with the record. The adapter starts or uses
   the grant's worker. The worker re-matches and recomputes the commitment, then reports
   `worker_ready`.
5. **Final mission gate:** the adapter calls a Node-provided **mission gate**. This is AS-specific,
   not policy: it neither reads nor caches a policy decision, so 00-CONTRACTS §7 holds. Under the
   per-desktop lock, the gate checks:
   - caller and enrollment;
   - mission state and generation;
   - effective expiry;
   - job state;
   - grant and process;
   - tier, reclassified.

   It **does not consume anything**. If the checks pass, it appends `authorized` and returns a go
   token:
   - bound to the record digest and the generation;
   - single-use;
   - with a deadline of `min(now + 250 ms, effective expiry)`.
6. **Worker:** on receiving the token, the worker checks its deadline and generation, re-runs the
   commitment check, then makes the pattern call and reports.

A failure at step 4 or 5 happens **after** the spend, so the approval stays spent. The request
ends `invalidated`, and a retry needs a new request and a new decision. That is deliberate: an
approval is never reusable.

### Invalidation

**Causes:**
- operator revoke, Hold or Stop all;
- mission or job expiry;
- the job reaching a terminal state;
- the automatic holds: a delegate denial, `outcome_uncertain` or `outcome_unknown`;
- enrollment reset;
- session lock or disconnect;
- audit-write failure;
- Node Core restart.

**Each one** bumps the generation, voids every grant, and does the following under the
per-desktop lock:
- requests not yet `authorized` → `invalidated`, worker killed;
- `authorized` but not yet `reported` → Node Core sends the worker **abort** and waits up to
  100 ms for a reply, then kills the worker. The outcome is decided by **proof, never by silence**
  (R4-B4):
  - **`invalidated`** only if the worker replies `aborted_before_call`. The worker sends this
    only from its final pre-call check, which reads the abort flag immediately before the pattern
    call. Sending it and calling the pattern are mutually exclusive in the worker's code.
  - **`outcome_uncertain`** if the worker reported `called`, or replied `call_in_progress`.
  - **`outcome_unknown`** in every other case: no reply, the worker was killed, it crashed, or a
    report was lost.

  `outcome_uncertain` and `outcome_unknown` both **hold** a still-live mission, are never retried,
  and are recorded with that exact outcome even when the mission has already ended.

A late verdict for an old generation is recorded and inert.

### Restart reconciliation

At start, every request whose last durable event is `authorized` without `reported` is recorded
as **`outcome_unknown`** (reconciled): the call may or may not have happened. Toros neither claims
the call occurred nor retries it. Requests that never reached `authorized` are recorded
`invalidated` (cause `restart`).

### Stated residuals (R3-B4)

- **Final check to pattern call:** microseconds to milliseconds in which a change cannot be
  detected.
- **Core death:** after Node Core sends a go token and dies, the worker can still use that token
  until its deadline (≤ 250 ms) or until it notices the death, whichever is first. Workers watch
  their stdin pipe from Node Core and abort the moment it closes. The supervisor kills the job
  within milliseconds of Core's death. A call in that gap is reconciled as `outcome_unknown`.

### Other rules

- **Audit-write ordering:** `received`, `decided`, `policy_allowed` and `authorized` are durable
  before the step they permit. A failed append before `authorized` refuses the request; a failed
  append after it ends every mission on the node.
- **MCP disconnect never cancels** a request; only the invalidation causes above do.
- **Locked or disconnected session:** an invalidation like the others. The mission survives, and
  new grants are needed after unlock.

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
  pass. A worker that already holds an unexpired go token could use it in that gap. This is the
  "Core death" residual in the lifecycle section, reconciled as `outcome_unknown`. Workers also
  abort when their stdin pipe from Node Core closes.
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
  - **Inspect before cleanup** (R3-B6). After the CLI process has exited (or been killed), and
    **before** anything is deleted, the runner lists every profile-controlled location. Any file
    other than the authentication material and the template config is a retention violation. On
    canary runs, the runner also searches those locations by canary content. **A violation marks
    the profile failed and the approver unavailable**, so every request is denied until the
    operator re-verifies.
  - **Per-decision wipe, after inspection, always:** after every decision (success, deny, crash,
    timeout or cancel) and after inspection, whatever its result, the runner deletes everything in
    the dedicated config home except the authentication material and restores the minimal config
    from a template held by Node Core. Cleanup is recovery, never evidence.
  - **Fail closed:** if the pinned CLI version cannot disable its own persistence, the profile
    check fails and the approver is **unavailable**, so every request is denied.
  - **Canary verification:** at mission start, and after any CLI version change, the runner runs
    one decision on a synthetic canary record. It then searches **every** location the profile
    controls (config home, working directory, the CLI's temp dirs and `%LOCALAPPDATA%`
    subfolders named in the finding doc) **by canary content, not by filename, before the wipe**.
    Any hit fails the profile.
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

A local stdio MCP server with zero runtime dependencies. *(rev 6)* It is spec AT's
`packages/mcp-discovery` (PR mbulentcakar/Toros#20), extended by AS4 with the tools below.
It is not a second server. AT owns the agent bearers, the reserved `agent:` actor prefix,
`/agent/status`, `/agent/invoke`, `desktop_control.ar_gate_cleared` and the `desktop_state` tool.
AS adds only `/agent/mission/*` and `/agent/desktop/*`. How a mission affects AT's
`/agent/invoke` is stated once, in "The mission hook" below.

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
| `desktop_state` | `/agent/invoke` (spec AT) | `desktop.state` (spec AR) |
| `desktop_request_app` | `/agent/desktop/request_app` | `desktop_uia.admit_app` |
| `desktop_list_windows` | `/agent/desktop/list_windows` | `desktop_uia.list_windows` |
| `desktop_find` | `/agent/desktop/find` | `desktop_uia.find` |
| `desktop_inspect_tree` | `/agent/desktop/inspect_tree` | `desktop_uia.inspect_tree` |
| `desktop_invoke` | `/agent/desktop/invoke` | `desktop_uia.invoke` |
| `desktop_set_value` | `/agent/desktop/set_value` | `desktop_uia.set_value` |
| `desktop_select` | `/agent/desktop/select` | `desktop_uia.select` |
| `desktop_await` | `/agent/desktop/await` | none: a read of request state |

**The mission hook in AT's `/agent/invoke` (rev 6, AS1).** When the granted job has an AS mission,
`desktop.*` on AT's `/agent/invoke` is decided by the mission as well. This paragraph is the only
statement of that rule; AT points here. The checks apply in this order:

1. the mission is held after a denial: `E_APPROVAL_DENIED`;
2. it has ended with reason `expired`: `E_EXPIRED`;
3. it has ended with reason `budget`: `E_BUDGET_EXHAUSTED`;
4. it has ended for any other reason, or is not yet enrolled: `E_CAP_NOT_ALLOWED`;
5. it is live: the call runs, and a window is returned only if it matches the job's
   `allowed_apps` (as today) **and**, when the mission's `app_scope` is `listed`, one listed
   image (canonical path and SHA-256) or one listed package rule (A10). `any_not_denied` adds no
   further filter on this read; the classifier still applies to AS's own routes.

`machine.inventory` is not affected. Without a mission, AT's own rules apply unchanged.

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
  the request id, stage (`received`, `rejected`, `classified`, `decided`, `policy_allowed`, `authorized`,
  `reported`, `executed`, `outcome_uncertain`, `outcome_unknown`, `invalidated`), the actor, the tier, the target summary, and the typed value
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
  `desktop.request_authorized`, `desktop.request_reported`, `desktop.request_invalidated`;
- `desktop.app_granted`, `desktop.app_denied`;
- `desktop.outcome_uncertain`, `desktop.outcome_unknown`.

**Lifecycle stage → event kind** (R4-N1). `received`, `rejected` and `classified` →
`desktop.request_received`, `desktop.request_rejected` and `desktop.request_classified`.
`replayed` and `policy_allowed` → the existing `action.requested` and `action.decided`, so no new
kind is added for them. `authorized`, `reported` and `invalidated` →
`desktop.request_authorized`, `desktop.request_reported` and `desktop.request_invalidated`.
`executed` → the existing `action.finished`. `outcome_uncertain` and `outcome_unknown` →
`desktop.outcome_uncertain` and `desktop.outcome_unknown`. The final A7 list in `00-CONTRACTS.md`
§10 is exactly the kinds named here. AS0 is checked by a test that every literal kind AS uses is in
the amended union.

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

- **Claude Code:** tools limited to `mcp__toros-discovery__*` (spec AT's server name), with a deny rule for the Toros config
  directory;
- **Codex:** a read-only sandbox, no network, and `toros-discovery` (spec AT's server, `packages/mcp-discovery`) as its only tool server.

`docs/USING.md` gets the exact launch lines. `tools/orient.mjs` **warns** when it can tell a driver
was launched otherwise. A separate Windows account for Node Core is a Phase 2 candidate; AS does
not claim it.

## Prerequisites before `act` is enabled

1. *(rev 6: met 2026-10-24.)* Spec AR's adversarial security review (PR mbulentcakar/Toros#3, verdict *do not enable*) is
   remediated. Slices **F1–F4** of `docs/reviews/AR-remediation-plan.md` are merged, and a native
   re-review of the AR surface has cleared them. *(rev 6)* Met: F1–F5, RR R1–R4 and R5 (FR-01) are
   merged, and the gate addendum of PR mbulentcakar/Toros#18 cleared the AR gate on 2026-10-24. AS's classification and read rules assume F2 (no
   generic UIA names from discovery) and F3 (resolved identity visible to policy, OS session
   verified, handles bound to job and caller).
2. Spec AG is accepted, with a versioned pattern set.
3. Contract amendment A7 is made, with every consumer in the same diff.
4. The approver profile is verified on the node for the pinned CLI and model
   (`docs/finding-approver-profile.md`).
5. Independent code review, independent MCP review (workspace invariant 3), and a third-lineage
   adversarial review of the implementation.

Prerequisite 1 gates **every** mode (R3-N3). `look` missions use AR's `desktop.state` and the
same read path, so neither `look` nor `act` routes are mounted until the AR gate clears. A Node
Core configuration flag (`desktop_control.ar_gate_cleared`; *(rev 6)* introduced by spec AT, or by AS1 if AT has not shipped, and absent
from Node Core today, default unset), set by the operator only after the
native re-review, controls mounting. `look` may then ship once 2–4 and the code and MCP reviews
in 5 are done. `act` needs all five, plus at least one reviewed surface profile for delegation.

## Delivery slices

| Slice | Content | Allowed paths (finalized at dispatch) |
|---|---|---|
| AS0 | contract amendments A7 and A10 (architect only, all consumers in one diff) *(rev 6)* | `packages/contracts/**`, affected consumers, `docs/specs/00-CONTRACTS.md` |
| AS1 | missions, enrollment, generations, execution lock and go token, budgets, hold, restart reconciliation, job supervisor, identity registry, operator routes, events, and *(rev 6)* the mission hook in spec AT's `/agent/invoke` (below) | `packages/node-core/src/**` + tests |
| AS2 | classifier with native evidence, surface-profile matcher, native catalog, per-grant worker, record build, commitment, mission-gate handshake and execution check | `packages/adapters-uia/**` (except `src/profiles/**`) |
| AS2p | the initial surface profiles `notepad` and `calculator`, each with its native fixture test; later profiles are one reviewed slice each | `packages/adapters-uia/src/profiles/**`, `packages/adapters-uia/test/profiles/**` |
| AS3 | approver runner and profile; profile finding doc | `packages/adapters-cli/src/approver*.ts` + tests, `docs/finding-approver-profile.md` |
| AS4 | extend spec AT's `packages/mcp-discovery` with the AS tools *(rev 6)* | `packages/mcp-discovery/**` |
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
13. *(rev 6)* An unsigned image without package identity → operator-only; a packaged process whose
    family name matches no profile, or whose origin is `developer`, `enterprise` or `none` →
    operator-only; packaged Calculator (origin `store`) matched by the `calculator` profile →
    delegate; a developer-signed package carrying Calculator's family name → operator-only.
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
28. Revoke after `authorized`: the worker is aborted; it ends `invalidated` if it had not called, `outcome_uncertain` if it reports `called`; no retry occurs.
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
55. *(Superseded by 70, revision 4.)* A destroyed-and-recreated target with identical state is
    governed by the profile rule. A received removal event still invalidates at once.
56. Switching between two selection items with the same label → invalidated.
57. A provider refusing event subscription → no early invalidation is available; correctness still
    rests on re-matching and the commitment, and the record notes `events: unavailable`.
58. An approved read at depth 1 cannot run at depth 8; the replayed call equals the record exactly.
59. Two different screen strings with the same redaction marker → commitment mismatch, refused.
60. Invalidation while the worker is paused before `ready`, and while it waits for the go token →
    the worker is killed and the pattern is never called.
61. Node Core killed after `authorized` and before `reported` → at restart, `outcome_unknown` with
    `reconciled: true`; Toros does not claim the call happened and replays nothing.
62. Node Core killed at each child-start boundary (suspended, assigned, registered) → no child runs
    outside the job; an assignment failure terminates the suspended child.
63. A direct-route request whose value or reason contains a live, an invalidated, or a past
    enrollment nonce → `E_SECRET_DETECTED`; the nonce appears in no event, error or cockpit view.
64. Envelope, registry, receipt and approval binding all carry the exact `desktop_uia.*` id; a
    `desktop.invoke` envelope entry admits nothing.
65. Ordinary pipeline denials (`E_JOB_TERMINAL`, `E_ENVELOPE_DIGEST_MISMATCH`, …) keep their codes
    and precedence for AS requests; an expired approval → `E_APPROVAL_INVALID`, an expired mission
    → `E_EXPIRED`.

**Revision 4 (R3 findings, profiles)**
66. An operator-approval card for an unprofiled control states that only observed state, not
    identity or function, is bound.
67. A same-process "terminal" fixture built from genuine `Edit`, `Button` and `Static` controls in
    a signed app → no profile matches; admission and actions go to the operator, never the
    approver.
68. A look-alike surface (same classes, a different context path) does not match a profile.
69. A profile declaring a forbidden function (command execution, external send, credential
    change) fails the profile review test and is not loaded.
70. A provider that accepts subscriptions but suppresses or delays events, with the control
    replaced by an identical one → on a profiled control the action proceeds as the declared
    function (commitment equal); on an unprofiled control it proceeds only under operator
    approval with the residual stated. A stale retained object is never used without re-matching.
71. Same-thread native-handle reuse with different state → commitment mismatch, refused.
72. Pauses after `authorized` is appended, after the token is sent, after it is received, and
    immediately before the pattern call, each combined with revoke, expiry and Core death → no
    call after an abort is delivered; Core death → `outcome_unknown` at restart; the token's
    deadline never exceeds effective expiry.
73. Exactly one `consume` per executed action: a duplicate token, a replay after execution and an
    invalidation between replay and the gate each fail, and the approval is never spent twice.
74. A native-plain edit whose provider reports `IsPassword = true`, or that has a password
    ancestor → `set_value` refused.
75. An operator-approved read never releases the name of a positively identified password element.
76. A fake CLI that writes a transcript, then exits, crashes, times out or is cancelled → the
    pre-wipe inspection fails the profile, even though the wipe leaves no file afterwards.
77. With `desktop_control.ar_gate_cleared` unset, neither `look` nor `act` desktop routes are
    mounted.

**Revision 5 (R4 findings)**
78. A worker paused after the pattern's observable effect but before it returns or reports, then
    revoked or killed → `outcome_unknown` (or `outcome_uncertain` on a `call_in_progress` reply),
    and the mission is held; never `invalidated`.
79. A worker that receives the abort flag before its final pre-call check → replies
    `aborted_before_call`, never calls the pattern → `invalidated`.
80. Every lifecycle stage emits exactly the event kind in the stage→event table; AS0's
    union-inventory test fails if any AS literal kind is missing from A7.
81. Same root class, automation id and context paths but a failing state predicate (for example a
    different `name_equals` or toggle state) → no profile match → operator tier.
82. A profile with an unknown title-rule kind, an unknown function category, `typing: true` on a
    non-plain-edit class, or `state_independent: false` with an empty context → fails to load.
83. A context path or control selector resolving to two elements → no match.
84. The approver prompt includes `context_observed` for a profiled request.
85. A profile whose `ControlDef` omits or nulls `native_class` fails to load. A no-handle
    `invoke` or `select` inside a matched surface routes to the operator, never the approver.

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

Revision 4, **chosen by the operator on 2026-10-14**:

- R4-a. **The approver approves only inside reviewed surface profiles.** Generic UI Automation
  cannot prove a control's function or its identity over time (R3-B1, R3-B3). So delegation is
  limited to apps, surfaces and controls that a reviewed profile declares. Everything
  unprofiled goes to the operator, who may approve it with the observed-state-only residual
  stated on the approval card.
