# AR-F5 — inventory honesty (implementation brief)

**Read `docs/specs/00-CONTRACTS.md` first.** F5 uses amendment A8 from F3a (`AR-F3-brief.md`) and
changes nothing in `packages/contracts`.

**Lane:** implementer from the deputy pool (sandboxed `deputize`); code review by Codex. The
implementer is never the reviewer.

**Order:** after F3a is merged. F5 touches only `packages/adapters-machine` and its wiring in
`packages/node-core/src/main.ts`. AR-11 moved to F3b, because it is the desktop manifest.

## Findings closed

| Finding | Sev | Change |
|---|---|---|
| AR-08 inventory's PATH walk can make undeclared network I/O | Medium | Probe only local, fixed, absolute directories |
| AR-09 inventory reports adapters outside the job allowlist | Low | Filter through the A8 resolver; out-of-job entries become `unauthorized` |

## AR-08 — local paths only

- Before probing, drop every `PATH` entry that is not an absolute path on a local fixed drive.
  Drop UNC (`\\server\…`, `//…`), device (`\\?\`, `\\.\`), drive-relative (`C:x`) and relative
  entries without touching them. On Windows, a drive letter counts only when `GetDriveType`
  reports `DRIVE_FIXED`. Query it once per drive letter, per invoke, through a small native helper
  or `fsutil fsinfo drivetype`, chosen by the implementer and stated in the PR.
- `file`-kind probes keep their fixed absolute paths and get the same local-fixed check.
- Count dropped entries in the output as `path_entries_skipped`, a number only, never the
  entries themselves.
- Check `signal.aborted` before every `access` call, as today. F4's Core-level timeout bounds the
  whole call.

## AR-09 — job-scoped inventory

- Give the machine adapter an A8 `resolver`. `resolve` for `machine.inventory` returns one
  `{ kind: 'capability', key, capability }` target per registered capability it would report.
- `invoke` reports full readiness only for keys whose decision is `allowed`. Every other entry
  appears with readiness `unauthorized` and no `reason`, platform or `backs_adapter` detail. Add
  `unauthorized` to the readiness taxonomy and to `docs/specs/AR-read-only-discovery.md`.
- A job whose only capability is `machine.inventory` therefore sees `machine.inventory` itself in
  full, and every other adapter as `unauthorized`.

## Tests

- PATH with a UNC entry, a `\\?\` entry, a relative entry and a drive-relative entry: none is
  touched (assert through an injected `access` seam), and `path_entries_skipped` is 4.
- A fixed local entry is probed. A non-fixed drive letter is skipped (fake the drive-type seam).
- Pre-aborted signal: zero `access` calls.
- Job with only `machine.inventory`: the desktop entries are `unauthorized`, with no detail fields.
- Job with `machine.inventory` and `desktop.state`: the desktop entry is reported in full.
- Through the real Core path: the receipt holds the counts only.

## Acceptance

- Delete every `packages/*/dist`, then `npm run typecheck`: 0 errors.
- `npm test` without `TOROS_REAL_TESTS`: 0 failed; every skip has its reason.
- CI green on the PR head.

## Round 2 — CI failure on 32999e1 (2026-10-20)

CI `Root` fails `machine.inventory › registered + present probe → usable`. It took 5,007 ms and got
`missing_prerequisite`. The test did not inject `driveTypes`, so it spawned the real PowerShell
reader. That reader timed out on the runner and failed closed, as designed, but two things are
wrong.

1. **Unit tests never spawn (P2).** Every test in `packages/adapters-machine/test/` passes a fake
   `driveTypes`, unless it is explicitly about the production reader. The production-reader test
   (fixed letters come back as a non-empty array on Windows) is gated behind
   `TOROS_REAL_TESTS=1`. Add a guard to the test helper: an adapter built in a test without
   `driveTypes` throws, so this cannot regress silently.
2. **The drive reader does not eat the whole action budget (P2).** Today it gets the full
   action timeout, so a slow PowerShell start leaves no time for the probes. Give it its own
   bound: `min(3_000, floor(timeout_ms / 2))`. On timeout it fails closed, as now. Cache a
   **successful** result per adapter instance for 5 minutes, because drive types rarely change.
   A failure is never cached. Test both the cache and the no-cache-on-failure rule with a fake
   reader and an injected clock.
