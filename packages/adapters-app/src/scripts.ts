/**
 * The fixed, parameter-free PowerShell script that drives Excel COM automation.
 *
 * This is the single most safety-critical piece of the adapter. SPEC F §"Script
 * generation is the risk here": the script text contains a file path and, for
 * `write_range`, cell values — all ultimately model-supplied. A value such as
 * `"; Remove-Item -Recurse C:\ ;#` would *execute* if it were interpolated into
 * PowerShell source text.
 *
 * The contract this constant upholds: no value is ever interpolated into this
 * text. Every input is read as *data* from `input.json` in the script's own
 * directory (`$PSScriptRoot`), and every result is written as data to
 * `output.json`. The action id itself is data, not source. Nothing here is
 * built with string concatenation from an argument.
 *
 * Two PowerShell 5.1 pitfalls are deliberately avoided:
 *
 *   1. `ConvertTo-Json` unwraps single-element arrays in property values, so a
 *      1×1 `read_range` result would collapse to a scalar. Output is therefore
 *      serialized with `JavaScriptSerializer` (System.Web.Extensions), which
 *      preserves array nesting and escapes strings correctly.
 *
 *   2. `ConvertFrom-Json` may unwrap a single-element input array to a scalar.
 *      `write_range` therefore receives a *flat* `cells` array plus `rows` and
 *      `cols`, and rebuilds it with `@($req.cells)` — the `@()` operator wraps
 *      a scalar back into a one-element array, so the loop is correct whether
 *      or not the parser unwrapped. The public `values` schema stays 2-D; the
 *      flat form is an internal contract between the adapter and this script.
 *
 * Process hygiene (SPEC F §"Excel process hygiene"):
 *   - open with Visible=$false, DisplayAlerts=$false, AskToUpdateLinks=$false
 *     (DisplayAlerts is what keeps a headless run off a modal dialog);
 *   - close the workbook with SaveChanges set explicitly in a finally block;
 *   - Quit() and release the COM object in an outer finally so the failure
 *     path is covered too;
 *   - report the Excel pid we started (via a before/after snapshot of
 *     EXCEL.EXE pids, so we never misattribute a pre-existing instance) so the
 *     Node side can kill *that* pid on a timeout — never every EXCEL.EXE.
 *
 * The script is invoked with `powershell.exe -NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -File <script>` and `shell:false`, so not even the
 * process launch lets a value reach a shell.
 */
