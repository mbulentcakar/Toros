import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fsPromises, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';

import { parseScriptJson } from '../src/json.js';

/**
 * Test-only helpers for the Excel adapter acceptance tests. These mirror the
 * adapter's own process hygiene (a before/after snapshot of EXCEL.EXE pids so
 * we never attribute a pre-existing instance to ourselves) but live in the
 * test package so the adapter's public surface stays exactly what SPEC F pins.
 */

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Fixed, parameter-free script that creates a fixture workbook at
 *  `input.json`'s `out_path`. The path is *data* (read from JSON), so a path
 *  containing a single quote or backtick is handled literally — the property
 *  test 12 exercises. */
export const FIXTURE_CREATE_PS1 = `# fixture-create.ps1 — fixed, parameter-free.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$dir = $PSScriptRoot
$inPath  = Join-Path $dir 'input.json'
$outPath = Join-Path $dir 'output.json'
$excel = $null
$workbook = $null
try {
    $req = Get-Content -LiteralPath $inPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $workbook = $excel.Workbooks.Add()
    $s1 = $workbook.Worksheets.Item(1)
    $s1.Name = 'Sheet1'
    $s1.Range('A1').Value2 = 'hello'
    $s1.Range('A2').Value2 = 42
    $s1.Range('B1').Value2 = $true
    $s2 = $workbook.Worksheets.Add([Type]::Missing, $s1)
    $s2.Name = 'Sheet2'
    $s2.Range('A1').Value2 = 'second'
    $s2.Range('A2').Value2 = 7
    $workbook.SaveAs([string]$req.out_path, 51)
    @{ ok = $true } | ConvertTo-Json -Compress | Set-Content -LiteralPath $outPath -Encoding UTF8
}
catch {
    @{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $outPath -Encoding UTF8
}
finally {
    if ($null -ne $workbook) { try { $workbook.Close($true) } catch {} }
    if ($null -ne $excel) {
        try { $excel.Quit() } catch {}
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
    }
}
`;

/** Fixed script that starts an *unrelated* Excel instance (one the test owns,
 *  not the adapter) and keeps it alive by sleeping. It reports that Excel's
 *  pid via pid.json. Test 16 uses it to prove a timeout does not kill an
 *  instance the adapter did not start. */
export const UNRELATED_EXCEL_PS1 = `# unrelated-excel.ps1 — fixed, parameter-free. Keeps an Excel alive.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$pidPath = Join-Path $dir 'pid.json'
$before = @(Get-CimInstance Win32_Process -Filter "Name='EXCEL.EXE'" | ForEach-Object { [int]$_.ProcessId })
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
# NOTE: $pid is a READ-ONLY automatic variable in PowerShell (the current
# process id). Assigning to it under ErrorActionPreference=Stop aborts the
# script before it ever writes pid.json, which is why this helper timed out.
$excelPid = $null
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='EXCEL.EXE'" | ForEach-Object { [int]$_.ProcessId })) {
    if ($before -notcontains $p) { $excelPid = $p; break }
}
@{ excel_pid = $excelPid } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidPath -Encoding UTF8
Start-Sleep -Seconds 300
`;

export const DEFAULT_EXCEL_EXE =
  process.env.TOROS_EXCEL_EXE ?? 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';

export interface ExcelRealTestPreflight {
  readonly run: boolean;
  readonly skip: false | string;
}

function excelRealTestPreflight(): ExcelRealTestPreflight {
  if (process.env.TOROS_REAL_TESTS === '1') {
    return { run: true, skip: false };
  }

  const missing: string[] = [];
  if (process.platform !== 'win32') missing.push('win32 host');
  if (!existsSync(DEFAULT_EXCEL_EXE)) missing.push('Excel binary');
  if (!existsSync(POWERSHELL_EXE)) missing.push('Windows PowerShell');

  if (missing.length === 0) {
    return { run: true, skip: false };
  }

  return {
    run: false,
    skip: `REAL EXCEL SKIPPED: missing ${missing.join(', ')}; set TOROS_REAL_TESTS=1 to force execution.`,
  };
}

/** Evaluated synchronously during test discovery, before Excel can launch. */
export const EXCEL_REAL_TEST_PREFLIGHT = excelRealTestPreflight();

export interface Options {
  readonly executable: string;
  readonly timeout_ms: number;
  readonly max_cells: number;
}

