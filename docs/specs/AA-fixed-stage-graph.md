# AA — Fixed Stage Graph MVP

**Status:** implemented, awaiting independent review and live four-stage validation.

## Purpose

Run one bounded unattended flow:

`specification → implementation → code_review → security_review`

This is deliberately not a general workflow engine. The order and stage names
are fixed. The operator may choose a registered CLI worker and limits for each
stage, but may not add arbitrary nodes, branches, loops, or tools.

## Authority model

The graph is a parent control record. Every attempt at every stage is a normal,
independently sealed Toros job. Its envelope contains only:

- the selected worker's `start`, `send`, `read`, and `stop` capabilities;
- one selected workspace;
- that stage's action ceiling and per-action retry ceiling;
- that stage's acceptance criteria and pipeline deadline.

Node Core creates these jobs. Hermes coordinates them. Workers still pull and
perform the actual work. The Cockpit remains an operator client and holds no
policy authority.

## Limits and pause rules

The operator sets:

- total pipeline deadline;
- worker adapter per stage;
- maximum actions per stage attempt;
- maximum retries for an identical failed action;
- active timeout per stage attempt;
- maximum attempts per stage.

The graph pauses when a coordinator asks for input or approval, fails, stops,
times out, reports blocked, exhausts attempts, or fails the machine-checked
handoff contract. A Node Core restart also converts a running graph to paused;
the operator reviews and resumes it rather than silently restarting model work.

Token limits are not implemented. The current CLI adapter contract does not
report authoritative token usage, so presenting a token field as enforced
would be false. Action, retry, attempt, and wall-clock ceilings are enforced.

## Explicit handoff boundary

Specification and implementation workers must write only declared outputs
under their session's `handoff/` directory:

- specification requires `handoff/SPEC.md`;
- implementation requires `handoff/IMPLEMENTATION.md` plus any deliverables.

Read-only review workers return their complete review in their final response.
Node Core versions it as `CODE_REVIEW.md` or `SECURITY_REVIEW.md`.

On successful completion, Node Core copies the handoff to:

`<workspace>/.toros-stage-graphs/<pipeline>/<stage>/v<attempt>/`

Before the next worker receives its first message, Node Core copies all prior
successful versions into that session under `input/<stage>/`. There is no
implicit chat-memory handoff.

The boundary rejects symbolic links and credential-like names, skips `.git`
and `node_modules`, and caps each stage at 500 files, 2 MiB per file, and
20 MiB total. Before seeding, every versioned file is checked against the
stored SHA-256 and byte-size manifest; a mismatch pauses the graph. A seeding
failure terminates the newly started CLI session and
marks its persisted session stopped.

## Durable state and API

Graph state is stored atomically beside the SQLite database as
`<db_path>.stage-graphs.json`. Normal jobs, conversations, sessions, receipts,
and policy decisions remain in SQLite. Pipeline creation and stage transitions
also enter the existing hash-chained event log.

The operator-only surface exposes:

- `POST /operator/pipelines`
- `POST /operator/pipeline_create`
- `POST /operator/pipeline_pause`
- `POST /operator/pipeline_resume`
- `POST /operator/pipeline_stop`

The coordinator bearer cannot call these operations.

## Cockpit

The **Pipelines** tab configures the fixed graph and shows each stage's worker,
state, attempt count, action ceiling, timeout, job id, artifact count, and
error. A paused graph accepts an optional clarification on resume.

Installed-machine defaults follow the chosen role flow with available workers:

- specification: Codex;
- implementation: Codex (until another implementation adapter is installed);
- code review: Codex;
- adversarial security review: Claude.

Every default remains editable before start.

## Acceptance checks

1. A graph creates only the four stages in the fixed order.
2. Each stage attempt is a separately sealed job with only one CLI lifecycle.
3. Missing `SPEC.md` or `IMPLEMENTATION.md` blocks advancement and pauses the graph.
4. A valid versioned handoff is present under the next session's `input/` before its first task message.
5. Pause, resume, stop, timeout, action limits, action retries, and attempt limits are operator-visible.
6. Running state survives restart as a durable paused graph requiring review.
7. Existing single-job Hermes work remains unchanged.
8. Node Core, Cockpit, and Rust proxy tests remain green.

## Known limitation before security testing

This stage graph does not change SPEC §8.1's worker-process limitation: a CLI
worker is policy-bounded by its Toros job, adapter mode, and working directory,
not proven OS-confined. The purpose of this milestone is to establish a
working, observable system. Adversarial vulnerability testing follows after a
live four-stage run succeeds.
