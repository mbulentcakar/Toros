# AS revision — agree first, then act within the agreement

Status: accepted by the operator for implementation 2026-10-30 (slice AF below); its AS parts take
effect with AS. Baseline: main `150df8d`; AS proposal mbulentcakar/Toros#1 at `e8e91e6`. A small
amendment to AS, not a replacement.

## Intent

The operator discusses a task, the agent proposes one concrete agreement, and the operator accepts
it once. Work then proceeds inside that agreement. The operator is interrupted only for a change of
scope or an existing operator-only gate. A second model may check actions (AS), but it cannot
create permission, revise the agreement or substitute its own goal.

Almost all of this exists. Discussion without authority is the advisory conversation
(`routes-operator.ts`, `run-credentials.ts`). The validated proposal is `propose_job`
(`draft.ts`, `routes-tools.ts`). Explicit acceptance is `accept_proposal` and the cockpit card.
Sealing, policy, approvals and receipts are unchanged. AT's agent surface stays read-only. This
revision only closes the gaps below.

## Gaps in today's acceptance (verified on `150df8d`)

1. **Accept is not idempotent.** `acceptProposal` makes three separate store calls: seal and create
   the job, bind the conversation, append "Job created". If it fails after the first call, the
   proposal is still live and a retry seals a second job. The unbound job is also startable:
   `conversationFor` gives it a fresh conversation, with no agreement.
2. **The operator accepts "the last turn", not what they saw.** The accept request names only the
   conversation. Nothing ties it to the proposal on the card.
3. **The agreement is partly lost at sealing.** `plan` and each capability's `why` are not in the
   envelope. The proposal turn keeps them, but nothing links that turn to the job.
4. **The agreement has no fields for target and effects.** A proposal states an objective and steps,
   but not the specific thing it will act on or the changes it is allowed to make.

## Slice AF — the change

1. **Three optional fields on `propose_job`:** `intent` (the bounded request agreed in conversation,
   not a transcript), `target` (the specific file, app or device), and `changes` (the permitted
   changes and intended side effects). Each is a string of at most 2,000 characters. They are
   validated in `validateDraft`, redacted like the rest of the turn, and shown on the card. They
   are not envelope fields: policy does not enforce prose. The coordinator's tool schema describes
   them.
2. **Agreement digest.** `agreement_digest` = SHA-256 over the canonicalized normalized proposal:
   `validateDraft`'s output, including defaults and completed CLI lifecycle capabilities. Use the
   existing canonicalization. `propose_job` stores it in the turn beside the proposal, as
   `{ propose_job, agreement_digest }`.
3. **Accept names what was seen.** `accept_proposal { conversation_id, seq, agreement_digest }`.
   Under the existing conversation guard:
   - **Retry first.** The job id is derived deterministically from (`conversation_id`, `seq`). If
     that job exists, finish any missing step (the "Job created" turn, the `job.created` event) and
     return it. Never seal again.
   - **Otherwise check the proposal.** The turn at `seq` must be the conversation's last turn, and
     a proposal. Its re-validated proposal must hash to the supplied digest. Anything else is
     refused with `E_SCHEMA` ("the proposal changed; review it again") and creates no job. A
     newer turn with identical text has a different `seq`, so an old card is stale.
4. **No unbound window.** `Store.createJob` takes an optional `conversation_id` and writes it in the
   same insert (contracts A12). An accepted job is therefore bound from its first durable moment,
   and `conversationFor` never invents a conversation for it. The `job.created` event payload gains
   `agreement_digest`, `conversation_id` and `proposal_seq`: ids and digests only, never text. That
   event links the job to its immutable proposal turn, which is the agreement snapshot.
5. **Cockpit.**
   - The card shows the full normalized proposal: plan, the three fields when present,
     capabilities with their `why`, workspaces, limits, exclusions and expiry. It also says who
     drafted it (Hermes, for the conversation's worker agent).
   - The button reads **Agree and run**. It sends `seq` and the digest, then starts the job as
     today.
   - A failed start can be retried. Re-accepting returns the same job.

Unregistered capabilities stay refused at proposal time, as today. A proposal Core cannot seal is
never shown. A change of scope is a new proposal and a new acceptance. A sealed envelope is never
widened. To stop the old authority, cancel the job and revoke any AT grant on it.

**Allowed paths.**
- `packages/node-core/src/{draft,routes-operator,routes-tools,core}.ts`;
- `packages/store/src/store.ts`;
- `packages/contracts/src/ports.ts`: the optional parameter only;
- `docs/specs/00-CONTRACTS.md`: A12;
- the coordinator's `propose_job` schema in `packages/coordinator/src/index.ts`;
- `apps/cockpit/src/{components/HermesChat.tsx,api.ts}`;
- the tests for all of the above;
- `docs/USING.md`.

No migration, no new package, no new error code, no change to `/agent/*` or the MCP tools.

## AS, when it lands

- Accepting an agreement whose capabilities include AS desktop actions **is** the operator's
  mission creation for that job: one act, not two. The driver is the one named on the card.
  Mission creation on the operator surface remains for jobs without an agreement.
- AS's reviewer loads the agreement by job id through the `job.created` link, never from caller
  text.
- Every AS boundary is unchanged: cross-family approval, surface profiles, operator-only
  browser/web and unknown surfaces, the absolute bans, driver credential isolation, and no raw
  driver conversation sent to the reviewer.
- Changing router settings through a browser therefore stays operator-only. An agreement card
  cannot make a browser an auto-approved surface.

## Acceptance checks (AF)

Run natively with real temporary SQLite, then `npm run build`, the root `npm test` and the cockpit
checks. Report counts and every skip.

1. The same (`conversation`, `seq`, digest) accepted twice, sequentially or concurrently, gives one
   job, one "Job created" turn and one `job.created` event.
2. Inject a failure after `createJob`. The retry returns the same job id, bound to the conversation,
   and completes the missing turn and event. Starting the job never creates a second conversation.
3. A stale `seq` (a newer turn exists, including an identical re-proposal) is refused and creates
   no job. So are a wrong digest and a proposal whose re-validation changes its normalized form
   (for example, a capability unregistered in between).
4. The three fields are validated (type and length), redacted, displayed, and absent from the
   envelope. An unknown capability is still refused at proposal time.
5. The `job.created` payload carries the digest, conversation id and `proposal_seq`, and no free
   text.
6. `createJob` without `conversation_id` behaves exactly as before. The direct `create_job` path is
   unchanged.
