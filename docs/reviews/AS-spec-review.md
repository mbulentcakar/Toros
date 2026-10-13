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
