# W — Cockpit Hermes workspace

## Objective

Add a bounded operator workflow to the Cockpit: create an immutable job,
start its one-job Hermes coordinator, observe progress, answer a clarification,
resume after an approval, stop the coordinator process, and checkpoint the job.

This is not a general chat channel. Every Hermes action remains constrained by
the job envelope and mediated by Node Core's existing typed tool surface.

## Authority and credential boundaries

- New mutations are operator operations authenticated by `operator_token`.
- Node Core validates and seals the envelope and remains policy authority.
- Cockpit's Rust bridge selects credentials; the WebView receives neither token.
- Hermes continues to receive only the coordinator token and cannot call the
  operator operations.
- The UI may select only capability and workspace identifiers advertised by
  Node Core. Workspace filesystem roots are never returned.
- Operator and model text is rendered as plain text, never HTML or Markdown.

## Operator operations

- `catalog`: registered capability ids and workspace ids.
- `jobs`: locally stored jobs, newest first.
- `create_job`: Node Core assigns `job_id`, validates and seals the envelope,
  persists it, and appends `job.created` before returning it.
- `hermes_start`: starts one coordinator process for a non-terminal job. An
  optional operator response or granted approval id is passed only to that run.
- `hermes_status`: returns bounded in-memory coordinator output and run state.
- `hermes_stop`: terminates the coordinator process but does not make the job
  terminal, so the operator may resume it.

Coordinator run state is intentionally process-scoped. Durable truth remains
the job, receipts, and append-only activity stored by Node Core; raw model
transcripts are not persisted.

> **Superseded by spec Y.** The conversation is now durable and is the
> transcript: turns are persisted, a run rehydrates from them, and the cockpit
> reads them rather than a process's in-memory output. Run state remains
> process-scoped and is still not the transcript. Raw *model* transcripts —
> the full message array sent to the provider — remain unpersisted; what is
> stored is the coordinator's own say/ask/act/done turns.

## Clarifications and approvals

`state: ask` still ends one coordinator process. Cockpit displays the question;
the operator's reply starts a fresh coordinator process for the same immutable
job and is added to its initial model context. The coordinator may inspect the
job's durable activity through its existing tools.

An approval remains a separate human decision. Cockpit grants it through the
existing operator endpoint and then starts Hermes with that approval id. Node
Core still verifies its exact job, capability, argument digest, expiry, and
single-use binding.

## Acceptance

1. The coordinator token cannot call any new operator operation.
2. A created envelope is sealed by Node Core and unknown capabilities or
   workspaces are rejected.
3. Only one coordinator process may run per job.
4. Clarification text reaches the coordinator without appearing in process
   arguments.
5. Stopping Hermes leaves the job resumable; terminal jobs cannot be started.
6. Cockpit receives no credential and invokes only allowlisted operation names.
7. Cockpit renders hostile objective, question, and reply text literally.
8. Existing Node Core, coordinator, and Cockpit tests continue to pass.
