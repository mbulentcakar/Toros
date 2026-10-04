# Spec B — `@toros/store`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements **SPEC §8.1** (append-only receipts, hash chain, head anchor) and **§8.3** (minimum
receipt). Provides the `Store` port from `@toros/contracts`.

## Objective

SQLite persistence for jobs, sessions, receipts, artifacts, findings, and the event log — and
the hash chain that makes "append-only" a mechanism instead of a promise.

The chain is the security-relevant part of this unit. Read SPEC §8.1 in full before writing
code; it states not only what the chain does but what it deliberately does not claim, and both
halves are requirements.

## Allowed paths

```
packages/store/package.json
packages/store/tsconfig.json
packages/store/src/**
packages/store/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

## Package setup

Name `@toros/store`, dependency `"@toros/contracts": "*"`, project reference to `../contracts`.
Storage is **`node:sqlite`**, built into Node 24. Do not add a driver package.

## Public API — frozen

```ts
import type { Store } from '@toros/contracts';

export interface StoreOptions {
  /** Absolute path to the database file, or ':memory:' for tests. */
  readonly path: string;
  /** This node's id. Every chain is per-node. */
  readonly nodeId: string;
}

/** Opens the database, applies migrations, and returns the port. */
export function openStore(options: StoreOptions): Promise<Store>;
```

Nothing else is exported. `Store` is defined in contracts — implement it exactly, including the
`readonly` array returns.

## Schema

Migrations live in `src/migrations/` as **numbered TypeScript modules exporting the SQL as a
string** — `001_initial.ts` with `export const sql = \`...\``, not `001_initial.sql`. They are
applied in order inside a transaction, with the applied version tracked in a `schema_version`
table. Applying twice must be a no-op — `openStore` runs on every start, and a migration that
is not idempotent turns a restart into data loss.

The `.ts` part is not a style preference. `tsc` emits `.ts` and copies nothing else, so a
`.sql` file never reaches `dist/`, and the package compiles cleanly and then dies at runtime
with `ENOENT` on the first `openStore`. Fixing that would mean a copy step, which means build
tooling this project deliberately does not have. A migration exported as a string needs no
build step, stays version-controlled and reviewable, and cannot go missing from a package that
type-checks.

For the same reason, **do not read any file at runtime from `dist/`**. If a package needs
static data, it is a TypeScript module.

Tables: `jobs`, `sessions`, `receipts`, `artifacts`, `findings`, `events`, `chain_head`.
Derive columns from the record types in `@toros/contracts/ports.ts` and `receipt.ts`; they are
the specification of the shape.

`receipts.adapter_fields` stores canonical JSON for the allowlisted adapter
metadata in `Receipt.adapter_fields`. Migration 002 adds it to version-1
databases with `{}` as the historical default; the upgrade is covered by a
real file-database test, including simultaneous upgrades by independent
connections.

Notes where SQLite needs a decision:

- Enable `PRAGMA foreign_keys = ON` at open. Set `PRAGMA busy_timeout = 15000`
  before `PRAGMA journal_mode = WAL`, because WAL negotiation itself needs a lock;
  retry a busy WAL negotiation with bounded backoff through the same 15-second
  contention budget.
- Run all pending migrations in one `BEGIN IMMEDIATE` transaction and read the
  current schema version only after acquiring that lock.
- Store timestamps as RFC 3339 **text**, not epoch integers. Receipts are read by humans during
  incident review, and a chain payload containing an integer is one more thing to decode.
- Store `envelope`, `payload`, `detail`, and `arguments_normalized` as canonical JSON text via
  `canonicalize()` from contracts. Not `JSON.stringify` — the chain rehashes stored payloads,
  so the stored bytes must be the canonical ones.
