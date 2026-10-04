# AH — Receipt queries for retry accounting

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Two hot paths list **every receipt of a job** and scan in JavaScript:

- `retriesUsed` runs before *every* action to count failures of the same
  capability+arguments since the last success;
- `settleCliExchange` runs on *every* `read_cli` poll to find the one
  `running` send receipt for a session — and the cockpit polls reads every
  two seconds during an exchange.

At Phase 1 scale this is invisible. A 1,000-action pipeline job makes it
quadratic, and the cost lands on the action pipeline — the path everything
else waits behind. Push both scans into SQL.

## The change

A new migration (next free number; the number is not part of this contract):

```sql
CREATE INDEX receipts_retry
  ON receipts (job_id, capability, arguments_digest, started_at);
CREATE INDEX receipts_session_outcome
  ON receipts (session_id, outcome);
```

Two new `Store` methods, replacing the call-site scans:

- `countRetries(job_id, capability, arguments_digest)` — failures
  (`failed` | `terminated`) since the most recent `succeeded` for that triple,
  computed in SQL with the same semantics as today's loop, including the
  first-failure-is-not-a-retry off-by-one **kept at the call site**, so the
  store answers "failures since last success" and policy alone owns what a
  retry *is*.
- `latestRunningReceipt(job_id, session_id, capability)` — the newest
  `running` receipt for that session and capability, or null.

**The derivation principle is unchanged and is the point of keeping this in
the store:** retries remain *derived from receipts*, never a counter that can
disagree with the audit log. The SQL is a faster way to read the same truth.

## Non-goals

- No caching layer, no denormalized counters, no changes to receipt shape or
  to what is persisted.
- No pagination of `listReceipts` for its remaining callers (`list_activity`,
  rehydration) — their result sizes are bounded by other budgets. If that
  changes, it is its own spec.

## Acceptance

1. Equivalence tests: for a seeded receipt history covering success-resets,
   interleaved capabilities, digest collisions across different capabilities,
   and denied outcomes, `countRetries` returns exactly what the removed loop
   returned. The old loop is kept in the test as the oracle.
2. `settleCliExchange` settles the same receipt as before against a seeded
   multi-send history.
3. `EXPLAIN QUERY PLAN` for both queries shows index use, asserted in a test.
4. `E_RETRIES_EXHAUSTED` behavior through the live service is unchanged:
   the existing acceptance tests pass unmodified.
5. Migration applies cleanly to a populated Phase-1 database copy.
