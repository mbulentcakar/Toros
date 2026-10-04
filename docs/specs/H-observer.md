# Spec H — `@toros/observer`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements **SPEC §8.2** (Numbat, monitor-only) and the §12.4 decision.

## Objective

Read Numbat's record stream, correlate records to Toros sessions and receipts by the four
routes §8.2 defines, and hand findings to the store with the correlation route recorded.

**This unit observes. It never decides.** `SecurityObserver` has no method that returns a
verdict, `packages/policy` is forbidden from importing this package, and neither restriction
may be worked around. A monitor-only observer that can influence execution is not monitor-only.

## Allowed paths

```
packages/observer/package.json
packages/observer/tsconfig.json
packages/observer/src/**
packages/observer/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/policy/**             the separation this unit exists to preserve
packages/*/                    any other package
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts` only.

## Numbat, as it actually is

Verified against the repository on 2026-08-02. Do not re-derive this from memory.

- [`perplexityai/numbat`](https://github.com/perplexityai/numbat), Go, CGO-free, native Windows.
- Records are **NDJSON** at `~/.numbat/records.ndjson` (`%USERPROFILE%` on Windows) when hooks
  are installed with `--emit all`.
- `schema_version` is `0.2.0`. Schemas live in `docs/schema/v0.2.0/`.
- Record types are distinguished by `record_type`: `event`, `finding`, plus enforcement,
  indicator, diagnostic and scan-summary records.

**Fields you may rely on** — these are `required` in the schemas:

| Record | Guaranteed fields |
|---|---|
| both | `schema_version`, `record_type`, `run_id`, `endpoint`, `source_agent`, `source_type`, `confidence` |
| event | `event_id`, `event_type`, `evidence` |
| finding | `finding_id`, `detected_at`, `rule_id`, `rule_version`, `severity`, `title`, `evidence_refs`, `cited_event_ids`, `redacted` |

**Fields you may not rely on**: `project_path`, `session_id`, `tool_call_id` are *optional* on
events and **absent from findings entirely**; findings carry an optional `project_path_hash`
instead. Treat every one of these as possibly missing on every record. An implementation that
indexes on them without a guard will throw on the first real finding.

## Correlation — the four routes

Implement §8.2's routes in order, taking the first that resolves:

1. **`exact`** — the record has a `project_path` whose final segment is a known session
   correlation id. Spec E gives each CLI session its own directory named for that id, which is
   what makes this work without any cooperation from the child agent.
2. **`cited`** — a finding where **every** entry of `cited_event_ids` resolves by route 1, and
   they all name **the same session**. Keep a bounded `event_id → session_id` map for events
   already seen. Findings always carry the field, so this is the normal finding path.

   Unanimity is over the *whole* list, not the subset that happens to resolve. A finding citing
   E1 and E2 where E1 resolves to session A and E2 carries no `project_path` still has a
   unanimous resolvable set naming A — while E2 may have come from session B, and you would
   export a multi-session finding as A's.

   So resolve to **`none`** if any citation fails to resolve, if they name more than one
   session, or if the list is empty. Route 2 is exportable and non-provisional; a wrong pick is
   permanent, so the conservative answer is the only safe one.
3. **`session`** — the record's `run_id` is already bound to a session because an earlier
   record with that `run_id` resolved as `exact`, **and both records have
   `source_type: "hook"`**. Keep a bounded `run_id → session_id` map. **Session-granular
   only**: set `session_id`, leave `receipt_id` null, and never narrow it to an action later.

   `source_type` is `artifact | hook | otel`. Only `hook` qualifies. A hook run is one live
   pre-action callback from one agent process, so its records belong to one session; an
   `artifact` run is `numbat scan`, which walks several roots in one pass and emits one stream
   spanning many sessions. Resolve `artifact` and `otel` records by route 1 or not at all.

   **The binding is single-valued and self-invalidating.** If a second exact resolution in the
   same run names a different session, drop the binding, stop using route 3 for that `run_id`,
   and **retroactively downgrade** every record already bound through it to `none`. Records
   that resolved by route 1 keep their exact result — they never depended on the binding. The
   retroactive part is not optional: a conflict found late means the earlier attributions were
   already guesses, and leaving them in place preserves exactly the false attribution this
   whole scheme exists to avoid.
4. **`none`** — nothing above matched. Store it anyway, with both ids null. An uncorrelated
   security finding is still a security finding, and dropping it is the one outcome that loses
   information permanently.

**Do not add a time-window fallback.** Matching on `source_agent` plus `endpoint.hostname`
plus an overlapping active window looks like free coverage and is not: `run_id` identifies a
Numbat run rather than a Toros session, and two concurrent Codex sessions on one machine share
an agent, share an endpoint, and overlap in time. Any rule that picks between them is guessing,
and a guess recorded in an audit trail cannot be told apart from a fact afterwards. Unbound
records go to `none`.

This deliberately gives up coverage. If it proves too thin, the fix is to make route 1 fire
more often, never to add a heuristic here.

## Public API — frozen

```ts
import type { SecurityObserver, FindingRecord } from '@toros/contracts';

export interface NumbatObserverOptions {
  /** Path to records.ndjson. Defaults to ~/.numbat/records.ndjson. */
  readonly records_path: string;
  /** Resolves a session correlation id to a session id, or null. */
  readonly resolveSession: (correlationId: string) => string | null;
  /** Resolves a session id to its job id. */
  readonly jobForSession: (sessionId: string) => string | null;
  /** Cap on the event_id and run_id maps. Oldest entries are dropped. */
  readonly correlation_map_limit: number;
}

export function createNumbatObserver(options: NumbatObserverOptions): SecurityObserver;

/** A no-op observer for hosts without Numbat. start/stop succeed; nothing is emitted. */
export function createNullObserver(): SecurityObserver;
```

`createNullObserver` is required, not optional: Node Core must run on a machine where Numbat is
not installed, and an observer that throws at startup would make an optional security tool a
hard dependency.

## Reading the file

- **Tail, do not re-read.** Open, seek to the end at `start()`, and follow appends. Re-reading
  from the top would re-emit every historical finding on each restart.
- Records are newline-delimited. A partial final line means a writer is mid-write: buffer it and
  wait for the newline rather than parsing a truncated object.
- A line that is not valid JSON, or whose `schema_version` is not `0.2.0`, is **skipped with a
  log line and does not stop the tail.** Numbat may add record types; an observer that dies on
  an unrecognised one takes the node's visibility with it.
- Ignore `record_type` values other than `event` and `finding`.
- The file may be rotated or truncated. Detect a shrink and reopen from the start of the new file.
- If the file does not exist at `start()`, wait for it rather than throwing — hooks may be
  installed after the node starts.

## Redaction

Numbat redacts secrets in its own output, but the contract on this side is independent:
`FindingRecord.detail` must never contain a raw transcript or a credential.

- Copy only a **named allowlist** of fields into `detail`: `rule_id`, `rule_version`,
  `severity`, `title`, `tags`, `confidence`, `detected_at`, `source_agent`, `source_type`,
  `evidence_refs` (types only), `cited_event_ids`.
- **Never copy `content_preview`, `observed_command`, or the whole record.** `content_preview`
  is by name a fragment of what the agent was doing, and `observed_command` is a command line —
  both routinely contain secrets. This is a copy-allowlist, not a strip-denylist, because a new
  Numbat field must default to excluded.
- Truncate `title` to 512 characters.

## Acceptance tests

`packages/observer/test/`. Use NDJSON fixtures you write, not a live Numbat.

**Parsing and tailing**
1. `emits nothing for records written before start`
2. `emits a finding appended after start`
3. `buffers a partial line until its newline arrives`
4. `skips a malformed line and keeps tailing`
5. `skips an unknown schema_version and keeps tailing`
6. `ignores record types other than event and finding`
7. `reopens after the file is truncated`
8. `waits for a records file that does not exist yet`

**Correlation**
9. `resolves exact from a project_path whose last segment is a known correlation id`
10. `resolves cited when every cited_event_id resolves to the same session`
10a. `records none when cited_event_ids resolve to two different sessions`
10f. `records none when any cited_event_id fails to resolve`
10g. `records none when cited_event_ids is empty`
10b. `a route-3 correlation is still provisional after its session stops`
10c. `map eviction does not finalize a provisional correlation`
10d. `a provisional correlation is exported as none`
11. `resolves session from a hook run_id already bound by an earlier exact resolution`
12. `session correlation sets session_id and leaves receipt_id null`
13. `records none when nothing matches`
14. `records none for a record whose run_id was never bound, even when exactly one session of that agent is active`
14a. `does not apply route 3 to an artifact source_type record`
14b. `does not apply route 3 to an otel source_type record`
14c. `a second exact resolution naming a different session drops the run binding`
14d. `records previously bound through an invalidated run are downgraded to none`
14e. `route-1 results survive a run binding invalidation unchanged`
15. `handles a finding with no project_path, session_id or tool_call_id`
16. `handles an event with none of the optional fields`
17. `the event and run maps are bounded and drop oldest entries`

**Redaction**
18. `detail never contains content_preview`
19. `detail never contains observed_command`
20. `an unrecognised field is excluded rather than copied`
21. `title is truncated at 512 characters`

**Monitor-only**
22. `SecurityObserver exposes no method returning a decision`
23. `createNullObserver starts and stops without a records file`

Tests 15 and 16 are the ones a naive implementation fails: build the fixture from the schema's
`required` list alone, with every optional field absent, and assert nothing throws.

## Installing Numbat (operator step, not code)

Recorded here so the version is pinned in one place. Not part of the diff.

```
# download numbat_<version>_windows_amd64.zip from the release
# verify against checksums.txt from the same release, fetched over the API
numbat agents                                  # read-only inventory
numbat scan                                    # read-only
numbat hook install --agent claude --emit all  # monitor-only
numbat hook install --agent codex  --emit all  # monitor-only
```

**No `--enforce`, no `--rules-dir`, no `enforce: true` override.** SPEC §8.2 requires Numbat not
to become the enforcement boundary, and every shipped rule is monitor-only by default.

`numbat hook status` verifies configuration, not delivery — so the acceptance check is that an
observed event actually reaches the findings store from a real adapter run, not that the hook
reports itself installed.

## Verification

```
npx tsc --build packages/observer
node --test packages/observer/dist/test/*.test.js
```

Clean, zero skips.

## Out of scope

Enforcement, rule authoring, policy, and anything that changes what executes. If you find
yourself writing code that could prevent an action, you have left this unit's scope.

## Provisional correlations — the export boundary

Route 3 depends on a run binding that a later record can revoke, so a route-3 correlation is
**provisional**. Routes 1 and 2 never are.

- **Provisional never ends.** Do not implement a finalization path at all. Two earlier drafts
  tried — eviction from your map, then the bound session stopping — and both fail for the same
  reason: nothing available to you proves that no further record for that `run_id` is still to
  arrive. The stream is a file another process appends to; you can lag, and a restart can
  replay a backlog. A session stop bounds what the session can do, not what the stream can
  still say about it. So route 3 is a live-view signal, permanently.
- Provisional correlations are emitted and displayed, labelled as such. Hiding a security
  finding until it settles is the worse failure.
- Anything leaving the process — a relay capsule, a checkpoint, any export — sees a provisional
  correlation as **`none`**. Those outlive the process or leave the machine, and a downgrade
  cannot reach them afterwards.
- On invalidation, emit a **retraction** rather than editing the original: the store appends a
  `finding.correlation_retracted` event citing the earlier one. The log is append-only, so a
  correction is a new row. Rewriting the original would make the false attribution
  indistinguishable from something that never happened, which is what an audit trail exists to
  prevent.
### Install record — done on Oruc, 2026-08-02

Pinned version: **numbat 0.1.2 (schema 0.2.0)** — the schema version this unit parses.

```
# artifact verified before use, checksum fetched over the API from the same release
gh release download v0.1.2 --repo perplexityai/numbat \
  --pattern "numbat_0.1.2_windows_amd64.zip" --pattern "checksums.txt"
# SHA-256 175f5e69b7eb316c81a07380802e72e2ddb246e0628caa7bf24c5dfef9200668  — matched
```

Installed at `%LOCALAPPDATA%\numbat\numbat.exe`.

`numbat agents` (read-only, changes nothing) reports three agents present on this host: **Claude
Code**, **Codex**, and **Grok Build** — all with config found, transcripts found, and hook-based
live capture available.

`numbat hook install --agent codex --emit all` is done: monitor-only, no `--enforce`, no
`--rules-dir`. Hooks land in `~/.codex/hooks.json` and must be trusted in Codex itself before
they fire.

**The Claude Code hook is deliberately deferred to the deploy step.** Installing it rewrites the
configuration of the agent orchestrating this build, and a mid-round change there would be a
poor trade for observability that is not needed until Node Core actually runs. It is the same
one-line command when the time comes.

Remember that `numbat hook status` verifies configuration and not delivery. The acceptance
check is an observed event reaching the findings store from a real adapter run.
