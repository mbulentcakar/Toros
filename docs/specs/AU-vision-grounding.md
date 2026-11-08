# Spec AU — vision for locating and checking, never for acting

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

**Status: proposed, draft 1 (2026-11-08, Claude). Not accepted.**

**Builds on:**
- **AR** (read-only discovery): shipped, gate cleared in mbulentcakar/Toros#18.
- **AS** (delegated desktop control): proposed, mbulentcakar/Toros#1, rev 6.
- **AS revision / slice AF** (agreement-first accept): merged #24.
- **AM** (the API-adapter rules): proposed.

**Spec V and AS stay unchanged for the action path.** AU adds no way to click, type or select. Admitting AU amends one sentence each in SPEC §2, AR's default omissions and AS's out-of-scope list (see "Amendments").

**Background:** the research behind this spec looked at ByteDance's UI-TARS (Apache-2.0 open models; the UI-TARS-desktop app and Agent TARS CLI). That research is kept outside this repository.
- **The model:** the open 7B model is a cheap, self-hostable grounder but weak as an end-to-end agent.
- **The desktop stack:** it runs a full-privilege pixel/keyboard agent and carries CVE-2026-81735, which is the opposite of Toros's posture. Hence the split below: borrow the eyes, keep the hands.

## Objective

Let a driver (AS) or a job (AF agreement) use a vision model for two things that UI Automation alone does poorly. In both, Node Core decides and nothing acts on pixels.

1. **Locate:** "which control in this admitted window is *the Save button*?"
   - A grounder model reads one window image and points.
   - Node Core turns the point into a real UIA element of the bound process and returns it in AR's own shape: an opaque id, structure only.
   - The driver then requests an action on that element through AS, exactly as if it had found the element by `desktop.inspect`.
2. **Check:** "after these steps, does the window show the result we agreed?"
   - Two independent typed checkers judge stated predicates against one window image: the OpenAI Decisions API and TypeSafe Jev.
   - Anything other than agreement on *pass* **holds** the work for the operator.
   - A pass grants nothing.

A third, offline use has no runtime surface. A tool drafts AS surface profiles from a window image plus its UIA tree, for human review in a PR.

**The one-line rule:** *vision may point and judge; it may never act, approve, widen scope or stand in for a reviewed profile.*

## Why

- **AR returns structure, not meaning.** By design (AR-F2), `desktop.inspect` never reads UIA `Name` or control values. On a profiled surface, AS supplies meaning by a reviewed declaration. On anything else, the driver sees opaque ids, types and automation ids, and must guess which control does what. A grounder supplies the "which one" from what a person would see.
- **Nothing checks the task outcome.**
  - AS proves each *action's* outcome (R4-B4). Nothing checks whether a *task* came out right after twenty correct-looking clicks.
  - STATUS lists a related gap: a run that ends without an answer still gets a `succeeded` receipt.
  - Agreed checkpoints, judged by two models and enforced by Core, give long jobs evidence instead of silence.
- **The price is disclosure, not authority.** The window image carries *more* content than the UIA names AR refuses to read. AU's boundary is therefore drawn around the **data path**: which pixels, to which endpoint, kept where. The action path stays exactly where AS and V put it.

## Roles and models

| Role | What it does | Reference choice | Rules |
|---|---|---|---|
| Grounder | Image + short target text → one or a few points | **UI-TARS-1.5-7B** (Apache-2.0), self-hosted on vLLM. Alternatives measured in AU0: Claude (vision / computer-use tool), one Qwen3-VL class model | Any OpenAI-compatible endpoint. The model id is pinned in config. Toros parses the reply itself and keeps only the coordinates |
| Checker A | Image + predicates → p per predicate | OpenAI **Decisions API**, model pinned (cad-loop uses `gpt-6-luna`) | AM rules: declared origin, key in operator config |
| Checker B | Same | TypeSafe **Jev**, model pinned (cad-loop uses `jev-1.13.0`; its image input is experimental) | Same. A different lineage from checker A is required |

**No ByteDance software runs in Toros.**
- No UI-TARS-desktop, no Agent TARS, and no `@ui-tars/*`, `@agent-tars/*` or `@gui-agent/*` package.
- The grounder is just a model behind an HTTP endpoint.
- The 00-CONTRACTS §3 dependency rule holds: `@toros/contracts` plus Node built-ins.

