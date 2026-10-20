# AR-F3 — bound identity and scope (implementation brief)

**Read `docs/specs/00-CONTRACTS.md` first.** F3 makes contract amendment **A8**. Its exact types
are fixed in this brief by the architect; the implementer types them in as written and changes
nothing else in `packages/contracts`. Spec AS reserves A7, so this is A8 even if A7 lands later.

**Lane:** implementer from the deputy pool (sandboxed `deputize`); code review by Codex; the native
re-review of the AR surface after F1–F4 by a third lineage. The implementer is never the reviewer.
A8 changes the policy surface, so workspace invariant 3 applies: the Codex review is the second,
independent reviewer, and it must read the policy and Core diffs line by line.

**Operator decision (2026-10-19):** policy sees the resolved identity through a **two-phase
resolve**. An adapter that touches OS targets resolves them first. Node Core decides each target
against the envelope. The adapter then acts only on the targets Core allowed, and re-verifies
them at execution. Adapters still never receive the envelope, and never consult policy
(`ports.ts`, the `Adapter` comment). Rejected: passing a scope view to the adapter, which would
make the adapter part of the policy boundary.

## Findings closed

| Finding | Sev | Closed by |
|---|---|---|
| AR-02 envelope cannot narrow the global app allowlist | High | F3a: Core decides each resolved app against `allowed_apps` and `forbidden` |
| AR-04 `session_scope` accepted but never enforced | High | F3b: the probe proves the interactive session; anything else is `unavailable` |
| AR-05 freshness handles global, cross-job, replayable | Medium | F3b: per-job, per-actor, single-use handles with issuance time |
| AR-10 process-basename allowlisting is spoofable | Low | F3b: identity = image path, SHA-256, signer, pid + creation time |
| AR-11 desktop manifest omits filesystem authority | Low | F3b: the manifest declares its temp-file use |

## Slicing

F3 is two PRs, in order. Each gets its own review.

- **F3a — the two-phase contract (A8), policy and Core.** Packages: `contracts`, `envelope`,
  `policy`, `node-core`, plus a fake resolving adapter in tests. No desktop code. Starts after F4
  is merged (both edit `action-pipeline.ts`).
- **F3b — desktop identity, session and handles.** Packages: `adapters-desktop`, and
  `node-core/src/main.ts` for config. Starts after F2 and F3a are merged (it edits the probe
  script, and implements the A8 port).

F5's inventory filter (AR-09) also uses the A8 port. See `AR-F5-brief.md`.

## F3a — amendment A8

### Types (`packages/contracts/src/ports.ts`), exactly

```ts
/** OS-observed identity of a process that owns a target. Never caller-supplied. */
export interface AppIdentity {
  readonly pid: number;
  /** Process creation time, ISO-8601 UTC. Guards against pid reuse. */
  readonly created_at: string;
  /** Canonical full image path, as the OS reports it. */
  readonly image_path: string;
  /** Lower-case hex SHA-256 of the image file. */
  readonly image_sha256: string;
  readonly signature: 'valid' | 'unsigned' | 'invalid';
  /** Authenticode subject CN when signature is 'valid', else null. */
  readonly signer: string | null;
  /** Version resource ProductName, or null. */
  readonly product_name: string | null;
  /** Windows session id of the process. */
  readonly session_id: number;
}

export type ResolvedTarget =
  | { readonly kind: 'app'; readonly key: string; readonly identity: AppIdentity }
  | { readonly kind: 'capability'; readonly key: string; readonly capability: CapabilityId };

/** Core's decision for each resolved key. Keys absent from the map are denied. */
export type TargetDecisions = ReadonlyMap<string, 'allowed' | 'denied'>;

export interface TargetResolver {
  /** Read-only. Must not mutate any target. Called by Core before invoke. */
  resolve(
    actionId: string,
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<readonly ResolvedTarget[]>;
}
```

