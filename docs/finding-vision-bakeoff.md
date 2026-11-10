# Finding: Vision grounding bakeoff (slice AU0a) — first live run, 2026-11-10

> **Status:** first live run, one repetition, two fixture apps, a single DPI (150%). The numbers are
> indicative, not a verdict. Reproduce with `tools/vision-bakeoff/run.mjs`, and re-grade stored replies
> with `rescore.mjs`. Raw results are local only (`tools/vision-bakeoff/results/`, git-ignored).

## Setup

- **Host:** JanBot (Windows 11), one monitor at **150% scaling (144 DPI)**.
- **Fixtures:**
  - Calculator, Standard mode: window 1402×1078 px, 62 UIA elements.
  - Notepad: window 1653×1191 px, 46 UIA elements.
  - Synthetic content only.
- **Targets:** 50 labelled targets per app (≥ 10 marked hard). Every target's `expected` selector
  exists verbatim in its committed fixture tree (tested).
- **Capture:** `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` bound by pid, plus the UIA ControlView tree.
- **Runs:** 1 repetition, 300 calls in total (150 per app). Total cost was about $1.10 on OpenRouter.
  The key was loaded from the server-side store into the run's process only.

## Models

| Grounder | Model (pinned) | Prompt | Coordinate convention |
|---|---|---|---|
| `ui-tars-1.5-7b` | `bytedance/ui-tars-1.5-7b` | UI-TARS action format | absolute pixels of the Qwen2.5-VL `smart_resize`d image |
| `claude` | `anthropic/claude-sonnet-5.5` | strict pixel JSON | image pixels |
| `qwen` | `qwen/qwen3-vl-235b-a22b-instruct` | strict pixel JSON | 0–1000 relative (Qwen3-VL ignores the pixel instruction) |

## Results (all targets)

| Grounder | App | **wrong_element** | hit | harmless_miss | not_found | parse_error | p50 / p95 ms | $ / 100 calls |
|---|---|---|---|---|---|---|---|---|
| claude | calculator | **0 / 50 (0%)** | 100% | 0% | 0% | 0% | 700 / 1348 | 0.45 |
| claude | notepad | **0 / 50 (0%)** | 98% | 2% | 0% | 0% | 888 / 2125 | 0.56 |
| ui-tars-1.5-7b | calculator | **2 / 50 (4%)** | 96% | 0% | 0% | 0% | 729 / 1381 | 0.02 |
| ui-tars-1.5-7b | notepad | **2 / 50 (4%)** | 90% | 2% | 0% | 4% | 718 / 1142 | 0.03 |
| qwen | calculator | **0 / 50 (0%)** | 56% | 0% | 0% | 44% | 788 / 2752 | 0.02 |
| qwen | notepad | **0 / 50 (0%)** | 68% | 0% | 14% | 18% | 667 / 1148 | 0.03 |

**UI-TARS's wrong elements.** All four landed on an adjacent, look-alike control:
- Calculator: √x → ÷, and "add to memory" → −.
- Notepad: "the menu with copy/paste/find" → View, and the window Close → the tab's Close.

**Qwen's parse errors** are format failures: quoted numbers and malformed JSON. A production
parser would reject them too.

## What we learned about the harness (kept as tests)

- **Coordinate conventions differ per model.** Reading UI-TARS-1.5 as 0–1000 gave a false 30%
  wrong-element rate, and reading Qwen3-VL's packed pairs gave 100% parse errors.
- **UIA trees are not strictly nested.** Hit-testing must take the smallest containing element, as
  `ElementFromPoint` does, not the deepest selector. A point on a non-clickable overlay inside the
  target's own rect is a hit (Notepad's scroll viewer over its Document).
- **Run 1 target labels were wrong.** Four Calculator targets had wrong automation ids. Targets are
  now generated from, and tested against, the committed fixture tree.

## Verdict against the AU0 thresholds (wrong_element ≤ 2%, hit ≥ 85%)

| Grounder | Meets both? | Note |
|---|---|---|
| Claude Sonnet 5.5 | **yes** on both apps | 0 wrong of 100. About 20× UI-TARS's cost, and the screenshots go to an external provider. |
| UI-TARS-1.5-7B | **no**: 4% wrong (4 of 100) | Hits are good (90–96%). The errors are adjacent look-alikes, which is exactly the dangerous kind. |
| Qwen3-VL-235B | **no**: hit 56–68% | Never wrong, but too many format failures as configured. |

**Indicative conclusion:**
- **AU1 as specified:** with AU's data rule (local grounder by default, external only for listed
  apps), no *local* grounder qualifies yet; UI-TARS-1.5-7B is the only local-capable candidate, and
  it misses the 2% wrong-element bar. AU1 can proceed with Claude only for apps on
  `vision.external_apps`.
- **Before deciding on UI-TARS:**
  - repeat ×3 to measure variance;
  - add the operator's real target apps;
  - test 100% and 200% DPI;
  - try a self-hosted UI-TARS (a GGUF on JanBot's GTX 1080, or a bigger GPU).

**Decision:** the operator's.
