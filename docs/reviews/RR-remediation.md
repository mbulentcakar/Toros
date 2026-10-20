# RR — remediation of the native re-review findings (plan and briefs)

**Source:** `docs/reviews/AR-native-rereview.md`, PR mbulentcakar/Toros#13: agy / Gemini 4 Argon,
native, `main` at `a5d9360`. Verdict **do not clear**. Seven findings, RR-01 to RR-07, all
demonstrated natively. RR-01 was also confirmed independently by the orchestrator: the forbidden
term `desktop.inspect` does not block the capability `desktop.inspect`.

**Gate (unchanged):** desktop discovery stays disabled, and spec AS stays blocked, until every RR
slice is merged and a **native** re-review clears them.

**Lane (operator, 2026-10-20):** the deputy-pool implementer (DeepSeek V4 Pro, sandboxed opencode)
writes each slice. agy / Gemini 4 Argon reviews each one (read-only). The orchestrator runs the
native suites before review. The implementer is never the reviewer and never merges.

## Operator decisions (2026-10-20)

- **RR-01: forbidden terms match as token sequences.** Both the forbidden term and the candidate
  are split into lower-case alphanumeric words. A term matches when its words appear
  **consecutively** in the candidate's words.
  - `powershell.exe`, `desktop.inspect`, `toros-fixture` and `Microsoft Windows` now work.
  - `deploy` still does not match `redeploy`.
  - A single-word term behaves exactly as before.
  - It applies to capabilities, arguments, and, for app targets, the **full** image path (every
    folder), the product and the signer.
  - Window titles and automation ids are **not** matched: any app can change them, and
    `allowed_apps` remains the real control.
  - A term with no alphanumeric word at all (for example `"--"`) is refused at seal time, so no
    term is silently inert.
- **RR-02: signer rules also require OriginalFilename** (contract amendment **A9**).
  `AppIdentity` gains `original_filename: string | null`, from the version resource. The signer
  rule shape becomes `{ signer, product_name, original_filename }`, with all three required. The
  old two-field signer rule is refused, with a migration message. OriginalFilename survives
  renames and copies, so a Notepad rule no longer covers PowerShell or cmd.

## Slices and order

| Slice | Findings | Packages | Order |
|---|---|---|---|
| **R1: forbidden matching** | RR-01, RR-03 (policy half) | `envelope`, `policy` | first |
| **R3: audit and session-id hygiene** | RR-04, RR-05 | `node-core` | after R1 (one implementer at a time) |
| **R2: A9 and the signer identity** | RR-02 | `contracts`, `envelope`, `policy`, `node-core`, `adapters-desktop` | after R1 (policy rule matching) |
| **R4: discovery leaks and pagination** | RR-03 (inventory half), RR-06, RR-07 | `adapters-desktop`, `adapters-machine`, `tools/orient.mjs` | after R2 (the same probe script) |

Each slice is one branch, one PR, its own Argon review, and natively verified.

---

## R1: forbidden matching (RR-01, RR-03 policy half)

1. **Token-sequence matching** in `packages/envelope/src/envelope.ts` `isForbidden`.
   - Tokenise the term the same way as the candidate (lower-case, split on `[^a-z0-9]+`, drop
     empty tokens).
   - Match when the term's token list appears as a **contiguous** run in the candidate's tokens.
   - `sealEnvelope` refuses (`E_ENVELOPE_INVALID`) any forbidden entry that produces zero tokens.
2. **The policy applies it everywhere the brief says.** In `packages/policy/src/index.ts`:
   - `decide` keeps its capability and argument checks, which now use sequence matching.
   - `decideTarget`, for `app` targets: test the **full** `image_path` (every folder and the file
     name), `product_name` and `signer`.
   - `decideTarget`, for `capability` targets: **also** apply `isForbidden(envelope, capability)`.
     A forbidden capability is `denied` even when it is allowed (RR-03).
3. **Tests.**
   - Every example in the RR-01 finding, both directions: `powershell.exe`, `notepad.exe`,
     `toros-fixture` against `toros-fixture-ab12.exe`, `Microsoft Windows`,
     `Microsoft® Windows® Operating System`, `desktop.inspect` against the capability, and a
     directory term such as `keepass` against `C:\Program Files\KeePass\app.exe`.
   - Negative cases: `deploy` against `redeploy`, and a partial-token case such as `power`
     against `powershell`.
   - Seal-time refusal of a zero-token term.
   - `codex` forbidden with `codex.start` allowed → that capability target is denied.
   - All existing envelope and policy tests still pass. Report any whose expectation changes, and
     why.

## R3: audit and session-id hygiene (RR-04, RR-05)

1. **Reconciliation never fabricates events (RR-04).** In `packages/node-core/src/action-pipeline.ts`,
   `reconcileCliSettlements`:
   - considers only `send` receipts that actually **started**. A receipt whose outcome is
     `denied`, or one with no `action.started` event, is skipped entirely;
   - when checking for an existing finished event, `hasSettledCliSendFinishedEvent` recognises any
     `action.finished` for that receipt id, whatever its outcome or `exchange_state`. A restart
     must never append a second one.

   Regressions:
   - a denied `send` receipt, then restart → no event appended;
   - three restarts in a row → the finished-event count for every receipt is unchanged;
   - the existing round-5/7/8 restart tests still pass.
