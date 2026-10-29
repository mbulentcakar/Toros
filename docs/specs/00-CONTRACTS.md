# 00 — Contracts brief

**Every implementer reads this before their unit spec. It is short on purpose.**

You are building one unit of Toros Phase 1. Ten other units are being built in parallel by
other people and other models. None of you will talk to each other. This document is what
makes that work.

---

## 1. The one rule that matters most

**`packages/contracts` is frozen. Do not edit any file under it.**

Not to add a field. Not to relax a type. Not to fix what looks like a bug. Your unit's
`forbidden_paths` includes it, the reviewer checks it, and a diff that touches it is rejected
regardless of how good the rest is.

If you genuinely cannot implement your spec without a contract change, you have found a gap in
the specification. **Stop and say so in your final message**, naming the exact type and what
is missing. Do not work around it, do not redeclare the type locally, and do not widen your
own types to compensate. A wrong guess here silently breaks the units built against the real
contract, and it will not be caught until integration.

## 2. What you may touch

Your unit spec has an **Allowed paths** section. That is the complete list. Creating files
outside it — including tests, fixtures, scripts, or config — is out of scope.

You may **read** anything in the repository. Reading `packages/contracts/src/*.ts` is expected;
those files carry comments explaining why each type is shaped the way it is, and the reasoning
is usually the answer to whatever you are about to ask.

## 3. The stack, pinned

- **TypeScript on Node 24**, ESM, `strict` plus `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Inherit `tsconfig.base.json`; do not
  loosen a compiler option to make an error go away.
- **`node:sqlite`** for storage. Built into Node 24 — do not add `better-sqlite3` or any other
  driver.
- **`node:test`** plus `node:assert/strict` for tests. No jest, no vitest, no chai.
- **Zero runtime dependencies.** The single exception is `ajv@8`, and only in
  `packages/registry`. If you believe you need a package, you have found a spec gap — see §1.
- Relative imports inside a package carry the **`.js` extension**, even from `.ts` sources.
  That is what `NodeNext` module resolution requires; `import './foo'` will not resolve.
- Import the contract as `@toros/contracts`, never by relative path into another package.

### Six things that will cost you a build if you skip them

These bit the first dispatch. They are environment facts, not design choices, so there is no
judgement to exercise — just do them.

1. **Build contracts before your own package, every time.**

   ```
   npm install
   npx tsc --build packages/contracts     # produces dist/index.d.ts
   npx tsc --build packages/<your-package>
   ```

   `@toros/contracts` resolves through its built output. Until that exists, every import of it
   fails with `TS2307: Cannot find module '@toros/contracts'` — which looks like a broken
   dependency and is really just a missing build step. Also add the project reference in your
   `tsconfig.json`, or the build graph will not know to rebuild it for you:

   ```jsonc
   { "references": [{ "path": "../contracts" }] }
   ```

   Note the emit layout when you copy `packages/contracts/package.json` as your template:
   `rootDir` is `.` so that `src/` and `test/` both compile, which puts the entrypoint at
   **`dist/src/index.js`**, not `dist/index.js`. Your `main`, `types`, and `exports` must point
   at `dist/src/…`. Tests land at `dist/test/…`, which is why the verification command globs
   there. Getting this wrong produces the same `TS2307` from your own consumers later.

2. **CommonJS packages need a default import under `NodeNext`.** Ajv is CJS, so
   `import Ajv from 'ajv'` gives you the namespace, not the constructor —
   `TS2709: Cannot use namespace 'Ajv' as a type` and
   `TS2351: This expression is not constructable`. Use the 2020 build's ESM entry:

   ```ts
   import { Ajv2020 } from 'ajv/dist/2020.js';
   ```

   Do not "fix" this by loosening `verbatimModuleSyntax` or adding `esModuleInterop`.

3. **`catch (err)` gives you `unknown`.** `useUnknownInCatchVariables` is on deliberately, so
   `err.code` is `TS18046`. Narrow before you touch it:

   ```ts
   import { TorosError } from '@toros/contracts';
   try { /* ... */ } catch (err) {
     assert.ok(err instanceof TorosError);
     assert.equal(err.code, ErrorCode.E_SCHEMA);
   }
   ```

   `node:assert`'s `assert.throws(fn, (err) => ...)` predicate form is usually tidier in tests.
   Do not cast to `any` and do not disable the flag — the narrowing is what makes the assertion
   actually check the type it claims to.

4. **Never ship a non-`.ts` asset your code reads at runtime.** `tsc` emits `.ts` and copies
   nothing else, so a `.sql`, `.json`, or `.txt` file under `src/` never reaches `dist/`. The
   package type-checks, then dies on first use with `ENOENT`. Fixing it properly would need a
   copy step, which means build tooling this project deliberately does not have. Static data is
   a TypeScript module exporting a string or an object — no build step, still reviewable, and
   it cannot go missing from a package that compiles.

5. **The target is Windows. Do not write a test that only passes under Linux.** The sandbox you
   run in is Linux over a Windows checkout, but every adapter here declares
   `platforms: ['win32']` and every verification run before merge is native Windows. A shell
   script with a `#!/bin/sh` shebang, a `chmod +x` that Windows ignores, a path assembled with
   `/`, a signal that does not exist on Windows — each of these passes in your sandbox and
   fails where it counts. When a test needs an executable, use `process.execPath` with the
   script as an argument.