export function defaultOptions(overrides: Partial<Options> = {}): Options {
  return {
    executable: DEFAULT_EXCEL_EXE,
    timeout_ms: 60_000,
    max_cells: 10_000,
    ...overrides,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Once a real Excel test is selected to run, missing prerequisites remain a
 * fail-loud error. AJ's discovery-time preflight skips only when execution was
 * not forced and a prerequisite is absent.
 */
export function ensureExcel(): void {
  if (process.platform !== 'win32') {
    assert.fail(
      `Excel integration test requires win32 with EXCEL.EXE installed; this host is ${process.platform}. ` +
        'SPEC F mandates failing rather than skipping when Excel is unavailable.',
    );
  }
  if (!existsSync(DEFAULT_EXCEL_EXE)) {
    assert.fail(`Excel executable not found at ${DEFAULT_EXCEL_EXE}; set TOROS_EXCEL_EXE if it lives elsewhere.`);
  }
  if (!existsSync(POWERSHELL_EXE)) {
    assert.fail(`powershell.exe not found at ${POWERSHELL_EXE}; cannot drive Excel COM automation.`);
  }
}

/** Lists EXCEL.EXE pids via tasklist (mirrors the adapter's own helper). */
export function listExcelPids(): Promise<Set<number>> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq EXCEL.EXE', '/FO', 'CSV', '/NH'],
      { shell: false, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(new Set<number>());
          return;
        }
        const pids = new Set<number>();
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.split(',');
          const nameField = parts[0];
          const pidField = parts[1];
          if (nameField === undefined || pidField === undefined) continue;
          if (nameField.replaceAll('"', '').toUpperCase() !== 'EXCEL.EXE') continue;
          const pid = Number.parseInt(pidField.replaceAll('"', ''), 10);
          if (Number.isFinite(pid)) pids.add(pid);
        }
        resolve(pids);
      },
    );
  });
}

export function killPidForce(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', '/PID', String(pid)], { shell: false, windowsHide: true }, () => resolve());
  });
}

/** Runs a fixed .ps1 with the standard invocation and resolves on close. */
function runPs(scriptPath: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { shell: false, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* too late */ }
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (c) => { clearTimeout(timer); resolve({ code: c ?? -1, stdout, stderr }); });
  });
}

/** Creates the shared fixture workbook (Sheet1/Sheet2 with known content). */
export async function createFixtureWorkbook(targetPath: string): Promise<void> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-fixture-script-'));
  try {
    const scriptPath = path.join(dir, 'fixture.ps1');
    const inPath = path.join(dir, 'input.json');
    const outPath = path.join(dir, 'output.json');
    await fsPromises.writeFile(scriptPath, FIXTURE_CREATE_PS1, 'utf8');
    await fsPromises.writeFile(inPath, JSON.stringify({ out_path: targetPath }), 'utf8');
    // Four minutes, not one.
    //
    // This is the FIXTURE, not the behaviour under test: it launches Excel over
    // COM to write a workbook the real tests then read. A cold Excel start on a
    // loaded machine has already blown a 60 s cap once — a full-suite run failed
    // at 60,103 ms while the same package measured 77 s / 141 s / 94 s across
    // other runs — and that failure reads as "the Excel adapter is broken" when
    // it means "the box was busy".
    //
    // The adapter's own `timeout_ms` stays at 60 s, because THAT one is a
    // tested control: test 16 asserts a timed-out action does not kill the
    // session. Raising the fixture's ceiling costs nothing when Excel is quick
    // and removes a false failure when it is not.
    const { code, stderr } = await runPs(scriptPath, 240_000);
    if (code !== 0) throw new Error(`fixture powershell exited ${code}: ${stderr}`);
    const outTxt = await fsPromises.readFile(outPath, 'utf8');
    const out = parseScriptJson(outTxt) as { ok?: unknown; error?: unknown };
    if (out.ok !== true) {
      throw new Error(`fixture creation failed: ${typeof out.error === 'string' ? out.error : 'unknown'}`);
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Creates a fixture workbook in a fresh temp dir, runs `fn`, cleans up. */
export async function withFixture<T>(fn: (fixturePath: string) => Promise<T>): Promise<T> {
  ensureExcel();
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-fixture-'));
  const fixturePath = path.join(dir, 'fixture.xlsx');
  try {
    await createFixtureWorkbook(fixturePath);
    return await fn(fixturePath);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForPidFile(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = await fsPromises.readFile(pidPath, 'utf8');
      const obj = parseScriptJson(txt) as { excel_pid?: unknown };
      if (typeof obj.excel_pid === 'number' && obj.excel_pid > 0) return obj.excel_pid;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error('unrelated Excel pid file was not written in time');
}

export interface UnrelatedExcel {
  readonly excelPid: number;
  readonly cleanup: () => Promise<void>;
}

/** Starts an unrelated Excel instance and keeps it alive until cleanup. */
export async function startUnrelatedExcel(): Promise<UnrelatedExcel> {
  ensureExcel();
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-unrelated-'));
  const scriptPath = path.join(dir, 'unrelated.ps1');
  const pidPath = path.join(dir, 'pid.json');
  await fsPromises.writeFile(scriptPath, UNRELATED_EXCEL_PS1, 'utf8');
  const child: ChildProcess = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { shell: false, windowsHide: true, detached: false },
  );
  const childClosed = new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
  let excelPid: number;
  try {
    excelPid = await waitForPidFile(pidPath, 20_000);
  } catch (e) {
    try { child.kill(); } catch { /* noop */ }
    await childClosed;
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const cleanup = async (): Promise<void> => {
    try { child.kill(); } catch { /* already gone */ }
    await Promise.all([
      childClosed,
      killPidForce(excelPid).catch(() => {}),
    ]);
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return { excelPid, cleanup };
}