## The boundary: the data path

1. **One window, captured by handle.**
   - **Resolve first:** capture runs only after A8's two-phase resolve of a `window_id` whose owning app is in the authorized application scope (the same scope `desktop.inspect` uses). It also re-verifies pid, creation time and image SHA-256, as AR's RR-07 does.
   - **Capture method:** `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` on the bound top-level window.
   - **Never a screen-region grab:** a region grab would include whatever overlaps the window.
   - **Failure is `unavailable`:** if `PrintWindow` returns a blank or failed image (some GPU-composited apps), the result is `unavailable`. AU never falls back to screen capture.
2. **Refused for everyone:** every AS absolute target. That means the Toros family, higher integrity than the worker, and the secure desktop. Capture is also refused for any window whose UIA or native tree shows a positive password signal anywhere (AS absolute rule 0: `IsPassword`, `ES_PASSWORD`, non-zero `EM_GETPASSWORDCHAR`). A login screen is never photographed.
3. **Endpoint classes:**
   - **`local`** is a loopback origin, or a tailnet origin the operator listed in config, for example a vLLM on a fleet GPU machine.
   - **`external`** is any other declared origin (AM rule 1).
   - The grounder defaults to `local` only.
   - Sending a window image to an `external` endpoint requires the window's app to be on the operator's `vision.external_apps` list, using AS identity rules (A9 signer, A10 package or listed image). The list is set by the operator only, never by an argument. Without it, the call is refused before any network request.
   - **The checkers are external by nature, so `vision.check` works only on listed apps.** For customer or tenant applications this is the operator's explicit data decision, consistent with the fleet rule to ask before sending tenant data to Jev.
4. **No pixels in Toros's durable state.**
   - Receipts carry `image_sha256`, the dimensions, the endpoint's *config name*, the model id and the latency.
   - Images never enter the store, the event log, Numbat, the approval record or a model context other than the one call they were captured for.
   - **Optional evidence retention:** off by default. When the operator enables it, images live in the job's session directory with a TTL, are deleted at job end plus TTL, and are referenced by hash only.
   - **AG cannot redact pixels, and AU does not pretend it can.**
5. **Model output is untrusted data.**
   - **Grounder:** of its reply, only the parsed coordinates survive. Its free text ("Thought: …") is discarded at the parser, and never reaches the driver, approver, operator card, receipt or log. That closes the obvious relay for on-screen prompt injection.
   - **Checkers:** of each checker's reply, only the typed number per predicate survives (plus a reason of at most 300 characters, redacted, shown only on the operator's hold card).
6. **Candidates carry no authority.**
   - A `vision.locate` result names candidates only. It has no tier, no pre-approval and no profile match.
   - The driver must still send an AS request. Classification, profiles, the approver and the operator tiers run unchanged, on the element's **real OS-read evidence**, never on the grounder's claim.
7. **Coordinates never leave Core.**
   - **Mapping:** Core maps a point to an element with UIA `ElementFromPoint`. It then requires the element's own `ProcessId` to equal the bound pid and its bounding box to lie inside the bound window.
   - **Output:** Core returns AR's opaque `control_id` (and, under AS, the selector path). The point is not returned to anyone.
   - **V and AS rules still hold:** "coordinates may never name a target" and "no nearest guess" both still apply. A point that does not map cleanly yields `not_found`.
8. **Checks can only stop work.**
   - A `vision.check` outcome other than `pass` puts the mission into AS's `held` state, or for a job without a mission, the job into `blocked` with an operator card.
   - `pass` changes nothing. It is not evidence for any approval, and AS's approver never sees it.
   - This is AF's rule in practice: "a second model may check actions but cannot create permission".

## Capabilities

Capability names follow 00-CONTRACTS (`<adapter>.<action>`). They live in a new package, `@toros/adapters-vision`, which declares `network_endpoints` (AM).

Both actions use AR's discipline:
- **PowerShell launch:** a fixed, parameter-free PowerShell script reads a JSON parameter file, run via `execFile` with `shell: false`.
- **BOM:** the UTF-8 BOM is stripped at every read site.
- **No interpolation:** nothing is ever interpolated into script source.

### `vision.locate`

