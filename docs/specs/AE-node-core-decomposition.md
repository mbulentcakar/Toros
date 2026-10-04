# AE — Node Core decomposition

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

`packages/node-core/src/index.ts` is ~1,900 lines holding HTTP transport, two
authentication schemes, the operator route chain, the Chrome worker surface,
run-credential management, the action pipeline, and retry accounting. Every
review round pays the cost of re-reading all of it to change any of it. Split
it into modules with one concern each, **changing no behavior**.

This is a refactor spec. The proof of correctness is that the test files do
not change.

## Target shape

```text
packages/node-core/src/
  index.ts              createNodeCore, NodeCoreOptions, re-exports (≤150 lines)
  core.ts               lifecycle: start/stop, wiring, owned state
  http.ts               server creation, readBody, send, auth (both schemes)
  routes-tools.ts       TOOL_NAMES, dispatch() for the coordinator surface
  routes-operator.ts    a Record<string, handler> table replacing the if-chain
  routes-chrome.ts      the chrome-worker surface
  action-pipeline.ts    actionTool, settleCliExchange, retriesUsed, paths
  run-credentials.ts    runTokens, mint/bind/revoke, redactSecrets
  draft.ts              validateDraft, createJobFromArgs, CLI lifecycle bundle
```

Boundaries follow ownership, not size: the module that owns a map owns every
read and write of it, reached through named functions rather than a shared
`this`. `handleOperator` becomes a route table — adding an operator operation
becomes adding an entry, not extending a 380-line conditional.

## Rules

- **No behavior change.** Same routes, same status codes, same error codes,
  same event and receipt sequences, same log lines.
- **No test edits.** Existing test files pass byte-identical. New unit tests
  for newly-isolated modules are welcome; modifications to existing ones are a
  spec violation, because the tests are the behavioral contract this refactor
  is measured against.
- **No new runtime dependencies** (SPEC §10 pin) and no export-surface change:
  what `@toros/node-core` exports today is exactly what it exports after.
- No module exceeds 500 lines. If a split forces one over, the split is wrong.
- The decision-order comments that encode review findings (audit-first,
  resolve-after-policy, spend-then-record) move **with** their code, verbatim.
  They are the accumulated review history; losing them re-opens the findings.

## Non-goals

- No performance work (that is AH), no new operations, no renamed error codes,
  no HTTP framework. `node:http` stays.

## Acceptance

1. `npm run typecheck` and the full root suite pass with zero modifications to
   existing test files — `git diff --stat` over `packages/node-core/test/` is
   empty.
2. `node-core/src/index.ts` is ≤150 lines; no source module exceeds 500.
3. `git log` shows the split as a series of move-only commits followed by
   at most one wiring commit, so review can verify moves mechanically.
4. Every decision-order comment present before the split is findable after it
   (`grep` for three named phrases, listed in the PR).
5. The cockpit and coordinator run unchanged against the rebuilt node —
   one live smoke: catalog, one conversation turn, one job action.
