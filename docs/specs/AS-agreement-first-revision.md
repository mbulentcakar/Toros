# AS revision — agree first, then act within the agreement

Status: proposed for operator review; not an authorization to enable desktop mutation.
Date: 2026-10-30
Baseline: main `150df8d`; AS proposal [PR #1](https://github.com/mbulentcakar/Toros/pull/1),
head `e8e91e6`. This is a small amendment to AS, not a replacement specification.

## Intent

The operator discusses a task with the original Claude or Codex. That agent proposes a concrete
agreement. The operator accepts it once. The agent then requests the necessary actions through
Toros, with the other model family reviewing them automatically inside that agreement.
The operator is interrupted for a material change or an existing operator-only gate, rather
than every routine action. Jev and the OpenAI Decisions API are parked; no new decision provider.

The original agent remains the driver. Hermes is optional. A second model checks actions; it
cannot create permission, revise the agreement, or substitute its own goal.

## What already exists, and what does not

| Reuse | Current source |
|---|---|
| Discussion without execution authority | `routes-operator.ts` advisory conversation and `run-credentials.ts` |
| Validated plan, capabilities, workspace, exclusions, budget and expiry | `draft.ts`, `routes-tools.ts` `propose_job` |
| Explicit operator acceptance of the recorded proposal | `routes-operator.ts` `acceptProposal`; cockpit conversation card |
| Sealed job, policy, exact-action approvals and receipts | envelope, policy, approvals and action pipeline |
| Agent credentials and read-only MCP | AT, `routes-agent.ts`, `packages/mcp-discovery` |

AS's UI mutation adapter, surface classification/profiles, mission enrollment and isolated
cross-model approver remain proposed, not implemented on this baseline. This amendment must not
represent those as existing functionality. In particular, AT cannot click or type.

## The revised flow

1. **Discuss.** The original agent clarifies the outcome. Existing permitted discovery can inform
   the proposal. Discussion and proposal submission grant no execution authority.
2. **Propose.** Show one agreement card with the fields below. If a necessary capability is
   unavailable, label the proposal unavailable; do not offer a working Start button.
3. **Accept.** The operator presses **Agree and create task** in the authenticated cockpit.
   This accepts exactly the displayed proposal. No model tool may accept it.
4. **Start.** Use the existing Start control. Acceptance does not silently launch a run. When AS
   is implemented, the original agent enrolls through AS's existing proposed MCP mechanism.
5. **Act.** Core first checks hard limits and target policy. For AS actions, the other family
   reviews the exact request using the accepted agreement and AS's sanitized observed state.
   Core executes only the approved request after rechecking freshness and authority.
6. **Return when needed.** A scope change or uncertainty holds work. Explain the issue in the
   original conversation. Revising scope produces a new proposal and requires user acceptance.
7. **Verify and report.** Read back the result against the completion criteria. Report verified,
   failed or unverified accurately; dispatch or a worker's successful exit is not proof of the
   requested outcome. Existing job completion remains a proposal, not final acceptance.

There are two separate gates: the human accepts the mission; the reviewer approves individual
actions within it. Human acceptance does not remove existing high-impact approval requirements.

## Agreement: a small extension of the existing proposal

Keep the existing `objective`, `plan`, `capabilities`, `workspaces`, `acceptance`, `forbidden`,
`max_actions`, `max_retries` and `expires_in_hours`. Add only:

- `intent`: the bounded user request agreed in the original conversation, not a raw transcript;
- `target`: the specific file, application or device and the information needed to distinguish it;
- `changes`: the exact permitted changes and intended side effects.

Use `forbidden` for exclusions and stop conditions, and `acceptance` for completion evidence.
Show driver and reviewer identities on the same card when applicable. Do not add a second plan
editor, workflow graph, risk score or new permission settings page.

Core validates, redacts known credentials, normalizes and freezes the proposal before display.
Compute `agreement_digest` with the existing canonicalization/digest helpers over the immutable
source identity (`conversation_id` and proposal turn `seq`), complete normalized proposal,
driver identity and any execution defaults. The accept request supplies that source identity
and digest. A stale digest is refused; do not accept a newer proposal the operator never saw.
Two identical texts in different turns are distinct proposals. A retry resolves an already
accepted source identity before checking whether a new live proposal exists.
Revalidation must not silently add capabilities or change displayed terms: redisplay and accept.

The accepted job retains an immutable agreement snapshot and digest through existing durable
conversation storage, linked to its job id and envelope digest. The server, not an agent,
records acceptance. Repeated acceptance of the same proposal returns the existing job, including
after restart; it must not create duplicate jobs. Acceptance and binding must be recoverable
without leaving an executable job with a missing agreement. Do not issue a run or AS enrollment
until that binding is complete. Existing Store calls are individually durable, not one public
multi-operation transaction. Use a durable pending-acceptance record with one server-assigned
job id and prepared sealed envelope, then record completed binding. Recovery must reuse that
same job id/seal and refuse execution while pending. Do not re-seal with a fresh id or expiry
on retry. Keep all of this serialized by the existing conversation guard.

Execution and reviewer context load the snapshot by job id; neither caller-supplied agreement
text nor an echoed digest is authority. Models receive the same accepted scope. Raw chat,
credentials and unrelated desktop content do not enter the reviewer prompt or receipt log.

**Enforcement limit:** prose does not become a deterministic semantic boundary. Existing policy
enforces capabilities, paths, app identities, budgets and expiry; AS adds its specified target
and action checks. The reviewer evaluates intent within those limits. Never label arbitrary
free-text exclusions as mechanically guaranteed.

## Change, stop and delegation rules

- New targets, broader effects, extra capabilities, changed exclusions or increased budgets
  require renewed agreement. Do not modify an accepted job envelope. End the old execution
  authority before starting its replacement; the conversation can continue.
- Navigation and mechanical steps necessary for the agreed result do not require a revised plan.
  Unexpected effects or uncertain execution do: hold and inspect before retrying.
- Keep AS's denial, revocation, one-request-at-a-time, restart and uncertain-outcome rules.
  No fallback execution when the reviewer is unavailable. A stop cannot undo an effect already
  dispatched; report that uncertainty and verify before any retry.
- No recursive delegation feature in this revision. Existing worker jobs keep their existing
  bounds. A child process or model verdict cannot mint operator authority or approve itself.

## Preserved AS boundaries

No relaxation of existing AS decisions: Claude/Codex cross-approval, reviewed surface profiles,
operator-only browser/embedded-web and unknown surfaces, absolute secret-entry and Toros-process
bans, driver credential isolation, and no raw driver conversation sent to the reviewer.
No coordinate fallback, unrestricted shell, new adapter, automatic application launch or new
credential mechanism is introduced here.

Consequently, changing router settings autonomously through a browser is **not** delivered by
this revision. Under the present AS proposal those actions remain operator-only. Removing that
friction requires a separately accepted, narrowly bounded browser policy/adapter change; an
agreement card alone cannot safely turn a browser into an automatically approved surface.

## One bounded implementation slice

Time box: one working day, targeting 4–6 engineering hours plus independent review. This is a
budget for the agreement-flow change, not a promise to finish AS or general Windows control.

1. **Core and persistence:** extend the existing draft validation; retain the accepted agreement;
   add displayed-digest checking and duplicate-accept protection to the current acceptance path.
2. **Cockpit and context:** extend the existing proposal card with the three fields and clear
   availability/approval labels. Pass the accepted snapshot to existing execution context.
3. **Verification and review:** run focused native tests against temporary SQLite and the cockpit
   checks; obtain independent review of the acceptance/authority boundary before landing.

Allowed implementation areas: `packages/node-core/src/{draft,routes-operator,routes-tools}.ts`,
`core.ts`/`action-pipeline.ts` only for incomplete-agreement start/dispatch gating, the existing
coordinator context builder, their tests, `apps/cockpit/src/components/HermesChat.tsx`, its tests,
`apps/cockpit/src/api.ts`, and `docs/USING.md`.
Do not change `packages/contracts`, add a migration/package, or widen `/agent/*` or MCP tools in
this slice. Adding the three agreement fields must not weaken existing draft validation.

If durable acceptance cannot fit the existing storage APIs within this time box, or work requires
a new authorization surface, report the precise gap and stop. Do not stretch this into an AS
implementation or substitute a volatile record that only appears to survive restart.

Direct external-agent proposal submission, AS enrollment/action MCP tools, the isolated reviewer
runner and UI mutation remain AS implementation work. For this first slice, an external agent's
agreed proposal can be entered into the existing cockpit discussion; this is a manual handoff,
not a claim that the original external agent now executes it. Do not add a new bridge merely to
finish this revision. Integrating the accepted snapshot with AS later is required before enabling
AS execution. The slice is preparation, not the completed autonomous-desktop experience.

## Acceptance checks for this slice

1. Discussion and proposals cannot execute actions. Unknown/unavailable capabilities are refused.
2. The card shows the complete normalized agreement and existing limits before acceptance.
3. Another proposal (including identical text in a new turn) or changed normalized defaults makes
   the displayed digest stale; no job is created from that stale acceptance. Two concurrent
   accepts of the same source proposal produce only one job.
4. Repeated acceptance after a response loss or restart returns that same job and agreement.
   Inject failures around job creation and snapshot binding; no incomplete binding can start.
5. The executor receives the accepted snapshot. Caller attempts to replace it are ignored or
   refused. Existing capability/path/expiry and exact-action approval denials still apply.
6. A scope amendment requires a new acceptance and never widens the existing sealed job.
7. Credentials are redacted before display/persistence/context construction. No raw transcript
   is copied into the agreement or hash-chained event payloads.
8. AT remains read-only. The UI never claims Windows actions or cross-model approval are enabled
   when the AS prerequisites are absent. Existing operator-only gates remain in force.

Run `npm run build`, focused draft/confirmation/credential tests with real temporary SQLite,
and the existing cockpit test/typecheck commands. Report actual counts and skips. This document
is a specification; it supplies no runtime acceptance evidence.

## Acceptance scenario for completed AS, not this slice

On a reviewed native fixture: the original Claude/Codex proposes a specific reversible change;
the operator agrees once; the other family approves permitted steps; a changed target, stale
observation or out-of-scope change stops execution; readback proves the result. Use only windows
created by the fixture. Browser/router automation is not the initial fixture.

The implementation is complete at the eight checks above. No API-provider evaluation, broader
desktop rollout, merge or deployment is included. This proposed revision requires operator
acceptance and independent review; it does not supersede AS merely by being written.