- **Input:** `{ session_scope: 'interactive', window_id, freshness_token, target, max_candidates? }`
  - `target` is a string of 1–200 characters ("Save button in the toolbar").
  - `max_candidates` is 1–3 and defaults to 1.
  - The envelope's `forbidden` terms apply to `target` with RR-01 token-sequence semantics. With `forbidden: ["send"]`, the Send button cannot even be located.
- **Processing:**
  1. Two-phase resolve (A8) and the scope check.
  2. The password and absolute checks.
  3. Capture.
  4. The endpoint-class check.
  5. One grounder call (bounded image size, deadline 30 s by default).
  6. Parse the point(s). Normalized 0–1000 coordinates are converted with the window rect and the window's DPI. Any parse failure is `E_ADAPTER_FAILURE`.
  7. `ElementFromPoint`, then the pid and inside-window checks. Points that fail are dropped.
  8. De-duplicate.
  9. Return.
- **Output:** `{ status: 'found' | 'not_found' | 'unavailable' | 'denied' | 'refresh_required', candidates: [{ control_id, type, automation_id?, enabled, patterns[] }] }`. This is AR's `desktop.inspect` control shape exactly: **no UIA `Name`, no values, no coordinates**.
- **Failure shapes:**
  - A stale or reused handle gives AR's identical `refresh_required`.
  - An out-of-scope app gives `denied`.
  - An unreachable grounder or a blank capture gives `unavailable`.
- **Receipt fields:** `status`, `image_sha256`, `image_px`, `endpoint_name`, `model_id`, `latency_ms`, `points_parsed`, `candidates_returned`.
- **Permissions:** `['process.spawn', 'app.automation', 'screen.capture', 'net.egress']`. `screen.capture` and `net.egress` are new permission names, registered in the same diff as the package.

### `vision.check`

- **Input:** `{ session_scope: 'interactive', window_id, freshness_token, predicates: [{ id, statement }] }`.
  - At most 8 predicates.
  - Each `statement` is at most 300 characters ("The status bar says Saved", "The Quantity field shows 12").
  - `forbidden` terms apply.
- **Processing:**
  1. The same resolve, the same refusals and the same capture as `vision.locate`.
  2. The app must be on `vision.external_apps`.
  3. One call to each checker, in parallel, with the same image and the same predicates.
  4. Typed parsing per AM rule 4.
- **Decision per predicate, deterministic:**
  - **`pass`** when both checkers' p ≥ θ.
  - **`fail`** when both p ≤ 1 − θ.
  - **`split`** otherwise.
  - **`error`** when either checker failed, timed out or answered off-schema.
  - θ is operator config (default 0.8) and never an argument.
  - The overall result is `pass` only if every predicate passed.
- **Output:** `{ result: 'pass' | 'hold', predicates: [{ id, decision, p_a, p_b }] }`.
  - `hold` triggers boundary rule 8.
  - The reasons go to the operator card only.
- **Receipt fields:** `result`, `image_sha256`, `predicates`, `passed`, `checker_a_model`, `checker_b_model`, `latency_ms`.

### Agreed checkpoints (AF extension)

- **Who writes them:** a driver can call `vision.check` with predicates of its own choosing. Those are advisory, and a weak predicate passes easily. The checks that **bind** are the ones the operator agreed to.
- **The proposal field:** AU adds one optional field to `propose_job`: `checkpoints: [{ id, after, statement }]`.
  - At most 8 checkpoints. `statement` is at most 300 characters.
  - `after` is `"end"` or a plan step index.
  - The field is validated in `validateDraft`, shown on the Agree-and-run card, and included in the agreement digest, so it is part of what the operator agreed to.
- **Enforcement:**
  - Core runs each agreed checkpoint itself at its point.
  - It always runs the `"end"` checkpoints before the job may reach `proposed` (SPEC §7) and before any run receipt may record `succeeded`.
  - A non-pass blocks the job with an operator card.
- **Not envelope fields:** checkpoints are not envelope fields, as with AF's `intent`, `target` and `changes`. They are enforced by Core's job lifecycle, not by policy over prose.

### Profile drafting (offline tool, no runtime surface)