Change `Adapter` to add `readonly resolver?: TargetResolver;`. Change `AdapterContext` to add:

```ts
  /** Who called: the receipt's actor. Lets an adapter bind handles to the caller. */
  readonly actor: string;
  /** Present only when the adapter has a resolver: Core's decision per resolved key. */
  readonly target_decisions?: TargetDecisions;
```

`key` is adapter-opaque, unique within one resolve call, and at most 128 characters.

### Envelope (`packages/envelope`, and `JobEnvelope` in contracts)

Add an optional field `allowed_apps: readonly AppRule[]`, with:

```ts
export type AppRule =
  | { readonly image_sha256: string }
  | { readonly signer: string; readonly product_name: string }
  | { readonly image_path: string };
```

- Validation: each rule has exactly one of the three shapes. `image_sha256` is 64 lower-case hex
  characters. `image_path` is absolute. Strings are non-empty and at most 512 characters. Unknown
  keys are refused (`E_ENVELOPE_INVALID`).
- The field is part of the sealed envelope and its digest. Envelopes without it seal exactly as
  before, so existing digests do not change. Add a regression test that proves this.

### Policy (`packages/policy`)

Add `authorizeTargets(envelope, capability, targets): TargetDecisions`, deterministic and pure:

- `kind: 'capability'`: allowed iff `envelope.allowed_capabilities` includes it.
- `kind: 'app'`: allowed iff **all** of these hold:
  1. `envelope.allowed_apps` is present and non-empty, and at least one rule matches. **Absent
     means deny**: a job that does not name its apps sees none.
  2. No `forbidden` term matches the image file name (basename, case-insensitive), the
     `product_name` or the `signer`, using the same matching as `isForbidden`.
  3. The identity's `session_id` equals the session Node Core runs in, which Core passes to
     policy at construction.
- Rule matching: `image_sha256` exact; `signer` + `product_name` exact (case-sensitive), and only
  when `signature === 'valid'`; `image_path` case-insensitive full-path equality after
  normalising separators. There is no basename or wildcard rule.

The node's global `desktop.authorized_apps` config stays an outer bound, enforced by the adapter
(F3b). A target must pass both the global bound and the envelope.

### Core (`packages/node-core/src/action-pipeline.ts`)

For an adapter with a `resolver`, after the existing policy decision and before `invoke`:

