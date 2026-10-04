# Security and safety review — 2026-09-03

Reviewer: Claude (Opus 5), single pass, unassisted.
Base: `main` at `d86924b`, plus the uncommitted spec backlog now in PR 7 and
the orientation tool in PR 8.
Occasion: the operator intends to make this repository public.

This is **one** review round by one reviewer. `AGENTS.md` requires an
independent reviewer before acceptance, and this document is not that for its
own findings.

## Method

- Read every security-load-bearing path: authentication and credential
  lifecycle, the policy decision order and path containment, the registry's
  schema compilation, all four adapters, the stage graph's handoff copying, the
  relay's scanner and tar writer, the observer's redactor, and the cockpit's
  Rust IPC boundary.
- Executed probes rather than reasoning about behaviour, where behaviour was
  the question: Windows path resolution for drive-relative and UNC forms, Ajv's
  treatment of inherited properties, and one full request through the real
  loopback service.
- Scanned the entire git history (1625 objects, all refs) for credential
  shapes, high-entropy strings, and secret-bearing filenames.
- Grepped for the usual sinks: dynamic SQL, `innerHTML`, shell invocation,
  dynamic-key assignment, prototype pollution.

## Summary

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | **Medium** | A `__proto__` key in a request body splits one object into two views: Ajv validates it, every audit and gate sees `{}` | **Confirmed by measurement. Fixed in PR 9.** |
| 2 | Low | The Chrome extension holds the `tabs` permission, which reads the URL and title of every open tab | Open |
| 3 | Low | A revoked run credential stops being redacted from persisted conversation turns | Open |
| 4 | Low | The Excel adapter resolves `powershell.exe` through `PATH` rather than an absolute System32 path | Open |
| 5 | Low | The extension's `host_permissions` cover all of loopback, not the configured port | Open |
| 6 | Info | The advisory-credential lookup is a hash-map `get`, not a constant-time comparison | Accept |
| 7 | Info | Policy's containment decision is check-then-use against the filesystem | Accept, document |
| 8 | Info | The cockpit WebView holds full operator authority through one IPC command | Accept, documented risk |
| 9 | Info | `redactSecrets` matches exact substrings only | Known — spec AG |
| 10 | Info | Drive-relative paths are contained for a reason the code does not state | Document |
| 11 | Info | No rate limit on the loopback surface | Accept |

**History is clean.** No credential, key, `.env`, or real `config.json` has
ever been committed on any ref. Every match for a credential pattern is either
the relay's own scanner rules, a test fixture, or a SHA-256 digest. Verified
across all refs, not just `main`.

