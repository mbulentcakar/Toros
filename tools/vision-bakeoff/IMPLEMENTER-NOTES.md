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
