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
