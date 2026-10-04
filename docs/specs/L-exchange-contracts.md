# Spec L — `@toros/exchange-contracts`

**Read `00-CONTRACTS.md` first.** It is short and it is binding. Everything it says about the
pinned stack, forbidden paths, and stopping when you find a spec gap applies here unchanged.

Implements the wire contract underneath **SPEC §10 Phase 2** — node heartbeat and capability
advertisement; inbox, claim, lease, renew, download, complete, fail and reject; capsule retention
and deletion policy; conflict-safe resumable transfer and integrity verification. Unit L of
the Phase 2 plan (an operator planning document kept outside the repository).

## Objective

Freeze the contract for node-to-node capsule exchange **before** units M, N, O, P and Q are built
against it. Types, error codes, and pure functions only. No I/O, no state, no policy, no network.

This unit exists because it worked last time. In Phase 1, eleven units were built in parallel by
five models against a frozen contract and they composed; every integration defect that did appear
was in the contract itself, not in the units. The contract is where mistakes are cheap and where
they are expensive — cheap to fix now, expensive once six units have compiled against them.

## Why a new package rather than extending `@toros/contracts`

`packages/contracts` is frozen and stays frozen. Phase 1 units are still built against it, and
unfreezing it to add Phase 2 types would invalidate the guarantee the whole Phase 1 parallel build
rested on.

So this is a **new package**, `packages/exchange-contracts`, which depends on `@toros/contracts`
and adds to it. Same discipline: once this spec is accepted, this package is frozen for Phase 2.

## Allowed paths

```
packages/exchange-contracts/package.json
packages/exchange-contracts/tsconfig.json
packages/exchange-contracts/src/**
packages/exchange-contracts/test/**
```

Add the package to the root `tsconfig.json` references and nothing else outside the list above.

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
tools/**
docs/**                        except this file is your spec, not your output
```

Dependencies: `@toros/contracts` only. **Zero runtime dependencies**, no exceptions — this package
has no need of `ajv`, and adding one here would put a parser in the type layer.

Declare the project reference or your build will fail in a way that looks like a broken
dependency and is really a missing edge in the build graph:

```jsonc
{ "references": [{ "path": "../contracts" }] }
```

That exact omission shipped in Phase 1 — `node-core` imported `@toros/observer` without
referencing it, and the root build only worked because the solution file happened to list them in
a lucky order. Do not reproduce it.

## Reuse, do not reimplement

`canonicalize`, `digest` and `chainHash` already exist in `@toros/contracts` and are already
tested to byte level. **Import them. Do not write your own.**

The reason is the same one that made them worth testing in the first place: two implementations
that disagree by one byte let two different capsules share a digest, which is the exact collision
the digest exists to prevent. A capsule digest computed differently on the sending and receiving
node is an integrity check that passes when it should fail.

## Public API — frozen

Shapes below are the contract. Field names and types are binding; ordering and comments are not.

```ts
import type { JsonValue } from '@toros/contracts';

/* ---------- identity and advertisement ---------- */

/** A node's stable identity. `tailnet_identity` is the verified caller identity
 *  from the transport; this package never verifies it — see "What this unit is not". */
export interface NodeIdentity {
  readonly node_id: string;
  readonly tailnet_identity: string;
}

export interface CapabilityAdvertisement {
  readonly node: NodeIdentity;
  /** Capability ids this node can execute, e.g. 'excel.read_range'. Sorted, no duplicates. */
  readonly capabilities: readonly string[];
  /** ISO 8601. When this advertisement was produced. */
  readonly advertised_at: string;
}

export interface Heartbeat {
  readonly node: NodeIdentity;
  readonly sent_at: string;
  /** Monotonic per node, so a stale heartbeat delivered late cannot look current. */
  readonly sequence: number;
}

/* ---------- capsules ---------- */

export type CapsuleState =
  | 'offered'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired';

export interface CapsuleMetadata {
  readonly capsule_id: string;
  readonly job_id: string;
  /** sha256 over the whole capsule byte stream. The authority for integrity. */
  readonly digest: string;
  readonly bytes: number;
  /** Capabilities a node must have advertised before it may claim this capsule. */
  readonly required_capabilities: readonly string[];
  readonly created_at: string;
  /** ISO 8601. After this instant the capsule is `expired` and its material is deleted. */
  readonly expires_at: string;
  readonly origin: NodeIdentity;
  readonly state: CapsuleState;
}

/* ---------- leases ---------- */

export interface Lease {
  readonly lease_id: string;
  readonly capsule_id: string;
  readonly holder: NodeIdentity;
  readonly granted_at: string;
  readonly expires_at: string;
  /** Monotonic, server-issued. Increments on every grant and renewal for a capsule.
   *  An operation carrying a lower epoch than the current one is stale and refused. */
  readonly epoch: number;
}

/* ---------- transfer ---------- */

export interface ChunkRange {
  /** Inclusive start, exclusive end, in bytes. */
  readonly start: number;
  readonly end: number;
  /** sha256 of exactly these bytes. Verified per chunk so a resumed transfer
   *  detects corruption without re-reading the whole capsule. */
  readonly digest: string;
}