1. Call `resolver.resolve` under the same timeout and abort as `invoke` (F4's race). A resolve
   failure closes the receipt like an invoke failure.
2. Validate the result: an array of well-formed targets, unique keys, at most 1,000 targets.
   Anything else is `E_ADAPTER_FAILURE`.
3. Compute `authorizeTargets`. Pass the decisions to `invoke` as `ctx.target_decisions`.
4. Record on the receipt only the counts `targets_allowed` and `targets_denied`, never the
   identities. Add both to the receipt fields Core always writes.
5. If no target is allowed, still call `invoke`. It returns an empty, well-formed result, so a
   caller cannot tell "denied" apart from "nothing there".

Every adapter call gets `ctx.actor`. An adapter without a resolver behaves exactly as today.

### Docs

- `00-CONTRACTS.md` §10: record A8 (types, why, every consumer) in the style of A1–A6.
- `docs/specs/AR-read-only-discovery.md` "Contract fit — no contract change": amend it to point to
  A8 and the two-phase flow.

### Tests (F3a)

Use a fake resolving adapter: no PowerShell, no windows.

- `allowed_apps` absent → every app target denied; capability targets unaffected.
- One test per rule kind, each matching and not matching; signer rules ignored when unsigned or
  invalid.
- A `forbidden` term matching basename, product or signer → denied, even when a rule matches.
- Session mismatch → denied.
- Malformed resolve output (duplicate keys, more than 1,000 targets, an unknown kind) → closed
  receipt with `E_ADAPTER_FAILURE`; budget and events as F4 defines.
- A resolve timeout or abort closes the receipt (reuse F4's helpers).
- The receipt holds counts only; no identity string appears in receipts or events.
- The old-envelope digest is unchanged.

## F3b — desktop identity, session and handles

### Probe (`DESKTOP_UIA_PS1` and `RawWindow`)

For each enumerated top-level window, the script returns the owning process's `AppIdentity`, read
from the OS:

- pid from `GetWindowThreadProcessId` (native, not the UIA provider), and creation time;
- image path from `QueryFullProcessImageName`;
- SHA-256 of that file;
- `Get-AuthenticodeSignature` status and the subject CN;
- `ProductName` from the file version resource;
- session id from `ProcessIdToSessionId`.

Any read failure (access denied, process gone, hashing failed) leaves that window **out** of the
result, with a counted `identity_unavailable`. It never falls back to a basename. Hash each
(image path, file size, last-write time) once per probe run.

### Session (AR-04)

- `session_scope` becomes the enum `"interactive"`. Any other value is `E_SCHEMA`.
- The probe proves the session. Node Core's own session id must be the active console session
  (`WTSGetActiveConsoleSessionId`), or an RDP session whose state is `WTSActive`, and the input
  desktop must be openable (`OpenInputDesktop`). Otherwise `desktop.state` returns
  `session: "unavailable"` with a reason, `locked` or `disconnected`, and no windows.

### Two-phase (implements A8)

- `resolver.resolve` for `desktop.state` runs the enumeration and returns one `app` target per
  window that passes the global `authorized_apps` bound. Windows outside the global bound are not
  returned as targets and never appear in output.
- `invoke` publishes titles and window ids only for keys whose decision is `allowed`. It
  re-verifies pid, creation time and SHA-256 against the resolved identity. A mismatch drops the
  window and counts it as `changed`.
- `desktop.inspect` resolves its single window from the handle, and inspects only on an `allowed`
  decision. Otherwise it returns `denied`.

### Handles (AR-05)

- Enumerations are stored **per (job_id, actor)**, never globally. A `desktop.state` call
  replaces only its own (job, actor) enumeration.
- A `window_id` + `freshness_token` pair is valid only for the job and actor that minted it, and
  for at most 60 s after issuance. It is **single-use**: `desktop.inspect` consumes it. A reused,
  expired or foreign pair returns `refresh_required`, with the same shape for all three, so a
  caller cannot probe which case it hit.
- The time-of-check-to-time-of-use check compares pid, creation time and SHA-256, not names.
- At most 32 live enumerations; evict the oldest.

### Global config (AR-10)

`desktop.authorized_apps` in the node config becomes a list of `AppRule`, the same shapes as the
envelope. A bare string entry (the old basename form) makes Node Core **refuse to start**, with a
message naming the new format. Update `docs/AR-T4-install-rollback.md` and `docs/INSTALL.md`
with the migration: the Oruc install has basename entries today.

### Manifest (AR-11)

Declare `fs.read` and `fs.write` in `required_permissions`, and record in the manifest comment
that their only resource is the probe's own `mkdtemp` directory.

### Tests (F3b)

- Process-free: the session enum; refusal of the config format; per-(job, actor) handles,
  single-use, expiry, foreign-job and foreign-actor reuse, all returning the same
  `refresh_required`; the 32-enumeration eviction; and identity re-verification against a fake
  probe.
- Native, gated by `TOROS_REAL_TESTS=1` as in F2: the canary fixture's identity comes back with a
  real SHA-256 and session id. A renamed copy of an allowlisted image with a different hash is
  denied. Spoofing the basename does not pass.
- The implementer does not run the native suites. The reviewer does.

## Acceptance (each PR)

- Delete every `packages/*/dist`, then `npm run typecheck`: 0 errors.
- `npm test` without `TOROS_REAL_TESTS`: 0 failed; every skip is a real-binary or native-desktop
  skip with its reason.
- CI green on the PR head.
- No secrets, local paths or machine names in the repository.

## F3a clarifications (architect, 2026-10-20, before dispatch)

1. **Where the session id comes from.** `PolicyOptions` (in `packages/policy`) gains
   `desktop_session_id?: number | null`, and `CoreOptions` passes it through. Absent or `null`
   means every `app` target is denied (fail closed). F3a does not compute it: `main.ts` leaves it
   unset, which is safe, because no adapter has a resolver until F3b. F3b resolves it on Windows
   at startup.
2. **`authorizeTargets` is a method on `Policy`**, next to `decide`, so it sees the same options.
   It stays deterministic and pure.
3. **Where the counts go.** Core writes `targets_allowed` and `targets_denied` into the receipt's
   `adapter_fields`, as **Core-reserved keys**. A manifest that declares either key in
   `receipt_fields` is refused at registration (`E_ADAPTER_FAILURE`). There is no new top-level
   `Receipt` field and no store schema change. Add the two reserved keys to A8's record.

## F3a round 2 — after the Codex review of 00ca084 (2026-10-20)

Codex: REQUEST CHANGES (four P2, two P3). All six are accepted.

1. **One deadline for resolve and invoke (P2).** `action-pipeline.ts` gives resolve and invoke
   separate `withinTimeout` budgets, so an 80 ms action can run for about 160 ms. Use **one**
   action deadline and one abort controller, started before resolve and shared by both phases.
   Test: a 60 ms resolve plus a 60 ms invoke under an 80 ms timeout → terminated receipt, with
   the signal aborted.
2. **Strict identity validation (P2).** Before policy sees a target, reject the whole resolve
   result with `E_ADAPTER_FAILURE` when any identity has:
   - a `pid` that is not a positive safe integer, or a `session_id` that is not a non-negative
     safe integer;
   - a `created_at` that is not a valid ISO-8601 UTC timestamp ending in `Z`;
   - an `image_path` that is not an absolute drive path (`^[A-Za-z]:\`), or that has a
     namespace prefix (`\?\`, `\.\`), a UNC root, a segment ending in a dot or a space, an
     8.3 short-name segment (`~` followed by a digit), or a `/` separator;
   - `signature: 'valid'` with a null or empty `signer`, or a non-valid signature with a non-null
     `signer`;
   - an `image_sha256` that is not 64 lower-case hex characters.

   Record in A8 (00-CONTRACTS §10) that `image_path` must be the canonical long path, as
   `QueryFullProcessImageName` returns it. F3b must guarantee that; F3a refuses anything else.
   One test per rule.
3. **Counts survive failure, and a later read does not overwrite them (P2).** Write
   `targets_allowed` and `targets_denied` into the receipt immediately after authorization, so a
   later invoke failure or timeout closes the receipt with them. `settleCliExchange` and any
   other receipt rewrite must preserve the Core-reserved keys already on the receipt, never
   replace them. Tests: an invoke that throws after two allowed targets → closed receipt with
   `targets_allowed: 2`; and the CLI send/read path keeps the send receipt's counts.
4. **Restore the `ConversationTurnRole` export (P2).** It was removed from
   `packages/contracts/src/index.ts`. Restore it exactly. Add a type-level test that imports it
   from `@toros/contracts`. A8 changes nothing else in contracts.
5. **Windows basename semantics (P3).** Use `path.win32.basename` for `identity.image_path` in
   policy. Test with a path whose directory contains a forbidden token while the file name does
   not → not denied by that token.
6. **Tests that can fail (P3).**
   - Split the forbidden test into product-only and signer-only cases, each with a distinct term.
   - Capture `actor` inside **resolve** and assert it there.
   - Add the missing coverage: the combined timeout (item 1), malformed identities (item 2),
     failed-invoke counts (item 3), and invoke still called when every target is denied.

Acceptance as before: a clean typecheck, `npm test` 0 failed, and CI green.
