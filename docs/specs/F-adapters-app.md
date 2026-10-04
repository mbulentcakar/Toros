# Spec F — `@toros/adapters-app`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements the Phase 1 pilot desktop adapter (**SPEC §12.1**) under the automation preference
order of **§4.3**.

## Objective

One adapter, for Microsoft Excel, exposing exactly four actions: `inspect_workbook`,
`read_range`, `write_range`, `export_pdf`.

The §10 acceptance criterion this unit must satisfy is: *"The pilot desktop app exposes only
its registered inspect/action schemas."* Four actions, no escape hatch, no generic "run macro"
and no passthrough parameter that turns into one.

## Allowed paths

```
packages/adapters-app/package.json
packages/adapters-app/tsconfig.json
packages/adapters-app/src/**
packages/adapters-app/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts` only. No `xlsx`, no `exceljs`, no COM wrapper package —
00-CONTRACTS §3 permits no runtime dependency here.

## Automation approach — read this before choosing one

SPEC §4.3 orders the options, and the ordering is a requirement, not a suggestion:

1. native API or plugin
2. document/file manipulation
3. application scripting
4. OS accessibility
5. keyboard/menu macro
6. screenshot/computer-use

**Use tier 3, application scripting, via PowerShell COM automation.** Excel's COM object model
is a real automation interface; drive it by generating a PowerShell script and running it with
`child_process.execFile` against `powershell.exe`, reading results back as JSON.

**Do not use tiers 4-6 at all.** No `SendKeys`, no window activation, no screenshots. If an
action seems to need one, it is out of scope for Phase 1 — say so rather than reaching down the
list. That §12.1 chose Excel specifically to avoid computer-use is the whole reason it is the
pilot.

### Script generation is the risk here

The script you generate contains a file path and, for `write_range`, cell values — both
ultimately model-supplied. **Never interpolate a value into PowerShell source text.**

Instead:

- write the parameters to a temporary **JSON file** inside the session directory;
- generate a *fixed*, parameter-free script that reads that JSON with
  `ConvertFrom-Json`, does the work, and writes results to another JSON file;
- invoke `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`
  with `execFile` and `shell: false`.

The script text must be a constant in your source. If a code path builds it with string
concatenation from an argument, that is the defect this section exists to prevent — a value
containing `"; Remove-Item -Recurse C:\ ;#` would otherwise execute.

## Public API — frozen

```ts
import type { Adapter } from '@toros/contracts';

export interface ExcelAdapterOptions {
  /** Absolute path to EXCEL.EXE, verified at init. */
  readonly executable: string;
  /** Wall-clock ceiling per action, milliseconds. */
  readonly timeout_ms: number;
  /** Maximum cells a single read_range or write_range may address. */
  readonly max_cells: number;
}

export function createExcelAdapter(options: ExcelAdapterOptions): Adapter;
```

Nothing else. This is an `Adapter`, not a `SessionAdapter` — Excel actions are one-shot.

## The four actions

| Action | Input | Behaviour |
|---|---|---|
| `inspect_workbook` | `{ path }` | Returns sheet names, used range per sheet, and cell counts. Reads only. |
| `read_range` | `{ path, sheet, range }` | Returns cell values as a 2-D array of string, number, boolean, or null. |
| `write_range` | `{ path, sheet, range, values }` | Writes a 2-D array, saves, closes. |
| `export_pdf` | `{ path, sheet?, out_path }` | Exports to PDF at `out_path`. |

`mutates` is `false` for the first two, `true` for the last two. `always_requires_approval` is
`false` for all four — path containment already bounds them to the workspace, and an approval
prompt on every cell read would train the operator to click through.

Constraints on every action:

- `path` and `out_path` must end `.xlsx`/`.xlsm` and `.pdf` respectively. Reject otherwise with
  `E_SCHEMA`.
- `range` must match `^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$`. **No named ranges and no
  formulas** — a range argument that Excel evaluates is an expression evaluator, which is not
  what a bounded action is.