- **What it does:** `tools/profile-draft.mjs`, run by the operator on a test machine against a fixture app with synthetic data. It captures the window and its UIA tree and asks a model for a **draft** `SurfaceProfile`: selectors plus a declared function per control.
- **Output:** a TypeScript data file whose first line is `// GENERATED DRAFT — NOT REVIEWED`.
- **Safeguard:** the AS matcher refuses to load any profile carrying that marker (one test).
- **Why it fits AS:** AS's rule ("static data, never fetched or generated at runtime, changed only by a reviewed PR") holds, because the draft becomes a profile only through review.

## Delivery slices

| Slice | Content | Gate | Allowed paths (finalized at dispatch) |
|---|---|---|---|
| **AU0** | **Grounding and checker bakeoff.** Offline, no Node Core change. Measures every candidate grounder and both checkers on fixture apps and on the operator's real target apps, using synthetic data | None. It produces the numbers that decide whether AU1 is worth building | `packages/bakeoff/src/vision/**` (or `tools/vision-bakeoff/**`), `docs/finding-vision-bakeoff.md` |
| AU1 | `vision.locate` behind `desktop_control.vision_enabled` (default unset), exposed through spec AT's MCP server | AR gate cleared; AS `look` shipped; AM accepted; AU0 thresholds met | `packages/adapters-vision/**`, the registration lines in `packages/node-core/src/**`, `packages/mcp-discovery/**` |
| AU2 | `vision.check` and agreed checkpoints | AU1 shipped; checker keys configured | `packages/adapters-vision/**`, `packages/node-core/src/{draft,core}.ts`, the cockpit card, tests |
| AU3 | `tools/profile-draft.mjs`, plus the matcher's refusal of the draft marker | AS2p shipped | `tools/profile-draft.mjs`, `packages/adapters-uia/src/profiles/matcher*.ts` (refusal only) |

**Reviews:**
- **Independent review:** every slice gets independent code review.
- **MCP review:** AU1 and AU2 change an MCP surface, so they also need an independent MCP review (workspace invariant 3).
- **Adversarial review:** a third-lineage adversarial review before the flag is set on any production node. That review owns the capture, prompt-injection and disclosure tests below.

### AU0 in detail: what "good enough" means

- **Fixtures:**
  - Notepad and Calculator: AS's profiled apps, with UIA ground truth.
  - Two or three of the operator's real target applications, with synthetic data only.
  - 50 labelled targets per app. Each label is the intended element's selector, read from UIA by a human.
- **Grounders, each pinned:**
  - UI-TARS-1.5-7B, local vLLM.
  - Claude, current pinned model, vision.
  - One Qwen3-VL-class open model.
- **Grounder metrics:**
  - Hit rate: the point maps to the intended element.
  - **Wrong-element rate:** the point maps cleanly to a *different* enabled, actionable element. This is the dangerous number.
  - `not_found` rate.
  - p50 and p95 latency.
  - Cost per 100 calls.
  - Behaviour at 100%, 150% and 200% DPI.
- **Checkers:** 30 labelled predicates per app, half true and half false. Measured:
  - Each checker's accuracy.
  - The agreement rate.
  - **The false-pass rate of the AND rule.** It must be about 0; a false pass is the failure that hides a wrong outcome.
- **Proposed thresholds (operator decision):**
  - For AU1, wrong-element ≤ 2% and hit ≥ 85% on the real target apps.
  - For AU2, the false-pass rate of the AND rule is 0 on the labelled set at the chosen θ.
- **If no local grounder meets them:** AU1 either waits or is limited to `external_apps`, and that is the finding.

## Acceptance tests (AU1–AU3)

Run natively on a Windows node, against real windows. A missing fixture fails the run; it never skips (00-CONTRACTS §6).

**Capture and disclosure**
1. Capture of a window that another process's window partly covers contains none of the covering window's pixels. The fixture overlays a second Notepad containing a canary text pattern, and the test compares against an uncovered capture of the same window.
2. An out-of-scope app is `denied`. The cockpit, an elevated window and the secure desktop are refused and recorded.
3. A window with any positive password signal (each of the three sources) is refused before capture.
4. An `external` endpoint for an app not on `vision.external_apps` is refused, **and a mock server receives no request**.
5. A blank `PrintWindow` result is `unavailable`. No screen-region capture is attempted (assert the API is never called).
6. No store row, event payload, Numbat record or receipt contains image bytes. Scan for PNG/JPEG magic bytes and long base64 runs.
7. With retention off, no image file survives the call. With retention on, files are deleted at job end plus TTL.
8. Checker and grounder keys never appear in receipts, errors or logs. The test injects a failing endpoint that echoes the request.

