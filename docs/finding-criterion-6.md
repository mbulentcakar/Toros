# Criterion 6 decision: job-scoped operator findings

## Resolution — 2026-08-09

The operator selected option 2, narrowed to one job per request:

- `POST /operator/findings` requires the distinct operator bearer and a `job_id`.
- It returns only `StorePort.listFindings(job_id)` and has no mutation path.
- It is not present in `TOOL_NAMES`; the coordinator bearer receives 401.
- The cockpit Rust proxy selects the operator credential, and the WebView receives neither
  credential.
- The Findings view asks for a job id and displays severity, rule, title, observed time, and
  correlation confidence without rendering Node Core data as HTML.

Unit and UI coverage proves authorization, job isolation, non-blocking behaviour, proxy
allowlisting, and escaped rendering.

The genuine live proof passed on 2026-08-09 via `node tools/criterion6-live.mjs`:

```text
real adapter          Claude 2.1.220, permission mode plan
benign trigger        cat .env (synthetic file: TOROS_ACCEPTANCE_MARKER=benign)
Numbat rule           secrets.agent_read_env, medium
correlation           cited, correct Toros job and session
operator visibility   POST /operator/findings returned the stored finding
non-blocking          stop_cli succeeded after the finding
```

No finding record was injected. The harness starts a scratch Node Core at the current end of the

## Original diagnosis (retained for decision history)

**SPEC §10, Phase 1 acceptance, item 6:**

> A Numbat finding reaches the findings store from a real adapter run and is
> visible in the cockpit **without blocking execution**.

At the time of this diagnosis, two clauses were met and cockpit visibility was impossible on
the then-current surface. The resolution above closes that design gap.

## Met: findings reach the store, and do not block execution

Verified 2026-08-07 against a Node Core watching a copy of the live records
file:

```
6a. a finding in the record stream reaches the findings store   PASS
6b. an uncorrelated finding is stored as such, not guessed at   PASS  (correlation=none, receipt_id=null)
6c. findings do not block execution — the node still serves     PASS
```

Numbat is emitting: `~/.numbat/records.ndjson` carries session events written
the same day, so the hook installed to `settings.local.json` is live. Those are
`event` records; a `finding` record additionally requires a numbat rule to
match something, which no ordinary session had done. The finding used above was
therefore injected into the stream rather than provoked, which tests the half
Toros owns — tail, correlate, store — and not numbat's rule engine.

## Not met, and unmeetable: "visible in the cockpit"

**Node Core exposes no findings tool.** `TOOL_NAMES` is the complete surface:

```
job_status, job_complete, job_block, list_capabilities, list_sessions,
start_cli, send_cli, read_cli, interrupt_cli, stop_cli,
inspect_app, invoke_app_action, create_checkpoint, create_local_relay,
list_activity
```

There is no way to read findings over it, so the cockpit cannot display them.
`FindingsView` says exactly that and has said so since it was written:

> Security findings are not available from Node Core's Phase 1 surface: no
> findings-list tool exists.

That component is correct. The criterion is what does not hold: **§10 item 6
requires a capability §6 does not define.** SPEC §6 also states plainly that the
tool list is the whole surface — "There is no generic `shell`, `execute`,
`read_file`, `write_file`, or arbitrary click tool" — so this is not an
oversight to be patched by adding a tool without thought.

## What to do about it, deliberately not decided here

Three options, in rough order of size:

1. **Add `list_findings(job_id)` to the tool surface.** Small, and it makes the
   criterion satisfiable. But it widens the surface the coordinator can reach,
   and §8.2 is emphatic that findings are advisory and the policy engine must
   not read them — a coordinator that can read its own findings is a new
   consideration, not a trivial addition.
2. **Expose findings on the OPERATOR surface only**, beside `/operator/approvals`.
   The cockpit is the operator's console and the criterion says "visible in the
   cockpit", not "visible to the coordinator". This keeps findings out of the
   coordinator's reach entirely, which matches §8.2's intent better than option
   1 does.
3. **Amend the criterion** to match the surface, and defer cockpit visibility to
   a later phase.

**Option 2 is the one I would argue for**, but the choice belongs to the
operator: it changes what Phase 1 claims to deliver.

## Why this was not found earlier

Every previous check of criterion 6 stopped at "no finding reached the store",
which was true and had a plausible cause — the hook was not installed. Once the
hook was installed and the store path was proven, the remaining clause turned
out to be blocked by the spec rather than by the implementation. The blocker
that hid behind a real blocker.
