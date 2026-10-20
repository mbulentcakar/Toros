import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ErrorCode, TorosError } from '@toros/contracts';

import { parseScriptJson } from './json.js';
import type { RawControl, RawWindow, UiaProbe } from './adapter.js';

/**
 * The fixed, parameter-free PowerShell script that drives read-only UIA discovery.
 *
 * Every input is read as *data* from `input.json` in the script's own directory;
 * no value is interpolated into this text. Names/titles are untrusted application
 * content — they travel as JSON values, never as script source. The script reads
 * control METADATA only (type, name, enabled, supported patterns) — never a
 * ValuePattern value.
 *
 * Live-validated on a real Windows 11 desktop 2026-09-16: enumerate returns real
 * process names + foreground; inspect walks the ControlView tree (RuntimeId cycle
 * guard, depth-bounded, document pre-order); the locked/secure desktop is detected
 * via OpenInputDesktop. Electron/Chromium apps that do not build an accessibility
 * tree legitimately return zero controls.
 */
const DESKTOP_UIA_PS1 = `# toros-desktop-uia.ps1 — fixed, parameter-free. Inputs via input.json; nothing is interpolated.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class TorosNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder pv, uint n, out uint need);
  public static string InputDesktopName() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return null;
    try { var sb = new StringBuilder(256); uint need; if (GetUserObjectInformation(d, 2, sb, 256, out need)) return sb.ToString(); return null; }
    finally { CloseDesktop(d); }
  }
}
"@
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$dir = $PSScriptRoot
$req = Get-Content -LiteralPath (Join-Path $dir 'input.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outPath = Join-Path $dir 'output.json'
function Emit($o) { $ser.Serialize($o) | Set-Content -LiteralPath $outPath -Encoding UTF8 }
$root = [System.Windows.Automation.AutomationElement]::RootElement
try {
  # Locked / secure desktop: input desktop inaccessible or not 'Default'.
  $deskName = [TorosNative]::InputDesktopName()
  if ($null -eq $deskName -or $deskName -ne 'Default') { Emit @{ session_state = 'locked' }; return }

  if ([string]$req.action -eq 'enumerate_windows') {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $fg = [TorosNative]::GetForegroundWindow().ToInt64()
    $ws = New-Object 'System.Collections.Generic.List[object]'; $z = 0
    foreach ($el in $els) {
      $hwnd = [int64]$el.Current.NativeWindowHandle
      $rid = ($el.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      $nh = if ($hwnd -ne 0) { [string]$hwnd } else { 'rid:' + $rid }
      $pn = ''; try { $pn = [string](Get-Process -Id $el.Current.ProcessId -ErrorAction Stop).ProcessName } catch { }
      [void]$ws.Add(@{ native_handle=$nh; title=[string]$el.Current.Name; process_name=$pn; z_order=$z; foreground=($hwnd -ne 0 -and $hwnd -eq $fg) })
      $z++
    }
    Emit @{ session_state='active'; windows=$ws.ToArray() }
  }
  elseif ([string]$req.action -eq 'inspect_window') {
    $want = [string]$req.native_handle
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $target = $null
    foreach ($el in $tops) {
      $hwnd = [int64]$el.Current.NativeWindowHandle
      $rid = ($el.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      $nh = if ($hwnd -ne 0) { [string]$hwnd } else { 'rid:' + $rid }
      if ($nh -eq $want) { $target = $el; break }
    }
    if ($null -eq $target) { Emit @{ closed = $true }; return }
    $pn = ''; try { $pn = [string](Get-Process -Id $target.Current.ProcessId -ErrorAction Stop).ProcessName } catch { }
    $depth = [int]$req.depth; $maxc = [int]$req.max_controls
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $controls = New-Object 'System.Collections.Generic.List[object]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $truncated = $false
    $stack = New-Object 'System.Collections.Generic.Stack[object]'
    $stack.Push(@($target, 0))
    while ($stack.Count -gt 0) {
      $p = $stack.Pop(); $el = $p[0]; $d = [int]$p[1]
      $rid = ($el.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      if (-not $seen.Add($rid)) { continue }
      if ($d -ge 1) {
        if ($controls.Count -ge $maxc) { $truncated = $true; break }
        $pats = New-Object 'System.Collections.Generic.List[string]'
        try { foreach ($pt in $el.GetSupportedPatterns()) { [void]$pats.Add([string]$pt.ProgrammaticName) } } catch { }
        [void]$controls.Add(@{ native_id=$rid; control_type=[string]$el.Current.ControlType.ProgrammaticName; name=[string]$el.Current.Name; enabled=[bool]$el.Current.IsEnabled; patterns=$pats.ToArray() })
      }
      if ($d -lt $depth) {
        $kids = New-Object 'System.Collections.Generic.List[object]'
        $c = $null; try { $c = $walker.GetFirstChild($el) } catch { }
        while ($null -ne $c) { [void]$kids.Add($c); try { $c = $walker.GetNextSibling($c) } catch { $c = $null } }
        for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($d + 1))) }
      }
    }
    Emit @{ closed=$false; process_name=$pn; controls=$controls.ToArray(); truncated=$truncated }
  }
  else { Emit @{ closed = $true } }
}
catch { Emit @{ session_state='error'; error=[string]$_.Exception.Message } }
`;