2. **Strict session-id parsing (RR-05).** In `resolveNodeSessionId`, accept only stdout matching
   `^\s*[0-9]{1,10}\s*$` that fits in uint32. Anything else, including empty output, whitespace
   or hex, returns `null`. Tests use an injected runner: `""`, `"  "`, `"0x10"`, `"-1"`, `"1e3"`
   and `"4294967296"` all give `null`; `"1"` gives `1`.

## R2: A9 and the signer identity (RR-02)

1. **Contract amendment A9** (`packages/contracts`, recorded in `00-CONTRACTS.md` §10 like A8):
   - `AppIdentity` gains `readonly original_filename: string | null`.
   - The signer variant of `AppRule` becomes
     `{ readonly signer: string; readonly product_name: string; readonly original_filename: string }`.
   - Nothing else changes.
2. **Validation.**
   - `envelope` and `desktop-config` refuse a signer rule without `original_filename`. The message
     names the new field. `original_filename` is non-empty, at most 260 characters, with no `\` or
     `/`.
   - Core's identity validator (action-pipeline) accepts `original_filename` as null or a string of
     at most 260 characters with no path separators.
3. **Policy matching.** A signer rule matches only when `signature === 'valid'`, `signer` and
   `product_name` are exactly equal, and `original_filename` is equal **case-insensitively**.
   That is because the version resource varies in case: `PowerShell.EXE`, `NOTEPAD.EXE`.
4. **The probe reads it.** `ReadIdentity` adds
   `(Get-Item -LiteralPath $imagePath).VersionInfo.OriginalFilename`, trimmed, or `$null`.
   `parseIdentity` validates it.
5. **`PSModulePath` isolation.** Every Windows PowerShell 5.1 spawn removes `PSModulePath` from
   the child environment, so 5.1 rebuilds its own default. That covers `runPowerShell` in the
   desktop probe, the machine drive reader and `resolveNodeSessionId`. Copy the environment and
   delete the key; never mutate `process.env`.
6. **A signature check that throws is never "unsigned".** If `Get-AuthenticodeSignature`
   throws, the identity is unavailable: the window is dropped and counted. Only a real
   `NotSigned` status maps to `unsigned`.
7. **Docs.** Update `docs/INSTALL.md` and `docs/AR-T4-install-rollback.md` with the three-field
   signer rule. Use generic examples only.
8. **Tests.**
   - Process-free: rule validation both ways; policy matching (a Notepad rule does not match
     PowerShell's identity; case-insensitive OriginalFilename); and `PSModulePath` absent from
     the spawn environment, through each spawn seam.
   - Native, gated: the fixture identity carries `original_filename`. A native run started under
     a polluted `PSModulePath` (point it at a nonexistent folder) still reports the real signature
     status of a signed system binary. The orchestrator runs this.

## R4: discovery leaks and pagination (RR-03 inventory half, RR-06, RR-07)

1. **Inventory reveals nothing outside the job (RR-03).** In `packages/adapters-machine`:
   - Entries whose adapter has no allowed capability are **omitted** from the output entirely:
     no `unauthorized` stub, and no count.
   - Filesystem probes and the drive read run **only** for entries that are allowed.
   - Update the AR spec doc's readiness taxonomy: `unauthorized` is no longer emitted.
   - Tests: an out-of-job adapter is absent; zero `access` calls for out-of-job probes.
2. **Pagination works without reopening replay (RR-06).**
   - `desktop.inspect` page 1 consumes the window handle and returns a `continuation_token`.
     That token is single-use, bound to (job, actor, window_id), and valid for 60 seconds.
   - Page N+1 requires the previous page's continuation token. Reused, foreign or expired tokens
     all return the same `refresh_required`.
   - Tests: pages 1–3 succeed; replaying page 2's token fails; a foreign actor fails.
   - Native, gated: `control_filter` by `automation_id`, using the id the fixture actually exposes.
     On WinForms that is the HWND string; document this in the spec doc.
3. **The probe reads nothing about out-of-scope windows (RR-07).**
   - `input.json` carries the global `authorized_apps` rules. `enumerate_windows` evaluates them
     in PowerShell, using the same matching as policy, **before** it calls `WindowText` and
     **before** a window counts toward `max_windows`.
   - Windows outside the bound are skipped without a title read and without a count.
   - `inspect_window` checks `sameIdentity` **before** walking the UIA subtree.
   - Native, gated: a second fixture outside the bound has its title absent from `output.json`,
     and does not take a `max_windows` slot.
4. **`tools/orient.mjs` (RR-07).** `validateNodeConfig` checks the F1 token rules (printable
   ASCII, at least 32 characters, distinct from the operator token) and F3b/A9
   `desktop.authorized_apps`, by reusing the node-core validation where possible. Add tests.

## Acceptance (every slice)

- Delete every `packages/*/dist` and `*.tsbuildinfo`, then `npm run typecheck`: 0 errors.
- `npm test`: 0 failed. Every skip has its reason.
- The orchestrator's native gated run (`TOROS_REAL_TESTS=1`) is green for any slice that touches
  a native path.
- CI green on the PR head.
- No secrets, local paths or machine names.