- `events.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, per node.
- `chain_head` holds one row per node: `node_id`, `head_hash`, `row_count`, `updated_at`.

## The chain — the part to get right

`appendEvent` is the **only** writer of `events`. In one transaction it must:

1. read `chain_head` for the node, treating a missing row as `GENESIS_HASH` with `row_count` 0;
2. compute `hash = chainHash(prev_hash, payload)` using the contract function;
3. insert the event row;
4. update `chain_head` to the new hash and `row_count + 1`.

All four, or none. Requirements that follow, each for a stated reason:

- **The transaction must serialise appends.** Begin it as `BEGIN IMMEDIATE`, not the default
  deferred transaction. Two writers that both read the same head produce two rows sharing a
  `prev_hash` — a fork, not a chain — and deferred transactions permit exactly that
  interleaving before the first write.
- **Callers cannot supply `prev_hash` or `hash`.** `AppendEventInput` does not carry them.
  Compute both; never accept them.
- **Use `chainHash` from contracts.** Do not reimplement the concatenation, and do not decode
  the hex to bytes first — §8.1 pins it to hex text, and the two choices produce mutually
  unverifiable chains.

`verifyChain(nodeId)` walks every row for the node in `seq` order and returns
`ChainVerification`:

- recompute each row's `hash` from its stored `prev_hash` and `payload`, and check that each
  row's `prev_hash` equals the previous row's `hash`;
- the first failure sets `broken_at_seq` and a human-readable `reason`, and stops the walk;
- after the walk, compare the final hash and the row count to `chain_head`, setting
  `anchor_matches`;
- `ok` is true only when there is no break **and** the anchor matches.

**The truncation case is the one to test deliberately.** Delete the last row directly with SQL
and run `verifyChain`: every surviving row still links correctly, so `broken_at_seq` is `null`,
but `row_count` no longer matches and `anchor_matches` is false. That combination is the
truncation signature. An implementation that only walks the links reports a clean chain here,
which is precisely the hole the anchor was added to close.

## Other behaviour worth pinning

- `createJob` stores the envelope and its digest as given. It does not recompute the digest —
  sealing belongs to `@toros/envelope`, and a second implementation of it here is a second
  thing that can disagree.
- `incrementActionsUsed` must be atomic (`UPDATE ... SET actions_used = actions_used + 1`), not
  read-modify-write. The budget is a policy boundary; a lost update spends an action the job
  did not have.
- `setJobState` records the transition and appends a `job.state_changed` event. It does **not**
  enforce which transitions are legal — that is policy's job, and duplicating the rule here
  means two places to change it.
- `getJob` on an unknown id returns `null`. It does not throw. Throwing is for
  `E_SESSION_UNKNOWN` on session lookups, where the caller supplied an id that should exist.
- `close()` must be safe to call twice.

## Acceptance tests

`packages/store/test/`, split as you see fit. Required cases:

**Migrations and lifecycle**
1. `applies migrations on a fresh database`
2. `applying migrations twice is a no-op`
3. `close is idempotent`

**Jobs and sessions**
4. `createJob then getJob round-trips the envelope and digest unchanged`
5. `getJob returns null for an unknown id`
6. `incrementActionsUsed is atomic under concurrent calls`
7. `setReadCursor and stopSession round-trip`

**Receipts and artifacts**
8. `putReceipt then listReceipts returns receipts for that job only`
9. `a receipt with arguments_digest and null arguments_normalized round-trips`

**The chain**
10. `the first append links to GENESIS_HASH`
11. `each append links to the previous hash`
12. `verifyChain reports ok on an intact chain`
13. `verifyChain detects an edited payload and reports the first broken seq`
14. `verifyChain detects an inserted row`
15. `verifyChain detects tail truncation via anchor_matches with broken_at_seq null`
16. `chain_head row_count matches the number of event rows after every append`
17. `concurrent appends produce a linear chain with no shared prev_hash`

**Restart persistence** — the §10 acceptance criterion
18. `a job, its receipts, and an intact chain survive close and reopen`

Test 17 needs genuinely concurrent calls (`Promise.all` over many `appendEvent`s), then an
assertion that the `prev_hash` values are all distinct and form one linear chain. Under a
deferred transaction this test fails; that is what it is for.

## Verification

```
npx tsc --build packages/store
node --test packages/store/dist/test/*.test.js
```

Clean, zero skips. Use `:memory:` for most tests, but tests 18 and 15 need a real file — put it
under the OS temp directory and delete it afterwards.

## Out of scope

Policy decisions, adapters, the observer, HTTP, checkpoints, and relay capsules. This unit
persists what it is given and hashes what it stores. It never decides whether something was
allowed.
