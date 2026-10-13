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
