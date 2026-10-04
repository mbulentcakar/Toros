# AR — adversarial security review (T4)

**Reviewer requirement:** a **third lineage — GPT-5.6 or Gemini-3**. **Not grok, not deepseek**
(deepseek implemented these slices; grok did the code reviews — using either here defeats the
independence the lineage rule exists for). Run against a checkout of `main` at or after `fb3701c`.

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
