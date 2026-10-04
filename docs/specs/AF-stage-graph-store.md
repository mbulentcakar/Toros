# AF — Stage graph state into the store

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Pipelines persist to a JSON sidecar (`<db>.stage-graphs.json`) while the jobs
they create live in SQLite. Two stores, two failure domains: a crash between a
job write and a sidecar save leaves a job the pipeline does not know about, or
a pipeline naming a job that was never created — and the sidecar has none of
the integrity properties the rest of the system is built on. Move pipeline
state into the store.

## The change

A new migration (take the next free number at implementation time; the number
is not part of this contract) adds:

```sql
CREATE TABLE pipelines (
  pipeline_id TEXT PRIMARY KEY,
  state       TEXT NOT NULL,       -- running | paused | completed | stopped
  graph       TEXT NOT NULL,       -- the full MutableGraph, canonical JSON
  updated_at  TEXT NOT NULL
);
```

One row per pipeline, whole-graph JSON in one column. The graph is small,
read-modify-written as a unit by a single controller, and its shape is still
evolving — per-stage columns would buy queries nobody runs at the cost of a
migration per shape change. `state` is a real column because the reconciler
selects on it.

The `StageGraphController` API does not change. Its persistence goes through
the `Store` interface — two new methods, `putPipeline` and `listPipelines` —
so the controller stops knowing about files at all.

**Ordering rule, kept from today and now enforceable:** the pipeline row is
written *before* `create_job` is called for a stage, and again *after* the
job id is recorded in the graph. A crash between the two leaves a pipeline
naming its intent but no job — the reconciler already treats an absent job as
a pause condition, and now that is the *only* inconsistency class left, in
one direction, detectable.

Pipeline lifecycle transitions (`created`, `paused`, `resumed`, `stopped`,
`completed`) append events to the ordinary hash chain with the pipeline id in
the payload, so the audit log can reconstruct pipeline history the way it
already reconstructs job history.

## Migration of existing state

On first start after upgrade, if the sidecar file exists: import each graph
into the table inside one transaction, then rename the file to
`<name>.imported-<date>`. Never delete it. A sidecar that fails to parse
aborts startup with a message naming the file — silently starting with zero
pipelines is the failure mode this spec exists to remove.

## Non-goals

- No change to stage semantics, handoff rules, ceilings, or the fixed
  four-stage flow (AA governs those).
- No cross-node pipeline state; Phase 2 relay concerns stay out.

## Acceptance

1. Create a pipeline, kill Node Core mid-stage, restart: the pipeline is
   `paused` with its history intact, read from SQLite; no sidecar file is
   written.
2. An existing sidecar is imported once, renamed, and never re-imported;
   its pipelines are listed identically before and after upgrade.
3. A corrupt sidecar aborts startup with the file named in the error.
4. The chain contains a `pipeline.*` event for every lifecycle transition in
   a test run, and `verify-chain` still passes.
5. Crash-ordering test: fault-inject a failure between the intent write and
   `create_job`; restart pauses the pipeline with an operator-readable reason
   rather than losing or duplicating a stage job.
6. `stage-graph.ts` contains no `node:fs` import.
