# T — Cockpit approvals panel

**Read `00-CONTRACTS.md` first.** `packages/contracts` is frozen.

## What this is

Node Core gained an operator surface (`/operator/approvals`, `/operator/approve`) that gates
high-impact actions behind a human decision. It is currently HTTP-only: approving something means
`curl`. This unit gives it a panel in the cockpit.

The point of the surface is that the operator sees **what they are approving**. A review found
the original design returned only a digest, so the untrusted coordinator narrated its own action
and the operator had no way to check that narration. The arguments are now carried. **Rendering
them is this unit's entire reason to exist** — a panel that shows a hash and an Approve button
would reintroduce the defect in a nicer font.

## Allowed paths

- `apps/cockpit/src-tauri/src/main.rs`
- `apps/cockpit/src/api.ts`
- `apps/cockpit/src/App.tsx`
- `apps/cockpit/src/components/ApprovalsView.tsx` (new)
- `apps/cockpit/src/types.ts`
- `apps/cockpit/src/App.test.tsx`
- `apps/cockpit/src/styles.css`
- `docs/DEPLOY.md` — amend §2.1 to say the panel exists

Nothing else. Do not touch `packages/`.

## The two-token decision, and why

The cockpit currently reads `{ port, token }` from `config.json` via the Tauri command
`read_node_core_config`. `token` is the **coordinator** bearer and cannot reach `/operator/*`.

**Extend that command to return `operator_token` as well, as an `Option<String>`.**

This is deliberate and it is the right call: the cockpit is the operator's console, running
locally, rendering only local content, with a CSP that confines `connect-src` to loopback. Its
whole job is to be the place the operator acts. Withholding the operator credential from it does
not protect anything — the token sits in a file that same user owns — while leaving the gate
usable only from a terminal.

What must NOT happen: the operator token reaching the coordinator. It does not, because the
coordinator reads `coordinator.json`, a different file that has never contained it.

Concretely:

- `NodeCoreConfig` gains `operator_token: Option<String>`, read from the same fixed path, with
  the same "no other config fields cross the WebView boundary" discipline. Do not widen the
  command to take a path argument. Do not return any other new field.
- When `operator_token` is absent or empty, return `None`. Absent is a legitimate configuration
  (a node that gates nothing needs no operator token), not an error.

## Client behaviour

`api.ts` gains exactly two calls, both against the operator surface with the operator token:

- `listPendingApprovals(): Promise<ApprovalRequest[]>` → `POST /operator/approvals`, returns
  `body.pending`.
- `grantApproval(approvalId): Promise<void>` → `POST /operator/approve` with
  `{ approval_id }`.

Both throw when `operator_token` is absent — the caller renders the unconfigured state rather
than sending a request that would 401.

`resolveConfig` currently throws `ConfigUnavailableError` when the IPC call fails or supplies no
token. Keep that exactly as it is. The absence of `operator_token` specifically is NOT a
config failure and must not throw from `resolveConfig`.

## The panel

`ApprovalsView.tsx`, reachable from the existing tab strip in `App.tsx`, alongside the current
views.

It must render, for each pending approval:

- the **capability** being requested;
- the **arguments**, in full, as readable formatted JSON — this is the load-bearing element;
- the job id, the request time, and the expiry;
- an **Approve** control.

The digest may be shown, but it is not a substitute for the arguments and must not be the only
representation.

Required behaviours:

- **Unconfigured** (`operator_token` absent): the existing honest empty-state treatment, saying
  approvals are not configured on this node. Not an error, not a spinner, not a 401.
- **Nothing pending**: an empty state saying so. Distinct from unconfigured — an operator needs
  to tell "nothing to do" from "this will never work".
- **After approving**: refresh the list. A granted approval leaves the pending set, so it
  disappears. Do not optimistically remove it before the call succeeds.
- **Approve fails**: surface the error. A failed grant is exactly the case where the audit could
  not be written and the approval was NOT granted, so silence would be a lie.
- **Expiry is visible.** Approvals live five minutes. An operator staring at a stale list needs
  to see that, not discover it when the grant 404s.

## Arguments are attacker-influenced — treat them as such

The values rendered in this panel are chosen by the coordinator. This is the highest-risk
rendering path in the application: hostile content arrives from the untrusted party and is
displayed to the human whose judgement the gate depends on.

- Render them as **text**, never as markup. React escapes by default; do not reach for
  `dangerouslySetInnerHTML`, and do not "pretty-print" through anything that emits HTML.
- **A test must assert this**, with an argument value containing `<img src=x onerror=alert(1)>`,
  checking that the literal text appears and no `img` element is created. Test 6 in
  `App.test.tsx` is the pattern.
- Long values must not break the layout or push the Approve control off screen. An operator who
  cannot read the arguments cannot make the decision the gate exists for.

## Acceptance

Each is a test in `App.test.tsx`, following the existing numbered style.

1. Pending approvals render their capability and their **arguments**, with the argument values
   present in the DOM text.
2. An argument value containing HTML renders literally and creates no element from it.
3. With `operator_token` absent, the unconfigured empty state renders and **no request is made**.
   Assert on the fetch mock, not only on what is displayed.
4. With `operator_token` present and nothing pending, the empty state distinguishes itself from
   the unconfigured one.
5. Approving posts `{ approval_id }` to `/operator/approve` with the **operator** token in the
   Authorization header — assert the header, because sending the coordinator token here is the
   mistake this design exists to prevent.
6. A failed grant surfaces an error and does not remove the row.
7. The operator token never appears in rendered output. Test 8 is the pattern.

## What this unit does not do

- It does not add a deny/reject control. Node Core has no such operation; an approval that is not
  granted simply expires. Adding a button with nothing behind it would be worse than its absence.
- It does not poll. A manual refresh is enough for a five-minute window and one operator at one
  console; a polling loop is a decision for whoever needs it.
- It does not create, edit, or cancel jobs.
