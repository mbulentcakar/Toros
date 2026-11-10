# Finding: Vision grounding bakeoff (slice AU0a) — first live run, 2026-11-10

> **Status:** first live run, one repetition, two fixture apps, a single DPI (150%). The numbers are
> indicative, not a verdict. Reproduce with `tools/vision-bakeoff/run.mjs`, and re-grade stored replies
> offline with `rescore.mjs`. Raw results are local only (`tools/vision-bakeoff/results/`, git-ignored).
> Scores below use the scoring rules after two independent review rounds (Grok).

## Setup

- **Host:** JanBot (Windows 11), one monitor at **150% scaling (144 DPI)**.
- **Fixtures:**
  - Calculator, Standard mode: window 1402×1078 px, 62 UIA elements.
  - Notepad: window 1653×1191 px, 46 UIA elements.
- **Targets:** 50 labelled targets per app (≥ 10 marked hard). Every target's `expected` selector
  exists verbatim in its committed fixture tree (tested).
- **Capture:** `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` bound by pid, plus the UIA ControlView tree.
- **Runs:** 1 repetition, 300 calls in total. Total cost was about $1.10 on OpenRouter. The key was
  loaded from the server-side store into the run's process only.

**Data incident (Notepad).** The capture attached to the operator's open Notepad instead of a fresh
synthetic one. The screenshot sent to the three providers showed only two tab names, an empty
document and a "path not found" dialog; no file content. The committed fixture now uses synthetic
tab names (`notes-a.txt`, `notes-b.txt`). Before the next Notepad run the fixture must be recaptured
from a clean, synthetic Notepad session, and `capture.ps1` should refuse to attach to a running
instance unless told to.

## Models

| Grounder | Model (pinned) | Prompt | Coordinate convention |
|---|---|---|---|
| `ui-tars-1.5-7b` | `bytedance/ui-tars-1.5-7b` | UI-TARS action format | absolute pixels of the Qwen2.5-VL `smart_resize`d image |
| `claude` | `anthropic/claude-sonnet-5.5` | strict pixel JSON | image pixels |
| `qwen` | `qwen/qwen3-vl-235b-a22b-instruct` | strict JSON (this run asked for pixels; the next asks for 0–1000) | 0–1000 relative |

## Results (all targets)

| Grounder | App | **wrong_element** | hit | harmless_miss | not_found | parse_error | p50 / p95 ms | $ / 100 calls |
|---|---|---|---|---|---|---|---|---|
| claude | calculator | **0 / 50 (0%)** | 100% | 0% | 0% | 0% | 700 / 1348 | 0.45 |
| claude | notepad | **0 / 50 (0%)** | 98% | 2% | 0% | 0% | 888 / 2125 | 0.56 |
| qwen | calculator | **0 / 50 (0%)** | 100% | 0% | 0% | 0% | 788 / 2752 | 0.02 |
| qwen | notepad | **0 / 50 (0%)** | 86% | 0% | 14% | 0% | 667 / 1148 | 0.03 |
| ui-tars-1.5-7b | calculator | **2 / 50 (4%)** | 96% | 0% | 0% | 0% | 729 / 1381 | 0.02 |
| ui-tars-1.5-7b | notepad | **2 / 50 (4%)** | 90% | 2% | 0% | 4% | 718 / 1142 | 0.03 |

**Qwen's reply format.** About a third of Qwen's replies (31 of 100) were malformed JSON that still
carried a clear point: quoted numbers, a missing bracket, or a pair packed into `"x"`. The bakeoff
scores the recovered point, because a click hidden as `parse_error` is not safe. A production
parser would need the same recovery, or a stricter prompt.

**UI-TARS's wrong elements.** All four landed on an adjacent, look-alike control:
- Calculator: √x → ÷, and "add to memory" → −.
- Notepad: "the menu with copy/paste/find" → View, and the window Close → the tab's Close.

## What we learned about the harness (kept as tests)

- **Coordinate conventions differ per model.** Reading UI-TARS-1.5 as 0–1000 gave a false 30%
  wrong-element rate. Qwen3-VL answers 0–1000 even when asked for pixels.
- **UIA trees overlap; they are not strictly nested.** Hit-testing therefore picks the smallest
  *actionable* control under the point, then the smallest element of any kind. A click on a
  non-actionable overlay inside the target's own rect is a hit. A click on another tab's title
  counts as that tab, so it is `wrong_element`.
- **Targets must come from the fixture.** Four Calculator targets in run 1 had wrong automation ids.
  Targets are now generated from, and tested against, the committed fixture tree.

## Verdict against the AU0 thresholds (wrong_element ≤ 2%, hit ≥ 85%)

| Grounder | Meets both? | Note |
|---|---|---|
| Claude Sonnet 5.5 | **yes** (0/100 wrong, 98–100% hit) | About 20× the others' cost; external provider only. |
| Qwen3-VL-235B | **yes** (0/100 wrong, 86–100% hit) | The format is unreliable (31% recovered). It has open weights: the 235B model is too large for JanBot, so test the 8B/30B variants locally. |
| UI-TARS-1.5-7B | **no**: 4/100 wrong | Hit rate is good, but the errors are look-alikes, the dangerous kind. |

**Indicative conclusion:**
- **AU1:** it can proceed with Claude, or with Qwen behind a recovering parser, for apps on
  `vision.external_apps`.
- **A local grounder:** the Qwen3-VL family is now the lead candidate over UI-TARS.
- **Before deciding:**
  - repeat ×3;
  - add the operator's real target apps;
  - test 100% and 200% DPI;
  - re-run Qwen with the 0–1000 prompt;
  - try the small Qwen3-VL variants and a self-hosted UI-TARS;
  - recapture Notepad cleanly.

**Decision:** the operator's.
