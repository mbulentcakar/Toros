# Z — Advisory Hermes and job proposal

> **Implemented 2026-08-10.** One deviation from the design below: advisory mode
> is enforced by the *credential* rather than by a mode flag on the run. An
> advisory run authenticates with its own run token instead of the node bearer,
> and Node Core grants that token only `propose_job`, `list_turns` and
> `append_turn`. This is strictly stronger than checking a field on the request —
> there is no argument an advisory run could vary to widen itself — and it left
> the existing job-bound surface untouched. `recall` and `load_skill` are absent
> because AA and AB are unwritten.

## Objective

Let the operator open a conversation in ordinary language and let Hermes ask
its way to understanding, then have Hermes draft the bounded job it wants to
run and put it in front of the operator for approval.

The envelope is a good execution boundary that is currently also the entry
boundary: nothing can be said to Hermes until an immutable capability contract
has been authored by hand. That constrains the operator, not the coordinator.
This slice moves the sealing to the moment Hermes wants to act.

Nothing about the security model relaxes. The envelope is still sealed by Node
Core, still digest-bound, still immutable, and still the sole authority on what
a job may do. It is drafted by Hermes and confirmed by the operator instead of
typed by the operator.

## Advisory mode

A conversation begins with no job. In that state the coordinator runs in
advisory mode and its tool surface contains only:

- `recall` and `list_skills` / `load_skill` when AA and AB land; until then,
  nothing.
- `propose_job`.

It has no access to `start_cli`, `send_cli`, `invoke_app_action`,
`create_local_relay`, or any other operation that reaches the machine. This is
enforced by Node Core against the run's mode, not by the system prompt, and is
asserted directly in a test. Advisory Hermes cannot act, so conversation with
it needs no envelope — that is the property that lets the form disappear.

## Proposal

`propose_job` carries a draft envelope and, for each requested capability, a
short justification in plain language:

```json
{
  "objective": "...",
  "acceptance": ["..."],
  "capabilities": [{"id": "codex.start", "why": "to read the failing test"}],
  "workspaces": ["..."],
  "max_actions": 20,
  "max_retries": 2,
  "expires_in_hours": 8
}
```

Node Core validates the draft against its registered capabilities and
workspaces and returns it to the cockpit as a proposal. A proposal is not a
job: nothing is sealed, nothing is persisted as an envelope, and no action
budget exists until the operator confirms.

The cockpit renders it as a card inside the conversation: objective, acceptance
criteria, each requested capability with its justification, workspace, budget
and expiry. Every field is editable in place. Confirming calls the existing
`create_job` operation with the edited draft, which seals it exactly as W
already does, and the job is bound to the conversation.

A rejected proposal is recorded as a turn and the conversation continues.

## Conversation and jobs

A conversation may produce zero, one, or several jobs; each job records the
`conversation_id` it came from. Envelopes remain immutable, so widening a
running job is never possible — Hermes proposes a successor job, and the
cockpit says so in those words rather than reporting a denial.

Job progress appears in the same thread as the conversation that produced it.
Receipts are rendered inline as short factual lines, not as a separate list.

## System prompt

The current coordinator prompt is a terse JSON-protocol instruction that
discourages questions. Advisory mode needs the inverse: ask when the objective
is ambiguous, one question at a time, plain language, no JSON in the human
channel. The acting prompt is unchanged apart from the channel split defined
in Y.

## Cockpit

The Hermes tab opens on a message box and a thread. The job creation form is
removed. Job listing, receipts, findings and approvals remain where they are.

## Acceptance

1. An operator can hold a conversation with Hermes without any job existing.
2. In advisory mode, every world-touching tool is refused by Node Core, and a
   test asserts the refusal rather than relying on the prompt.
3. A job can be created end to end without the operator typing a capability id
   or a timestamp.
4. A proposal naming an unregistered capability or workspace is refused with a
   message that names it.
5. A proposal is not a job: rejecting one leaves no envelope, no budget, and no
   `job.created` event.
6. An operator edit to a proposal is what gets sealed, and the sealed envelope
   digest covers the edited values.
7. Objective, question, reply and justification text from any source renders
   literally, never as HTML or Markdown.
8. Existing Node Core, coordinator, and cockpit tests continue to pass.
