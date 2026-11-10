# Implementer Notes — Toros Slice AU0a: Vision Grounding Bakeoff Harness

## Files Created / Modified

1. `/mnt/c/Code/_worktrees/Toros-au0/.gitignore` *(modified)*
   - Added `tools/vision-bakeoff/results/` and `tools/vision-bakeoff/fixtures/*/window.png` so raw window captures and local bakeoff run outputs are never committed.
2. `/mnt/c/Code/_worktrees/Toros-au0/docs/finding-vision-bakeoff.md` *(created)*
   - Skeleton document with sections: `Setup`, `Models and versions`, `Results`, and `Verdict against AU0 thresholds`.
3. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/capture.ps1` *(created)*
   - Fixed, parameter-free PowerShell script reading its input from `-ParamsFile <path>` (stripping a leading UTF-8 BOM).
   - Enables Per-Monitor DPI awareness (`SetProcessDpiAwarenessContext`), attaches to or launches the target executable, resolves its top-level window strictly by process ID (supporting UWP `ApplicationFrameHost` child `CoreWindow` PID matching; never matching by window title), captures the window via `PrintWindow(hwnd, PW_RENDERFULLCONTENT)`, queries `GetDpiForWindow(hwnd)` and `GetWindowRect`, dumps the UI Automation `ControlViewWalker` tree with Spec V selector paths (`control_type`, `automation_id`, `name`, `index`), and closes the process only if `capture.ps1` launched it.
4. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/capture.mjs` *(created)*
   - Node wrapper that writes temporary JSON params, runs `capture.ps1` via `execFile` (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, `shell: false`) with `PSModulePath` stripped, validates the PNG header/dimensions, `tree.json`, and `meta.json`, and writes normalized outputs under `tools/vision-bakeoff/fixtures/<app>/`.
5. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/targets/calculator.json` *(created)*
   - 50 labelled Calculator (Standard mode) targets with Spec V selector paths and 12 `"hard": true` targets (memory keys `MC`/`MR`/`M+`/`M-`/`MS`/`M▾`, unary operators, small header/flyout/history icons).
6. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/targets/notepad.json` *(created)*
   - 50 labelled Notepad targets with Spec V selector paths and 12 `"hard": true` targets (tab strip controls, settings gear, status bar cells, menu items).
7. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/grounders.config.json` *(created)*
   - Configuration file holding placeholder OpenRouter model IDs for `claude` and `qwen` plus optional `local` endpoint settings.
8. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/grounders.mjs` *(created)*
   - OpenAI-compatible vision chat client using built-in `fetch`, model table (`ui-tars-1.5-7b`, `claude`, `qwen`, optional `local`), `parseUiTarsOutput` (`click(start_box='(x,y)')` and `<point>x y</point>` normalized 0–1000 scaled to image pixels), `parseGenericJsonOutput` (`{"x":<int>,"y":<int>}` or `{"not_found":true}`), `verifyModelsInCatalog` / `checkOpenRouterModels` against `https://openrouter.ai/api/v1/models`, `assertApiKeysPresent`, and `scrubSecrets`.
9. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/score.mjs` *(created)*
   - Image-pixel-to-screen-coordinate conversion (`pixelToScreenPoint`), deepest on-screen UIA element hit-testing (`findDeepestElementAtPoint`), and response classification (`hit`, `wrong_element`, `harmless_miss`, `not_found`, `parse_error`).
10. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/report.mjs` *(created)*
    - Summary computation and Markdown/JSON report generation (`report.md` and `summary.json`) with **`wrong_element`** as the first metric column (bolded), hard-target split, `p50`/`p95` latency, and cost per 100 calls from OpenRouter model pricing.
11. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/run.mjs` *(created)*
    - CLI runner supporting `--apps`, `--grounders`, `--repeat`, `--limit`, and `--out`, failing fast on missing API keys before any capture or network call, verifying OpenRouter model IDs against `/api/v1/models`, executing with bounded concurrency (2) and a 60s per-call deadline, and resuming from per-call JSON records in `<out>/calls/`.
12. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/README.md` *(created)*
    - Documentation covering fixture capture, adding applications, running the bakeoff, reading the report, and the synthetic-data / secret-scrubbing rules.
13. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/test/vision-bakeoff.test.mjs` *(created)*
    - Offline `node:test` unit test suite with zero skips covering UI-TARS parsing, JSON parsing, synthetic tree scoring, 150% DPI coordinate mapping, OpenRouter catalog model checking, report formatting/rates, and pre-flight API key fail-fast.
14. `/mnt/c/Code/_worktrees/Toros-au0/tools/vision-bakeoff/IMPLEMENTER-NOTES.md` *(created)*
    - This summary file.

## Design Decisions Where the Brief Left Room

- **Interior decorative children of atomic controls in `capture.ps1`:** In Windows XAML/WinUI apps (such as Calculator and Notepad), buttons and menu items often expose a child `Text` or `Image` glyph in `ControlViewWalker`. `capture.ps1` skips non-actionable children inside atomic actionable controls (`Button`, `MenuItem`, `CheckBox`, `RadioButton`, `Hyperlink`) so the deepest element at an interior point is the actionable control itself rather than its label text.
- **Selector matching across Windows 11 builds (`score.mjs`):** `matchesExpectedSelector` performs strict step-by-step Spec V selector path equality whenever `expected` exists verbatim in `tree.json` (including all unit tests). When a live Windows capture has extra intermediate XAML wrapper containers so no element matches the full static path verbatim, it falls back to matching the leaf step's `control_type` + `automation_id` (or `name`).
- **Atomic resumable call records (`run.mjs`):** Each completed call is written to `<out>/calls/<grounder>__<app>__<targetId>__r<repeat>.json`, avoiding write contention between the 2 concurrent workers and allowing interrupted runs to resume cleanly.

## Verification Status

- Per instructions in `.au0-brief.md` ("Do not run shell commands... The orchestrator (Claude) builds and runs the tests natively on Windows after you finish"), no shell commands or git commits were executed.

---

## Round 2

Mapping of every Round 2 finding (`.au0-brief-r2.md` and `.au0-review-grok.md`) to the changes implemented:

### Orchestrator Live-Run Findings

- **Orchestrator A — Model coordinate conventions (`tools/vision-bakeoff/grounders.mjs`, `tools/vision-bakeoff/grounders.config.json`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`, `docs/finding-vision-bakeoff.md`):**
  - Kept `smartResize` (Qwen2.5-VL round-half-to-even `factor = 28`, `minPixels = 100 * 28 * 28`, `maxPixels = 16384 * 28 * 28`) and `mapModelPoint` (`smart_resize`, `norm1000`, `pixels`) in `grounders.mjs`.
  - Kept `ui-tars-1.5-7b` configured with `coord_mode: 'smart_resize'` (whilst `parseUiTarsOutput` defaults `opts.coordMode` to `'norm1000'` for backward compatibility) and `qwen` (`qwen/qwen3-vl-235b-a22b-instruct`) configured with `coord_mode: 'norm1000'`.
  - Kept packed-pair JSON formats (`{"x":[x,y],"y":[y]}`, `{"point_2d":[x,y]}`, `{"point":[x,y]}`, `[x,y]`) in `parseGenericJsonOutput`.
  - Added unit tests in `test/vision-bakeoff.test.mjs` covering `smartResize(1402, 1078) -> { width: 1400, height: 1064 }`, `>maxPixels` downscaling, `<minPixels` upscaling, the live UI-TARS-1.5 `(351,996)` example mapping into `num0Button` (`{ x: 378, y: 1160 }`) in `fixtures/calculator/tree.json`, Qwen packed-pair shapes under `coordMode: 'norm1000'`, and out-of-range coordinate rejection (`>1000` in `norm1000`, `>smart_resize` in `smart_resize`, `<0`).
