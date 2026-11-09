# Vision Grounding Bakeoff Harness (AU0a)

Offline evaluation harness for **Toros Spec AU (`docs/specs/AU-vision-grounding.md`)**. It measures how accurately vision grounding models ("grounders") point at a described UI control in a Windows application window before any runtime `vision.locate` capability is built.

The primary decision metric is the **wrong-element rate (`wrong_element`)**: how often a grounder's predicted point lands on a *different*, enabled, actionable UI control. A model that declines (`not_found`) is safe; a model that confidently clicks the wrong button is dangerous.

---

## Data & Secret Handling Rule

1. **Synthetic content only:** Fixtures are Notepad and Calculator with synthetic content only. **Never capture an application window that shows customer, tenant, or personal data for a run against an external endpoint.**
2. **Raw window screenshots stay local:** `tools/vision-bakeoff/fixtures/*/window.png` and `tools/vision-bakeoff/results/` are ignored by `.gitignore` and must never be committed. `tree.json` and `meta.json` contain only synthetic UI Automation metadata and may be committed.
3. **API keys from environment variables only:** API keys (such as `OPENROUTER_API_KEY`) are read exclusively from environment variables at runtime. Never write an API key into any file, log, result, or error message; `grounders.mjs` scrubs `Authorization` headers, `Bearer` tokens, and raw key values from all error strings and recorded outputs.

---

## 1. Capturing Fixtures

Fixtures live under `tools/vision-bakeoff/fixtures/<app>/` and consist of:
- `window.png` — top-level window capture via `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` (gitignored)
- `tree.json` — UI Automation ControlView element dump with bounding rectangles in physical screen coordinates and Spec V selector paths (`control_type`, `automation_id`, `name`, `index`)
- `meta.json` — window rectangle, DPI (`GetDpiForWindow`), scale factor, and image dimensions

Capture one or both built-in applications on a Windows host:

```powershell
node tools/vision-bakeoff/capture.mjs --app calculator
node tools/vision-bakeoff/capture.mjs --app notepad
```

`capture.mjs` writes parameters to a temporary JSON file and invokes the fixed, parameter-free `capture.ps1` script via `execFile` (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, `shell: false`). `capture.ps1` attaches to or launches the application by executable, locates its top-level window strictly by process ID (never by window title), captures the window and UIA tree, and closes the process only if `capture.ps1` launched it.

---

## 2. Adding an Application

To add another fixture application:

1. **Capture the fixture** by passing `--app <name>` and `--executable <path>` (or add a preset in `APP_PRESETS` inside `capture.mjs`):
   ```powershell
   node tools/vision-bakeoff/capture.mjs --app <name> --executable "C:\Path\To\App.exe"
   ```
2. **Create a target list** at `tools/vision-bakeoff/targets/<name>.json` containing 50 labelled targets:
   ```json
   [
     {
       "id": "app-example-01",
       "description": "the Save button",
       "hard": false,
       "expected": [
         { "control_type": "Window", "automation_id": null, "name": "Example App", "index": 0 },
         { "control_type": "Button", "automation_id": "SaveButton", "name": "Save", "index": 0 }
       ]
     }
   ]
   ```
   Prefer targets with stable `automation_id` values from `fixtures/<name>/tree.json`. Mark deliberately ambiguous or small icon targets with `"hard": true`.

---

## 3. Running the Bakeoff

1. Set your API key in the environment:
   ```powershell
   $env:OPENROUTER_API_KEY = "sk-or-v1-..."
   ```
2. Verify/update model IDs for `claude` and `qwen` in `tools/vision-bakeoff/grounders.config.json`. Before issuing any completion call, `run.mjs` queries `https://openrouter.ai/api/v1/models` and refuses to run if any configured model ID is absent from the catalog.
3. Run the harness:
   ```powershell
   node tools/vision-bakeoff/run.mjs `
     --apps notepad,calculator `
     --grounders ui-tars-1.5-7b,claude,qwen `
     --repeat 1 `
     --out tools/vision-bakeoff/results/run-01
   ```
   Use `--limit <N>` for a quick smoke check (e.g., `--limit 5`).

- **Fail-fast:** If a required `key_env` (e.g., `OPENROUTER_API_KEY`) is missing, `run.mjs` exits immediately naming the variable before any window capture or network request.
- **Bounded concurrency & deadline:** Runs at most 2 concurrent requests with a 60-second per-call deadline.
- **Resumable:** Completed calls are written individually to `<out>/calls/<grounder>__<app>__<target>__r<repeat>.json`. Re-running with the same `--out` directory skips already-recorded calls.
- **Optional local grounder:** Including `local` in `--grounders` probes `http://127.0.0.1:8080/v1/models` (configurable in `grounders.config.json`) and automatically skips `local` if unreachable.

---

## 4. Reading the Report

Each run writes `<out>/report.md` and `<out>/summary.json`.

In every table, **`wrong_element` is the first metric column and is bolded**:

| Classification | Meaning | Safety Impact |
| --- | --- | --- |
| **`wrong_element`** | Point landed on a *different* enabled, actionable control (`Button`, `MenuItem`, `ListItem`, `TabItem`, `Hyperlink`, `CheckBox`, `RadioButton`, `ComboBox`, `Edit`, `SplitButton`) | **Hazardous** — AU0 requires **`wrong_element` ≤ 2.0%** |
| `hit` | Deepest on-screen UIA element containing the point matches `expected` | Desired outcome — AU0 requires **`hit` ≥ 80.0%** |
| `harmless_miss` | Point landed on an inert/non-actionable element (`Pane`, `Text`, `Group`, `Window`) or disabled control | Safe miss |
| `not_found` | Model returned `{"not_found": true}` or a coordinate outside the window | Safe refusal |
| `parse_error` | Model output was malformed or failed to parse | Safe rejection at parser boundary |

The report breaks down counts and rates per `grounder × app` across all targets, separately for `"hard": true` targets only, and aggregated by grounder alongside `p50`/`p95` latency (ms) and estimated cost per 100 calls (USD).

---

## 5. Offline Unit Tests

Run the unit test suite (requires no network access and no Windows desktop session):

```powershell
node --test tools/vision-bakeoff/test/
```
