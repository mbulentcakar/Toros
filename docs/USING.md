# Using a Toros node

> **Draft skeleton.** Sections marked `TODO` must be written against a running node, with
> real command output pasted in. Nothing here should be written from memory.

Toros runs work as **jobs**. A job is a sealed envelope (objective, allowed capabilities,
allowed workspaces, acceptance criteria, forbidden actions, action and retry budgets, expiry)
that Node Core validates on every call. Two things can drive a job: **you**, through the
loopback tools API, or the **Hermes coordinator**, a model that is given only the typed tools
and the envelope.

## 1. Vocabulary

- **Capability** — one typed action an adapter registers, e.g. `grok.send`, `excel.read_range`.
  A job can only call capabilities its envelope lists.
- **Workspace** — a directory root a job may touch. Path arguments outside it are denied
  (`E_PATH_ESCAPE`), never silently corrected.
- **Session** — one CLI worker conversation inside a job; it owns one session directory under
  the workspace, where the worker's raw exchange logs (`exchange-N.jsonl`) are written.
- **Receipt** — the durable record of one action: what was asked, whether policy allowed it,
  when it started and ended, and the outcome. Receipts chain with hashes; `verify-chain`
  proves the chain is unbroken.
- **Checkpoint / relay capsule** — resumable evidence of unfinished work. Not a commit, not a
  review, not an acceptance.

## 2. Your first job, by hand

TODO: an end-to-end worked example on a running node:

1. seal and store an envelope (the store API today; a `tools/` helper is the intended path);
2. `start_cli` → session id (it is the receipt id);
3. write the brief into the session directory;
4. `send_cli` with a message; `read_cli` with a cursor until `exchange_state` leaves `running`;
5. `stop_cli`;
6. read the receipts back and `verify-chain`.

With the exact JSON of each call and response.

## 3. Writing a brief a worker can act on

- Name the workspace path the worker will see. For Antigravity that is the **absolute WSL
  path** of the session directory; without it the model may assume its scratch directory is
  the workspace.
- Say what the worker may not do (write files, run the shell, leave the workspace). A
  read-only Grok has no shell tool at all; Claude runs in `plan` mode.
- Put the source in the session directory (a git worktree under `./code` is the pattern that
  has worked) and say so.
- Ask for a final section with a fixed title. A worker that ends without one has not finished,
  whatever its receipt says (see known issues in [STATUS.md](STATUS.md)).

TODO: one brief that has produced a complete review from each of the four workers.

## 4. Reading what happened

- `list_activity` / `job_status` / receipts: what was allowed and denied, with error codes
  (`E_CAP_NOT_ALLOWED`, `E_PATH_ESCAPE`, `E_EXPIRED`, `E_APPROVAL_REQUIRED`, …).
- The session directory's `exchange-N.jsonl`: the worker's raw stream. This is where a
  "succeeded" exchange that never answered shows its real ending (`stopReason: cancelled`,
  `denied_actions`).
- `verify-chain`: the receipt chain is intact and anchored.

TODO: an annotated receipt and an annotated exchange log.

## 5. Running a job through the Hermes coordinator

```bash
node packages/coordinator/dist/src/main.js <job_id>
```

Exit codes: `0` done/proposed/blocked, `3` operator question (answer over stdin with
`--operator-message-stdin`), `4` turn limit, `5` malformed model output twice, `6` an approval
is needed (`--approval <id>` on the re-run), `7` Node Core or the model endpoint unreachable.
Approvals are granted on the operator surface with `operator_token`, never by the coordinator.

TODO: a transcript of one coordinator run, including what the model saw and what it could not.

## 6. Approvals

Any capability listed in `approval_required` denies with `E_APPROVAL_REQUIRED` and an
`approval_id`; you read the exact arguments on the operator surface and grant once. The grant
is bound to that job, capability, and argument digest, and expires. See [DEPLOY.md §2.1](DEPLOY.md).

## 7. What Toros does not do

It does not confine a CLI worker at the OS level (SPEC §8.1). It does not commit, push,
deploy, or merge. It does not let the coordinator approve its own actions. It does not run on
macOS or Linux.