- **Orchestrator B — Targets whose element is absent from the fixture tree (`tools/vision-bakeoff/score.mjs`, `tools/vision-bakeoff/report.mjs`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Added `targetExistsInTree` in `score.mjs`; when a target's `expected` selector cannot be located on any on-screen element in `tree` (neither verbatim nor via unique on-screen leaf `automation_id`), `scoreResponse` returns `classification: 'invalid_target'`.
  - Updated `report.mjs` (`computeSummary`, `summarizeGroup`, `renderMarkdownReport`) to exclude `invalid_target` from `total`, `hard.total`, and all rate denominators, report `invalid_target` counts separately, and list `excluded_target_ids` in `summary.json` and `report.md`.
- **Orchestrator C — Offline re-score tool (`tools/vision-bakeoff/rescore.mjs`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`, `tools/vision-bakeoff/README.md`):**
  - Created `tools/vision-bakeoff/rescore.mjs` (`node tools/vision-bakeoff/rescore.mjs --in <results dir>`) and exported `rescoreBakeoffDir`.
  - Re-parses each call record's stored `raw_reply` with the current grounder parser (`coord_mode`), re-scores against the current fixture (`tree.json`, `meta.json`) and `targets/<app>.json`, rewrites `parsed_point`, `screen_point`, `classification`, and `hit_element` while preserving the original `classification` once as `classification_v1` for audit, and regenerates `report.md` and `summary.json` without network calls or API keys.

### Grok R1 Findings

- **Grok #1 (HIGH) — Target selector alignment with captured fixtures & unique leaf fallback (`tools/vision-bakeoff/targets/calculator.json`, `tools/vision-bakeoff/targets/notepad.json`, `tools/vision-bakeoff/score.mjs`):**
  - Rewrote all 50 `expected` selectors in `targets/calculator.json` (12 hard) and all 50 `expected` selectors in `targets/notepad.json` (12 hard) verbatim from on-screen elements in `fixtures/calculator/tree.json` and `fixtures/notepad/tree.json`.
  - Updated Calculator targets whose automation IDs differed in the Windows 11 capture (`xpower2Button` for `calc-20`/`calc-48`, `NormalAlwaysOnTopButton` for `calc-29`, and `HistoryLabel` for `calc-30`).
  - Replaced the Notepad targets that referenced the non-existent `"Untitled"` tab in the captured fixture (`notepad-06` -> `FREButton` `"What's new"`, `notepad-18` -> active tab `CloseButton` `"Close Tab"`, `notepad-31` -> dialog `CloseButton` `"OK"`, `notepad-39` -> `SystemMenuBar` `Item 1` `"System"`, `notepad-50` -> active `TabItem` `"review-codex-pr154-round2.log. Unmodified."`).
  - Restricted leaf fallback in `matchesExpectedSelector` (`score.mjs`) to fire only when no on-screen element matches the full selector verbatim AND `leaf.automation_id` is non-empty and unique among on-screen elements of that `control_type` in `tree` (preventing collisions such as duplicate `CloseButton` or `ContentTextBlock` controls in Notepad).
- **Grok #2 (MEDIUM) — No name-only leaf matching (`tools/vision-bakeoff/score.mjs`):**
  - Removed the `leaf.name` fallback branch from `matchesExpectedSelector`. Elements without a non-empty `automation_id` must match by full `selectorsEqual`.
- **Grok #3 (MEDIUM) — Separate `transport_error` from `parse_error` (`tools/vision-bakeoff/grounders.mjs`, `tools/vision-bakeoff/score.mjs`, `tools/vision-bakeoff/run.mjs`, `tools/vision-bakeoff/report.mjs`):**
  - Tagged network/deadline failures, non-2xx HTTP responses, and invalid HTTP JSON bodies with `err.code = 'E_TRANSPORT_ERROR'` in `callGrounder` (`grounders.mjs`).
  - Mapped `callGrounder` errors to `status: 'transport_error'` in `run.mjs` and `classification: 'transport_error'` in `scoreResponse` (`score.mjs`).
  - Excluded `transport_error` from `total`, `hard.total`, and all rate denominators in `report.mjs`, reporting `transport_error` counts separately.
  - Updated `run.mjs` (`main`) to exit with code `1` when `transport_error` exceeds 10% of calls.
- **Grok #4 (MEDIUM) — Missing Calculator & Notepad targets (`tools/vision-bakeoff/targets/calculator.json`, `tools/vision-bakeoff/targets/notepad.json`, `tools/vision-bakeoff/score.mjs`):**
  - Resolved together with Grok #1 and Orchestrator B: all 50 Calculator and 50 Notepad targets match on-screen elements in `fixtures/<app>/tree.json` verbatim, and any hypothetical missing target is classified as `invalid_target`.
- **Grok #5 (MEDIUM) — Unit test coverage for real fixtures, leaf fallback, resume, and transport/deadline (`tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Added unit tests verifying verbatim `selectorsEqual` alignment of all 50 Calculator and 50 Notepad targets against `fixtures/<app>/tree.json`, leaf-fallback uniqueness and name-only rejection, resume skipping and `resumedRecords` accounting, deadline/HTTP `transport_error` handling and `>10%` non-zero exit code, and `rescoreBakeoffDir`.
- **Grok #6 (MEDIUM) — UI-TARS explicit decline action (`tools/vision-bakeoff/grounders.mjs`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Added `finished(content='not_found')` to the UI-TARS prompt action space in `buildGrounderPrompt` and updated `parseUiTarsOutput` to map `finished(content='not_found')` (and only that form when no coordinates are present) to `{ ok: true, status: 'not_found', not_found: true, point: null }`, keeping free text without coordinates as `parse_error`.
- **Grok #7 (LOW) — Threshold copy alignment (`tools/vision-bakeoff/report.mjs`, `tools/vision-bakeoff/README.md`):**
  - Updated threshold copy from `hit ≥ 80.0%` to `hit ≥ 85.0%` (matching `docs/specs/AU-vision-grounding.md` and `docs/finding-vision-bakeoff.md`).
- **Grok #8 (LOW) — `capture.ps1` cleanup kills only launched process tree (`tools/vision-bakeoff/capture.ps1`):**
  - Replaced `$procName`-wide `Get-Process` termination with `$startedPid` tracking (`Start-Process -PassThru`) and `Add-DescendantPids` (`Win32_Process` `ParentProcessId` traversal) so `finally` stops only `$startedPid` and its descendant PIDs.
- **Grok #9 (LOW) — Half-open hit-test intervals (`tools/vision-bakeoff/score.mjs`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Updated `rectContainsPoint` to use half-open intervals (`left <= x < right` and `top <= y < bottom`) and added an edge-pixel boundary unit test.
- **Grok #10 (LOW) — `resumedRecords` counts only current run plan (`tools/vision-bakeoff/run.mjs`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Changed `resumedRecords` to count only `existingByKey.has(key)` hits within the current `apps × activeGrounders × targets × repeat` plan rather than `existingByKey.size`.
- **Grok #11 (LOW) — CLI `--concurrency` and `--deadline-ms` flags (`tools/vision-bakeoff/run.mjs`, `tools/vision-bakeoff/README.md`, `tools/vision-bakeoff/test/vision-bakeoff.test.mjs`):**
  - Added `--concurrency <N>` and `--deadline-ms <ms>` flags to `parseRunArgs` and wired them through `main()` to `runBakeoff()`.