/** Absolute path to Windows PowerShell, built from `SystemRoot`. */
function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'];
  if (systemRoot === undefined || systemRoot.length === 0) return 'powershell.exe';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Captured stdout/stderr ceiling for the PowerShell child (execFile.maxBuffer). */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** output.json ceiling read back from the probe before it is parsed. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The part of `ChildProcess` runPowerShell relies on, so a test seam never needs a real child. */
export interface ProbeChild {
  readonly kill: () => void;
}

/** execFile-like spawn shape, injectable so tests never spawn PowerShell. */
export type ProbeSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly shell: false; readonly windowsHide: boolean; readonly timeout: number; readonly maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ProbeChild;

/** Remove a probe temp dir, logging a failure once with the basename only. */
async function removeProbeDir(dir: string): Promise<void> {
  try {
    await fsPromises.rm(dir, { recursive: true, force: true });
  } catch (removalErr: unknown) {
    // A failed removal is a hygiene problem, not a probe failure: the action's
    // result stands. Log once, naming only the basename and the error CODE —
    // never the raw message or the full path, which can contain a machine root
    // or a local username and must not reach the log.
    const code = (removalErr as { readonly code?: unknown } | null)?.code;
    console.error(`desktop probe cleanup failed: ${path.basename(dir)}${typeof code === 'string' && code.length > 0 ? ` (${code})` : ''}`);
  }
}

/**
 * Run PowerShell with the fixed script and JSON input, returning the parsed output.
 * The temp dir holds the script + input.json PowerShell reads, so it must survive
 * until the child exits — cleanup happens only in `done` (completion / timeout /
 * abort), never in a synchronous finally — and the promise settles only after the
 * removal completes.
 *
 * `spawn` is injectable for tests; the default is the real `execFile`.
 */