6. **Compile and run before you report.** A submission that does not typecheck is rejected at
   review without being read, and one that typechecks but throws on the first call is worse —
   it looks finished. Running both commands is the cheapest thing you can do for yourself.

## 4. Two properties several units must agree on byte for byte

`canonicalize()` and `chainHash()` live in contracts precisely because independent
implementations of them would drift. **Call them. Never reimplement them**, not even a
"simpler" version for a test fixture.

- `canonicalize(value)` — RFC 8785. Key order is UTF-16 code units, not locale collation.
  `undefined` members and non-finite numbers are refused rather than silently rendered, because
  either would let two different values share one digest.
- `chainHash(prevHash, payload)` — mixes `prevHash` as its 64-character lowercase hex **text**,
  not as decoded bytes. Uppercase is rejected rather than normalised.

## 5. Error codes are an API

Deny paths are asserted on by tests, by the bakeoff harness, and by the cockpit. Use the
`ErrorCode` value the spec names for a condition, throw `TorosError`, and put the machine-
readable code in `code` — not in a formatted message string.

Never invent an error code. Never reuse one for a condition it was not defined for; each has a
comment saying what it means, and `E_ENVELOPE_INVALID` versus `E_ENVELOPE_DIGEST_MISMATCH` is a
representative example of a distinction that exists for a reason.

`TorosError.detail` must never contain a secret, a credential, or a raw transcript.

## 6. Tests

Your spec names the acceptance tests. Write those, and write them so they would **fail** if the
behaviour regressed — a test that passes against a stub implementation is worse than no test,
because it reports coverage that does not exist.

Two things the reviewer checks specifically:

- **A skip is a finding.** A green run that is mostly skips is not a pass. Do not skip a test
  because the environment is awkward; say so in your final message instead.
- **Assert on `error.code`**, not on message text.

Run `npx tsc --build <your-package>` and `node --test <your-package>/dist/test/*.test.js`
before you finish. Note in your final message that you ran them and what the counts were.

> Node 24 is installed in the sandbox, so both commands should work. If either genuinely
> cannot run, **say that plainly rather than reporting a pass you did not observe.** Your work
> is verified natively on Windows before it merges either way, and an unverified "tests pass"
> costs more to unwind than an honest "could not run".

## 7. What your unit is not allowed to assume

- **You are not the policy boundary.** Only `packages/policy` decides whether an action may
  execute. Adapters, the registry, the store, and the observer must not consult, cache, or
  second-guess a decision.
- **Findings are advisory.** Nothing outside the observer reads them, and nothing may deny an
  action because of one.
- **The model is never the boundary.** Do not write code whose safety depends on a model
  behaving reasonably.
- **Stop means stop.** When a job is in a terminal state, expired, or out of budget, the
  correct behaviour is to refuse — not to try a narrower version of the action.

## 8. Style

Match the surrounding code. `packages/contracts` is the reference for comment density and
naming: comments explain *why* a constraint exists, not what a line does. Follow that.

No `any`. No `as` casts to escape a type error — if a cast seems necessary, re-read the
contract, because it usually means the data is being threaded through the wrong shape.

## 9. When you finish

Your final message should state: what you implemented, the exact commands you ran and their
output counts, anything in the spec you found ambiguous and how you resolved it, and anything
you could not do. Being explicit about the last two is more useful than a confident summary —
the review is against the spec, and a known gap costs far less than a hidden one.

