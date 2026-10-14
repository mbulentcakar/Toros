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
| **F3 — bound identity and scope** | AR-02, AR-04, AR-05, AR-10 | Policy sees the resolved app identity, so envelope `forbidden` and scope apply. Verify the requested OS session. Bind handles to the minting job and caller, single-use, with issuance time. Replace basename identity with image path, hash and signer. | `adapters-desktop`, `policy`, `node-core` | yes |
| **F4 — pipeline integrity** | AR-06, AR-07 (Core + `runPowerShell`) | Resolve workspace before budget spend and close every started receipt on any error. Core-level timeout and abort race on every adapter call. Honour pre-aborted signals. Bound field and serialized output size. Await temp cleanup. | `node-core`, `adapters-desktop` | yes |
| **F5 — inventory and manifest honesty** | AR-08, AR-09, AR-11 | Probe only local fixed paths, never UNC entries from `PATH`. Filter inventory to the job's allowlist, with an `unauthorized` state. Declare the probe's temp-file use in the manifest. | `adapters-machine`, `adapters-desktop` | AR-11 only |

## Ordering and ownership

- **F1 first.** It is small and closes a High finding on its own.
- **F2 and F4 next, in parallel.** Both touch `probe.ts`, split by region: F2 owns the embedded
  script and raw types, F4 owns the `runPowerShell` wrapper. Briefs: `AR-F2-brief.md`, `AR-F4-brief.md`.
- **F3 after F2,** since both edit the probe.
- **F5 any time.**
- **Lanes (per `fleet/lanes.toml`):** an implementer from the deputy pool writes each slice; Codex
  reviews the code. The native re-review of the whole AR surface after F1–F4 must again be a
  third lineage, never the slice implementer's model family.
- **Every slice:** native Windows test run with counts, a skip is a finding, and no secrets or
  local paths in the repository.

## Spec impact

Spec AS revision 3 assumes F2 (no names from discovery) and F3 (resolved identity visible to
policy) as its foundation, and lists F1–F4 as prerequisites.
