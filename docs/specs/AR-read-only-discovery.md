# Spec AR — read-only discovery: `machine.inventory`, `desktop.state`, `desktop.inspect`

**Read `00-CONTRACTS.md` first.** It is short and it is binding. `packages/contracts` is frozen;
nothing in this slice edits it.

**Status (2026-09-16): T1–T3 shipped; T4 in progress.** T1 (coordinator-optional, #19), T2
(`machine.inventory`, #20) and T3 (`desktop.state` + `desktop.inspect`, #21) are merged to `main`;
T3's PowerShell probe was live-validated on a real Windows 11 desktop. T4 (regression + adversarial
security review + rollout) is underway. This spec is the revision of the "Fleet simplification and
Toros revision" plan (§4), rewritten against the actual repository; it supersedes that document's §4
for the Toros track. The fleet-simplification track (§1–3 of that plan) is out of scope here — see
Appendix B.

## Execution assignment (lanes per `fleet/lanes.toml`)

- **Orchestrator / spec owner** — Claude (`claude-opus-4-8`). Owns T0 (the gate), reviews merges,
  runs any host step. T0 requires desktop `F:\Code` verification + go/no-go judgment that a
  sandboxed worktree cannot perform, so it is **not** dispatched.
- **Implementer** — **`deepseek-v4-pro`** (deputy pool, OpenRouter, opencode harness). One slice
  per isolated worktree → one coherent commit → one draft PR. Starts at **T1** (T0 must exit first).
- **Code review** — **`grok-4.5`** (grok adapter). Independence holds: DeepSeek vs xAI lineage are
  distinct, so this does not trip the "never review your own lineage" rule.
- **Adversarial security review** — required at T4 for the new desktop data surface, and it must be
  a **third lineage**: `gpt-5.6` or `gemini-3`. **Never grok or deepseek here** (lanes adversary
  rule). This is separate from, and additional to, grok's code review.

**Relationship to the source plan.** The plan's §4 was written without visibility into two things
this spec is built on:

1. **Spec V (`@toros/adapters-uia`) already exists** as an unaccepted proposal for the Windows
   UI-Automation *mutation* surface (`inspect_tree`, `invoke`, per-application adapter instances).
   This spec is the **read-only discovery layer beneath it**, not a competitor. It introduces no
   `invoke`. Future UI mutation is Spec V's job, separately gated, exactly as the plan's §4
   required ("Future UI mutation needs a separate spec").
2. **Node Core already runs without a coordinator.** Every reference in `core.ts` is
   `this.options.coordinator?.…` and it throws `'Hermes coordinator is unavailable'` when absent
   (`packages/node-core/src/core.ts:309`). Only the composition root forces it:
   `main.ts:223` unconditionally calls `createCoordinatorSupervisor(...)`. So "run Core without a
   model coordinator" is a one-file entry-point change plus tests, not a refactor. The plan's
   1–2 day estimate for T1 is revised down accordingly.

---

## Objective

An authorized external caller can, over Node Core's existing authenticated loopback interface and
with **no model credential present**:

- discover what one local Windows machine can do (`machine.inventory`);
- enumerate the desktop of an explicitly authorized interactive session as bounded, opaque window
  summaries (`desktop.state`);
- inspect the accessibility tree of a single allowlisted window by opaque handle (`desktop.inspect`).

All three are read-only, go through the same registry → policy → receipt path as every existing
capability, and return explicit **availability** and **freshness** semantics rather than guessing.
Discovery does not authorize control.

## Non-goals (carried from the plan's §4, unchanged)

No new orchestration framework, model router, planner, generic remote shell, universal UI action
tool, new relay/H2 deployment, fleet scheduler, Mac driver, business integration, or BOSS/Sicil
change. **No `invoke`/`click`/`type`** — that is Spec V, and admitting it needs its own review.
No provider dependency. No automatic commits or deploys. The existing Toros "Hermes" coordinator
terminology must not be confused with the protected H1 Hermes email gateway.

---

## Contract fit — no contract change

This slice ships entirely within the frozen contracts. It was designed to, and if that turns out
to be false the correct response is to stop and say so (00-CONTRACTS §1), not to widen a type.

- **Capability ids.** `capabilityId` permits `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  (`packages/contracts/src/capability.ts`). The three names fit as `<adapter>.<action>`:
  adapter `machine` → `machine.inventory`; adapter `desktop` → `desktop.state`,
  `desktop.inspect`. (The plan's `window.inspect` is renamed `desktop.inspect` to avoid a
  `window` pseudo-adapter.)
- **Two-phase target resolution is amendment A8.** The desktop actions are the one place a
  policy decision has to be made *per OS target* rather than per action, which is exactly the gap
  A8 closes. `resolver.resolve` enumerates the windows, Core decides each resolved `app` target
  against `allowed_apps`, and `invoke` publishes only the keys Core allowed, re-verifying the
  identity at execution. Nothing here decides application scope inside the adapter — the decision
  stays in policy (00-CONTRACTS §10 A8).
- **Read-only ⇒ no approval gate, by construction.** Each `ActionSchema` sets `mutates: false`,
  `always_requires_approval: false`, `path_fields: []`. Read-only actions are already exempt from
  the approval gate; nothing special is needed.
- **Permissions reuse the existing enum.** `machine.inventory`:
  `['process.spawn', 'fs.read']`. `desktop.*`: `['process.spawn', 'app.automation', 'fs.read',
  'fs.write']` — `fs.read`/`fs.write` are declared (AR-11) because the probe reads and writes only
  its own `mkdtemp` directory. No new `Permission` value, so `packages/contracts` stays frozen.
- **The envelope already carries the scope this slice needs.** `allowed_capabilities`,
  `allowed_workspaces`, `forbidden`, `max_actions`, `max_retries`, `expires_at`
  (`packages/contracts/src/envelope.ts`), and — added by A8 — the optional `allowed_apps` for the
  application scope the desktop actions consult. Caller identity is an auth-layer concern,
  deliberately *not* in the envelope: it reaches every adapter call as `ctx.actor`. **Session /
  window targeting and freshness are runtime handles, not authorization scope** — they live in
  action input/output JSON and a per-call handle check inside the adapter, never as new envelope
  fields. This is the same decision Spec V took, for the same reason.
- **Receipts** use the §8.3 minimum (`packages/contracts/src/receipt.ts`). Each adapter declares
  its extra audit keys in the manifest's `receipt_fields` (e.g. `window_count`, `truncated`,
  `probe_ms`) — never raw inspected content. Node Core already rejects undeclared receipt keys,
  and A8 adds two **Core-reserved** receipt keys, `targets_allowed` and `targets_denied`, that no
  adapter may declare: Core records the two-phase resolve as counts, never identities.

---

## The boundary (this is the deliverable, not the automation)

Spec V's central rule: **do not make the target an argument, because arguments are chosen by the
coordinator** — a per-application adapter instance is how `invoke` stays decidable. Read-only
discovery cannot follow that rule literally: enumerating "what is on screen" means the target set
is dynamic by definition. So read-only discovery gets its **own** boundary, and it is a different
axis:

| | Spec V (`invoke`, mutation) | This slice (read-only) |
|---|---|---|
| Bounded by | *target selection* — one adapter instance per operator-configured app | *content sensitivity* — what fields may be returned |
| Target | fixed in the adapter id (`uia_outlook.invoke`) | opaque handle passed as an argument |
| Risk class | state change | data disclosure |

Concretely:

1. **`machine.inventory`** is node-scoped and returns no window content. Lowest risk.
2. **`desktop.state`** enumerates windows in the authorized interactive session and returns
   **opaque ids only** — no titles, no document names, no control contents — *unless* the window's
   owning application is in the envelope's authorized application scope (see below), in which case a
   bounded title is included. This means enumeration alone leaks nothing sensitive.
3. **`desktop.inspect`** returns controls for **one window whose owning application is in the
   authorized application scope**. Inspecting a window outside that scope is denied, not truncated.
   This re-imports Spec V's per-application boundary for the one read-only action where content is
   actually exposed.

**Authorized application scope** is the operator-configured allowlist of applications
(`%LOCALAPPDATA%\Toros\config.json`, the same file Spec V uses), intersected with the job's
`allowed_capabilities`/`forbidden`. It is an operator + envelope decision, never a caller argument.

Default omissions, always, regardless of scope: password field values, clipboard contents, browser
cookies, hidden/off-screen document contents, and screenshots. When reliable inspection is
impossible, return `unavailable` — never silently broaden scope, and never fall back to vision.

---

## The three capabilities

Names below are contract-final. I/O shapes are JSON validated by the registry against each
action's `input_schema`; the output shapes are the adapter's contract with its callers.

### `machine.inventory`  (package `@toros/adapters-machine`)

- **Input:** `{ capability_filter?: string }` — optional substring over capability ids.
- **Output:** for each known adapter/tool on this node — `id`, `platform`, `observed_at`,
  `registered_actions[]`, and a **readiness** verdict from a fixed taxonomy:
  `registered` (manifest loaded) · `usable` (probe succeeded) · `missing_adapter` ·
  `unsupported_platform` · `missing_prerequisite` (with `reason`) · `unauthorized` (caller lacks
  the capability). An `unauthorized` entry is reduced to `id` and `readiness` only — no
  `reason`, `platforms`, or `backs_adapter` — because the job-scoped filter (AR-09) reports
  only the entries a resolved capability admitted. "Installed" is never conflated with
  "usable": a probe that finds an executable
  but no registered manifest reports `missing_adapter`, not `usable`.
- **Bounds:** probes a fixed, declared list of locations only. **No filesystem-wide scan, no
  secret or account enumeration, no registry-wide sweep.**
- **Permissions:** `['process.spawn', 'fs.read']`. **Receipt fields:** `probe_ms`, `probe_count`.

### `desktop.state`  (package `@toros/adapters-desktop`)

- **Input:** `{ session_scope: 'interactive' }` — the enum value `"interactive"` (amendment A8,
  F3b). Any other value is schema-rejected (`E_SCHEMA`).
- **Output (active):** `{ session: 'active', freshness_token, windows: [{ window_id (opaque),
  z_order, foreground: bool, title? }], changed? }`. Settlement is now two-phase (A8): only
  windows Core allowed against the envelope's `allowed_apps` are published, and only those whose
  OS identity re-verifies (pid, creation time, SHA-256) at execute time. A window that changed
  is dropped and counted in `changed`.
- **Output (unavailable):** `{ session: 'unavailable', reason: 'locked' | 'disconnected', windows: [] }`
  — a locked or disconnected session returns this shape and **no window list**.
- **Identity (AR-10):** the owning application is identified as the OS observes it — pid, creation
  time, canonical long image path (`QueryFullProcessImageName`), image SHA-256, Authenticode
  signature + subject CN, version-resource ProductName, and session id — never by a spoofable
  process basename.
- **Bounds:** bounded window count; a window whose identity cannot be read is dropped (not
  basename-fell-back).
- **Permissions:** `['process.spawn', 'app.automation', 'fs.read', 'fs.write']`. **Receipt fields:**
  `window_count`, `session`, `reason`, `truncated`, `changed`.

### `desktop.inspect`  (package `@toros/adapters-desktop`)

- **Input:** `{ session_scope: 'interactive', window_id, freshness_token, depth?, control_filter?,
  page?, page_size? }`.
- **Output:** `{ controls: [{ control_id (opaque), type, automation_id?, enabled, patterns[] }],
  truncated: bool, next_page? }`. Control output is structure only; UIA `Name` is **never read or
  emitted** for controls (AR-F2 remediation for AR-01). `automation_id` is included only when it is
  1–128 printable ASCII characters. Control **values are never returned** (that would be a read of
  content; a future typed read is a separate action). `patterns[]` reports supported UIA patterns so
  a future Spec V `invoke` can be planned without this action performing one. Window titles in
  `desktop.state` come from native window text (`GetWindowText` on the top-level handle, capped at 256
  characters), not UIA `Name`.
- **Two-phase (A8):** `desktop.inspect` resolves its single window from the handle and inspects
  only on an `allowed` decision; a denied decision returns `denied`. At execute time it re-verifies
  pid, creation time and SHA-256 against the resolved identity — a mismatch is `unavailable`, never
  the new owner's tree.
- **Failure modes, each explicit and tested:** `window_id` unknown, `freshness_token` stale,
  reused, expired, or from a foreign job/actor → `refresh_required` (the **same shape** for all of
  them, so a caller cannot probe which case it hit — invariant 4); window's app not allowed →
  `denied`; window closed since enumeration, or its identity changed → `unavailable`. Handles are
  per `(job_id, actor)`, **single-use**, valid for at most 60 s.
- **Permissions:** `['process.spawn', 'app.automation', 'fs.read', 'fs.write']`. **Receipt
  fields:** `status`, `control_count`, `truncated`, `depth`.

**Automation mechanism (both `desktop.*` actions), per Spec V's established discipline:** drive
`System.Windows.Automation` from PowerShell — parameters written to a JSON file in the session
directory, read by a *fixed, parameter-free* script via `ConvertFrom-Json`, invoked with
`execFile`, `shell: false`, `-NoProfile -NonInteractive -File`; strip the UTF-8 BOM at every read
site (Spec F's trap, identical here). **Never interpolate a window title or element name into
script source** — names are application content and content is untrusted. Dependency:
`@toros/contracts` only (00-CONTRACTS §3).

---

## Invariants (carried from the plan's §4, mapped to existing mechanisms)

1. Every entry point — discovery included — passes the existing schema, authentication, allowlist
   and policy checks. Loopback alone is not authentication.
2. Operator approval is separate from caller credentials, bound to the exact approved
   action/resources with expiry. Already structural: Core refuses to start unless
   `operator_token !== token` (`core.ts:138`), so the coordinator/caller cannot self-approve.
3. UI and web content are untrusted data. They cannot expand a grant, alter a job, or inject into
   policy. Enforced by never interpolating content into scripts and by the frozen envelope.
4. Node/session/window identity and freshness are revalidated every call; stale or reused handles
   fail explicitly with `refresh_required`, never a guessed substitute.
5. One active *mutating* desktop job per interactive session — vacuously satisfied here (no
   mutation), but the lock discipline is reserved for Spec V. A locked/disconnected desktop is
   `unavailable`, not a success.
6. No blind retry. (No writes in this slice; the rule is inherited by Spec V.)
7. Receipts identify job, caller, node, capability, policy/envelope digest, timing, outcome and
   sanitized artifact refs — **no raw inspected content by default** (`receipt_fields` only).
8. Core discovery and existing typed execution work without model credentials. Model-assisted
   recovery is deferred until deterministic paths prove insufficient.

---

## Delivery slices and acceptance

Each slice: one bounded branch/worktree, a coherent commit, a draft PR stating exact commands and
results, assumptions, and next owner. Independent review before acceptance. **Do not report the
August STATUS as current, and do not report a skipped real-binary test as passing.**

### T0 — re-ground and audit · 0.5–1 day · docs only

The plan's findings are partly stale (Appendix A). Before any code:

1. Re-verify the plan's §"Evidence" findings against the **desktop `F:\Code`** checkout and
   current `main`, not a month-old copy. Rewrite the stale ones.
2. Reconcile `docs/STATUS.md` (dated 2026-08-16) with the actual repo, which has merged PRs #16/#18
   since. Record what is genuinely open (per memory: neither CLI adapter completes a full exchange
   on the desktop — confirm or refute).
3. Confirm the coordinator-optional claim by reading `main.ts`/`core.ts` and running the existing
   node-core tests.
4. **Draft the SPEC §10 amendment.** Spec V notes SPEC §10 Phase 1 admits exactly one
   operator-selected desktop adapter (Excel). Admitting read-only discovery needs the same
   amendment path; write it as part of T0 so T2/T3 are not blocked on a governance surprise.
5. Emit the precise allowed-file list for T1–T4 and flag any security repair required before adding
   the desktop data surface.

**Exit:** reconciled STATUS, a SPEC §10 amendment draft, a per-slice allowed-file list, and a
written go/no-go on each downstream slice.

### T1 — coordinator-optional startup · 0.5–1 day

- Gate `createCoordinatorSupervisor` in `main.ts` behind explicit config; default is **off**.
- Prove a small external caller over the existing authenticated loopback interface can
  `list_capabilities`, invoke an **existing read-only** action (an `@toros/adapters-app` /
  spec-F Excel read against a fixture), and retrieve its receipt — **with no model key set**.
- Prove the caller **cannot** grant approval, alter an envelope, or bypass policy.
- Update `G-node-core.md` / `AP-first-run-orientation.md` language and dependency tests.
- **No new network listener.**

**Exit:** Core serves discovery + existing typed execution with the coordinator absent; negative
tests for self-approval / envelope tampering / policy bypass are green.

### T2 — `machine.inventory` · ~1 day

- New package `@toros/adapters-machine` (allowed paths below).
- Bounded probes → readiness taxonomy through registry/policy.
- Tests distinguish `registered` vs `usable` vs `unsupported_platform` vs `missing_prerequisite`
  vs `missing_adapter` vs `unauthorized`.
- Run real inventory on **Oruc** and on **YOGA** if available.
- **No filesystem-wide scan, no secret/account enumeration.**

Allowed: `packages/adapters-machine/{package.json,tsconfig.json,src/**,test/**}` ·
registration wiring in `packages/node-core/src/main.ts` (registration only) ·
`docs/specs/AR-read-only-discovery.md`. Forbidden: `packages/contracts/**`, any other package's
`src`, `apps/**`.

### T3 — `desktop.state` + `desktop.inspect` · 2–3 days

- New package `@toros/adapters-desktop` implementing both read-only actions over
  `System.Windows.Automation` per the mechanism above.
- Test: pagination/limits, freshness-token mint + stale/reused rejection, password/secret omission,
  cross-session denial, locked/disconnected session, closed window, reused `window_id`,
  in-scope vs out-of-scope title/name redaction.
- Validate real accessibility behavior against an **allowlisted test application** on Oruc, then
  repeat on a **second Windows node** before any broader rollout.

Allowed: `packages/adapters-desktop/{package.json,tsconfig.json,src/**,test/**}` ·
registration in `main.ts` · this spec. Forbidden: as T2, plus `packages/adapters-uia/**` (Spec V is
a separate unit).

### T4 — regression, review, rollout · ~0.5–1 day + review

- Demonstrate an existing spec-F Excel action and an operator-attached spec-AB Chrome workflow
  still pass on safe fixtures; preserve tab/site grant requirements.
- Run the repo-required typecheck/build/test commands; report prerequisite failures honestly.
- **Independent code review AND a separate adversarial security review** are required — this adds a
  new desktop data-disclosure surface.
- Prepare an install/rollback receipt. Local installation is a later explicit operator action, not
  implied by acceptance here.

---

## Revision completion criteria

- Core starts and serves authorized execution + discovery with no model coordinator.
- The three read-only capabilities work with bounded output and explicit availability/freshness
  semantics.
- Unauthorized requests and attempts to cross node/session/application scope are denied **and
  recorded**.
- Existing Excel and Chrome demonstrations pass, or rollout stays blocked with a concrete
  prerequisite/defect named.
- Independent reviewers clear each slice; the previous installer/config can be restored without
  downgrading policy grants or discarding receipts.
- `STATUS.md`, this spec, the SPEC §10 amendment, install notes, and one ops activity event all
  point to current evidence.

---

## Appendix A — stale findings in the source plan (resolve in T0)

Verified on YOGA (`C:\.Code`) 2026-09-15:

- **"`ops/AGENTS.md` still assigns H2 to Codex" — likely a phantom.** The current file reads
  *"Host access and deploys are Claude's or the operator's… Codex/Grok/Kimi implement in worktrees
  and open PRs."* The only "Codex-owns-H2" strings are in the immutable `ACTIVITY.md` history, and
  the ledger records this was corrected on 2026-07-11. Either the desktop copy is behind, or it is
  already fixed. Re-verify against `F:\Code` before "correcting" anything.
- **Fleet README vs. actual push behavior — a real contradiction.** `fleet/README.md` (lines
  68–70) says auto-push *"isn't done."* MEMORY and the plan say bootstrap installs a SessionEnd
  auto-commit+push hook. Reconcile the README to reality and confirm the hook's actual staged
  scope before it stays a default config distributor.
- **STATUS is a month stale.** `docs/STATUS.md` is 2026-08-16; `main` has merged PRs #16/#18 since.
  Treat every "live/verified" claim in it as historical until re-checked.

## Appendix B — fleet-simplification track (deferred, not dropped)

The source plan's §1–3 (rule/config consolidation, machine profiles, migration sequence) is a
separate, independent track — H1/H2 is already cut over (DNS flipped 2026-09-15), so nothing here
blocks it and it blocks nothing here. The re-grounding in Appendix A is its natural first task.
Spec it separately when the Toros slices above are underway.