---

## 10. Amendments to the frozen contract

`packages/contracts` is frozen for the reason in §1: eleven units were being built in parallel
by people and models who could not talk to each other, and a unilateral contract change would
silently break units written against the real one.

**That freeze holds. It is not lifted here.** What follows is the record §1 asks for — "you have
found a gap in the specification… stop and say so, naming the exact type and what is missing" —
written down after the fact for changes made post-integration, by the architect, with every
consumer in the same diff and the full suite green. That is a different situation from a blind
parallel implementer, but it is not an exemption: the obligation to *state* the gap is what
§1 requires either way, and these were made without stating them until a review caught it.

Anything added here must be reflected in the unit specs it touches. An amendment that lives
only in code is the failure mode §1 exists to prevent.

### A1 — `ErrorCode.E_APPROVAL_INVALID` (2026-08-05)

**Gap.** `E_APPROVAL_REQUIRED` had to carry two different meanings: "the gate is asking you to
get approval" and "you presented something that does not authorise this". They call for
different responses — the first is a normal prompt, the second is the shape a bypass attempt
takes — and a log that cannot tell them apart cannot show the difference.

**Change.** One added member. No existing member changed meaning.

### A2 — `ApprovalBinding`, `ApprovalVerifier` in `ports.ts` (2026-08-05)

**Gap.** SPEC §8.1 rule 12 required operator approval but named no mechanism, so the original
implementation accepted any non-null token — a gate that `approval_token: "yes"` opened. Closing
it needs policy to *ask* something whether a presented approval authorises this exact action, and
policy must not own approval state: issuance is Node Core's, because only Node Core has the
operator surface.

**Change.** Two type-only additions, following the existing port pattern (`Store`,
`SecurityObserver`, `CapabilityRegistry` are all declared here and implemented elsewhere).
Nothing existing changed shape.

### A3 — `PolicyOptions.approvals` (spec D) (2026-08-05)

**Gap.** As A2, on the consuming side. Optional, and absent means *deny* — a policy that cannot
check approvals must not behave as though every approval checks out.

### A4 — `decide` is no longer pure (spec D) (2026-08-05)

Spec D states: *"`decide` is **synchronous and pure**. No I/O, no clock read (`now` is passed
in), no randomness. A verdict that depends on ambient state cannot be reproduced from a receipt."*

**Rule 12 now mutates**: `approvals.consume()` marks the approval spent.

**Why it cannot simply be moved out.** Approval is the last rule, so nothing can deny after it —
a consumed approval is always an allowed action. Splitting the check from the spend would let two
actions both verify before either spent, and one operator decision would authorise two. The
atomicity has to sit where the decision is made.

**What this costs.** Replaying `decide` against a receipt is no longer idempotent for a gated
action: the first replay would spend an approval, and a second would deny. Reproducing a *gated*
verdict from a receipt now requires reading `approval.requested`/`approval.resolved` from the
event log rather than re-running the decision. Ungated verdicts are unaffected, which is every
action unless `approval_required` is non-empty.

