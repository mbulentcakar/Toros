# Spec V — `@toros/adapters-uia`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

**Status update (2026-10-13): the target-binding model below — one adapter instance per
operator-configured application — is superseded by spec AS (mission grants with cross-agent
approval). The six actions, selector rules, bans, automation mechanism, and acceptance tests
remain in force and are inherited by AS.**

**Status: proposed. Not accepted, and out of Phase 1 scope.** SPEC §10 Phase 1 says *exactly
one* operator-selected desktop adapter, and that is Excel (spec F). This unit cannot be built
until SPEC is amended to admit it. This document is the proposal that amendment would ratify,
written now because the decisions below are cheaper to take before receipts exist than after.

## Objective

Let Hermes drive Windows desktop applications through the **UI Automation** accessibility API,
under a per-application capability boundary that policy can still decide about.

This sits at **tier 4** of the §4.3 preference order — OS accessibility — above keyboard macros
and screenshot/computer-use, below native APIs and application scripting. That position is a
requirement, not a default: **an application with a real automation interface must get its own
adapter instead.** Excel has COM and therefore has spec F; routing Excel through UIA would be a
defect, not a shortcut.

## The problem this unit has to solve

Every other capability in Toros is bounded in *extension*. `excel.read_range` can only ever read
a range: the set of things it can do is finite and knowable before it runs, which is what gives
the policy engine something to decide.

A UIA action is not like that. `invoke` means "activate the control I name," and the set of
controls is whatever happens to be on screen. Left unbounded it is the generic click tool §6 says
does not exist, and Node Core would still be the authority — over a decision with no content.

So the unit's real deliverable is not the automation. It is the boundary that keeps the
automation decidable.

## The boundary: one adapter instance per application

**Do not build a single `uia` adapter with an `app` parameter.** That makes the target an
argument, and arguments are chosen by the coordinator.

Instead, instantiate the adapter once per application the operator has configured, taking the
application's identity from the *adapter id*:

```jsonc
// %LOCALAPPDATA%\Toros\config.json
"adapters": {
  "uia_notepad":  { "executable": "C:\\Windows\\System32\\notepad.exe" },
  "uia_outlook":  { "executable": "C:\\Program Files\\...\\OUTLOOK.EXE",
                    "deny_elements": ["Send", "Delete", "Empty Folder"] }
}
```

Capability ids then come out as `uia_notepad.invoke`, `uia_outlook.inspect_tree`, and the
existing allowlist does the rest: an envelope that lists `uia_notepad.*` cannot touch Outlook,
`list_capabilities` shows the operator exactly which applications a job may drive, and
`E_CAP_NOT_ALLOWED` is returned by machinery that already exists and is already tested.

**This requires no contract change.** `capabilityId` already permits underscores
(`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`), and `packages/contracts` stays frozen per 00-CONTRACTS
§1. The alternative — adding an `allowed_surfaces` field to `JobEnvelope` — is a real contract
amendment, and buys only per-job surfaces where per-install plus per-envelope already gives a
bound. Prefer the version that changes nothing.

## Allowed paths

```
packages/adapters-uia/package.json
packages/adapters-uia/tsconfig.json
packages/adapters-uia/src/**
packages/adapters-uia/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts` only. No UIA wrapper package, no `robotjs`, no `nut.js` —
00-CONTRACTS §3 permits no runtime dependency here.

## Automation approach

Drive UIA from **PowerShell against `System.Windows.Automation`**, using the same
parameter-file discipline spec F established for Excel:

- write the action's parameters to a **JSON file** in the session directory;
- run a *fixed, parameter-free* script that reads it with `ConvertFrom-Json`;
- invoke via `execFile` with `shell: false`, `-NoProfile -NonInteractive -File`;
- **strip the leading UTF-8 BOM at every read site** — see spec F's closing section, the trap is
  identical here and costs a day if rediscovered.

Never interpolate an element name or automation id into script source. Names come from
application *content*, and content is not trusted (see "Selectors are content" below).

## Public API — frozen

```ts
import type { Adapter } from '@toros/contracts';

export interface UiaAdapterOptions {
  /** Adapter id, e.g. `uia_notepad`. Must match the config key. */
  readonly id: string;
  /** Absolute path to the application executable, verified at init. */
  readonly executable: string;
  /** Element names or automation ids this instance refuses to invoke, ever. */
  readonly deny_elements: readonly string[];
  /** Wall-clock ceiling per action, milliseconds. */
  readonly timeout_ms: number;
  /** Maximum elements one inspect_tree or find may return. */
  readonly max_elements: number;
}

export function createUiaAdapter(options: UiaAdapterOptions): Adapter;
```

`platforms: ['win32']`, `required_permissions: ['process.spawn', 'app.automation']`,
`cancellation: 'kill'`.

`receipt_fields`: `process_id`, `window_title`, `control_type`, `automation_id`, `element_path`,
`pattern`, `elements_returned`, `truncated`.

## The six actions

| Action | Input | `mutates` | Behaviour |
|---|---|---|---|
| `list_windows` | `{}` | false | Top-level windows belonging to the bound process only. |
| `inspect_tree` | `{ root?, depth }` | false | Element subtree: control type, name, automation id, enabled, bounding rect. |
| `find` | `{ automation_id?, name?, control_type? }` | false | Matching elements as addressable paths. |
| `invoke` | `{ element }` | true | InvokePattern — press a button, activate a menu item. |
| `set_value` | `{ element, value }` | true | ValuePattern — type into a field without keystrokes. |
| `select` | `{ element }` | true | SelectionItemPattern — choose a list or tab item. |

