# AD — Cockpit attention model

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19
Absorbs: the "AD conversational polish" sketch named in STATUS.md

## Objective

Everything that needs the operator — a pending approval on a timer, a paused
pipeline, a Hermes run that ended in `waiting_for_input`, a failed advisory run
— is currently discoverable only by visiting the right tab. The cockpit shows
state; it does not summon attention. This spec adds the summons and makes the
Hermes thread honest about what Hermes did.

## 1. Attention strip

One new operator operation, `POST /operator/attention`, returning counts and
the earliest deadline in one response:

```json
{
  "pending_approvals": 2,
  "earliest_approval_expiry": "RFC3339 | null",
  "paused_pipelines": 1,
  "runs_waiting": 1,
  "browser_paused": false,
  "node": "reachable"
}
```

The cockpit renders a persistent strip under the tab bar whenever any count is
non-zero, each item deep-linking to its tab, and badges the Approvals and
Pipelines tabs with their counts. One poller feeds strip and badges; per-view
pollers do not multiply. The Rust command allowlist gains exactly this one
fixed operation name; neither bearer reaches the WebView (unchanged invariant).

## 2. Native notifications

Via the Tauri notification plugin, fired on **transitions** the poller
observes, never on every poll: a new pending approval (title includes the
capability and time remaining), a pipeline entering `paused`, a run entering
`waiting_for_input` or `failed`. Notifications are best-effort and carry no
argument values — the cockpit is where details live. A setting in the cockpit
(not in Node Core) can disable them.

## 3. Hermes thread transparency

`HermesChat` currently drops machine-channel turns entirely, so the operator
sees what Hermes *said* but not what it *did* — the opposite of what spec W
promised ("summarises the machine channel"). Change: render machine turns as
collapsed one-line chips — `▸ act codex.send`, `▸ done complete` — expandable
to the raw JSON. Proposals keep their card. The chip is a summary, never a
paraphrase: expansion shows the stored turn verbatim.

Add a run-state line to the thread while a run is live (`Hermes is working…`,
`Run failed — exit 7`), driven by the existing status operation. `busy` today
covers only the HTTP call; the async run is invisible.

## 4. Conversation list

Replace the bare `<select>` with a list showing title, last-activity time, and
open/closed state, plus an archive control (a new `conversation_archive`
operator operation setting state to `closed`; archived conversations are
listed under a toggle and are read-only). Titles remain first-message-derived.

## 5. Small repairs (all in this slice)

- Proposal-card number inputs: empty or non-finite input disables **Approve
  and run** instead of sending `NaN` to sealing.
- Polling pauses when `document.visibilityState` is `hidden`, resumes on
  visible.
- The duplicated nav block in `App.tsx` (job-detail branch re-renders the
  whole shell) collapses to one return.
- The palette moves to CSS custom properties on `:root`. A dark scheme is NOT
  in scope; the variables make it a later variable-swap.

## Non-goals

- No WebSocket/SSE push channel; polling stays, consolidated. A push channel
  is a separate decision with its own surface-area cost.
- No change to what the operator may do — this spec adds visibility, not
  authority. The archive operation touches conversation state only.

## Acceptance

1. With one pending approval, one paused pipeline, and one waiting run, the
   strip shows all three from every tab, each link lands on the right view,
   and the Approvals badge reads 1.
2. Granting the approval clears its strip entry and badge within one poll
   interval without a manual refresh.
3. A new pending approval fires exactly one native notification; ten
   subsequent polls fire none.
4. Machine turns render as chips; expanding one shows the stored turn
   verbatim; human turns and proposal cards are unchanged. Cockpit tests
   cover chip rendering and expansion.
5. A live advisory run shows a working indicator that clears when the run
   ends; a run exiting 7 shows a visible failure line in the thread.
6. An empty `max_actions` field disables approval rather than producing a
   sealing error.
7. All existing cockpit tests pass; the Rust allowlist diff contains exactly
   the two new operation names.
