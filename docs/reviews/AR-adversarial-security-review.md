# AR — adversarial security review (T4)

**Reviewer requirement:** a **third lineage — GPT-5.6 or Gemini-3**. **Not grok, not deepseek**
(deepseek implemented these slices; grok did the code reviews — using either here defeats the
independence the lineage rule exists for). Run against a checkout of `main` at or after `fb3701c`.

> **Dispatch update, 2026-10-13. Read this first.**
>
> - **Reviewer:** Codex (GPT-5.6, the adversary lane). Use Gemini 3 if Codex is busy.
> - **Repository and baseline:** the public repo `mbulentcakar/Toros`, `main` at `2847726` or
>   later. That is a single squashed commit, so the commit hashes and PR numbers in this brief
>   (`fb3701c`, `228ce68`, `a9597e8`, #19–#21) exist only in the earlier private history. The code
>   they name is all present at `2847726`. Use the file paths, not the hashes.
> - **Why now:** spec AS (PR mbulentcakar/Toros#1) builds clicking and typing on top of exactly
>   this surface, and lists this review as a hard prerequisite. Until the findings below are
>   filled in, AS's mutating actions cannot be enabled, and neither can this surface in
>   production. Nobody has run this review yet; the findings section has been empty since T4.
> - **Where to run it:** on a **native Windows 11 machine with an unlocked interactive desktop**.
>   Read the code anywhere, but every exploit claim about `probe.ts` or UI Automation behaviour
>   must be demonstrated live, or the finding must be labelled `unverified (static only)`. A
>   sandbox or Linux run cannot exercise UI Automation.
> - **Use benign targets only:** Notepad, Calculator, and windows you create yourself. Do not
>   inspect the operator's real applications, mail, or documents, and do not paste anything they
>   contain into findings.
> - **Additional surface (9):** for each finding, say whether it would be **inherited by spec
>   AS**. For example, a scope escape in `desktop.inspect` becomes a scope escape for an approved
>   click. Mark those `AS-inherited`; they decide whether AS can proceed.
> - **Deliverable mechanics:** append the report below the line at the end of this file. Commit on
>   branch `review/ar-adversarial` (it already holds this update), push it, and open a PR into
>   `main` titled `review(AR): adversarial security review`. Do not fix code in the same PR. Each
>   fix gets its own slice after triage.
> - **Verification to record in the PR:** `npm ci`, `npx tsc --build`, and
>   `node --test packages/adapters-desktop/dist/test/*.test.js` run natively, with the
>   pass/fail/skip counts. A skip is a finding.
> - **Constraints:** public repository. No secrets, tokens, local user paths, hostnames, or
>   screenshots of real desktops in anything you commit. One agent per working tree.

**This is a SECURITY review, not a code review.** Functional correctness and the obvious code-level
issues were covered by the grok reviews on PRs #19/#20/#21. Assume the code does what it says; your
job is to break it. Think like an attacker who holds a **valid but minimal** job envelope (they can
call the discovery capabilities they were granted, nothing more) and wants to read something, reach
something, or take the node down that they should not.

## Target

The read-only discovery surface, all on `main`:
- `packages/node-core/src/main.ts` — coordinator-optional startup (T1, `228ce68`).
- `packages/adapters-machine/**` — `machine.inventory` (T2, `a9597e8`).
- `packages/adapters-desktop/**` — `desktop.state`, `desktop.inspect` (T3, `fb3701c`); `src/probe.ts`
  is the real PowerShell/UIA layer.
- Boundary code it rides on: `packages/policy`, `packages/registry`, `packages/node-core/src/core.ts`
  / `http.ts` / `routes-tools.ts` / `routes-operator.ts`, and `packages/contracts` (frozen).

Design promises to attack (from `docs/specs/AR-read-only-discovery.md`): read-only; **metadata only,
never a control value**; window titles and accessibility trees revealed **only** for
operator-allowlisted apps; opaque ids (native handles never leave); freshness tokens; discovery does
not authorize control; core works with no model credentials.

## Attack surfaces to probe (find holes, give concrete exploits)

1. **Content exfiltration.** Can a caller read window/control *content* it shouldn't? Look for any
   field carrying document/field contents; any `ValuePattern`/`.Value` read in `probe.ts` or the
   adapter; `name` leaking for an out-of-scope window; whether `Name` on Text/Document nodes is
   effectively content (accepted residual — assess the exposure); clipboard/cookies/screenshots.
2. **Scope escape.** Reach a window/app outside `authorized_apps`? Attack the inspect-time TOCTOU
   re-validation (reused native handle now owned by another process), freshness-token replay/forgery,
   opaque-id → native-handle inference, and the **single global current-enumeration** model: can
   caller B use caller A's `window_id`/`freshness_token`? Is there any cross-caller / cross-session
   isolation, and does its absence enable a read a caller shouldn't get?
3. **Injection.** In `DESKTOP_UIA_PS1`: is any untrusted value (window title, element name, handle)
   ever interpolated into script source, a shell, a path, or a `require`/`Add-Type`? Attack the
   `input.json` round-trip, the temp-dir path, and `execFile` arguments. Can a crafted window title
   or a malicious `native_handle`/`session_scope`/`control_filter` argument change what runs?
4. **Auth boundary.** Loopback is explicitly *not* authentication. With the coordinator OFF (T1),
   does any auth/policy/allowlist/envelope check weaken? Can a caller holding the run token approve
   its own action, mutate a sealed envelope, or invoke a capability outside `allowed_capabilities`?
   Is `operator_token !== token` truly enforced on every path the discovery surface touches?
5. **DoS / resource exhaustion.** Can a huge or cyclic UIA tree hang or exhaust the node? Assess the
   RuntimeId cycle guard, `depth`/`max_controls` bounds, the PowerShell timeout + child-kill on
   timeout/abort, temp-dir cleanup, and `maxBuffer`. Can a caller spin unbounded probes?
6. **Least privilege.** Does `desktop` do more than `process.spawn` + `app.automation`? Does
   `machine.inventory` probe beyond its fixed catalog (any fs-wide scan, registry sweep, secret or
   account enumeration)? Are declared `required_permissions` honest?
7. **Audit integrity.** Do receipts leak raw inspected content? Is `adapter_fields` restricted to the
   manifest's `receipt_fields`? Can an action avoid leaving a receipt?
8. **Contract integrity.** Confirm `packages/contracts` is unmodified by these slices.

## Deliverable

Severity-ranked findings, each with a concrete exploit scenario (inputs → what leaks/breaks) and a
file:line. Then an explicit verdict: **is the desktop data surface safe to enable in production**
(with `authorized_apps` configured), or what must change first. Append the report below this line.

---

<!-- security review findings go here -->

## Independent adversarial security review — 2026-10-13

**Verdict: do not enable the desktop discovery surface in production, and do not
enable spec AS clicking or typing on top of it.** A benign native Windows fixture
demonstrated that `desktop.inspect` can disclose the exact contents of a genuinely
masked password field through `AutomationElement.Current.Name`. The implementation
also fails to apply envelope scope to the configured app allowlist, conditionally
permits operator and run credentials to be the same, and stores freshness handles
without job, caller, or session provenance.

### Verification conditions

- Native Windows 11 build 26200, Node.js 24.13.1, unlocked interactive desktop.
  Only a self-created visible WinForms fixture was inspected; its handle, process,
  and title were known in advance and matched. A fixture-only enumeration seam
  avoided reading the operator's applications.
- `npm ci`: exit 0; zero vulnerabilities.
- `npx tsc --build`: exit 0.
- `node --test packages/adapters-desktop/dist/test/*.test.js`: **19 passed, 0
  failed, 0 skipped**. The required native rerun was used after a sandboxed runner
  could not spawn; the suite uses a fake probe and therefore is not evidence of
  real UI Automation behaviour.
- Additional native Core boundary regression selection: **98 passed, 0 failed,
  0 skipped**.

### High — AR-01: masked password values and off-client text leak through UIA `Name`

**Evidence:** demonstrated natively against the isolated fixture.

**Exploit:** an allowlisted fixture was inspected using the unmodified production
`createPowerShellUiaProbe(...).inspectWindow`. A `TextBox` configured with
`UseSystemPasswordChar=true` had its exact benign password canary returned as a
public `name`. Native checks confirmed `ES_PASSWORD` and a nonzero
`EM_GETPASSWORDCHAR`. UIA nevertheless exposed it as `ControlType.Pane` with
`IsPassword=false`. A label beyond the bottom of the form client area was also
returned as a Pane name while UIA reported `IsOffscreen=false`.

The probe reads `Current.Name` for every traversed control and the adapter publishes
it. It does not call `ValuePattern.Value`, but that does not protect the content.
Checking `IsPassword`, omitting only `Edit` or `Document`, or trusting
`IsOffscreen` would not prevent this demonstrated provider behaviour.

**Code:** `packages/adapters-desktop/src/probe.ts:95-100`;
`packages/adapters-desktop/src/adapter.ts:398-405`;
`docs/specs/AR-read-only-discovery.md:127-129,164-170`.

**AS inheritance:** **AS-inherited.** AS would consume this disclosure before any
mutation.

### High — AR-02: the envelope cannot narrow the global app allowlist

**Evidence:** demonstrated through the real Core/policy/adapter path with the
fixture-only enumeration seam.

**Exploit:** globally allowlist the fixture process, then create a job allowing
`desktop.state` and `desktop.inspect` with that process name in `forbidden`.
`desktop.state` still returns its title as in scope and `desktop.inspect` returns
its controls. Policy scans the capability and caller arguments, neither of which
contains the resolved process identity; the adapter consults only global
`authorized_apps`. A generic desktop grant can therefore read every globally
allowlisted app even where the envelope is intended to exclude one.

**Code:** `packages/adapters-desktop/src/adapter.ts:57-60,255-275,365-405`;
`packages/node-core/src/main.ts:192-200`; `packages/policy/src/index.ts:200-220`.

**AS inheritance:** **AS-inherited.** A later AS action could target an application
the job forbids.

### High — AR-03: operator/run credential separation is conditional

**Evidence:** demonstrated through native Core HTTP integration.

**Exploit:** configure `operator_token` equal to the ordinary node token while
`approval_required` is empty and all actions have `always_requires_approval:false`.
Core starts because token strength and distinctness are checked only when a gated
capability exists. The ordinary bearer then received HTTP 200 from `/operator/jobs`,
created a new benign inventory job through `/operator/create_job`, and executed it.
With distinct credentials, the ordinary bearer correctly received HTTP 401 from the
operator route.

**Code:** `packages/node-core/src/core.ts:127-141,239-251`;
`packages/node-core/src/http.ts:176-195,216-227`.

**AS inheritance:** **AS-inherited.** The ordinary caller could create the job or
operator decision that grants future AS actions.

### High — AR-04: `session_scope` is accepted but never enforced

**Evidence:** **unverified (static only)** for cross-session UIA behaviour.

**Exploit:** a job allowed `desktop.state` submits `{"session_scope":"an-unauthorized-or-nonexistent-session"}`. The adapter forwards the value, but the PowerShell script never reads it; it enumerates the desktop visible to Node Core/PowerShell and can return opaque ids and allowlisted titles without authenticating the requested session. The probe can report `locked`, but has no requested-session validation or `disconnected` path.

**Code:** `packages/adapters-desktop/src/adapter.ts:214-224`; `packages/adapters-desktop/src/probe.ts:47-69,189-200`.

**AS inheritance:** **AS-inherited.** Mutation would act on the process-visible desktop, not a proven authorized session.

### Medium — AR-05: freshness handles are global, cross-job, and replayable

**Evidence:** cross-job use, replay, and invalidation demonstrated through Core integration; same-process native-handle reuse is **unverified (static only)**.

**Exploit:** job A, allowed only `desktop.state`, obtains a `window_id` and `freshness_token`. Job B, allowed only `desktop.inspect`, submits A's pair and successfully inspects the window; B can replay it repeatedly. A state call from a third job replaces the one global enumeration and makes A's pair `refresh_required`, allowing any state-capable job to invalidate others' handles. The stored enumeration has no job, caller, session scope, issuance time, or consumed flag. The TOCTOU check compares only process basenames, so reuse by another window in the same process would pass.

**Code:** `packages/adapters-desktop/src/adapter.ts:83-94,157-161,280,332-377`.

**AS inheritance:** **AS-inherited.** These bearer handles are unsafe selectors for click/type.

### Medium — AR-06: pathless actions can leave a false running receipt

**Evidence:** demonstrated through Core integration.

**Exploit:** invoke `machine.inventory` without wrapper `workspace_id`. Policy allows the null workspace for this pathless action. The pipeline spends budget, appends `action.started`, and persists a `running` receipt; its later workspace lookup throws `E_WORKSPACE_DENIED` outside the adapter try/catch. The receipt stays `running` with no `ended_at` or `action.finished`. Repeating consumes action budget and creates false in-flight audit records.

**Code:** `packages/node-core/src/action-pipeline.ts:121-128,192-201,251-266,280-316`; `packages/policy/src/index.ts:208-220`.

**AS inheritance:** **AS-inherited** for pathless AS/app actions through this pipeline.

### Medium — AR-07: cancellation and output bounds are not enforced end to end

**Evidence:** pre-abort and short timeout behaviour demonstrated natively; exhaustion is **unverified (static only)**.

**Exploit:** Core gives the adapter a fresh `AbortSignal` that it never aborts and does not race `adapter.invoke` against the declared timeout. A real pre-aborted desktop probe still returned one control because `runPowerShell` registers an abort listener without first checking `signal.aborted`. Its local 10 ms timer did reject, which does not add Core-level cancellation. UIA enumeration/serialization happens before `max_windows`; sibling collection can precede `max_controls`; names and file-backed JSON have no byte limit; and temp cleanup is unawaited with errors swallowed. A native long-name attempt did not exhaust memory, so that portion remains static only.

**Code:** `packages/node-core/src/action-pipeline.ts:264-300`; `packages/adapters-desktop/src/probe.ts:44-49,56-69,84-108,128-178`.

**AS inheritance:** **AS-inherited.** AS shares the Core cancellation and UIA output path.

### Medium — AR-08: inventory's PATH walk can make undeclared network I/O

**Evidence:** **unverified (static only)**.

**Exploit:** a stale or attacker-influenced UNC directory in `PATH` is checked by each executable probe's `fs.access`, which can block on resolution and initiate SMB authentication. The adapter checks its signal only between accesses, while Core does not schedule an abort for the manifest timeout.

**Code:** `packages/adapters-machine/src/adapter.ts:106-147,154-179,205-253`; `packages/node-core/src/action-pipeline.ts:264-300`.

**AS inheritance:** the generic timeout gap in AR-07 is **AS-inherited**; this PATH trigger is inventory-specific.

### Low — AR-09: inventory reports adapters outside the job allowlist

**Evidence:** demonstrated through Core integration.

**Exploit:** a job whose only capability is `machine.inventory` still receives the registered desktop adapter, despite having no desktop capability. The adapter receives only global registered ids and has no `unauthorized` readiness state, unlike `list_capabilities`, which is envelope-filtered.

**Code:** `packages/adapters-machine/src/adapter.ts:87-100,226-290`; `packages/node-core/src/main.ts:237-251`; `packages/node-core/src/routes-tools.ts:52-55`.

**AS inheritance:** not directly AS-inherited; this is a node-readiness metadata leak.

### Low — AR-10: process-basename allowlisting is spoofable

**Evidence:** **unverified (static only)**.

**Exploit:** a local executable runs under an allowlisted basename. UIA returns only `Get-Process(...).ProcessName`, which is case-normalized and stripped of `.exe`; no executable path, package identity, signer, bound PID, or pinned instance is checked. The spoofed process would be marked in scope. This needs local process execution but becomes material if this identity check later authorizes mutation.

**Code:** `packages/adapters-desktop/src/probe.ts:61-66,76-84`; `packages/adapters-desktop/src/adapter.ts:52-60,365-377`.

**AS inheritance:** **AS-inherited.** Basename equality is inadequate authority for a click/type target.

### Low — AR-11: the desktop manifest omits filesystem authority

**Evidence:** demonstrated from source control flow.

**Exploit:** the manifest declares only `process.spawn` and `app.automation`, without a resource. Each probe creates a temp directory, writes PowerShell and input JSON, reads output JSON, then recursively deletes it. The paths are internally generated, so this is authority/audit drift rather than arbitrary filesystem access, but the manifest is not an honest account of its `fs.read` and `fs.write` use.

**Code:** `packages/adapters-desktop/src/adapter.ts:140-149`; `packages/adapters-desktop/src/probe.ts:128-175`; `packages/contracts/src/capability.ts:17-28,39-52`.

**AS inheritance:** **AS-inherited** wherever AS reuses this probe mechanism.

### Positive coverage and proof limits

- No caller- or UI-controlled value reached PowerShell source, a shell command, a path, `Add-Type`, or `require`: input uses fixed-script JSON and `execFile` with `shell:false`. An unexpected `native_handle` parameter was rejected with `E_SCHEMA`.
- No bearer returned HTTP 401; `Origin` returned 403; an unallowed capability returned `E_CAP_NOT_ALLOWED`; and a caller envelope override could not widen the stored envelope.
- Receipts held counts, status, depth, and truncation only. Fixture titles and all benign canaries were absent; undeclared adapter receipt fields are rejected.
- The script uses UIA getters/tree walking only: no click, type, clipboard, screenshot, or `ValuePattern.Value` call was found. Public ids are random opaque ids rather than native handles/runtime ids.
- The current public tree has the same `packages/contracts` tree object as `public/main`. Historical proof that contracts were untouched in the earlier, pre-squash private slices is unavailable from the public history.

### Required remediation before enablement

1. Remove generic UIA `Name` from discovery results, or replace it with explicit, app/control rules that fail closed. Do not rely only on control type, `IsPassword`, or `IsOffscreen`.
2. Bind discovery to a verified OS interactive session, a policy-visible resolved app identity, and the exact job/caller that minted the handle. Use an identity stronger than process basename.
3. Require strong, distinct operator credentials whenever the operator surface exists. Repair pathless-action failure handling before budget spend and ensure all post-start errors close receipts.
4. Enforce Core-level cancellation/timeouts, honor already-aborted signals, bound field and serialized output sizes, await cleanup, bound executable probing to local paths, and filter inventory to the job allowlist.

Until these controls are implemented and independently re-reviewed on native fixtures, the desktop data surface and spec AS are **not safe to enable**.