export interface TransferPlan {
  readonly capsule_id: string;
  readonly total_bytes: number;
  readonly chunks: readonly ChunkRange[];
  /** Whole-capsule digest. Chunk digests are an optimisation; this is the authority. */
  readonly digest: string;
}
```

### Operations

Request and response shapes for inbox, claim, renew, download, complete, fail and reject. Each
request carries the caller's `NodeIdentity`; each response is either a result or an
`ExchangeError`. Specify them as discriminated unions on a `kind` field so an unhandled operation
is a compile error rather than a runtime fallthrough.

## Four invariants, made unrepresentable

Phase 1 shaped two ports so a rule could not be broken rather than merely documented — `Store`
computes its own chain links so a caller cannot forge one, and `SecurityObserver` has no method
returning a decision so a monitor-only observer cannot deny anything. Carry that forward. These
four are not style preferences; a reviewer will check each one against the types.

**1. There is no `accepted`.** SPEC §10's Phase 2 acceptance says relay completion does not create
a Git commit or mark work accepted. `CapsuleState` therefore has no `accepted` member and no type
in this package carries an acceptance flag. `completed` means the capsule was delivered and the
work reported back — it says nothing about whether the work was any good, and no sequence of
exchange operations can express that it was. Acceptance is a human act on GitHub, outside Toros
entirely.

**2. A client cannot mint a lease.** `Lease` is only ever produced by the service. Export no
constructor, no builder, and no function in this package that returns a `Lease` from client-side
inputs. A node proves it holds a lease by presenting `lease_id` and `epoch`, both of which it
received; it can never manufacture them.

**3. A claim cannot skip the capability check.** `required_capabilities` lives on the capsule and
`capabilities` lives on the advertisement, both as sorted string arrays, so the check is a set
comparison a reviewer can read — not a predicate someone has to trust. Provide the pure function
that performs it (below) so M, N and O cannot each invent their own subtly different version.

**4. Nothing here carries a secret.** No type in this package has a field for a token, key,
password or file content. Capsule metadata carries digests, sizes and identities. If you find
yourself adding a field that would hold bytes a secret scanner would care about, you have found a
spec gap — stop and say so.

## Pure functions

```ts
export function capsuleDigest(bytes: Uint8Array): string;
export function verifyTransfer(plan: TransferPlan, received: Uint8Array): TransferVerdict;
export function isExpired(expires_at: string, now: string): boolean;
export function leaseIsCurrent(lease: Lease, now: string, current_epoch: number): boolean;
export function canClaim(
  advertisement: CapabilityAdvertisement,
  capsule: CapsuleMetadata,
): ClaimVerdict;
```

**Every one of these takes time as an argument.** No function in this package reads the clock.
Not `Date.now()`, not `new Date()`. Expiry and lease currency are decided against a `now` passed
in by the caller, which is what makes them testable without fake timers and what stops two nodes
disagreeing because their clocks differ — the caller decides whose clock is authoritative, and
this package never quietly assumes it is the local one.

`verifyTransfer` and `canClaim` return a verdict object with a reason, not a bare boolean. A
rejection that cannot say why produces a log line nobody can act on.

## What this unit is not

- **It does not verify identity.** `tailnet_identity` arrives already verified by the transport in
  unit O. This package defines the shape; it does not authenticate. Do not add a signature check,
  a certificate parser, or a trust store.
- **It does not do I/O.** No `node:fs`, no `node:http`, no `node:net`.
- **It does not hold policy.** Retention duration, lease length and chunk size are configuration
  that units O and N supply. This package defines that `expires_at` exists, never what it should
  be.

## Tests

`node:test` plus `node:assert/strict`, under `packages/exchange-contracts/test/`.

Test the properties that other units will rely on, not the getters:

- `capsuleDigest` agrees with `@toros/contracts`'s `digest` over the same bytes — the cross-node
  integrity guarantee is exactly this equality, so assert it rather than assuming it.
- `verifyTransfer` fails a plan whose chunk digests are individually correct but whose
  whole-capsule digest does not match. That is the case a per-chunk-only check misses, and it is
  the one an attacker or a resumed-transfer bug produces.
- `isExpired` and `leaseIsCurrent` are exercised at the boundary instant, not merely well inside
  it. Equal-to-`expires_at` must have a decided answer and the test must state which.
- `leaseIsCurrent` refuses a lease whose epoch is lower than the current epoch even when its
  `expires_at` is still in the future. That is the fencing case — a node that was disconnected,
  had its lease reassigned, and came back believing it still holds it.
- `canClaim` refuses when the capsule requires a capability the advertisement lacks, and accepts
  when the advertisement is a strict superset.

**Before you trust a new test, check it fails against the old behaviour.** Break the thing on
purpose, watch the test go red, put it back. The last full review of this repository found six
tests that asserted less than their names claimed, and three of them presented no stimulus at all
for the behaviour they scored.

## Acceptance

- `npm run build` and `npm test` pass from the repository root with the new package in the graph.
- The package exports the types and functions above and nothing that performs I/O.
- No file under `packages/contracts/` is modified.
- `grep` for `Date.now`, `new Date(`, `node:fs`, `node:http` and `node:net` under
  `packages/exchange-contracts/src/` returns nothing.
- No type in the package has an `accepted` state or an acceptance field.
- No function returns a `Lease` from client-supplied input.