**Precedent.** Spec D already carves out one exception to purity, for the per-call realpath in
the containment rule ("this rule reads the filesystem, which sits awkwardly with `decide` is
pure"). This is a second, and it is a mutation rather than a read, which is why it is recorded
here rather than left as a note.

### A5 — `NodeCoreOptions.observer` widened, `operator_token` added (spec G) (2026-08-05)

**Gap.** `observer` was `SecurityObserver | null`, which forced `main.ts` to construct an
observer before the store existed — so it passed `resolveSession: () => null` and SPEC §8.2
routes 1 and 3 were inert in the deployed service while every unit test exercised them with a
real resolver. A correlating observer cannot be built before the thing it correlates against.

**Change.** `observer` also accepts a factory taking `ObserverDeps`. The old form still works.
`operator_token` is new and optional, required only when a capability is gated.

### A6 — `Receipt.adapter_fields` (2026-08-09)

**Gap.** `ActionResult.receipt_extra` and `AdapterManifest.receipt_fields` were
specified, but `Receipt` and the receipts table had nowhere to store them. Node
Core consumed `bytes_read` as transient state and discarded every audit value,
including CLI conversation ids and Excel process ids.

**Change.** `Receipt.adapter_fields` stores adapter-specific JSON values. Node
Core accepts only keys declared in `manifest.receipt_fields`; an undeclared key
is `E_ADAPTER_FAILURE`, not silently omitted. Store migration 002 adds the
durable column, and existing version-1 databases receive an empty object for
historical receipts.

### A7 — desktop control: event kinds, `E_APPROVAL_DENIED`, delegated-approval semantics (spec AS) — PROPOSED

**Status: proposed with spec AS (2026-10-13). Not in effect.** It is made by the architect in
slice AS0, with every consumer in the same diff and the full suite green. An implementation
worker on any other AS slice still treats `packages/contracts` as frozen.

**Gap.** Spec AS needs events the closed `EventKind` union cannot express, a denial outcome no
code describes (there is no deny path today, only approve or expire), and approvals decided by
someone other than a human. The independent review (AS-B7) inventoried the following.

| Contract type | Change |
|---|---|
| `EventKind` (`receipt.ts`) | **Structural.** Add `mission.created`, `mission.held`, `mission.resumed`, `mission.ended`, `mission.invalidated`, `desktop.request_received`, `desktop.request_rejected`, `desktop.request_classified`, `desktop.request_authorized`, `desktop.request_reported`, `desktop.request_invalidated`, `desktop.app_granted`, `desktop.app_denied`, `desktop.outcome_uncertain`, `desktop.outcome_unknown`. This is the complete list (spec AS revision 5, stage→event table). The lifecycle stages `replayed`, `policy_allowed` and `executed` use the existing `action.requested`, `action.decided` and `action.finished`. |
| `ErrorCode` (`errors.ts`) | **Structural.** Add `E_APPROVAL_DENIED`: an approver (agent or operator) refused this exact request, or the mission is held after such a refusal. Distinct from `E_APPROVAL_REQUIRED` (a decision is pending) and `E_APPROVAL_INVALID` (the presented approval does not authorise this action). **Documentation:** `E_SECRET_DETECTED` widens from relay creation to any input refused for secret content. |
| `ActionSchema` (`capability.ts`) | **Documentation.** `always_requires_approval` means "approval through a gate Node Core recognizes": human, or, for spec AS desktop actions only, a Node-run delegate within an operator mission. `mutates: false` is no longer a blanket exemption: Node Core may gate reads by tier (AS gate table). Fields unchanged. |
| `ApprovalVerifier` (`ports.ts`) | **Documentation.** Authority remains operator-issued, **or** Node-issued from a delegate verdict that Node Core itself obtained. No external route may decide a delegate approval. `consume` stays atomic and single-use. Signature unchanged. |
| `ApprovalBinding` (`ports.ts`) | **No change.** AS's server-prepared approval record is the canonical argument object, so `arguments_digest` covers it. |
| `Receipt.actor` (`receipt.ts`) | **Documentation.** May be `agent:claude` / `agent:codex` for driver actions. `adapter_fields` already fits. |
| `EventRow`, `AppendEventInput`, `Store` | No change: `payload: JsonValue` fits; `kind` follows the amended union. |
| `JobEnvelope`, `AdapterContext`, `Adapter`, `TargetResolver`, `AppIdentity` | **No further change beyond A8, A9 and A10** *(rev 6)*. A mission's job lists admitted apps in A8's `allowed_apps`; the `desktop_uia` adapter implements A8's `resolver` for app admission and element targets, so policy, not the adapter, decides each one; `ctx.actor` carries `agent:claude` / `agent:codex`; `target_decisions` carries Core's verdicts. Packaged apps use A10. |
| `AdapterManifest`, `ActionResult`, `SessionAdapter`, `SessionRecord`, `Permission`, `PolicyDecision`, `CapabilityId` | No change. Mission and grant state stay in Node Core; the OS desktop session is not a CLI `SessionRecord`. |

Outside `packages/contracts`, and owned by their AS slices: `NodeCoreOptions` (agent tokens),
the approval registry's deny path and replay trigger, the approver runner options, and the AS
adapter API. Binding comments in specs D, T, E and V are updated where behaviour differs.

### A8 — Two-phase target resolution (2026-10-20)

**Gap.** The envelope could bound capabilities, workspaces and forbidden terms,
but not *which applications* a job may touch on the desktop. `desktop.state` and
`desktop.inspect` enumerate and inspect OS windows, and the adapter would have
had to decide for itself whether a window's owning application was in scope —
which makes the adapter part of the policy boundary, against §7 and the
`Adapter` contract's own comment. There was also no field recording Core's
decision per target, and no way for an adapter to bind a handle to its caller.

**Change.** Four types in `ports.ts` — `AppIdentity` (OS-observed process
identity: pid, creation time, image path and hash, signature, signer, product,
session), `ResolvedTarget` (an `app` or `capability` keyed by an adapter-opaque
string), `TargetDecisions` (Core's `allowed`/`denied` verdict per key), and the
`TargetResolver` port — plus `Adapter.resolver?: TargetResolver` and
`AdapterContext.actor` / `AdapterContext.target_decisions?`. `JobEnvelope` gains
an optional `allowed_apps: readonly AppRule[]` (hash, signer+product — A9 adds
`original_filename` — or path; A10 proposes a package shape),
participating in the digest only when present. Policy gains a deterministic
`authorizeTargets` and the `desktop_session_id` option. Node Core performs the
resolve under the same timeout/abort as invoke, validates the output, passes the
decisions to the adapter, and records only the counts `targets_allowed` /
`targets_denied` as **Core-reserved receipt keys** — a manifest that declares
either is refused at registration. Consumers: envelope (validation + digest),
policy (target decisions), node-core (resolve step, registration, plumbing),
adapters-desktop (implements the port, in F3b), and the F5 inventory filter. The
caller identity is carried to every adapter call as `ctx.actor`, never placed in
the envelope.

`AppIdentity.image_path` must be the canonical long path, exactly as
`QueryFullProcessImageName` returns it: an absolute drive path (`C:\…`) with
backslash separators, no namespace prefix (`\?\`, `\.\`), no UNC root, no 8.3
short-name segments, and no segment ending in `.` or a space. Node Core (F3a)
refuses any other spelling as `E_ADAPTER_FAILURE` before policy sees the target;
the desktop adapter (F3b) must guarantee it, never fall back to a basename.

### A9 — signer rules require `original_filename` (2026-10-20)

**Gap.** The A8 signer rule bound an application by `signer` + `product_name`
only. Both come from the version resource, but neither survives a rename or a
copy: a file renamed to `powershell.exe` keeps its vendor's signer and product
name, so a Notepad rule (`Microsoft Corporation` + `Microsoft® Windows®
Operating System`) also covered a renamed PowerShell or cmd image. The version
resource's `OriginalFilename` is the field that does survive renames and copies,
and the signer rule did not carry it.

**Change.** Two type changes, nothing else. `AppIdentity` gains
`readonly original_filename: string | null` (the version resource
OriginalFilename, or null when absent). The signer variant of `AppRule` becomes
`{ signer, product_name, original_filename }` — all three required, so the old
two-field signer rule is refused at validation with a message naming the new
field. Policy matches `original_filename` case-insensitively (the version
resource varies in case: `PowerShell.EXE`, `NOTEPAD.EXE`), while `signer` and
`product_name` stay exact. Consumers: envelope (validation), policy (matching),
node-core (identity validation, desktop-config validation), adapters-desktop
(the probe reads and parses it).

**Clarification (R5, 2026-10-22):** `original_filename` is the **language-neutral**
OriginalFilename — the value the version resource carries independent of any adjacent
`en-US\<image>.mui` — for example `NOTEPAD.EXE`, never `NOTEPAD.EXE.MUI`. This is a clarification
of what the value means, not a type change: the field remains `string | null` and A9's
case-insensitive comparison is unchanged.

### A10 — packaged-app identity (spec AS revision 6) — PROPOSED

**Status: proposed with spec AS revision 6 (2026-10-26; round 2 after the independent review).
Not in effect.** Made by the architect in slice AS0 together with A7, every consumer in the same
diff.

**Gap.** A8/A9 identify an application by image hash, image path, or signer + product +
`OriginalFilename`. A packaged (MSIX/AppX) application is poorly served by all three:

- its image lives under a versioned install path, and its hash changes on every Store update;
- its image may carry no Authenticode signature of its own (`CalculatorApp.exe` reports
  `NotSigned`; the package is signed, not the file), so no A9 rule can name it;
- where the image *is* signed (packaged `Notepad.exe`), an A9 rule names it, but it also matches a
  copy of the same file run without package identity.

**Change.**

| Contract type | Change |
|---|---|
| `AppIdentity` (`ports.ts`) | **Structural.** Add four fields, each OS-read by the adapter. Never taken from the window, UIA, or the image path text. `package_family_name: string \| null` comes from `GetPackageFamilyName` on the process handle (the `PROCESS_QUERY_LIMITED_INFORMATION` handle the probe already opens). `package_signature_kind: 'store' \| 'system' \| 'enterprise' \| 'developer' \| 'none' \| null` and `package_version: string \| null` (dotted quad, `Package.Id.Version`) come from the registered package: `GetPackageFullName` on the handle, then `PackageManager.FindPackageForUser(<session user SID>, <full name>)` (WinRT, usable from the unpackaged Windows PowerShell 5.1 probe; `Package.Current` is not, and `GetStagedPackageOrigin` is a different enum). `package_relative_path: string \| null` is the image path relative to that package's `InstalledLocation`: separator-bounded, no `..`, not absolute, no alternate data stream. |
| `AppRule` (`envelope.ts`) | **Structural.** A fourth shape `{ package_family_name: string, package_relative_path?: string }`. The family name is 1–255 characters, matching `^[A-Za-z0-9.-]+_[a-z0-9]{13}$`. Both fields compare case-insensitively. It matches only when the identity's `package_signature_kind` is `store` or `system`. A `null` identity value never matches. It participates in the digest like the other shapes. |
| `Policy.authorizeTargets` and the probe's copy of `AppRuleMatches` | **Behavioural, both changed together.** The new shape is evaluated as above. An identity with a non-null `package_family_name` **never** matches an `image_path` rule, wherever the path is: a versioned path is not an identity, and package roots are not only `C:\Program Files\WindowsApps`. The family-name read decides by its return status, not by where the image lies: `ERROR_SUCCESS` publishes the name; `APPMODEL_ERROR_NO_PACKAGE` (15700) publishes `null` (a genuinely unpackaged process); **any other status drops the target**. When the name was published, a failed origin, version or relative-path read also drops the target. So an unreadable packaged process cannot fall through to a path rule, on any install volume. Hash and signer rules are unchanged. |

**What the family name proves, stated plainly.** Its 13-character publisher id is a hash of the
publisher *subject string*, not of the signing key. A sideloaded or developer package signed by
any certificate the machine trusts with the same subject gets the same family name. That is why
every A10 match also requires origin `store` or `system`: Windows checks those signatures against
the Store or the OS image. While the Store package is installed, Windows refuses a second package
with the same family name. The origin check covers the case where it has been removed.

**Consumers:**
- contracts;
- envelope (validation, digest);
- policy (`appRuleMatches`);
- adapters-desktop (the probe reads the four fields, applies the matching rules and the drop rule
  above, and the resolver publishes the fields);
- node-core (`desktop.authorized_apps` validation);
- adapters-uia (AS `packaged` profile form).

**Tests:**
- a rule for one family name never admits another;
- an updated package's new hash and path do not matter;
- a renamed or copied classic image never acquires a family name;
- a developer-signed package carrying a Store family name is not admitted;
- a packaged process is not admitted by an exact `image_path` rule for its own image;
- a family-name read that fails with any status other than 15700 drops the target;
- `package_version` comes from the probe's real read (a fixture asserts it equals `Get-AppxPackage`'s `Version` for the same full name), never from a hand-built identity.

### A11 — `E_GRANT_INVALID`; `E_MODE_DENIED` on the agent surface (spec AT) (2026-10-27)

**Gap.** Spec AT adds an agent surface whose calls are bound to an operator-issued *grant*.
No existing code describes "this agent has no live grant, its grant was revoked, or no grant can
be issued for this job" without repurposing a code (`E_RUN_INVALID` is a coordinator run
credential; `E_CAP_NOT_ALLOWED` means the capability is not in `allowed_capabilities`).

| Contract type | Change |
|---|---|
| `ErrorCode` (`errors.ts`) | **Structural.** Add `E_GRANT_INVALID`: an agent call has no live grant, its grant was revoked, or a grant cannot be issued for this job (no discovery capability, or not exactly one workspace). |
| `ErrorCode.E_MODE_DENIED` | **Documentation.** Besides an advisory run, the agent surface is a mode: it permits only `desktop.state`, `desktop.inspect` and `machine.inventory`, and `desktop.*` only while `desktop_control.ar_gate_cleared` is set. A call outside that is `E_MODE_DENIED`. |

Consumers: contracts (`errors.ts`, test), node-core (the AT agent routes, AT1). Nothing else
enumerates the codes; the cockpit renders `error` strings as received.