**Grounding**
9. A grounder point outside the window gives `not_found` with empty candidates.
10. A point landing on another process's window that overlaps the bound window is dropped.
11. Normalized 0–1000 coordinates map correctly at 100/150/200% DPI (Calculator fixture).
12. **Injection canary:** a mock grounder whose free text contains instructions and a canary string. The canary appears nowhere: not in the output, receipt, event, AS approval record or operator card.
13. A `target` containing an envelope `forbidden` term is refused with `E_FORBIDDEN` before capture.
14. Output contains no UIA `Name`, no control value and no coordinates (schema plus a property test).
15. A located candidate gives no advantage. The AS tier, approver call and decision for an action on it are identical to an action on the same element found via `desktop.inspect` (property test).

**Checking**
16. Both p ≥ θ gives `pass`. One below gives `split` and then `hold`. A timeout or off-schema answer gives `error` and then `hold`.
17. `pass` never changes an AS approval decision. Run with checkers mocked to always-pass and assert decisions are identical.
18. An agreed `"end"` checkpoint that fails leaves the job `blocked` (never `proposed`), and no run receipt records `succeeded`.
19. `checkpoints` are part of the agreement digest. A changed checkpoint makes the old card stale (AF test 3 pattern).
20. θ cannot be set by any request field.

**Gating**
21. With `desktop_control.vision_enabled` unset, no `vision.*` route or MCP tool is mounted.
22. A profile file carrying the draft marker is refused by the AS matcher.

## Non-goals

- **Any actuation by vision:** no `click_at`, `send_keys`, `screenshot` action, drag or pixel fallback, and no grounder or checker executing anything. Apps without a usable UIA tree stay unsupported, or get a native adapter.
- **A full GUI agent (UI-TARS-style) doing "simple tasks" by itself:** if ever wanted, it belongs in a disposable VM under its own spec, never on a node's real interactive desktop. This spec does not propose it.
- **Full-desktop or multi-window capture, video, or continuous watching.**
- **Model-chosen thresholds, endpoints, app lists or retention.**
- **Replacing surface profiles:** locate finds a control; only a reviewed profile says what it does.
- **Any ByteDance runtime component.**

## What AU cannot enforce, stated plainly

- **Disclosure:** a window image shows whatever the window shows. Sending it to an `external` endpoint discloses that to the provider. That is an operator decision per app, not something Toros can make safe.
- **A grounder can be misled** by on-screen text or look-alike controls into pointing at the wrong element. AU contains this (a candidate has no authority, and AS decides on real evidence) but does not prevent it. A wrong-but-allowed element can still be requested, and the AS approver or operator sees its real evidence.
- **Checkers can be fooled** by a UI that looks right. A `pass` is not truth, which is why checks can only stop work.
- **AS decision 14 is unchanged:** a driver with its own shell is not confined by any of this.

## Amendments made by admitting AU

- **SPEC §2:** keep "Requiring vision-based computer-use where an API… works" as a non-goal, and add: *"Vision may locate controls and check outcomes under spec AU; it never acts."*
- **AR, default omissions:** "screenshots" becomes "screenshots, except the single-window captures of spec AU's two capabilities, under AU's data-path rules".
- **AS, out of scope:** "Any vision or coordinate fallback" stays for **actuation**. Add a cross-reference stating that AU's locate and check are not a fallback and change no AS rule.
- **Spec V:** unchanged.
- **Contracts:** depend on AM's proposed `network_endpoints` manifest field and on two new permission names. No other change. If AM's field has not landed when AU1 is dispatched, AU1 waits; it never redeclares the field locally.

## Appendix: decisions needed from the operator

1. **Targets:** which real applications AU0 should measure (the reason AU exists).
2. **Grounder hosting:** which fleet machine has a GPU for a local vLLM, if any (JanBot's VRAM is unverified). Otherwise: is an external grounder acceptable for which apps?
3. **The initial `vision.external_apps` list** (governs `vision.check` and any external grounding).
4. **θ** for the checker AND rule (proposed 0.8).
5. **Evidence retention:** keep off by default? If on, which TTL?
6. **The AU0 pass thresholds** (proposed: wrong-element ≤ 2%, hit ≥ 85%, AND-rule false-pass 0).