The public-repo blockers are in [their own section](#public-repository-readiness)
and are documentation and licensing, not code.

## What the design gets right

This matters for calibration: the findings below are small because the
structure underneath them is sound, and a reader who skips this section will
over-read them.

- **The boundary is in the right place, and it is deterministic.** Policy
  decides; the model proposes. Every gate — expiry, budget, retries,
  registration, capability allowlist, forbidden terms, workspace, containment,
  approval — is a separate ordered check in one 247-line file with no model in
  the loop.
- **Path containment is unusually careful.** Candidate and root both go through
  `fs.realpathSync.native`, deliberately, with a comment explaining that a JS
  and a native resolver disagreeing on junctions or 8.3 names fails in both
  directions. Comparison is by path segment, not string prefix, so `C:\a\bc`
  does not pass as contained in `C:\a\b`. Missing tail components are walked
  rather than assumed. Probed: `C:evil`, `\\server\share`, `\\?\`, `/abs`, and
  device names are each refused.
- **Two credentials, and the split is enforced.** Node Core refuses to start if
  `approval_required` is non-empty without an `operator_token` that differs
  from `token` — because a gate the gated party can open is not a gate, and a
  gate nobody can open is a broken node that looks like a working one. Both
  comparisons are `timingSafeEqual`.
- **The approval carries its arguments, not only their digest.** The module
  says why: with a hash on screen, the only account of what the action does
  comes from the untrusted party that requested it. Cryptographically the right
  bytes execute; practically the human authorised something they never saw.
  Very few systems get this right.
- **The Excel adapter has no injection surface.** A fixed, parameter-free
  PowerShell script is written verbatim, every input arrives in `input.json`,
  and the spawn is `shell: false`. Nothing is interpolated anywhere.
- **The CLI adapter refuses `.cmd` and `.bat`.** Correct: a `.cmd` is
  interpreted by `cmd.exe`, where an argument list is not a boundary. It also
  pins its own sandbox and permission mode and refuses configured arguments
  that would override them.
- **The stage graph's handoffs refuse symbolic links** and credential-like
  filenames, exclude `.git` and `node_modules`, and cap files and bytes.
- **The Chrome worker allowlists by host with a leading dot** (`host === domain
  || host.endsWith('.' + domain)`), so `evil-example.com` does not pass for `example.com`;
  it is HTTPS-only, strips URL userinfo, and re-validates the URL the worker
  reports back.
- **The cockpit's Rust layer is a fixed operation-to-path allowlist.** Neither
  bearer reaches the WebView; the CSP has no `unsafe-eval` and restricts
  `connect-src` to loopback; the frontend is React with no `innerHTML` sink
  anywhere; and its own tests assert the token never appears in rendered HTML.
  The scheduled-task command has no operator-controlled executable, task name,
  or argument, and uses an absolute `System32\schtasks.exe`.
- **The observer redacts by copy-allowlist, not strip-denylist**, so an
  unrecognised Numbat field is excluded by default rather than included by
  omission.
- **All SQL is parameterised.** 34 prepared statements, no interpolation.

---

## Findings

### 1. A `__proto__` key in a request body splits one object into two views

**Severity: Medium. Confirmed by measurement. Fixed in PR 9.**

`normalizeParsed` runs on every HTTP body and rebuilds each parsed object so
that the executed value equals the digested value. One key defeats the rebuild.
`JSON.parse` produces `__proto__` as an ordinary own property, but assigning it
to a plain object sets that object's *prototype* instead of adding a property:

```js
const args = normalizeParsed(JSON.parse('{"__proto__":{"label":"smuggled"}}'));
Object.keys(args)      // []
JSON.stringify(args)   // {}
args.label             // 'smuggled'
```

Everything that audits or gates reads the own-property view —
`arguments_digest`, the receipt, the operator's approval screen, and policy's
`containsForbidden`, which walks `Object.values`. Ajv reads the other one:
`required` is satisfied through the prototype chain and `additionalProperties:
false` sees no extra own key, so the object validates.

Measured through `/tools/invoke_app_action` against the real loopback service,
with an authenticated coordinator credential and the entire `parameters` object
smuggled:

```text
HTTP status                : 200
own keys the audit can see : []
```

**Why medium and not high.** The smuggled value does not reach an adapter
today. `executedArgs` passes through `resolvePathArgs`, whose `{ ...args }`
spread copies own properties only and discards the poisoned prototype. There is
exactly one `adapter.invoke` call site, and the branch that bypasses the spread
requires an unregistered capability, which policy denies first. So this is not
code execution.

What is live:

1. **Schema validation can be satisfied by data that never executes.** A
   `required` field supplied through `__proto__` passes the registry and
   arrives at the adapter as `undefined`. Excel and the CLI adapters
   re-validate and are unaffected; an adapter that trusts the registry's
   certification would not be.
2. **Policy decides containment for a path the adapter never receives.**
   `paths()` uses `args[field]`, and bracket access reads the prototype, so
   containment is computed over a value that is then thrown away. Fail-safe in
   direction, but it is exactly the decided-versus-executed divergence that the
   comment above `executedArgs` says it closed.
3. **The only barrier is incidental.** An object spread inside a helper whose
   stated purpose is path resolution — not sanitisation — and which nobody
   would think to preserve while refactoring.

**Fix, in PR 9:** refuse the key at the parse boundary, and refuse rather than
skip — silently dropping it leaves point 1 intact. `constructor` and
`prototype` assign normally and are untouched, which a test asserts.

### 2. The Chrome extension can read the URL and title of every open tab

**Severity: Low. Open.**

`apps/chrome-worker-extension/manifest.json` requests the `tabs` permission.
`optional_host_permissions` correctly forces a per-site grant for *acting* on a
page, and `docs/DEPLOY.md` describes the model as the operator granting "the
current origin only". But `tabs` is a separate grant that yields the URL and
title of every tab in the profile, allowlist or not, from install onward and
with no per-site prompt.

Nothing in the extension appears to exfiltrate that, and Node Core's
`browser_status` surface reports the paired tab only. The finding is the
capability, not a use of it: the extension's stated model is narrower than its
manifest, and a reviewer reading the manifest first would conclude the
opposite.

**Recommendation.** Establish whether `tabs` is needed at all — `activeTab`
plus the granted host permission covers acting on the selected tab, and
`chrome.tabs.query` on a granted origin returns the URL without the broad
grant. If it is needed, say so in `docs/specs/AB-chrome-worker.md` and in
DEPLOY.md's four-gesture description, so the operator grants it knowingly.

### 3. A revoked run credential stops being redacted

**Severity: Low. Open.**

```ts
const secrets = [this.options.token, this.options.operator_token, ...this.runTokens.keys()];
```

`redactSecrets` enumerates the credentials that are *live*. Revocation deletes
the run token from `runTokens`, so from that moment the value is no longer
redacted from anything written afterwards. A turn persisted during the shutdown
window — after `onRunEnded` fires and before the child's last write is
processed — would store the credential in clear text in the durable
conversation.

The credential is dead by then, so this is disclosure of an expired secret
rather than an active one. It matters because the durable conversation is
rehydrated into later model context: a dead token in the transcript teaches the
model what a Toros credential looks like, and it survives in the database.

**Recommendation.** Keep revoked tokens in a bounded set (last N, or a
time-window) purely for redaction. Spec AG's pattern-based redaction would also
cover it, and is the better fix if AG is taken.

### 4. The Excel adapter resolves `powershell.exe` through `PATH`

**Severity: Low. Open.**

```ts
spawn('powershell.exe', ['-NoProfile', ..., '-File', scriptPath], { shell: false, ... })
```

Everything about this call is right except the first argument. The name is
resolved through the inherited `PATH`, so anything earlier on that path named
`powershell.exe` runs instead — with the operator's token in reach, since this
child is spawned by Node Core rather than by the minimal-environment CLI path.

Exploiting it needs write access to a `PATH` directory, which is close to
already owning the account, so the severity is low. But the fix is free, the
cockpit already sets the precedent by building an absolute
`%SystemRoot%\System32\schtasks.exe`, and Node Core is the one process in this
system that should never be the weak link.

**Recommendation.** Build the path from `SystemRoot`, matching
`start_scheduled_node_core`.

### 5. The extension may reach any loopback port

**Severity: Low. Open.**

`host_permissions: ["http://127.0.0.1/*"]` grants the extension access to every
service on loopback, not to the port Node Core is configured on. Chrome's
manifest match patterns cannot express a port, so this cannot be tightened
there — but it is worth recording, because a reader reasonably assumes the
extension can only talk to Toros. The pairing token bounds what Node Core will
*accept*; it does not bound where the extension may *speak*.

**Recommendation.** Record the limitation in spec AB rather than leaving it to
be rediscovered.

### 6. The advisory-credential lookup is not constant time

**Severity: Informational. Accept.**

`authenticate` compares against the node token with `timingSafeEqual`, then
falls through to `this.runTokens.get(supplied)` — a hash-map lookup, whose
timing depends on the key. Recovering a 256-bit token through V8 Map timing
over loopback is not a practical attack, and the surface is loopback-only.
Recorded so that a future reviewer does not have to re-derive that it was
considered.

### 7. Containment is check-then-use against the filesystem

**Severity: Informational. Accept and document.**

`pathIsContained` resolves symlinks with `realpath` at decision time; the
adapter acts afterwards. A worker with write access inside the workspace — which
every CLI worker has — can replace a component with a symlink in the interval
and cause the write to land outside.

This is inherent to path-based authorisation without an OS-level handle
(`O_PATH`, or opening the directory and using `*at` syscalls), and closing it
properly is a different design, not a patch. SPEC §8.1 already states that
Toros bounds its own tool surface rather than confining the worker, so this
sits inside a limitation the specification owns.

**Recommendation.** Name it explicitly in `docs/specs/D-policy.md` alongside
the containment rules, so nobody reads the realpath care as stronger than it
is.

### 8. The cockpit WebView holds full operator authority

**Severity: Informational. Accept — but state it.**

`node_core_request` takes a `serde_json::Value` body verbatim from the WebView
and forwards it, with the operator bearer, to any allowlisted operation —
including `operator_create_job` and `operator_accept_proposal`. That is the
design: the cockpit *is* the operator surface. The consequence is that script
execution in the WebView equals operator authority, and the operator credential
is the one thing the architecture holds back from the coordinator.

The mitigations in place are genuine and layered: React's escaping, no
`innerHTML` sink in the codebase, a CSP with `default-src 'self'` and no
`unsafe-eval`, and the fact that neither bearer is reachable from JavaScript.
Untrusted content — CLI stdout, page titles from the Chrome worker, model prose
— reaches the page as text bindings.

**Recommendation.** Record it in SPEC §8.1 as an explicit trust assumption. Two
concrete hardenings if it is ever worth more: tighten `connect-src` from
`http://127.0.0.1:*` to the configured port, and consider whether
`operator_create_job` and `operator_accept_proposal` should require a
per-action confirmation the WebView cannot synthesise.

### 9. `redactSecrets` matches exact substrings only

**Severity: Informational. Known — spec AG.**

Redaction is `content.split(secret).join('[redacted]')`. Any transformation —
base64, hex, URL-encoding, a newline inserted mid-token — passes through. Spec
AG (now in PR 7) proposes pattern-based redaction and is the right answer.
Recorded here so the review is complete, not as a new finding.

### 10. Drive-relative paths are contained for an unstated reason

**Severity: Informational. Document.**

`path.resolve(root, 'C:evil')` yields `C:\evil` — it ignores `root` entirely,
because a Windows drive-relative path resolves against the *process* working
directory for that drive. Containment then denies it, correctly, because the
segment comparison fails. But the denial depends on where Node Core happens to
be running, not on anything the code asserts, and `hasWindowsUnsafeSyntax`
blocks UNC, `\\?\`, NUL, and device names without mentioning this form.

Probed: `C:evil`, `F:evil`, `\\abs`, and `/abs` are all denied under the
current layout.

**Recommendation.** Either reject a drive-relative path explicitly in
`hasWindowsUnsafeSyntax` — it is a two-line regex and removes the dependency on
cwd — or note in `D-policy.md` why it is safe. Also worth considering: a colon
inside a segment (`file.xlsx:stream`) selects an NTFS alternate data stream. It
cannot escape containment, since the stream belongs to the contained file, but
content written there is invisible to an ordinary directory listing.

### 11. No rate limit on the loopback surface

**Severity: Informational. Accept.**

Bodies are capped at 1 MiB and live approvals at 256 (32 per job, with a
comment noting that a denied action never charges the action budget, so asking
for approval is free). There is no request-rate limit. On a loopback-only
service whose only clients are the local coordinator and the local cockpit,
that is the right trade: a compromised local caller has better options than
flooding a socket.

---

## The systemic risk, which is not a finding

The largest residual risk in Toros is not a defect. It is that a CLI worker's
output reaches the coordinator's context, and that output is attacker-influenced
whenever the worker reads a file, a page, or a repository that someone else
wrote. Injected text there shapes what Hermes says and what it proposes.

The architecture answers this correctly and deliberately:

- an injected instruction can only make the model *propose*; policy decides, and
  policy has no model in it;
- an advisory run authenticates as itself, with `propose_job`, `list_turns`, and
  `append_turn` and nothing else, so no world-touching tool is reachable before
  a human confirms;
- spec AO's proposal card renders the requested permissions as a read-only list
  *beside* the model's own prose, so persuasive text sits next to the capability
  list it is trying to justify;
- `accept_proposal` seals the proposal Node Core recorded, which must be the
  conversation's last turn, so a stale or forged card seals nothing.

The remaining gap is human: an operator who reads the plan and not the
permission list. That is a UI property, and AO is the right place for it. Worth
one concrete addition: when a proposal requests a capability the operator has
not previously granted in this conversation, mark it as new. The set difference
is cheap and it puts the reader's attention where the escalation would be.

---

## Public repository readiness

These are the items to close before flipping visibility. None is a code defect.

### Blocking

1. **There is no LICENSE.** Without one, the default is exclusive copyright:
   nobody may copy, modify, or contribute, and the repository is
   look-only-at-your-own-risk. This is the single item that most changes what
   publishing means. Note that the reciprocal question also needs an answer —
   what licence *inbound* contributions arrive under — for which the
   conventional answer is the same licence, stated in `CONTRIBUTING.md`.

2. **`docs/DEPLOY.md` publishes the operator's Windows account layout.** Five
   occurrences of `C:\Users\<operator>\...`, plus the npm global path, the WinGet
   links path, and the `.claude/settings.local.json` location. It also names
   the machine (`oruc`) and its exact toolchain versions. Replace with
   `%LOCALAPPDATA%`, `%APPDATA%`, and `<your-user>` placeholders. Same for the
   one occurrence in the Chrome worker handoff note (since removed).

3. **`docs/PHASE-2-PLAN.md` publishes Tailscale node addresses** —
   `<tailscale address>` (yoga) and `<tailscale address>` (hetzner2) [addresses redacted for publication] — alongside a
   description of the credential gap between them. These are private overlay
   addresses, so the exposure is modest, but publishing a host address next to
   a note about its missing credential is a poor combination. Replace with
   role names.

4. **`docs/USE-CASES.md` (in PR 7) names four internal production
   hostnames** and the products behind them. Fine while private; scrub or
   generalise before publishing.

### Should have

5. **No `SECURITY.md`.** A repository describing a policy boundary, an
   approval gate, and a credential model needs a stated way to report a
   vulnerability privately. GitHub private vulnerability reporting plus a
   contact line is enough.

6. **No CI.** Every verification in this repository's history is a manually run
   command whose result was manually transcribed into `STATUS.md`. Spec AJ (PR
   7) and draft PR 5 already cover this; the prerequisite AJ names — real-binary
   suites must self-skip loudly — is also what makes the three known failures
   legible to a stranger instead of looking like a broken project. Right now a
   newcomer's first `npm test` shows three failures with no explanation.

7. **No `CONTRIBUTING.md`.** `AGENTS.md` is excellent and is written for
   agents. A human contributor needs the build-and-verify path, the Windows-only
   rule, the spec-per-slice convention, and the review gate.

8. **The README claimed the project was specification-only** while an installed
   system was running. Fixed in PR 8; noted here because it was the first thing
   any reader would have seen.

### Verified clean

- No credential, private key, `.env`, or real `config.json` on any ref, ever.
  1625 objects across all refs, checked against credential-shape patterns,
  48+-character hex runs, long base64 runs, and secret-bearing filenames. Every
  hit is the relay's own scanner rules, a test fixture, or a SHA-256 digest.
- `.gitignore` correctly anchors its runtime-state rules with a leading slash,
  with a comment recording that the unanchored form silently excluded
  `packages/relay` from a commit.
- The relay refuses to build a capsule containing a secret-pattern match, and
  records `content_scanned: false` in the manifest for files over 8 MiB rather
  than implying a scan it did not perform. That is the right way to have a
  limit.

---

## What this review did not cover

- **The Tauri frontend's own logic** beyond XSS sinks, credential handling, and
  the IPC boundary. 43 UI tests pass; I did not audit the views.
- **Dependency supply chain.** No `npm audit`, no lockfile provenance review,
  no check of the Rust crate graph.
- **The chrome extension's `background.js` and `popup.js`** beyond the manifest
  and the pairing protocol as Node Core implements it.
- **Numbat**, which is external and monitor-only by design.
- **Relay transport**, which is Phase 2 and not yet implemented.
- **Live behaviour of an installed node.** No node is installed on this machine
  — which is itself the observation that motivated the orientation tool in
  PR 8.
- **Re-checking finding 1's fix independently.** I wrote it; someone else should
  confirm it.