**Not in this adapter, and not to be added:** `send_keys`, `click_at(x, y)`, `screenshot`,
`run_script`, or any action taking a coordinate pair. Each is an escape hatch that would make the
other six decorative — the same reason spec F has no "run macro". A task that seems to need one
is a task this adapter should refuse, and that refusal is the finding.

`always_requires_approval` is `false` on all six. Gating every invoke would produce click-through
fatigue, which spec F already identified as a real failure mode, and the per-application boundary
plus `deny_elements` is the bound that does the work. An operator who wants a gate adds
`uia_outlook.invoke` to `approval_required` in config; the machinery is already there.

## Addressing an element

Selectors are **paths from the window root**, not runtime ids and never coordinates:

```jsonc
{ "element": [
  { "control_type": "Window", "automation_id": null, "name": "Inbox", "index": 0 },
  { "control_type": "ToolBar", "automation_id": "MainToolbar", "index": 0 },
  { "control_type": "Button",  "automation_id": "ReplyButton", "index": 0 }
] }
```

Rules:

- **Runtime ids are forbidden.** They do not survive a restart, so a receipt containing one is
  not replayable — and replayability is the point of §8.3.
- **Coordinates are forbidden.** A bounding rect may be *returned* by `inspect_tree` for the
  operator's benefit; it may never be *accepted* as a way to name a target.
- `automation_id` is preferred; `name` is a fallback; `index` disambiguates siblings.
- Resolve the whole path or fail. A partial match is `E_ADAPTER_FAILURE`, never a nearest guess —
  clicking approximately the right button is worse than clicking nothing.

### Selectors are content, and content is not trusted

An element's `name` is frequently application *content*: an email subject, a document title, a
row of data. That means a hostile document can contain a string chosen to match a selector, and
a job that addresses elements by name can be steered by the data it is reading.

Consequences, all enforced by the adapter:

1. **Bind to the process, not the title.** At `start`, resolve the target process and store its
   pid. Every subsequent action operates only on windows owned by that pid. Never re-resolve the
   target by window title — a title is content and can be spoofed.
2. **`deny_elements` matches on name *and* automation id**, case-insensitively, and is checked
   after resolution against the resolved element's real properties. Refuse with
   `E_CAP_NOT_ALLOWED`.
3. **The envelope's `forbidden` terms apply to selector names**, exactly as they apply to other
   arguments. `forbidden: ["send"]` must stop `invoke` on a control named "Send".

## Sessions

This is a `SessionAdapter`. `start` launches or attaches to the application and records the pid;
`stop` closes the session and does **not** kill an application the operator started themselves —
track whether Toros launched it, and only terminate what Toros owns. Killing an operator's live
Outlook to end a job would lose their unsent mail, which is the desktop equivalent of the
`EXCEL.EXE` rule in spec F.

A locked workstation makes UIA fail; report it as `E_ADAPTER_FAILURE` with a message naming the
lock, because the alternative is a timeout that reads like a hang.

## Acceptance tests

`packages/adapters-uia/test/`. Use **Notepad and Calculator** as the fixtures — benign, present
on every Windows install, and cheap to assert against. A missing executable **fails the run**; it
does not skip (00-CONTRACTS §6).

1. `init refuses when the executable does not exist`
2. `manifest exposes exactly six actions`
3. `list_windows returns only windows of the bound process`
4. `list_windows does not return a window of another process with the same title`
5. `inspect_tree returns automation ids and control types`
6. `inspect_tree respects depth and max_elements, and reports truncated`
7. `find by automation_id returns an addressable path`
8. `set_value writes into a text field and inspect_tree reads it back`
9. `invoke activates a button and the application state changes`
10. `a selector naming a denied element is refused with E_CAP_NOT_ALLOWED`
11. `a selector whose name matches an envelope forbidden term is refused with E_FORBIDDEN`
12. `a coordinate-shaped selector is rejected with E_SCHEMA`
13. `a partially resolvable path fails rather than matching the nearest element`
14. `an element name containing PowerShell metacharacters is handled literally`
15. `a window belonging to another process cannot be reached even by exact title`
16. `stop does not terminate an application Toros did not start`
17. `a timeout kills the driver process and leaves the application running`

Tests 4 and 15 are the confinement tests — open a second Notepad outside the session, title it
identically, and assert it is unreachable. Test 14 is the injection test, in the spirit of spec
F's tests 11-12.

## Verification

```
npx tsc --build packages/adapters-uia
node --test packages/adapters-uia/dist/test/*.test.js
```

Clean, zero skips. These are real integration tests against real windows; they need an
interactive desktop session and will fail under a locked screen or a headless runner. Say so in
the PR rather than skipping them.

## What this unit does not fix

**§8.1's containment gap widens here, and this adapter does not close it.** A CLI worker is
already an ordinary process with the operator's rights; a UIA adapter adds the ability to drive
whatever application the operator configured. The per-application boundary bounds *which*
application, not what can be done inside it — `invoke` on an allowed control in an allowed
application can still do something consequential.

Two things follow, and they are prerequisites rather than follow-ups:

- **Criterion 6 must be closed first.** Findings currently reach the store and are visible to
  nobody: no findings tool exists on the §6 surface (`docs/finding-criterion-6.md`). Broad access
  plus monitoring is a coherent posture; broad access plus monitoring *nobody can read* is not.
- **Numbat cannot be the limit.** §8.2 makes it monitor-only and forbids it from becoming the
  enforcement boundary. The limits here are the per-application adapter id, `deny_elements`,
  `forbidden`, and `approval_required` — all policy, all deterministic, all decided before the
  action runs.

## Out of scope

A second application per adapter instance. Any coordinate or vision-based fallback. Cross-window
orchestration. Web page automation, which belongs to a browser adapter with its own DOM-level
boundary, not to UIA.
