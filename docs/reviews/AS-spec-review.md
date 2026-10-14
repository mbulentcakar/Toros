# AS — independent spec review (brief)

**Reviewer: Codex (GPT-5.6), the orchestrator-deputy lane in the fleet lane map. Not Claude.**
Claude wrote spec AS, and the author is never the reviewer. If Codex is unavailable, use Gemini 3.
Do not use Claude, Grok, or any model that will implement an AS slice.

## Goal

Decide whether spec AS is **safe and precise enough to implement**, and say exactly what must change
first if it is not.

## Why this review exists

Spec AS gives a Claude or Codex session the ability to click and type into any Windows
application. Its whole value is the authorization structure around that ability: an operator
mission, cross-agent approval, deny tiers, and a log. A spec with a gap in that structure produces
an implementation that ships the gap faithfully. This review is the last cheap point to find it.

It is a **spec** review, not a code review. There is no AS code yet. The question is whether the
design holds, and whether an implementer could misread it into something weaker.

## Target

PR [mbulentcakar/Toros#1](https://github.com/mbulentcakar/Toros/pull/1), branch `spec/desktop-grants`:

- `docs/specs/AS-delegated-desktop-control.md`: the spec under review;
- `docs/SPEC.md`: the amendments to §2, §4.1, §6, §8.1, §10;
- `docs/specs/V-adapters-uia.md`: the superseded-in-part note.

Read for context, not under review: `docs/specs/00-CONTRACTS.md` (binding),
`V-adapters-uia.md` (inherited rules), `AR-read-only-discovery.md` (the read layer AS builds on),
`D-policy.md` rule 12, `AC-approval-replay.md`, `T-cockpit-approvals.md`,
`packages/contracts/src/ports.ts` (`ApprovalBinding`, `ApprovalVerifier`),
`packages/node-core/src/approvals.ts`, `core.ts` (the token-distinctness check near line 137).

**Appendix A of AS lists 14 operator decisions. They are requirements, not open questions.**
Challenge them only if one is internally contradictory or impossible to implement as written,
and say which.

## Questions to answer

1. **Self-approval.** Can the driver end up approving its own request by any path? Consider: the
   approver identity derivation, the driver reading `config.json` (accepted gap, decision 14), the
   driver driving the cockpit (absolute tier), the driver influencing the approver's prompt through
   screen content or its stated reason, and repeated reworded requests.
2. **Approval binding.** Is "what the approver saw" exactly "what executes"? Look at selector
   re-resolution, the element-property check before execution, `arguments_digest`, TTL, AC replay,
   and pid reuse. Find a time-of-check/time-of-use window, if there is one.
3. **Deny-tier classification.** Can a target dodge the operator-only or absolute tier? For example
   a renamed or copied `cmd.exe`, a console hosted inside another process, a browser embedded as
   WebView2 in an ordinary app, an elevated process, a Toros child process, or a password field
   that does not set `IsPassword`. Process-name lists are weak; say what the classifier should key
   on instead.
4. **Fail-closed.** Is every approver failure a deny? Check timeout, malformed output, adapter
   crash, Node Core restart mid-request, a locked screen, and an expired mission with requests in
   flight.
5. **Mission scope.** Does 24-hour expiry plus the job binding actually bound authority? Check
   "unless otherwise specified" (there is no hard maximum; is that a problem?), the
   `any_not_denied` scope, and one act-mission per desktop session.
6. **MCP surface.** Is the stdio server really policy-free? Could any tool become an approve path,
   a shell, or a file read? Is "zero runtime dependencies, implement MCP on node built-ins"
   realistic, or a trap?
7. **Contract fit.** AS claims no contract change, with a possible A7 for the `approval.resolved`
   payload. Verify against `packages/contracts`. Name every type that would actually have to change.
8. **Implementability.** Is any acceptance test untestable, contradictory, or impossible to make
   fail? Is any sentence ambiguous enough that two implementers would build different things?
9. **Omissions.** What does a two-agent desktop-control design need that the spec does not say?

## Out of scope

- Code changes of any kind. Do not implement AS, and do not edit `packages/` or `apps/`.
- Rewriting the spec yourself. Report findings; the author revises.
- Re-reviewing spec AR's read-only surface. That has its own adversarial review
  (`AR-adversarial-security-review.md`).

## Deliverable and acceptance

1. Findings appended **below the line at the end of this file**. Rank them `blocker`, `major`,
   `minor`, or `nit`. Each finding gives the spec section, the concrete failure (what an attacker or
   a careless implementer does → what goes wrong), and the smallest spec change that closes it.
2. An explicit verdict line: `VERDICT: ready to implement` | `ready after the listed blockers` |
   `needs redesign`, with one sentence of why.
3. Commit on a branch `review/as-spec` cut from `spec/desktop-grants`, push it, and open a PR into
   `spec/desktop-grants`. Also post the verdict and the blocker list as a review comment on PR #1.
4. Do not approve or merge PR #1. The operator accepts it.

## Constraints

- One agent per working tree. Use your own worktree, not the author's.
- No secrets, tokens, local user paths, or hostnames in anything you commit. This is a public
  repository.
- Docs only, so there are no tests to run. Say so in your PR rather than reporting a pass.

---

<!-- spec review findings go here -->

## Independent review — 2026-10-13

Reviewer: Codex. Reviewed PR #1 at `7afe8678c447a639a3f9f1947a52ee3843edf2b8`,
independently against the three target documents, the named context specifications, and the
current contracts, approval registry, policy, HTTP transport, action pipeline and CLI adapters.
This is a design review; no AS implementation or spec rewrite is included.

VERDICT: ready after the listed blockers — the operator/driver/delegate structure is implementable,
but the target, execution, secrecy and contract boundaries below must be specified before an
implementer can safely build it.

Appendix A's fourteen decisions are treated as requirements. In particular, decision 14's
same-user shell/config-file gap is accepted; this review does not demand Phase 2 confinement.
The verdict is conditional on that stated trust assumption and does not accept PR #1.

### AS-B1 — blocker — deny tiers lack a trustworthy classification algorithm

**Sections:** AS “Two deny tiers”, “App grant”; SPEC §4.1 and §8.1 amendments.

**Failure:** copy/rename a shell or browser executable, host a terminal or WebView2 inside an
ordinary application, or reach the cockpit through its child WebView process. A classifier
implemented from the listed basenames and a console window class can call these ordinary
delegate targets. Capturing a hash and signer does not specify how either affects classification.
Toros is hosted by generic runtimes, so a basename test also cannot identify its process family.
An elevated application on the ordinary desktop is not the secure desktop; if the automation
worker is also elevated, relying on UIA access failure does not close that path. Finally, a
credential control that omits or falsely reports `IsPassword` can receive a non-pattern password
through `set_value`, violating decision 13.

**Smallest change:** specify classification precedence (absolute wins), evidence and unknown
handling. Use OS-observed process identity/start time, canonical executable identity with verified
image/hash and signed metadata, token integrity/session/desktop, and the resolved element's
actual owner and hosting ancestry. Maintain a Node-owned identity registry for Toros and its
UI/automation/approver children; make hosted cockpit content absolute. Recognize protected
binary identities across renames/copies, embedded shell/browser surfaces and credential surfaces;
names, signer alone and provider labels are insufficient. Route unrecognized or unverifiable
surfaces to operator-only or refuse them; refuse credential entry where protection cannot be
established, even if `IsPassword` is false. Define elevated-process handling and prohibit an
automatic elevated/UIAccess helper. Reclassify at execution, including reads, and add adversarial
cases for each example. If universal classification of arbitrary providers cannot be guaranteed,
say so and conservatively restrict delegation to surfaces whose classification is supported.
Windows documents the integrity-dependent access rules in its
[UI Automation security guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview).

### AS-B2 — blocker — app grants can become standing approval for operator-only reads

**Sections:** AS “App grant”, “Operator-only”, MCP surface; acceptance 9, 14–15.

**Failure:** the operator approves access to a credential application once; the implementer then
uses the grant's unconditional “admits reading that process's windows” rule for every subsequent
`inspect_tree`/`find`. Operator-only requests are supposed to require a personal decision per
action, yet only mutations explicitly enter rule 12. A subtree read can also encounter a password
control below a harmless root after root-only classification. This exposes content without the
required human decision. App requests themselves have no element, so their password-read tier
cannot be implemented by the same check without more rules.

**Smallest change:** give app admission and each of the six actions an explicit tier/gate table.
An app grant is a prerequisite, never a replacement for per-read operator approval in that tier.
Classify all data to be returned; quarantine an operator-only subtree until its exact bounded
read is approved, and retain AR's unconditional password-value omissions. State how the operator
grants an operator-only app without granting future actions. Specify read replay/binding and
expiry exactly as for mutations. The current policy can gate a read if configured; the issue is
the missing normative rule, not a need to pretend the read mutates.

### AS-B3 — blocker — equal selector properties do not bind the approved target

**Sections:** AS “Action approval”, “App grant”; inherited V “Addressing an element”; acceptance
10–11, 13.

**Failure:** approve a button, then replace it with another button at the same selector/index
having the same type, id, name, enabled flag and patterns. AS's property comparison succeeds on
a different control. Alternatively, keep the button unchanged while switching the selected
document/recipient/account; the approved click now affects different data. `arguments_digest`
currently covers arguments only, and AS never defines whether mission/grant/process identity or
the observed snapshot is among those arguments. A matching selector in another grant or a new
mission on the same job can consequently fit a careless implementation's binding. PID start
time is recorded for grants but not explicitly checked on every resolution/replay. There is also
a check/use interval between comparing properties and calling the UIA pattern; another process
can change state during it.

**Smallest change:** define one immutable, server-prepared approval record binding authenticated
driver, mission, envelope digest/job, grant, desktop session, process start/image identity,
window/control instance, action/value and a precisely enumerated relevant-state snapshot. Cover
that record in the canonical arguments digest, or expressly amend the binding contract. Show
the same record to either approver, retain it for replay and audit its digest. At execution,
revalidate the grant/process and instance, all relevant ancestor/context properties and tier,
then call the pattern on that same resolved element without another selector lookup. V needs an
explicit exception if ephemeral internal instance identifiers are used; do not turn them into
durable/restart selectors. Microsoft notes that
[runtime identifiers can be reused](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid),
so an id alone is insufficient. State that generic UIA cannot atomically bind arbitrary
application state to a side effect: require an application-specific state guard where needed,
or refuse an action whose promised binding cannot be established. Add replacement-with-identical-
properties, context-switch, cross-grant/mission, PID-reuse and last-check race tests. Do not claim
property equality guarantees the semantic effect an arbitrary application will perform.

### AS-B4 — blocker — invalidation has no execution/cancellation ordering

**Sections:** AS “Mission”, “Sessions and failure behaviour”, “Stop all”; acceptance 4, 8, 15.

**Failure:** the delegate starts while a mission is live; revoke/expiry/lock then occurs; a late
`approve` callback re-grants authority or an already-started PowerShell worker invokes the
control. Clearing maps or pending requests is not a cancellation barrier. The existing action
pipeline checks policy before awaited store operations and supplies a new, unconnected
`AbortController` signal. On a hard Node crash, an external automation child also needs explicit
lifetime supervision; forgetting its grant in memory does not stop that child's next UI call.

**Smallest change:** specify a request state machine, mission generation and a per-desktop
execution serialization point. Under that guard, recheck live caller/mission/job, expiry,
grant/process, tier and approval immediately before committing execution; late decisions for
invalid generations are inert. Revoke, expiry, terminal-job and lock/disconnect invalidate
pending/granted work and cancel/reap owned approver and automation children, including on parent
death, before a new mission can act. Distinguish an unstarted action from a UIA call already
issued: cancellation cannot undo an external effect; log that race/uncertain outcome without
retry. Require fail-closed audit-write failure as well as timeout, malformed output, nonzero CLI
exit, adapter failure and restart. Test each invalidation while awaiting a verdict, after grant,
after policy, and at worker dispatch; assert no later unstarted action executes.

### AS-B5 — blocker — refusal can happen after a secret has entered the log

**Sections:** AS “Absolute”, “Real-time log”, “Events and receipts”; acceptance 18, 20; AG.

**Failure:** follow the specified `requested(value)` → `classified` → `refused` sequence with a
pattern-matching `set_value`. The append-only request event already contains the refused secret.
Scanning only values also leaves driver reasons, selectors, titles, delegate reasons and error
messages as echo paths into the log or approver transcript. AG is still a proposed consolidation;
the current known-token redactor does not automatically include AS's new agent tokens.

**Smallest change:** require schema/size validation and secret detection before any persistence,
cockpit publication, parameter-file creation or delegate invocation. Log rejected input using
request id, digest and detection kind only, never its raw value. Decision 9 applies to admitted,
non-secret typed values. Sanitize other untrusted strings and error/verdict reasons at every
durable boundary; include all Toros credentials in known-token detection and define the exact
versioned AG pattern dependency before AS ships. Never treat an oversized/unscannable value as
clean. Add tests that search events, receipts, files and error responses for synthetic rejected
secrets, including a delegate echo. This preserves full logging of permitted values without
contradicting the no-secrets invariant.

### AS-B6 — blocker — the existing CLI exchange is neither tool-free nor transcript-free

**Sections:** AS “Cross-approval”, prompt/verdict, AS3 allowed paths; inherited E.

**Failure:** implement “through the existing CLI adapters” using their read-only mode. Claude
maps that to `--permission-mode plan` and Codex to a read-only sandbox; neither is AS's mandated
no-tools mode. Both operate in a workspace-derived directory and can inherit project instructions
or configured tool servers; a fresh conversation alone does not isolate a driver-controlled
instruction file. The adapter also writes `exchange-N.jsonl` unconditionally, contrary to AS's
explicit no-raw-transcript rule. Its reserved policy flags prevent AS3 from simply adding some
of the needed switches through operator arguments.

**Smallest change:** define a dedicated approver execution profile: Node-owned clean working
directory, no driver-writable instruction/config/resume source, pinned actual opposite CLI/model
identity, no tools/MCP/hooks with execution authority, bounded input/output/deadline, and no raw
exchange-file retention. Require a completed successful exchange and exactly one validated
verdict; an `approve` fragment followed by crash/timeout/extra output denies. Separate CLI
authentication material from Toros approval authority. Assign and review the necessary adapter
changes explicitly (AS3 currently lists only Node Core paths), and verify both real CLIs under
this profile. The profile is an implementation of decisions 3/12, not a request to remove the
accepted driver confinement limitation. Add poisoned-workspace/config, tool-attempt, partial-
output failure and transcript-absence tests.

### AS-B7 — blocker — the frozen-contract gap is definite and larger than a payload field

**Sections:** AS introduction, “Action approval”, “Events and receipts”; 00-CONTRACTS §10.

**Failure:** an implementer obeys “no contract change” and tries to append `mission.created` or
`desktop.app_granted`. Those strings are absent from the closed `EventKind` union, so the code
cannot typecheck without violating the freeze or hiding events under another kind. Conversely,
`approval.resolved` already has a `JsonValue` payload: adding JSON keys is not the structural gap
the proposed A7 describes. Delegated approvals also change documented human/operator-only
semantics in the shared contract.

**Smallest change:** record an explicit amendment before dispatch, with this inventory:

| Contract type | Required change or verified fit |
|---|---|
| `EventKind` (`receipt.ts`) | Structural change: add the six specified mission/app lifecycle kinds; enumerate any additional lifecycle/classification kinds the revised design requires. |
| `ActionSchema` (`capability.ts`) | Semantic/documentation change: `always_requires_approval` currently promises human approval; document tier-bound delegation and conditional read gates, including the inaccurate blanket read exemption in `mutates`. Existing boolean fields need not widen. |
| `ApprovalVerifier` (`ports.ts`) | Semantic/documentation change: its authority is currently explicitly operator-only. Specify Node-issued delegate decisions without exposing an external agent decide route, and preserve atomic `consume`. Signature can remain. |
| `ErrorCode` (`errors.ts`) | Semantic/documentation change: AS uses `E_SECRET_DETECTED`, currently documented for relay creation, for desktop refusal. Enumerate mappings for every new denial; do not invent codes during implementation. |
| `Receipt` (`receipt.ts`) | Document authenticated driver attribution in `actor`, currently described as coordinator/operator. `adapter_fields` already accommodates the declared AS fields; no structural widening is needed. |
| `ApprovalBinding` | Its three fields can remain if AS-B3's server-prepared context is covered by `arguments_digest`; otherwise name the deliberate structural amendment, rather than silently adding private binding semantics. |
| `EventRow`, `AppendEventInput`, `Store` | `payload: JsonValue` and existing append/read ports already fit the new JSON payloads. Their kind fields consume the amended `EventKind`; no separate payload union needs widening. |
| `JobEnvelope`, `AdapterManifest`, `AdapterContext`, `ActionResult`, `Adapter`, `SessionAdapter`, `SessionRecord`, `Permission`, `PolicyDecision`, `CapabilityId` | No structural change demonstrated: keep mission/grant state local, context in validated JSON, cancellation through `signal`, and manifest-declared receipt fields. Do not confuse the OS desktop session with a CLI `SessionRecord`. |

`NodeCoreOptions`, CLI options, `ApprovalRequest`/replay state and `UiaAdapterOptions` are outside
`packages/contracts`; their AS-specific changes still need written ownership and API definitions.
Update binding comments in D/T/E/V where the new behaviour differs. This is a design inventory,
not permission for an implementation worker to edit the frozen package.

### AS-M1 — major — denial finality is delegated back to the model

**Sections:** AS MCP denial/rewording rule, “Out of scope”; SPEC §5 and D “Denial is final”.

**Failure:** repeatedly reword the reason or alter a selector representation after a refusal,
paying for fresh one-shot verdicts until one approves. Showing denial history is advisory, not
enforcement. The current registry caps simultaneous live requests, not total attempts; failed
executions are what its retry accounting counts. A sequential stream of denied model calls can
therefore escape the action budget and the claimed finality.

**Smallest change:** define Node-enforced denial finality and a finite mission-level request/model-
call budget, including app requests and failures. The simplest rule is that a denied proposal
requires operator intervention before further attempts for that target/action; define its stable
key independently of free-text reason and selector aliases. Alternatively end the act mission on
denial. Cap queues, concurrent calls and history size; exhausting the cap denies, not silently
drops history. Add repeat/reword/alias and sequential-flood cases. Do not claim prompt-injection
immunity: fixed prompts/data labels reduce risk, while deterministic tiers/budgets contain it.

### AS-M2 — major — mission session, scope and effective lifetime are underspecified

**Sections:** AS Mission, Sessions, MCP `mission_status`/`desktop_await`; acceptance 1–6.

**Failure:** the mission has no interactive-session identity, and an agent token identifies
`claude`/`codex`, not a unique CLI session. Two callers or Core instances can interpret “one act
mission per session” differently. `desktop_await` names only a request id, allowing an
implementation to return another caller's result. A listed executable is not required to match
the canonical live image on every access. Long operator expiry also has no explicit intersection
with the job and approval lifetimes.

**Smallest change:** specify the OS session/desktop key and exclusive owner, including the
multiple-Core case; bind mission, caller identity and every request/status/result lookup to it.
State whether “driver” means an authenticated agent role or one enrolled CLI instance and provide
the enrollment binding for the latter. Define executable canonicalization/revalidation and scope
intersection with envelope capabilities/forbidden terms/grants. Set effective authorization expiry
to the earliest mission, job, approval and grant expiry; clamp already-pending requests too.
Keep decision 4's operator override: the absence of a hard maximum is not itself a blocker when
only the operator can choose it and all other bounds still apply. `any_not_denied` must still
require positive app admission and classification; it cannot be the classifier's unknown default.

### AS-M3 — major — “policy-free MCP” lacks a bounded wire/route contract

**Sections:** AS MCP surface, AS4; acceptance 21–22.

**Failure:** implement a generic HTTP forwarder using caller-supplied operation/path/agent/config
fields, or interpret tool arguments as launch paths. The thin server becomes a route/credential
selection primitive. Alternatively implement only JSON-RPC `tools/call`; real clients cannot
negotiate or distinguish transport failure from a policy denial. Repeating `desktop_await` can
execute twice if execution is coupled to each waiter, while dropping the connection leaves
execution timing unspecified.

**Smallest change:** pin a supported MCP revision and exact tool input/output schemas, fixed
tool-to-Node routes and one configured identity. No tool may choose a URL, credential, config
path, executable launch command or arbitrary filesystem operation. Node Core must reject agent
credentials on operator/Hermes routes and enforce ownership even when MCP is bypassed. Define
request creation, the single execution trigger, wait/poll idempotence, disconnect/cancellation and
unknown-id behaviour. Bound frames, outstanding ids, input/output and wait duration; stdout is
protocol-only. Zero dependencies is feasible for this narrow subset, but require initialization,
capability/version negotiation, `tools/list`, `tools/call`, errors and native Claude/Codex
interoperability checks against the
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
[stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and
[tools contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
Protocol validation in MCP is compatible with policy staying in Node Core.

### AS-M4 — major — inherited rules and fixture promises are not mutually implementable as written

**Sections:** AS introduction, AS2, acceptance preamble/fixture paragraph; V public API/actions/tests;
SPEC §2/§10 amendments.

**Failure:** AS says it supersedes only V's per-app target binding and keeps everything else,
but V declares approval false for all six actions, requires a configured executable at init,
allows start to launch that program, defines only the old six input schemas, and forbids UIA for
applications with a native API. AS adds mutations with mandatory approval, dynamic grants and
namespaced request/wait operations without an explicit replacement API. V's `inspect_tree`
output description omits values although its test 8 reads a value back; AR's read action never
returns values. Two implementers will expose different read surfaces. The claim that all tests
use Notepad/Calculator cannot exercise protected targets, a lying password provider, process
replacement, lock/restart races or real one-shot agent failure. V's write tests also need mission
setup and approval now. Passing only those benign fixtures misses the design's security claims.

**Smallest change:** enumerate exactly which V clauses are overridden, publish the AS adapter/
Node APIs and schemas (including mission/grant/reason context), and define whether non-running
applications can be launched. Do not run an arbitrary caller-selected executable merely to
resolve an app request. Retain native-API preference or explicitly amend it, rather than implying
that “any application” silently supersedes it. Specify the exact allowed read output, inherited
omissions and field bounds. Rewrite the test matrix for mission-equipped real desktop smoke
tests plus controlled classifier/identity/clock/worker fault fixtures and real-CLI profile checks;
give each assertion an observable result. Cross-reference the blocker regression cases above,
including audit-write failure and snapshot equality with unchanged leaf properties. No skip
substitutes for evidence, and these are requirements for future implementation tests, not tests
claimed to have run in this review.

### AS-N1 — minor — the Phase 1 amendment is placed under Deferred extensions

**Sections:** SPEC §10/§11 amendment; V status note.

**Failure:** an implementer follows §10's unchanged “exactly one” deliverable, or reads V's
unconditional “is superseded” as an already-accepted authorization while AS remains proposed.
The amendment presented as a §10 change actually sits at the end of §11.

**Smallest change:** put or explicitly link the proposed Phase 1 change at the controlling §10
deliverable/exit gate, and make V's supersession conditional on acceptance of AS. Keep the
operator acceptance and AS mutation prerequisites visible; no broader Phase 1 scope is implied.

### Coverage and disposition

1. **Self-approval:** deriving the opposite agent and having no delegate bearer closes direct
   request-field impersonation. It does not close token theft (accepted decision 14), hosted
   cockpit access (AS-B1), poisoned approver setup (AS-B6), or model persuasion/repeated attempts
   (AS-M1). “Impossible by construction” needs those qualifications.
2. **Approval binding:** atomic consume and AC's exact-byte replay are sound primitives; they do
   not establish UI instance/state identity (AS-B3). Existing replay can run before a coordinator
   starts, but its current operator entry requires a coordinator; AS needs its own ordinary-
   pipeline execution trigger (AS-M3), not `hermes_start` as a prerequisite.
3. **Deny tiers:** AS-B1/B2 cover renamed/copied binaries, hosted console/browser/cockpit content,
   elevation, Toros children, misleading password flags and per-read gating.
4. **Fail-closed:** the explicit timeout/malformed/adapter-deny rule is correct; AS-B4/B6 specify
   the missing late-verdict, in-flight expiry/lock/restart and partial-success handling.
5. **Mission scope:** operator overrides and broad scopes are accepted, with the intersections,
   session ownership and request budgets required by AS-M1/M2.
6. **MCP:** the enumerated tools contain no inherent approve/shell/file tool; AS-M3 closes the
   forwarding, execution-trigger and protocol ambiguities without moving policy into stdio.
7. **Contract fit:** AS-B7 gives the required structural/semantic inventory; a payload-only A7
   cannot authorize the missing event kinds.
8. **Implementability:** AS-M4 reconciles inherited APIs/fixtures and makes adversarial failures
   observable; the blocker cases supply the missing regression assertions.
9. **Omissions:** immutable target snapshots, execution ordering, child lifetime supervision,
   request finality/resource bounds, clean approver configuration, sanitized audit ordering and
   caller/session ownership are the missing pieces. None requires another agent role or workflow.

All seven blockers must be resolved in the spec before implementation dispatch. Resolve the
major items in the same revision because they define the APIs and objective acceptance checks;
the minor wording change can accompany it. Preserve all fourteen operator decisions. This
review does not clear AR's separate adversarial review, AS's later code/MCP/adversarial reviews,
or the operator's acceptance gate.

### Verification record

- Read-only inspection: `git status --short --branch`, `git branch --show-current`,
  `git remote -v`, `git rev-parse HEAD`, `git log -5 --oneline`,
  `git diff public/main...HEAD -- docs/SPEC.md docs/specs/V-adapters-uia.md`.
  Confirmed a clean `review/as-spec` checkout at the reviewed SHA and `public` as the public remote.
- GitHub target: `gh pr view 1 -R mbulentcakar/Toros --json url,title,body,headRefName,headRefOid,baseRefName,files`.
  Confirmed head `spec/desktop-grants` at the same SHA, base `main`, and the target documents.
- Independently read the named specifications and live contract/approval/pipeline/CLI definitions;
  checked the external technical claims against the primary documentation linked above.
- Documentation integrity: `git diff --check` returned exit 0; `git diff --name-only` returned
  only `docs/reviews/AS-spec-review.md`. A line-by-line prefix comparison confirmed the original
  brief is unchanged; all additions are below its original delimiter. The added-text scan found
  no local user paths or credential-shaped values.
- Docs only: no executable tests were run, and none apply to this review-only change. No passing
  implementation tests or AS acceptance are claimed.

## Re-review (revision 2)

Reviewer: Codex, 2026-10-13. This is a delta review of
`3a407aeee1d9ccc1d469365fe1bf7251899b2579` and
`038d28851076492679e205700e0e37ee12fa9b0b`, fetched from `public/spec/desktop-grants`.
The baseline is revision 1 at `7afe8678c447a639a3f9f1947a52ee3843edf2b8` and the findings above.
All AS line references in this section refer to the immutable `038d288` version, not the
revision 1 files still checked out on this review branch. The delta changes only AS, SPEC,
00-CONTRACTS and V; it contains no implementation changes.

The original verdict and seven-blocker list were posted first as a **comment-only review** on
[PR #1](https://github.com/mbulentcakar/Toros/pull/1), as requested. GitHub returned review state
`COMMENTED`. That comment explicitly identifies the revision 1 baseline; it is not a verdict on
revision 2 merely because GitHub associates the submission with the current PR head.

The fourteen original operator decisions and **R2-a through R2-d are requirements**. In
particular, operator Resume after delegate denial, operator routing for unrecognized/embedded
web surfaces, no application launching, and defaults of 200 requests/200 approver calls are
accepted. `038d288` changes their status to operator-confirmed; it does not add another design
change. No finding below asks the operator to reconsider those decisions or to add Phase 2
confinement.

VERDICT: ready after the listed blockers — revision 2 closes six original findings and materially
improves six others, but target classification, complete replay binding, invalidation and CLI
retention still leave implementers with unsafe or contradictory choices.

### Disposition of every original finding

“Closed” means closed at the specification level, not implemented, tested or operator-accepted.
No original finding is wholly untouched; the remaining six are **partly closed**, rather than
open. Newly introduced issues are distinguished below.

| Finding | Status | Reason at revision 2 |
|---|---|---|
| B1 | **partly closed** | Classification now uses process creation time, image/signature/version evidence, integrity, element ownership and ancestry, with conservative unknown handling and Toros precedence (AS 124–210). Renames, elevation and common hosted surfaces are addressed. However, signature plus a broad UI framework is still not proof that a surface lacks embedded terminal/web or unmarked credential controls; the explicit password residual contradicts decision 13. Trusted population of the externally launched cockpit/MCP process registry is also unspecified. See R2-B1 below. |
| B2 | **partly closed** | The gate table explicitly requires per-call operator decisions for protected reads, quarantine and unconditional omission of values (212–239); this closes standing read authority from an app grant. The approval record still cannot describe the exact bounded read, and gated-read pending/result shapes are absent from the MCP table. See R2-D1. |
| B3 | **partly closed** | The server-prepared record now binds mission/generation, enrolled driver, job/digest, grant, process and a stated snapshot; AC replays its digest, and execution uses the same resolved object (241–301). The semantic/atomicity limitation is now honestly stated and is accepted as a limit of generic UIA. Runtime-id reuse plus an identical snapshot remains an identity hole; redaction introduces another equality hole, and read parameters remain outside the record. See R2-B3, R2-D1 and R2-D2. |
| B4 | **partly closed** | Generation checks, a desktop lock, late-verdict rejection, audit-before-dispatch, Job Objects and uncertain-outcome handling address most lifecycle omissions (303–340). But invalidation after dispatch and before the UIA pattern call has no specified cancellation/recheck, and crash recovery of an executing audit record is not defined. The new Job Object mechanism also needs a safe creation/assignment sequence. See R2-B4 and R2-D4. |
| B5 | **closed** | The original log-before-secret-refusal problem is closed by validation/scanning before persistence, publication, files or prompts, digest-only rejection, screen/verdict/error sanitization and a pinned AG prerequisite (342–366, 573–584). Logging admitted values in full preserves decision 9. The newly introduced enrollment nonce needs explicit coverage too (R2-D5); that is a new credential surface, not a reopening of the original event-order defect. |
| B6 | **partly closed** | A dedicated runner replaces the ordinary session writer; clean working/config directories, identity/version/model pins, no-tool requirements, bounded completed exchanges and real-CLI verification are specified (368–399, 593, 663–671). The runner's own file ban does not explicitly suppress the CLIs' automatic session/transcript persistence, and test 37 searches only selected filenames under one root. See R2-B6. |
| B7 | **closed** | A7 is now a definite, architect-owned AS0 prerequisite, with the event union, new `E_APPROVAL_DENIED`, delegated approval semantics and the complete unchanged-type inventory recorded in 00-CONTRACTS §10 A7 and AS 487–521/590. `ApprovalBinding` remains unchanged because the prepared record is digested. The new error-table wording has a separate compatibility defect (R2-D6), but the formerly missing amendment is present. |
| M1 | **closed** | R2-a makes denial hold deterministic until logged operator Resume; R2-d fixes both default budgets at 200. Counts include failed/rejected admissions, reads and actions; exhaustion ends the mission, one request is in flight, and denial history is capped without silent loss (415–427). No further model decision can override a held mission. |
| M2 | **closed** | Mission generation/envelope binding, an OS-derived desktop key, one machine-wide desktop Core, one act mission per key, enrollment nonce, scoped lookups, listed-image revalidation and earliest-bound expiry are explicit (70–122). Operator expiry overrides and `any_not_denied` remain bounded by grants and classification. Enrollment reset should be made explicit in the invalidation rules when completing R2-B4/R2-D5, but the original missing ownership/lifetime design is supplied. |
| M3 | **closed** | Credentials are route-separated, protocol revision and handshake/tools are pinned, mapping/identity are fixed, frames/outstanding ids/waits are bounded, Core enforces bypass calls, and Core alone triggers execution independently of idempotent waiters (48–51, 429–468). Zero dependencies is credible for the stated subset. Gated-read result framing still needs the R2-D1 correction. |
| M4 | **partly closed** | Explicit V overrides, no launching (R2-c), no control values, an adapter API, controlled fault fixtures and 48 observable cases replace the inconsistent inherited tests (523–554, 598–689). However, capability names conflict with the actual registry (R2-D3), and the native-adapter rule is narrowed to registered adapters while claiming V's stronger rule still stands. See R2-M4. |
| N1 | **closed** | The proposed Phase 1 addition now sits at the controlling §10 deliverable; the misplaced §11 amendment is removed. V's note and AS's introduction explicitly make supersession conditional on AS acceptance. |

### Remaining original blockers and major

#### R2-B1 — blocker — supported frameworks do not establish protected-surface identity

**Sections:** AS Classification, 155–178, 180–204; Appendix A decision 13 and R2-b.

**Failure:** a signed WinForms/WPF application hosts its own terminal widget or an unlabelled
credential field with `IsPassword=false`. It meets the complete delegate predicate at 201–204;
its signer, framework and window class need not identify the embedded function. A normal
non-pattern password passes the scanner. Warning the approver about the stated residual at
176–178 leaves the absolute prohibition dependent on model judgement. R2-b requires all embedded
web content to go to the operator too, not only surfaces reporting Chrome/WebView2 identities.
Separately, an identity registry is not sufficient until Node knows which externally started
cockpit/MCP processes to register: `mission_enroll {}` over loopback supplies no specified
OS-verified process-registration mechanism. An unregistered hosted cockpit window can therefore
miss the absolute family test.

**Smallest change:** distinguish verified protected-surface classification from a merely
recognized framework. Specify supported application/provider profiles or equivalent positive
evidence for delegated surfaces, including credential-entry protection and hosted content;
unknown hosting remains operator-only and uncertain credential entry remains refused. Give the
Toros registry a trusted OS-observed population/lifecycle rule before the operator UI or an
enrolled MCP process becomes targetable. Do not trust caller-supplied pid or `FrameworkId` as
proof. Add an unlabelled false-password fixture, a same-process custom terminal/web host and
pre-registration cockpit-child tests. The original operator decisions require closing these
paths; the new residual paragraph does not authorize an exception to decision 13.

#### R2-B3 — blocker — runtime-id reuse is acknowledged but still assumed not to happen

**Sections:** AS Approval record, 274–290; acceptance 21–22.

**Failure:** the original element is destroyed and another element in the same live process
reuses its runtime id and all enumerated properties. Process creation time and snapshot equality
are unchanged, so every specified execution check passes. This is exactly the case for which
[Microsoft says runtime ids can be reused](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid).
The assertion at 288–290 that an identical replacement has a new id does not follow. Likewise,
two different selected items can have the same name; `selection_context` stores names only, so
changing between them need not change that snapshot. These are identity failures within the
enumerated target, not a demand to guarantee hidden semantic effects.

**Smallest change:** retain and validate the actual element's live instance/lifetime or introduce
a supported-provider generation/lifecycle guard that invalidates approvals on destruction or
replacement; if continuity cannot be established, refuse. Bind selection context to item
identity as well as labels. Add same-process reused-id/identical-property and duplicate-selection-
name fixtures. Keep the stated final-check/UIA-call residual window, but remove claims that a
runtime id plus equality alone proves continuity.

#### R2-B4 — blocker — dispatch is earlier than the irreversible UIA operation

**Sections:** AS Request lifecycle, 311–340; MCP execution, 461–465; acceptance 26–30.

**Failure:** dispatch the worker, pause it during process hashing/selector resolution, then revoke,
expire or lock the mission. Invalidation voids only requests not yet `executing` and explicitly
kills only approvers. The worker later calls the UIA pattern with an invalidated approval: the
worker checks its snapshot and tier, but not a live mission generation/expiry. Treating dispatch
as started does not make a not-yet-issued UIA call irreversible. Allowing a call already issued
to return is reasonable; permitting a new call after invalidation is the remaining gap. On hard
Core death the pre-dispatch audit remains, but no surviving process can record the promised
`outcome_uncertain`; restart currently supplies no reconciliation rule. “Revocation is the only
cancellation” also conflicts with hold/expiry/lock/job-end invalidation unless expressly scoped
to an MCP client's disconnect.

**Smallest change:** cancel/reap dispatched workers that have not issued their pattern, and add a
live generation/expiry permission check at the final worker-ready boundary under the shared
ordering rule. Define the last-check/call residual explicitly; only an already-issued call gets
the complete-or-uncertain treatment. Cover automatic denial/uncertainty holds and enrollment
reset in the invalidation table. At restart, reconcile durable executing-without-final-result
records as uncertain without replaying them or restoring authority. Test invalidation with the
worker paused before its pattern and Core death between dispatch and result persistence.

#### R2-B6 — blocker — CLI-owned persistence is outside the runner's filename test

**Sections:** AS Approver profile, 376–399; acceptance 37.

**Failure:** the dedicated runner writes no `exchange-N.jsonl` or prompt file, but the CLI saves
its own session transcript in its config home. A per-CLI home persists across decisions and
deleting the clean working directory does not clear it. Test 37 can pass while a differently
named session/rollout/history file retains screen content and the prompt. The requirement to
retain only verdict metadata should cover the subprocess as well as the runner.

**Smallest change:** explicitly require disabling CLI-native session/prompt/history/debug
retention before process start, with fail-closed profile verification if the pinned version
cannot do it. Search every profile-controlled storage location by synthetic prompt content on
success, crash, timeout and cancellation, not just by `exchange-*` filenames. The current
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents a separate
session-persistence switch, and the
[Codex exec source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) has a
separate `ephemeral` option; an isolated home or read-only permission mode does not imply either.
These are evidence of the distinction, not a claim that the node's eventual pinned versions
have already passed the required profile check.

#### R2-M4 — major — registered native adapter is weaker than V's inherited preference

**Sections:** AS Native adapter preference, 206–210; Relationship to V, 536–540; V Objective.

**Failure:** an application has a real native automation interface but no registered Toros
adapter. The new admission rule refuses only when a **registered** adapter covers it, so it
permits UIA; V says such an application must get its own adapter instead, and AS explicitly
claims that rule remains. Two implementations can make opposite admission decisions.

**Smallest change:** explicitly retain the native-interface rule and refuse/reroute known native-
automation applications even when their adapter is not installed; specify the supported
application/catalog evidence used for that decision. Do not silently weaken it under the word
“registered”. This does not ask AS to implement another integration.

### Issues newly introduced by revision 2

#### R2-D1 — blocker — the canonical approval record omits executable read parameters

**Sections:** AS Approval record, 243–273; MCP table, 453–459; adapter API, 545–550. Affects B2/B3.

**Failure:** approve a bounded `inspect_tree` read at depth 1, then run depth 8 through the separate
`UiaWorkerRequest.input`. The record contains no read depth, find filters, element-count bounds
or complete read input. Its digest therefore cannot bind those choices; alternatively, a replay
of the record alone cannot reconstruct them at all. The API expressly carries both a record and
an independent `input` without requiring equality. App admission also requires the universal
record's `grant_id` and element snapshot before a grant exists, without defining that variant.
Protected read tools promise only read output, whereas operator approval needs a pending request
id usable with `desktop_await`.

**Smallest change:** define discriminated admission/read/mutation record schemas. Include the
complete normalized action input and effective bounds in the record before hashing; derive the
worker input exclusively from it, or assert exact equality. Define the pre-grant admission
identity without an invented live grant. Give gated reads an explicit pending/denied/result
union with request ids. Test altered depth/filter/bounds and exact reconstruction on replay.

#### R2-D2 — blocker — redaction turns distinct snapshots into the same approved snapshot

**Sections:** AS Approval record, 253–290; Secrets and sanitization, 356–360. Affects B3.

**Failure:** a selected item or window name contains a secret-shaped string; the record stores
its redacted form. Change that item/name to a different string of the same secret-pattern kind
while keeping the control instance and other state fixed. Execution recomputes the same
redaction marker, so “every field” compares equal and the approval remains valid despite changed
enumerated state. Redaction is deliberately many-to-one, not a state-identity function.

**Smallest change:** keep the display record sanitized while binding comparison to a separate
server-derived commitment to the raw observed state, preferably keyed where low-entropy secret
state could otherwise be guessed. Include that commitment in the approved canonical object and
compare it before the UIA call without persisting raw content. A simpler safe rule is to refuse
actions whose required state comparison would depend on redacted fields. Add two-different-inputs/
same-redaction fixtures; do not solve this by logging or showing the secret.

#### R2-D3 — major — the envelope capability namespace does not match the adapter id

**Sections:** AS Mission scope, 98–100; adapter API, 552–553; current registry registration.

**Failure:** the mission/envelope lists the required `desktop.invoke`, but the new adapter is
`desktop_uia`. The registry constructs capabilities as `<manifest.id>.<actionId>`
(`packages/registry/src/index.ts`, registration), so it registers `desktop_uia.invoke` and
policy denies the spec's capability. Reusing id `desktop` instead would collide with the
existing AR desktop adapter. An implementer may work around this by skipping the registry or
adding an unspecified alias, defeating the claimed contract fit.

**Smallest change:** publish one mapping of MCP names, Node routes, adapter/action ids and actual
envelope capability ids. Retain AR's `desktop.state` separately and use the registered
`desktop_uia.*` ids for AS UIA actions, or explicitly specify a registry-compatible alternative.
Test exact registration/allowlist/receipt/approval capability equality; no bypass or silent alias.

#### R2-D4 — major — Job Object membership must precede child execution

**Sections:** AS Child lifetime, 327–330; AS1–AS3 ownership; acceptance 29. Affects B4.

**Failure:** implement `spawn`, then attach the child to the Job Object. Kill Core between those
steps: the unassigned worker survives and may still invoke UIA. A child inheriting the last job
handle can also defeat the intended kill-on-owner-death behaviour. Testing only a child already
running inside the job misses both startup/handle-lifetime cases.

**Smallest change:** require association before any child code can act, using inherited job
membership or suspended creation/assignment/resume, with assignment failure refusing execution,
no breakaway and no child-held lifetime handle. Specify the reviewed native/PowerShell bridge
and its owning slice: the ordinary Node child-process adapter does not itself expose the required
Win32 job-handle operations. Microsoft's
[Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
distinguishes creation from process assignment; the
[job-limit flags](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
define kill-on-last-handle-close, and the
[process flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
provide suspended creation. Add parent-death tests at each startup boundary, including assignment
failure and handle inheritance. This is a concrete mechanism for the already-required boundary,
not a request for a new remote workflow or platform.

#### R2-D5 — major — the new enrollment credential is missing from the explicit secret inventory

**Sections:** AS Driver enrollment, 115–122; known-token detection, 349–351; acceptance 33.

**Failure:** a direct authenticated Node client enrolls and receives the random 256-bit nonce.
It submits that unprefixed nonce as an otherwise ordinary typed value or reason. A scanner
implemented from the explicit token/operator/agent list has no match; the value enters the
full-value audit, disclosing the second credential to audit readers. Keeping the nonce out of
MCP tool results does not protect the direct-route path that AS explicitly supports.

**Smallest change:** explicitly include live and recently invalidated enrollment nonces, plus
other still-sensitive Core-issued run credentials, in known-secret detection at every audit
boundary. Scope reset/rotation to generation invalidation, replace the enrolled credential
atomically, and keep the raw nonce out of events, errors and the cockpit. Add direct-route nonce
echo and reset/old-nonce regression cases, using synthetic credentials only.

#### R2-D6 — major — the exclusive error table contradicts the inherited policy/AC contract

**Sections:** AS Error mapping, 502–516; D normative decision order; AC acceptance 3–4.

**Failure:** AS says “No other code may be used”, but the ordinary pipeline must still emit
`E_JOB_TERMINAL`, `E_ENVELOPE_DIGEST_MISMATCH`, `E_RETRIES_EXHAUSTED`, `E_WORKSPACE_DENIED` and other
existing first-denial codes omitted from the table. It also maps an expired approval to
`E_EXPIRED`, while `ApprovalVerifier.consume`/AC classify an expired approval as
`E_APPROVAL_INVALID`. Following either document violates the other and can encourage skipping
the ordinary policy path or translating away its audit meaning.

**Smallest change:** scope the AS table to new mission/classifier preconditions and preserve all
ordinary policy/adapter codes and their precedence, or explicitly enumerate an intentional
contract amendment across D/AC and consumers. Distinguish expired mission/job from expired
approval. Add contract-level assertions for the exact codes; A7's new denial code alone does not
amend these existing meanings.

### Re-review verification and handoff

- First publication: `gh pr review 1 -R mbulentcakar/Toros --comment --body-file <temporary-body>`
  returned exit 0; `gh pr view 1 -R mbulentcakar/Toros --json headRefOid,reviews` confirmed the
  revision 1 verdict/blocker list with state `COMMENTED`.
- Target refresh: `git fetch public spec/desktop-grants` returned exit 0;
  `git log --oneline -5 public/spec/desktop-grants` and `git rev-parse 038d288` confirmed the two
  requested commits and head `038d28851076492679e205700e0e37ee12fa9b0b`.
- Delta inspection: `git diff 7afe867..038d288 --name-only` listed precisely the four spec files;
  `git diff 7afe867..038d288 -- packages apps` was empty. Read the complete revised AS from
  `git show 038d288:docs/specs/AS-delegated-desktop-control.md`, all other changed documents, and
  `git diff 3a407ae..038d288 -- docs/specs/AS-delegated-desktop-control.md`.
- Rechecked the live frozen contracts, registry capability construction, policy decision order
  and replay behaviour. Primary references above verify runtime-id reuse, CLI-native retention
  controls and the separate Job Object creation/assignment operations. No model exchanges,
  desktop actions or implementation tests were executed for this docs-only review.
- Review-only integrity: `git diff --check` returned exit 0 and `git diff --name-only` listed only
  `docs/reviews/AS-spec-review.md`. Prefix comparison confirmed the existing brief and findings
  are unchanged. All twelve disposition rows are present: six closed, six partly closed. An
  added-text scan found no local user paths or credential-shaped values. No spec, package or
  application file is edited; publication uses the existing `review/as-spec` branch.

Next owner: the spec author resolves the six partly closed findings and the introduced issues;
the operator retains acceptance authority. The implementation review/MCP/adversarial gates and
AR's independent adversarial review remain separate. This delta review grants none of them.

## Re-review (revision 3)

Reviewer: Codex, 2026-10-14. Delta reviewed: `038d28851076492679e205700e0e37ee12fa9b0b` →
`da02d1a91d846db61cd62c1fa56c1a9fd1ec09df`, fetched from `public/spec/desktop-grants`.
The baseline is **Re-review (revision 2)** above. This revision changes AS and the proposed A7
event-kind inventory only; there is no implementation delta. AS line references below refer to
the immutable `da02d1a` document, read through Git, rather than the older spec checkout on this
review branch.

All Appendix A decisions are requirements, including R2-a–R2-d and **R3-a**. The strict native-
evidence typing rule, refusal of typing without that evidence, and operator-only actions on
elements without a native handle are accepted. This review does not ask for broader delegation,
an exception to decision 13, another agent role, or Phase 2 confinement.

VERDICT: ready after the listed blockers — seven revision 2 findings are closed and four are
partly closed, but classification and continuity still overclaim their evidence, the go-token
protocol does not establish the stated cancellation boundary, and new password/read-rollout
contradictions must be corrected before implementation dispatch.

### Disposition of every revision 2 finding

“Closed” means resolved in the written design; it does not claim implementation, native test
evidence, AR remediation, or operator acceptance. No finding is wholly untouched/open.

| Finding | Status | Reason at revision 3 |
|---|---|---|
| R2-B1 | **partly closed** | AS 130–259 replaces framework recognition with native class/style evidence, narrows typing as required by R3-a, withholds unsupported actions from delegation, and specifies OS-based cockpit/MCP registry population. The former unmarked-field residual is withdrawn. However, a same-process terminal assembled from genuine `Edit`/`Button` controls still satisfies the delegate predicate, so the claim that every custom terminal/web host is excluded does not follow. See R3-B1; the affirmative password veto regression is new, R3-N1. |
| R2-B3 | **partly closed** | AS 367–403 retains live element/selection objects, removes runtime-id lookup, subscribes before preparation and checks native ownership, commitment and tier. Duplicate selection labels are now bound to live items. Subscription acceptance and absence of received events still do not establish reliable lifetime continuity, and `IsWindow`/same thread/process do not defeat recycled handles. See R3-B3. |
| R2-B4 | **partly closed** | AS 405–452 adds dispatched/ready/issued states, a ready/go handshake, all invalidation causes, enrollment reset and crash reconciliation. This closes the long preparation-before-permission gap and the missing restart disposition. It still defines `issued` as the actual UIA call while durably recording it before sending a 250 ms go token; invalidation/Core death can occur before that call. See R3-B4. |
| R2-B6 | **partly closed** | AS 538–558 explicitly disables runner and CLI persistence before start, fails closed on unsupported versions and searches all profile-controlled locations by content. The substantive retention requirement is fixed. Canary verification can run after the mandatory per-decision wipe and therefore pass despite a prohibited write; test 37 has the same ambiguity. The remaining issue is verification ordering, ranked major below. |
| R2-M4 | **closed** | AS 261–269 retains the native-interface preference whether or not an adapter is installed and specifies a reviewed signer/product catalog, refusal code and installed/missing-route detail. Acceptance 54 covers both installed and absent adapters. AS does not need to implement the missing native integration. |
| R2-D1 | **closed** | AS 307–350 provides admission/read/mutation variants, no pre-existing grant in admission, complete normalized read input and effective bounds. Every worker call is derived from the record, with no independent executable input. AS 302–305/619 supplies pending and final result framing for gated reads; acceptance 58 asserts exact depth/replay binding. |
| R2-D2 | **closed** | AS 353–365 compares a mission-keyed HMAC of raw observed state, rather than sanitized display strings. The commitment is included in the canonical record; raw state/key are not persisted. Different secrets with the same display redaction now mismatch, with acceptance 59. This closes the equality defect without exposing low-entropy secret state through an unkeyed hash. |
| R2-D3 | **closed** | AS 98–101/621–639 defines the exact MCP/route/registered-capability mapping, uses `desktop_uia.*` for AS and retains AR's `desktop.state`. It forbids aliases and uses the same id in envelope, policy, receipt, binding and record; acceptance 64 verifies it. |
| R2-D4 | **closed** | AS 454–476 assigns the fixed PowerShell/C# supervisor to AS1, creates children suspended, assigns/registers before resume, terminates on assignment failure, forbids breakaway and prevents job-handle inheritance. Acceptance 62 covers startup boundaries. The original spawn-before-assignment and last-handle-inheritance defects are closed. The separate claim that a previously issued go token cannot act during parent-death detection is not true; it is covered by the remaining R3-B4 boundary issue. |
| R2-D5 | **closed** | AS 117–125/485–494 introduces the detectable `tdn_` nonce format, explicit live/recent-invalidated nonce detection, other live Core credentials, digest-only past-nonce storage and atomic generation/nonce reset. The pattern also detects older formatted nonces. Acceptance 63 covers direct-route credential echoes and invalidated/past enrollment credentials. |
| R2-D6 | **closed** | AS 684–702 preserves ordinary policy codes and precedence, limits its table to AS-specific conditions, and distinguishes expired approvals (`E_APPROVAL_INVALID`) from mission/job expiry. Acceptance 65 states those assertions. A separate new scheduling ambiguity about where atomic consumption happens is R3-N2; the formerly exclusive error table is fixed. |

### Remaining findings

#### R3-B1 — blocker — ordinary native controls can still host an operator-only function

**Sections:** AS Operator-only/Positive evidence, 221–259; acceptance 51; Appendix A R2-b/R3-a.

**Failure:** a signed application implements a terminal with a genuine native `Edit` input,
`Button` command control and `Static` output under its own frame. No separate console process,
console class or non-native child is required. All classes are in the delegate set and its frame
is expressly admitted by 250; it need not match a known shell image. A delegate can therefore
approve command entry and invocation even though terminal actions are operator-only. The
assertion at 255–257 that custom terminal/web hosts must have an excluded class or lack handles
does not follow from the predicate. R3-a's native-edit requirement is necessary for typing; it
does not turn every genuine edit control into a verified non-terminal context.

**Smallest change:** define how the enclosing function is positively classified in addition to
the individual native control. Unsupported terminal/web hosting contexts remain operator-only;
do not grant a function classification merely by admitting its top-level frame. Use verified
supported surface/context profiles or equivalent deterministic evidence, and add a same-process
fixture built from actual allowlisted native controls. Preserve the chosen strict typing rule;
this correction concerns the already-required terminal/web tier, not broader typing authority.

#### R3-B3 — blocker — an accepted event subscription is not a continuity guarantee

**Sections:** AS Element continuity, 374–397; acceptance 55–57.

**Failure:** the provider accepts subscriptions but omits or delays an invalidating event while
an element/window is destroyed and replaced with matching state. The worker treats “no event
received” as continuity. A recycled native handle can still pass `IsWindow` and same-thread/
process checks; holding a process handle protects process identity, not its child windows'
lifetimes. A retained UIA wrapper must not be assumed to pin an external HWND's lifetime.
Microsoft explicitly warns that
[providers need not raise all events](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-events-for-clients)
and that [window handles can be recycled](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindow).
The raw-state HMAC detects differing state, but not an identical replacement or an unobserved
change-and-return. This is a missing lifetime proof, not the already-disclosed final-check/call
race or a demand to bind hidden semantic effects.

**Smallest change:** specify what establishes the supported provider/native object's lifetime
continuity beyond successful subscription, including callback synchronization and destruction/
reuse handling. When the worker cannot establish it, refuse with `no_continuity` as already
required. Add fixtures that accept subscriptions but suppress/delay notifications, and same-
thread native-handle reuse. Test that a stale retained object cannot silently rebind; do not
limit acceptance to providers that voluntarily emit the expected invalidation callback.

#### R3-B4 — blocker — a durable issue intention is still confused with an issued UIA call

**Sections:** AS Lifecycle 413–449 and supervisor gap 473–475; acceptance 60–62.

**Failure:** Core appends `issued`, sends a go token, and the worker pauses before receiving it or
before calling the pattern. Revoke/expiry/lock then arrives. The event says `issued`, so the
written rule assumes the call has already happened and permits completion, although no call has
been made. The token remains usable for up to 250 ms; its deadline is not explicitly clamped to
mission/job/approval expiry. Likewise, Core can die after sending it but before the supervisor
detects death: the token was issued while Core was live and can still be used during that gap.
“Only a live Core can issue a token” does not revoke an already-issued token. The snapshot/tier
checks occur before the worker blocks, and the protocol does not require their recheck after
receiving permission. Tests 60–62 stop before delivery or after the asserted `issued` point,
leaving this exact interval untested.

**Smallest change:** distinguish durable dispatch/issue intention, authorization commit, and
actual pattern issuance. Give the worker final permission/deadline/generation and state checks
immediately at the call boundary, with explicit cancellation/liveness handling for a received
but unused token. Bind permission to this record/generation and cap it by effective expiry.
State the unavoidable final-check/call and parent-death detection residual accurately instead
of claiming that a preceding log append proves execution. Recovery may conservatively report
an intended-but-unconfirmed call as uncertain; it must not assert the call occurred or retry it.
Add pauses after log append, after token send/receipt, and before the pattern, testing revocation,
expiry and parent death at each point. The ready handshake is useful and should be retained.

#### R3-B6 — major — cleanup can erase evidence before the retention canary examines it

**Sections:** AS Approver profile, 538–555; acceptance 37.

**Failure:** a misconfigured CLI writes its canary transcript, then the runner performs the
mandatory “after every decision” wipe. The subsequent canary-content search is clean, so the
profile passes even though the no-persistence requirement was violated. Searching more names
and locations does not fix this ordering. The requirement to disable persistence is now clear;
this is the remaining weakness in the verification intended to prove it.

**Smallest change:** inspect/monitor the profile-controlled storage before any cleanup can
erase evidence, then wipe regardless of the check's outcome. Add a deliberately persisting fake
CLI as a negative control: it must fail the profile even if cleanup leaves no file afterward.
Exercise success, crash, timeout and cancellation. Preserve the no-retention-before-start
requirement and the real pinned-CLI checks; cleanup is recovery, not proof that nothing was
written.

### Issues introduced or exposed by revision 3

#### R3-N1 — blocker — the native allow rule drops an affirmative password veto

**Sections:** AS Secret entry 199–212, password reads 232–233, read names 289–293.

**Failure:** a native edit has no `ES_PASSWORD` style or password character, a neutral name/id,
and no known credential ancestor, but its UIA provider reports `IsPassword=true`. It passes all
seven newly exhaustive `set_value` conditions: the old UIA-true veto, including ancestor flags,
is absent. Native evidence is needed to defeat a false negative; it must not erase a positive
password indication. The read tier still treats the same element as a password, so the two
paths disagree. Separately, “every other element's name ... unless the operator approves” can
be read as releasing even a positively identified password element's name, contradicting the
explicit “existence, never its name or value” rule. An ordinary password need not match AG.

**Smallest change:** make any positive own/ancestor password indication an unconditional typing
veto, alongside all native R3-a requirements. Explicitly separate unknown-evidence names, whose
reads may be gated, from known password names/values, which remain suppressed after operator
approval. Add native-plain/UIA-password-true, password-ancestor and operator-approved password-
name fixtures. This enforces decision 13 and the specified read omissions without relaxing R3-a.

#### R3-N2 — major — the new ready boundary has no unambiguous single approval spend

**Sections:** AS 428–438/684–689; D rule 12 and 00-CONTRACTS A4; live policy/action pipeline.

**Failure:** the ready-stage checklist includes `ApprovalVerifier.consume` but calls it “on
dispatch only”. The new state machine places `dispatched` before `ready`. AS also requires the
ordinary policy to run first, and that policy already consumes an approval atomically at rule
12 (`packages/policy/src/index.ts`); the pipeline calls it before reaching the adapter. An
implementer consuming at both places denies every valid replay as spent. Another implementer
may skip the ordinary gate to make the later checklist work, or never revalidate policy after
waiting. The new protocol needs one defined spend point, not two plausible readings.

**Smallest change:** provide one normative pipeline sequence showing preparation, approval,
worker checks, final ordinary policy decision/atomic consumption, audit and permission. Identify
exactly one call to `consume` and how ordinary policy is rechecked at the final boundary without
a second spend. If the existing pipeline/port semantics must change, assign that work and amend
the appropriate contract/spec deliberately. Test one valid execution, duplicate permission/
replay and invalidation between preparation and the single spend.

#### R3-N3 — blocker — read-mode rollout bypasses its newly explicit AR foundation

**Sections:** AS Prerequisites 760–772 and `desktop_state` mapping; referenced AR remediation gate.

**Failure:** fulfill AG, A7, the approver profile, code review and MCP review, then ship a `look`
mission exactly as line 772 permits. Prerequisite 1 is excluded, although lines 762–764 say the
classification/read design assumes AR F2/F3 and `desktop_state` calls the AR `desktop.state`
capability. The known discovery name-disclosure and identity/pipeline problems can therefore
remain enabled through AS's read surface. The referenced
[AR remediation plan PR #4](https://github.com/mbulentcakar/Toros/pull/4) expressly keeps desktop
discovery disabled until F1–F4 merge and native re-review clears them; it is a plan, not a fix.

**Smallest change:** make the cleared AR foundation a prerequisite for every AS mode that exposes
AR desktop discovery/inspection, including `look`. If a narrower mode is intended before that
gate, explicitly exclude the affected AR routes and establish its independent read boundary;
do not imply that look-only operation remediates an underlying read vulnerability. Add a startup/
route test that neither mode exposes the affected capability before the dependency gate clears.
This checks AS's new integration and does not re-review or claim to fix AR itself.

### Verification and disposition

- Target fetch performed with `git fetch public spec/desktop-grants`; `git log --oneline -4
  public/spec/desktop-grants` and `git rev-parse da02d1a` confirmed the requested head. A live
  `gh pr view 1 -R mbulentcakar/Toros --json headRefOid,state` recheck still showed `da02d1a`.
- Read the complete `git diff 038d288..da02d1a` for AS and 00-CONTRACTS, including the revised
  acceptance cases and R3-a. The changed-file list contains only those two specifications;
  `packages/` and `apps/` have no delta.
- Rechecked the existing policy's atomic consume and the action pipeline's policy-before-adapter
  order. Read-only GitHub checks of PRs #3/#4 and `gh pr diff 4 -R mbulentcakar/Toros` confirmed
  the referenced AR review/remediation gate. Neither those PRs nor their implementation are
  accepted by this review.
- Primary Microsoft documentation linked above supports the specific event-delivery and recycled-
  handle limitations. The review's failure paths are design analysis, not claimed live exploit
  demonstrations.
- Documentation-only review: no executable tests, CLI model exchanges or desktop actions were
  run; none apply to this append-only change. No AS acceptance test pass is claimed.
- Integrity checks: `git diff --check` returned exit 0; `git diff --name-only` listed only
  `docs/reviews/AS-spec-review.md`. Prefix comparison confirmed all prior brief/review content is
  unchanged. The disposition check found all eleven distinct requested findings: seven closed,
  four partly closed. An added-text scan found no local user paths or credential-shaped values.

Next owner: the spec author closes R3-B1/B3/B4, corrects the R3-B6 verification ordering and the
three new issues. The seven closed revision 2 findings stay closed; no reversal of the accepted
operator decisions is requested. The operator retains acceptance authority, and AR/AS native,
code, MCP and adversarial gates remain outstanding.
