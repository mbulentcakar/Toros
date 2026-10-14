# AR-F1 — operator credential separation (implementation brief)

**Read `docs/specs/00-CONTRACTS.md` first.** It is short and binding. `packages/contracts` is
frozen and this slice does not touch it.

**Lane:** implementer from the deputy pool (via `deputize`); code review by Codex; native
re-review of the AR surface after F1–F4 by a third lineage. The implementer is never the reviewer.

## Goal

Node Core never runs with an operator surface that the ordinary bearer can open. Whenever an
`operator_token` is configured, it is strong and distinct from `token`, **whether or not** any
capability is currently gated.

## Why

AR-03 (High, `docs/reviews/AR-adversarial-security-review.md`) showed that with
`operator_token` equal to `token` and no gated capability, Core starts and the ordinary bearer
gets HTTP 200 on `/operator/*`: it can list jobs, create a job and run it. The strength and
distinctness checks in `packages/node-core/src/core.ts` (the block after
`const gated = this.gatedCapabilities(registry)`) run **only when `gated.length > 0`**. But the
operator surface in `packages/node-core/src/http.ts` is mounted whenever `operator_token` is a
non-empty string. The check and the exposure are conditioned on different things. That gap is the
whole defect. Spec AS (PR mbulentcakar/Toros#1) builds missions on the operator surface, so this
has to be closed first.

## In scope

- `packages/node-core/src/core.ts`: the start-up credential checks.
- `packages/node-core/src/http.ts`: defence in depth on the operator route only.
- `packages/node-core/test/**`: a new `operator-credential.test.ts`, plus fixture updates where
  an existing test configures equal or short tokens.
- `docs/DEPLOY.md` and `docs/INSTALL.md`: one short note that an operator token, if set, must be
  at least 32 characters and differ from `token`, and what the start-up error says.

## Out of scope

- `packages/contracts/**`, `packages/policy/**`, every adapter package, `apps/**`.
- Any other AR finding (F2–F5 are separate slices).
- Changing *when* the operator surface exists. Absent or empty `operator_token` must still mean
  "no operator surface", with every `/operator/*` request answered 401, exactly as today.
- Rotating, generating or storing tokens. No real token values anywhere, including tests and docs.

## Required behaviour

1. **Start-up.** If `operator_token` is present and non-empty, Core refuses to start unless it
   is at least 32 characters **and** not equal to `token`. This applies regardless of gating.
   Keep the existing rule that a gated capability with no operator token refuses to start. Error
   messages name the rule, never a token value.
2. **Equality** is checked on the exact strings. Do not trim or case-fold, so two tokens that
   differ only in case or surrounding whitespace count as distinct, as today. A test pins this.
3. **Operator route, defence in depth.** In `handleHttp`, on the `operator` branch, a request
   whose bearer equals `token` is answered **401** even if it would also match `operator_token`.
   Start-up already prevents that configuration; this guards against a future code path that
   skips start-up validation. Use a timing-safe comparison, like `authenticateAgainst`.
4. **Advisory run credentials** must not open `/operator/*` either. Assert it in a test; it should
   already hold, so this is a regression guard, not new code.

## Acceptance

1. Equal `token`/`operator_token` with **no** gated capability → Core refuses to start; the error
   names the distinctness rule.
2. A short (`< 32`) `operator_token` with no gated capability → refuses to start.
3. A valid distinct `operator_token` with no gated capability → starts; `/operator/jobs` with
   `token` → 401; with `operator_token` → 200.
4. Absent or empty `operator_token`, no gated capability → starts; every `/operator/*` → 401.
5. A gated capability with no `operator_token` → still refuses to start (existing behaviour kept).
6. Tokens differing only by case or by trailing whitespace → treated as distinct (pinned).
7. A live advisory run credential on `/operator/*` → 401.
8. The full node-core suite passes with **zero skips**. Every existing test that used equal or short
   tokens is updated, not deleted.

## Verify (native Windows, record the counts in the PR)

```
npm ci
npx tsc --build
node --test packages/node-core/dist/test/*.test.js
```

Report pass, fail and skip counts. A skip is a finding. If the sandbox cannot run these, say so;
the reviewer runs them natively before merge.

## Constraints

- One agent per worktree: `_worktrees/Toros-f1-operator-credential`, branch
  `fix/ar-f1-operator-credential`, cut from `public/main`.
- Public repository. No secrets, real tokens, local user paths or hostnames in code, tests, docs
  or the PR. Tests use obviously synthetic 32+ character strings.
- One coherent commit and one PR into `main`, titled `fix(node-core): AR-F1 operator credential
  separation`. Link AR-03 and the remediation plan. Do not merge it.
- Match the surrounding comment style: say *why* a check exists, as the existing gated-check
  comment does.