- Reject a range addressing more than `max_cells`, with `E_SCHEMA`. An unbounded `A1:XFD1048576`
  otherwise hangs the host.
- **Never resolve paths yourself.** Policy has already contained them; treat them as given. Do
  not "helpfully" join a relative path against anything.

### Excel process hygiene

Excel COM leaves an invisible `EXCEL.EXE` running if a workbook is not closed and the
application not quit. Requirements:

- open with `Visible = $false`, `DisplayAlerts = $false`, `AskToUpdateLinks = $false`;
- close the workbook with `SaveChanges` set explicitly — never leave it to the default;
- call `Quit()` and release the COM objects in a `finally` block, so it happens on the failure
  path too;
- the generated script must complete even when the workbook is corrupt or locked, returning a
  structured error rather than blocking on a modal dialog. `DisplayAlerts = $false` is what
  prevents the modal; without it a headless run hangs until the timeout.

On timeout, kill the PowerShell process **and** any `EXCEL.EXE` it started. Track the pid the
script reports; do not kill every `EXCEL.EXE` on the machine — the operator may have their own
workbook open, and killing it would lose their unsaved work.

## Acceptance tests

`packages/adapters-app/test/`. Excel is installed on the target machine, so these can be real
integration tests. Guard them: if `options.executable` does not exist, the correct behaviour is
to **fail the run with a clear message**, not to skip (00-CONTRACTS §6).

1. `init refuses when the executable does not exist`
2. `manifest exposes exactly four actions`
3. `inspect_workbook returns sheet names and used ranges`
4. `read_range returns values as a 2-D array`
5. `read_range preserves null for an empty cell`
6. `write_range then read_range round-trips values`
7. `export_pdf produces a file at out_path`
8. `rejects a path that is not .xlsx or .xlsm with E_SCHEMA`
9. `rejects a named range with E_SCHEMA`
10. `rejects a range exceeding max_cells with E_SCHEMA`
11. `a cell value containing PowerShell metacharacters is written literally and read back unchanged`
12. `a path containing a single quote and a backtick is handled literally`
13. `no EXCEL.EXE survives a successful action`
14. `no EXCEL.EXE survives a failed action`
15. `no EXCEL.EXE survives a timeout`
16. `a timeout does not kill an unrelated EXCEL.EXE`

Tests 11 and 12 are the injection tests — write a value like
`"; Remove-Item -Recurse C:\Temp\marker ;#` into a cell, then assert the marker file still
exists and the cell reads back as that exact string.

Tests 13-16 need a before/after pid comparison. For 16, start a separate Excel instance in the
test, run an action that times out, and assert that instance is still alive.

## Verification

```
npx tsc --build packages/adapters-app
node --test packages/adapters-app/dist/test/*.test.js
```

Clean, zero skips. Put fixture workbooks under the OS temp directory and delete them after.

## Out of scope

Any second application. Policy, persistence, receipts, HTTP. Word, Outlook, and the Oruçoğlu
AGT application are explicitly not in Phase 1 — §4.3 says exactly one desktop adapter.

## PowerShell writes a UTF-8 BOM, and `JSON.parse` rejects it

Every JSON file the script produces — the result file, the pid file — comes back with a leading
`U+FEFF` byte-order mark. `Out-File`, `Set-Content`, and `>` all emit one by default on Windows
PowerShell, and `JSON.parse` throws `SyntaxError: Unexpected token '﻿'` on it.

The failure is unhelpfully misleading: the Excel automation has already succeeded, the file
contains exactly the right content, and only the read fails. It looks like a COM problem and is
not one.

So **strip a leading BOM at every read site** — the adapter and the test helpers both:

```ts
function parseScriptJson(text: string): unknown {
  return JSON.parse(text.replace(/^﻿/, ''));
}
```

Route every `JSON.parse` of script output through one helper rather than repeating the strip;
there are several read sites and missing one produces an intermittent failure that looks like a
different bug each time.

Writing the input file from Node is unaffected — `fs.writeFile` emits no BOM, and
`ConvertFrom-Json` reads it fine.