export function runPowerShell(
  input: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
  spawn: ProbeSpawn = execFile,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    void (async () => {
      // A signal that is already aborted means the action is over before it
      // began. Refuse before creating the temp directory or spawning anything,
      // so a pre-aborted probe cannot leave a directory behind or hold a
      // process slot (AR-07).
      if (signal.aborted) {
        reject(new Error('desktop probe cancelled'));
        return;
      }
      let dir: string | undefined;
      let scriptPath: string;
      let outPath: string;
      try {
        dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-desktop-'));
        scriptPath = path.join(dir, 'action.ps1');
        outPath = path.join(dir, 'output.json');
        await fsPromises.writeFile(scriptPath, DESKTOP_UIA_PS1, 'utf8');
        await fsPromises.writeFile(path.join(dir, 'input.json'), JSON.stringify(input), 'utf8');
      } catch (setupErr: unknown) {
        if (dir !== undefined) await removeProbeDir(dir);
        reject(setupErr);
        return;
      }

      // The entry check cannot see an abort landing WHILE the setup awaited on
      // the filesystem. Re-check now that setup finished: an already-aborted
      // signal must reject before spawning anything — a probe must not start
      // after Core has already terminated its action. Cleanup is awaited so no
      // temp dir survives this path either.
      if (signal.aborted) {
        await removeProbeDir(dir);
        reject(new Error('desktop probe cancelled'));
        return;
      }

      let settled = false;
      let child: ProbeChild | undefined;
      const cleanup = (): Promise<void> => removeProbeDir(dir);
      const done = async (err: Error | null, value?: Record<string, unknown>): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener?.('abort', onAbort);
        try { child?.kill(); } catch { /* already gone */ }
        // Await the removal: the promise must not settle while the temp dir
        // still exists, and a removal error never changes the action's result.
        await cleanup();
        if (err) reject(err); else resolve(value!);
      };

      const timer = setTimeout(() => { void done(new Error(`desktop probe timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const onAbort = (): void => { void done(new Error('desktop probe cancelled')); };
      signal.addEventListener?.('abort', onAbort, { once: true });

      try {
        child = spawn(
          powershellPath(),
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
          (err, stdout, stderr) => {
            if (settled) return;
            if (err) {
              void done(new Error(`powershell exited with error: ${String(err)} stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`));
              return;
            }
            void (async () => {
              try {
                // Stat before reading: an oversized output is rejected by size,
                // never read into memory (AR-07). The code is E_OUTPUT_LIMIT so
                // the adapter surfaces it as the terminate-outcome code instead
                // of a generic adapter failure.
                const stat = await fsPromises.stat(outPath);
                if (stat.size > MAX_OUTPUT_BYTES) {
                  void done(new TorosError(ErrorCode.E_OUTPUT_LIMIT, `desktop probe output exceeded ${MAX_OUTPUT_BYTES} bytes`));
                  return;
                }
                const text = await fsPromises.readFile(outPath, 'utf8');
                await done(null, parseScriptJson(text) as Record<string, unknown>);
              } catch (readErr: unknown) {
                await done(new Error(`failed to read probe output: ${String(readErr)}`));
              }
            })();
          },
        );
      } catch (spawnErr: unknown) {
        // A SYNCHRONOUS spawn/execFile failure must reject the caller through
        // the same closing path as every other outcome — cleanup awaited, no
        // unhandled rejection — rather than escaping the detached IIFE and
        // becoming an unhandled rejection that can take Core down.
        await done(new Error(`failed to start powershell: ${String(spawnErr)}`));
        return;
      }
    })();
  });
}

/**
 * Creates the real PowerShell-backed UIA probe. Live-validated on Windows 11
 * 2026-09-16; the deferred quality items in the T3 review are addressed here.
 */
export function createPowerShellUiaProbe(options: { timeout_ms: number }): UiaProbe {
  const timeoutMs = options.timeout_ms;

  return {
    async enumerateWindows(sessionScope: string, signal: AbortSignal): Promise<
      | { readonly session_state: 'active'; readonly windows: readonly RawWindow[] }
      | { readonly session_state: 'locked' | 'disconnected' }
    > {
      const output = await runPowerShell({ action: 'enumerate_windows', session_scope: sessionScope }, timeoutMs, signal);

      const sessionState = output['session_state'];
      if (sessionState === 'locked' || sessionState === 'disconnected') {
        return { session_state: sessionState };
      }
      if (sessionState !== 'active') {
        throw new Error(`desktop probe enumerate failed: ${JSON.stringify(output['error'] ?? sessionState)}`);
      }

      const rawWindows = (output['windows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const windows: RawWindow[] = rawWindows.map((w) => ({
        native_handle: typeof w['native_handle'] === 'string' ? w['native_handle'] : String(w['native_handle'] ?? ''),
        title: typeof w['title'] === 'string' ? w['title'] : String(w['title'] ?? ''),
        process_name: typeof w['process_name'] === 'string' ? w['process_name'] : String(w['process_name'] ?? ''),
        z_order: typeof w['z_order'] === 'number' ? w['z_order'] : Number(w['z_order'] ?? 0),
        foreground: w['foreground'] === true,
      }));

      return { session_state: 'active', windows };
    },

    async inspectWindow(nativeHandle: string, opts: { depth: number; max_controls: number }, signal: AbortSignal): Promise<
      | { readonly closed: true }
      | { readonly closed: false; readonly process_name: string; readonly controls: readonly RawControl[]; readonly truncated: boolean }
    > {
      const output = await runPowerShell(
        { action: 'inspect_window', native_handle: nativeHandle, depth: opts.depth, max_controls: opts.max_controls },
        timeoutMs,
        signal,
      );

      // A locked/disconnected desktop mid-inspect, or a script error: the window
      // is not inspectable now — treat as gone rather than an empty success.
      const sessionState = output['session_state'];
      if (sessionState === 'error') {
        throw new Error(`desktop probe inspect failed: ${JSON.stringify(output['error'])}`);
      }
      if (sessionState === 'locked' || sessionState === 'disconnected' || output['closed'] === true) {
        return { closed: true };
      }

      const rawControls = (output['controls'] as Array<Record<string, unknown>> | undefined) ?? [];
      const controls: RawControl[] = rawControls.map((c) => ({
        native_id: typeof c['native_id'] === 'string' ? c['native_id'] : String(c['native_id'] ?? ''),
        control_type: typeof c['control_type'] === 'string' ? c['control_type'] : String(c['control_type'] ?? ''),
        name: typeof c['name'] === 'string' ? c['name'] : String(c['name'] ?? ''),
        enabled: c['enabled'] === true,
        patterns: Array.isArray(c['patterns']) ? (c['patterns'] as readonly string[]) : [],
      }));

      const processName = typeof output['process_name'] === 'string' ? output['process_name'] : String(output['process_name'] ?? '');
      const truncated = output['truncated'] === true;

      return { closed: false, process_name: processName, controls, truncated };
    },
  };
}
