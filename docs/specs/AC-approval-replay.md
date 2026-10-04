# AC — Approval replay

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Make an operator's approval structurally spendable. Today an approval is bound
to exact arguments with a five-minute TTL, the coordinator exits 6, and the
resumed run **re-derives** the action from model context rather than replaying
the approved one. Y's rehydration makes re-derivation *likely* to reproduce the
same arguments; nothing makes it certain. A gate whose grant only probably
matches the spend is a gate that trains the operator to expect
`E_APPROVAL_INVALID`.

## The change

**Node Core replays the approved action itself.** `hermes_start` with an
`approval_id` no longer merely forwards the id to the coordinator:

1. Node Core looks up the granted approval and reads back the **exact pending
   request it stored when the gate fired** — capability and full arguments. The
   approval registry already holds both; nothing new is persisted.
2. It executes that action through the ordinary pipeline — `action.requested`,
   policy decision (presenting the approval token), budget spend, receipt,
   `action.finished` — before the coordinator process starts. Policy still
   decides; replay is not a bypass. A replay denied by policy (expired
   envelope, exhausted budget) fails the start with that denial.
3. The coordinator then starts normally. The executed action reaches the model
   the same way every prior action does: through receipt rehydration. No new
   prompt channel is added.

The coordinator's `--approval` flag and the "present the token on every call"
behavior are removed once replay lands — they are the workaround this spec
retires.

## TTL

The five-minute TTL was calibrated to a coordinator waiting in-process. With
replay, the TTL only needs to outlive the operator's decision, not the model's
memory. Raise the default to 60 minutes, configurable in operator config as
`approval_ttl_minutes` (1–1440). Expiry semantics are unchanged: expired is
expired, and the log over-records rather than under-records (the existing
audit-first grant order is untouched).

## Non-goals

- No approval survives Node Core restart. In-memory pending approvals remain
  in-memory; DEPLOY.md documents that a restart clears them, and that stays
  true.
- No batch approvals, no standing approvals, no "always allow". One decision,
  one action, exactly once.
- Cockpit notification of pending approvals is spec AD, not this one. This
  spec only guarantees that a granted approval can actually be spent.

## Acceptance

1. Gate fires → operator grants → `hermes_start` with the approval id executes
   the exact approved action (same capability, same `arguments_digest`) before
   the model's first turn, visible as an ordinary receipt chain.
2. The replayed receipt's `arguments_digest` equals the digest recorded in
   `approval.resolved`. A test asserts equality, not similarity.
3. A granted-then-expired approval fails the start with `E_APPROVAL_INVALID`
   and executes nothing.
4. Replay of an action whose job has meanwhile gone terminal, expired, or
   exhausted its budget is denied by policy with the correct code, and the
   denial receipt exists.
5. An approval is spent by its replay: a second `hermes_start` with the same
   id fails and executes nothing.
6. The resumed model run sees the action in `already_performed` and does not
   re-request it — one bakeoff-style case proves no double execution.
7. `approval_ttl_minutes` is honored from config; absent, the default is 60.
