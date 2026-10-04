# Y — Durable Hermes conversation

## Objective

Give Hermes a memory of the conversation it is having and of the work it has
already done, and separate what it says to a human from what it asks the
machine to do.

Today every `hermes_start` spawns a coordinator that rebuilds its model context
from the system prompt and one synthetic user message. It has no record of the
question it asked, the answer it received, or the actions it already executed.
Answering a clarification does not continue a conversation; it restarts one.
The visible transcript is scraped from raw stdout and lives only in memory, so
a Node Core restart erases it while the job continues.

This slice does not change what Hermes is allowed to do. The envelope, the
digest, the policy gate, approvals, receipts and the event chain are untouched.

## Storage

Store migration 3 adds two tables, both append-only in the same discipline as
`events`:

- `conversations` — `conversation_id`, `node_id`, `title`, `created_at`,
  `updated_at`, `state`. A conversation is long-lived and may relate to zero,
  one, or many jobs.
- `conversation_turns` — `conversation_id`, `seq`, `role`
  (`operator` | `hermes` | `system` | `tool`), `channel` (`human` | `machine`),
  `content`, `job_id` (nullable), `recorded_at`.

`seq` is monotonic per conversation and assigned by the store, not the caller.
Turns are never updated or deleted. Model credentials are never written; the
existing redaction applied to tool output before the next model request applies
equally before persistence.

`Store` gains `createConversation`, `getConversation`, `listConversations`,
`appendTurn`, and `listTurns(conversationId, { after? })`.

## Coordinator lifecycle

The coordinator remains a one-shot process. It does not become a daemon, and
no untrusted process outlives the turn it was started for. What changes is
where its state lives:

- On start it is given a `conversation_id` and rehydrates its model context by
  reading that conversation's turns from Node Core, oldest first, bounded by a
  configured context budget with the oldest turns elided first.
- When the run is bound to a job, it also loads that job's receipts and places
  them in context as a record of work already performed. This is what stops a
  resumed coordinator repeating actions it has already taken and consuming
  `max_actions` a second time.
- Every turn it produces is appended through Node Core before the next model
  request, so a crash loses at most the turn in flight.

Rehydration is a Node Core operation on the coordinator's existing authenticated
surface, scoped to the conversation it was started for. A coordinator cannot
read another conversation.

## Protocol

The coordinator's stdout becomes NDJSON, one object per line, replacing exit
codes as the primary state signal and raw text as the transcript:

```
{"say": "I would need to read the deploy log to answer that. Shall I?"}
{"ask": "Which of the two workspaces did you mean?"}
{"act": {"tool": "read_cli", "arguments": {}}}
{"done": {"outcome": "complete", "summary": "..."}}
```

`say` and `ask` are the human channel and are the only fields the cockpit
renders. `act` and `done` are the machine channel and are never shown as prose.
Exit codes remain, and remain the authority on run outcome, but the transcript
no longer depends on them.

Malformed lines are recorded as `system` turns and do not terminate the run;
the existing two-consecutive-parse-failure rule continues to govern the model's
structured responses.

## Cockpit

The workspace reads the conversation from the store rather than from process
memory, and streams new turns as they are appended. A run that ended, a Node
Core that restarted, and a cockpit that was closed and reopened all show the
same history.

## Spec amendments

`S-coordinator.md` states that the coordinator holds no state between runs and
that raw model transcripts are not persisted. Both claims change here and the
document is amended in this slice rather than after it. `W-cockpit-hermes-
workspace.md` gains a note that process-scoped run state is superseded.

SPEC §5's immutability guarantee is unaffected: conversations do not touch
envelopes. §8.1 rule 12 is unaffected; approvals are addressed in AC.

## Acceptance

1. A conversation survives a Node Core restart with every turn intact and in
   order.
2. A resumed coordinator's first model request contains its own prior turns.
3. A resumed coordinator bound to a job has that job's receipts in context, and
   a test demonstrates it does not repeat an already-executed action.
4. No transcript text reaches the cockpit by parsing unstructured stdout.
5. `act` and `done` payloads are never rendered as human prose.
6. A configured credential never appears in a persisted turn.
7. A coordinator cannot read turns from a conversation it was not started for.
8. A crash between two turns loses at most the turn in flight.
9. Existing store, Node Core, coordinator, and cockpit tests continue to pass,
   and migration 3 upgrades an existing database without loss.
