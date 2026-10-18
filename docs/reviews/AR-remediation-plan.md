# AR — remediation plan for the adversarial security review

**Source:** `docs/reviews/AR-adversarial-security-review.md` (PR mbulentcakar/Toros#3), verdict
*do not enable*. This plan groups the eleven findings (AR-01 … AR-11) into bounded fix slices. It
is triage, not a fix. Each slice is one branch, one PR, and its own independent review.

**Gate.** The desktop discovery surface stays **disabled in production**, and spec AS mutation stays
blocked, until slices F1–F4 are merged and a native re-review of the AR surface clears them. F5 is
needed before re-review, but does not block on its own.

## Slices

| Slice | Findings | Change, in one line | Packages | AS-inherited |
|---|---|---|---|---|
| **F1 — credential separation** | AR-03 | Require a strong `operator_token` distinct from `token` whenever the operator surface is mounted, not only when a capability is gated. | `node-core` | yes |
| **F2 — no UIA `Name` in discovery** | AR-01, AR-07 (script side) | Never read UIA `Name` for controls; structure only (type, automation id, patterns, enabled); window titles from native window text; bound enumeration inside the PowerShell script. Brief: `AR-F2-brief.md`. | `adapters-desktop` (script + adapter), spec AR | yes |
| **F3a — two-phase resolve (A8)** | AR-02 | Contract amendment A8: an adapter resolves its OS targets, Core decides each against the envelope (`allowed_apps`, `forbidden`, session), the adapter acts only on allowed ones. Brief: `AR-F3-brief.md`. | `contracts`, `envelope`, `policy`, `node-core` | yes |
| **F3b — desktop identity, session, handles** | AR-04, AR-05, AR-10, AR-11 | Identity = pid + creation time, image path, SHA-256, signer; proven interactive session; per-(job, actor) single-use handles; manifest declares its temp files. Brief: `AR-F3-brief.md`. | `adapters-desktop`, `node-core` (config) | yes |
| **F4 — pipeline integrity** | AR-06, AR-07 (Core + `runPowerShell`) | Resolve workspace before budget spend and close every started receipt on any error. Core-level timeout and abort race on every adapter call. Honour pre-aborted signals. Bound field and serialized output size. Await temp cleanup. | `node-core`, `adapters-desktop` | yes |
| **F5 — inventory honesty** | AR-08, AR-09 | Probe only local fixed paths, never UNC entries from `PATH`. Filter inventory to the job through the A8 resolver, with an `unauthorized` state. Brief: `AR-F5-brief.md`. | `adapters-machine` | no |

## Ordering and ownership

- **F1 first.** It is small and closes a High finding on its own.
- **F2 and F4 next, in parallel.** Both touch `probe.ts`, split by region: F2 owns the embedded
  script and raw types, F4 owns the `runPowerShell` wrapper. Briefs: `AR-F2-brief.md`, `AR-F4-brief.md`.
- **F3a after F4** (both edit `action-pipeline.ts`). **F3b after F2 and F3a** (the probe script, and the A8 port). **F5 after F3a.**
- **Operator decision (2026-10-19):** policy sees resolved identity by a two-phase resolve; adapters still never receive the envelope. A scope view passed to the adapter was rejected.
- **Lanes (per `fleet/lanes.toml`):** an implementer from the deputy pool writes each slice; Codex
  reviews the code. The native re-review of the whole AR surface after F1–F4 must again be a
  third lineage, never the slice implementer's model family.
- **Every slice:** native Windows test run with counts, a skip is a finding, and no secrets or
  local paths in the repository.

## Spec impact

Spec AS revision 3 assumes F2 (no names from discovery) and F3 (resolved identity visible to
policy) as its foundation, and lists F1–F4 as prerequisites.