export const EXCEL_ACTION_PS1 = `# toros-excel-action.ps1 — fixed, parameter-free. Generated verbatim from @toros/adapters-app.
# Every input is read from input.json in this script's directory; nothing is interpolated.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = 67108864

$dir = $PSScriptRoot
$inPath  = Join-Path $dir 'input.json'
$outPath = Join-Path $dir 'output.json'
$pidPath = Join-Path $dir 'pid.json'

function Write-Out {
    param($obj)
    $ser.Serialize($obj) | Set-Content -LiteralPath $outPath -Encoding UTF8
}

function Snapshot-ExcelPids {
    try { @(Get-CimInstance Win32_Process -Filter "Name='EXCEL.EXE'" | ForEach-Object { [int]$_.ProcessId }) }
    catch { @() }
}

function Find-NewExcelPid($before) {
    foreach ($p in (Snapshot-ExcelPids)) {
        if ($before -notcontains $p) { return [int]$p }
    }
    return $null
}

$excel = $null
$workbook = $null
$action = ''

try {
    $req = Get-Content -LiteralPath $inPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $action = [string]$req.action

    $before = Snapshot-ExcelPids
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $ser.Serialize(@{ excel_pid = (Find-NewExcelPid $before) }) | Set-Content -LiteralPath $pidPath -Encoding UTF8

    try {
        $readOnly = -not ($action -eq 'write_range')
        $workbook = $excel.Workbooks.Open([string]$req.path, [Type]::Missing, $readOnly)

        switch ($action) {
            'inspect_workbook' {
                $sheets = New-Object 'System.Collections.Generic.List[object]'
                foreach ($ws in $workbook.Worksheets) {
                    $used = $ws.UsedRange
                    [void]$sheets.Add(@{
                        name       = [string]$ws.Name
                        # AddressLocal is a PARAMETERISED property in the Excel COM
                        # model, so PowerShell will not coerce it to a value —
                        # [string]$used.AddressLocal yields the method signature
                        # text, not "$A$1:$C$3". The empty parentheses invoke it.
                        used_range = [string]$used.AddressLocal()
                        rows       = [int]$used.Rows.Count
                        cols       = [int]$used.Columns.Count
                    })
                }
                Write-Out @{ ok = $true; sheets = $sheets.ToArray() }
            }
            'read_range' {
                $ws = $workbook.Worksheets.Item([string]$req.sheet)
                $rng = $ws.Range([string]$req.range)
                $rows = [int]$rng.Rows.Count
                $cols = [int]$rng.Columns.Count
                $grid = New-Object 'System.Collections.Generic.List[object]'
                for ($r = 1; $r -le $rows; $r++) {
                    $rowArr = New-Object 'System.Collections.Generic.List[object]'
                    for ($c = 1; $c -le $cols; $c++) {
                        $v = $rng.Cells.Item($r, $c).Value2
                        if ($null -eq $v) { [void]$rowArr.Add($null) }
                        elseif ($v -is [bool]) { [void]$rowArr.Add([bool]$v) }
                        else { [void]$rowArr.Add($v) }
                    }
                    [void]$grid.Add($rowArr.ToArray())
                }
                Write-Out @{ ok = $true; values = $grid.ToArray() }
            }
            'write_range' {
                $ws = $workbook.Worksheets.Item([string]$req.sheet)
                $anchor = ([string]$req.range).Split(':')[0]
                $start = $ws.Range($anchor)
                $cells = @($req.cells)
                $nRows = [int]$req.rows
                $nCols = [int]$req.cols
                for ($i = 0; $i -lt $cells.Count; $i++) {
                    $r = [int]([math]::Floor($i / $nCols))
                    $c = $i % $nCols
                    $v = $cells[$i]
                    $cell = $start.Offset($r, $c)
                    # ConvertFrom-Json gives JSON numbers as System.Decimal, and
                    # Excel's Value2 setter cannot take one — assigning it raises
                    # "Unable to cast object of type 'System.Decimal'". Narrow to
                    # the four JSON scalar shapes explicitly rather than letting
                    # PowerShell guess.
                    if ($null -eq $v) { $cell.Value2 = $null }
                    elseif ($v -is [bool]) { $cell.Value2 = [bool]$v }
                    elseif ($v -is [decimal] -or $v -is [double] -or $v -is [int] -or $v -is [long]) { $cell.Value2 = [double]$v }
                    else { $cell.Value2 = [string]$v }
                }
                Write-Out @{ ok = $true; written = [int]$cells.Count }
            }
            'export_pdf' {
                $hasSheet = ($req.PSObject.Properties.Name -contains 'sheet')
                if ($hasSheet -and [string]$req.sheet -ne '') {
                    $ws = $workbook.Worksheets.Item([string]$req.sheet)
                    $ws.ExportAsFixedFormat(0, [string]$req.out_path)
                } else {
                    $workbook.ExportAsFixedFormat(0, [string]$req.out_path)
                }
                Write-Out @{ ok = $true; out_path = [string]$req.out_path }
            }
            default {
                Write-Out @{ ok = $false; error = "unknown action: $action" }
            }
        }
    }
    finally {
        if ($null -ne $workbook) {
            try {
                if ($action -eq 'write_range') { $workbook.Close($true) }
                else { $workbook.Close($false) }
            } catch {}
        }
    }
}
catch {
    Write-Out @{ ok = $false; error = [string]$_.Exception.Message }
}
finally {
    if ($null -ne $excel) {
        try { $excel.Quit() } catch {}
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
    }
}
`;
