import { execFile, type ChildProcess } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseScriptJson } from './json.js';
import type { UiaProbe } from './adapter.js';

/** Raw data from the OS layer — native handles, real titles. Never leaves the adapter as-is. */
export interface RawWindow {
  readonly native_handle: string;
  readonly title?: string;
  readonly process_name: string;
  readonly z_order: number;
  readonly foreground: boolean;
}

export interface RawControl {
  readonly native_id: string;
  readonly control_type: string;
  readonly automation_id?: string;
  readonly enabled: boolean;
  readonly patterns: readonly string[];
}

/**
 * The fixed, parameter-free PowerShell script that drives read-only UIA discovery.
 *
 * Every input is read as *data* from `input.json` in the script's own directory;
 * no value is interpolated into this text. Titles come from GetWindowText on the
 * native handle (never UIA Name). The script reads control METADATA only
 * (type, automation_id, enabled, supported patterns) — never a ValuePattern value
 * and never UIA Name.
 *
 * Live-validated on a real Windows 11 desktop: enumerate returns real
 * process names + foreground + native window text titles; inspect walks the
 * ControlView tree (RuntimeId cycle guard, depth-bounded, document pre-order);
 * the locked/secure desktop is detected via OpenInputDesktop.
 */
export const DESKTOP_UIA_PS1 = `# toros-desktop-uia.ps1 — fixed, parameter-free. Inputs via input.json; nothing is interpolated.
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  public static string InputDesktopName() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return null;
    try { var sb = new StringBuilder(256); uint need; if (GetUserObjectInformation(d, 2, sb, 256, out need)) return sb.ToString(); return null; }
    finally { CloseDesktop(d); }
  }
  public static string GetWindowText(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return null;
    var sb = new StringBuilder(512);
    int len = GetWindowText(hWnd, sb, 512);
    if (len <= 0) return string.Empty;
    string s = sb.ToString();
    if (s.Length > 256) return s.Substring(0, 256);
    return s;
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
# Test-only binding: createPowerShellUiaProbe's restrict_to_pid option. When
# set, every top-level window walk below skips windows owned by another process
# BEFORE reading their native text or descending into them. Native fixture tests
# use this to bind discovery to the window they themselves created, so the probe
# never inspects the operator's real applications. It is never an action input
# or a configuration field.
#
# The restriction CANNOT fail open: a present restrict_to_pid must parse as a
# positive integer, and any other value (empty, null, boolean, float, negative,
# zero, non-numeric) emits an error and enumerates nothing. It never means "no
# restriction". Only the ABSENCE of the key means unrestricted.
$restrictPid = $null
if ($null -ne $req.PSObject.Properties['restrict_to_pid']) {
  $restrictOk = $false
  $restrictParsed = 0L
  $restrictRaw = $req.restrict_to_pid
  if ($null -ne $restrictRaw) {
    $restrictText = [string]$restrictRaw
    if ($restrictText -match '^\\d+$') {
      $restrictOk = [long]::TryParse($restrictText, [ref]$restrictParsed)
    }
  }
  if (-not $restrictOk -or $restrictParsed -le 0) {
    Emit @{ session_state='error'; error='restrict_to_pid must parse as a positive integer; refusing to enumerate' }
    return
  }
  $restrictPid = $restrictParsed
}
try {
  # Locked / secure desktop: input desktop inaccessible or not 'Default'.
  $deskName = [TorosNative]::InputDesktopName()
  if ($null -eq $deskName -or $deskName -ne 'Default') { Emit @{ session_state = 'locked' }; return }

  if ([string]$req.action -eq 'enumerate_windows') {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $walker = New-Object System.Windows.Automation.TreeWalker($cond)
    $maxw = [int]$req.max_windows
    if ($maxw -le 0) { $maxw = [int]::MaxValue }
    $ws = New-Object 'System.Collections.Generic.List[object]'
    $truncated = $false
    $z = 0
    $fg = [TorosNative]::GetForegroundWindow().ToInt64()
    $c = $null; try { $c = $walker.GetFirstChild($root) } catch { }
    while ($null -ne $c) {
      if ($ws.Count -ge $maxw) { $truncated = $true; break }
      if ($null -ne $restrictPid -and [int64]$c.Current.ProcessId -ne $restrictPid) {
        try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
        continue
      }
      $hwnd = [int64]$c.Current.NativeWindowHandle
      $rid = ($c.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      $nh = if ($hwnd -ne 0) { [string]$hwnd } else { 'rid:' + $rid }
      $pn = ''; try { $pn = [string](Get-Process -Id $c.Current.ProcessId -ErrorAction Stop).ProcessName } catch { }
      $w = @{ native_handle=$nh; process_name=$pn; z_order=$z; foreground=($hwnd -ne 0 -and $hwnd -eq $fg) }
      if ($hwnd -ne 0) {
        $wt = [TorosNative]::GetWindowText([IntPtr]$hwnd)
        if ($null -ne $wt) { $w['title'] = $wt }
      }
      [void]$ws.Add($w)
      $z++
      try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
    }
    Emit @{ session_state='active'; windows=$ws.ToArray(); truncated=$truncated }
  }
  elseif ([string]$req.action -eq 'inspect_window') {
    $want = [string]$req.native_handle
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $walker = New-Object System.Windows.Automation.TreeWalker($cond)
    $target = $null
    $c = $null; try { $c = $walker.GetFirstChild($root) } catch { }
    while ($null -ne $c) {
      if ($null -ne $restrictPid -and [int64]$c.Current.ProcessId -ne $restrictPid) {
        try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
        continue
      }
      $hwnd = [int64]$c.Current.NativeWindowHandle
      $rid = ($c.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      $nh = if ($hwnd -ne 0) { [string]$hwnd } else { 'rid:' + $rid }
      if ($nh -eq $want) { $target = $c; break }
      try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
    }
    if ($null -eq $target) { Emit @{ closed = $true }; return }
    $pn = ''; try { $pn = [string](Get-Process -Id $target.Current.ProcessId -ErrorAction Stop).ProcessName } catch { }
    $depth = [int]$req.depth; $maxc = [int]$req.max_controls
    if ($maxc -le 0) { $maxc = [int]::MaxValue }
    $cwalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $controls = New-Object 'System.Collections.Generic.List[object]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $truncated = $false
    $stack = New-Object 'System.Collections.Generic.Stack[object]'
    $curr = $null; try { $curr = $cwalker.GetFirstChild($target) } catch { }
    $d = 1
    while ($null -ne $curr) {
      if ($controls.Count -ge $maxc) { $truncated = $true; break }
      $rid = ($curr.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      if ($seen.Add($rid)) {
        $pats = New-Object 'System.Collections.Generic.List[string]'
        try { foreach ($pt in $curr.GetSupportedPatterns()) { [void]$pats.Add([string]$pt.ProgrammaticName) } } catch { }
        $aid = ''; try { $aid = [string]$curr.Current.AutomationId } catch { }
        $ctrl = @{ native_id=$rid; control_type=[string]$curr.Current.ControlType.ProgrammaticName; enabled=[bool]$curr.Current.IsEnabled; patterns=$pats.ToArray() }
        if (-not [string]::IsNullOrEmpty($aid)) { $ctrl['automation_id'] = $aid }
        [void]$controls.Add($ctrl)

        $child = $null
        if ($d -lt $depth) {
          try { $child = $cwalker.GetFirstChild($curr) } catch { }
        }
        if ($null -ne $child) {
          $stack.Push($curr)
          $curr = $child
          $d++
          continue
        }
      }
      $next = $null
      try { $next = $cwalker.GetNextSibling($curr) } catch { }
      while ($null -eq $next -and $stack.Count -gt 0) {
        $curr = $stack.Pop()
        $d--
        try { $next = $cwalker.GetNextSibling($curr) } catch { }
      }
      $curr = $next
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

/**
 * Run PowerShell with the fixed script and JSON input, returning the parsed output.
 * The temp dir holds the script + input.json PowerShell reads, so it must survive
 * until the child exits — cleanup happens only in `done` (completion / timeout /
 * abort), never in a synchronous finally.
 */
function runPowerShell(input: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let dir: string;
      let scriptPath: string;
      let outPath: string;
      try {
        dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-desktop-'));
        scriptPath = path.join(dir, 'action.ps1');
        outPath = path.join(dir, 'output.json');
        await fsPromises.writeFile(scriptPath, DESKTOP_UIA_PS1, 'utf8');
        await fsPromises.writeFile(path.join(dir, 'input.json'), JSON.stringify(input), 'utf8');
      } catch (setupErr: unknown) {
        reject(setupErr);
        return;
      }

      let settled = false;
      let child: ChildProcess | undefined;
      const cleanup = (): void => { fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {}); };
      const done = (err: Error | null, value?: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener?.('abort', onAbort);
        try { child?.kill(); } catch { /* already gone */ }
        cleanup();
        if (err) reject(err); else resolve(value!);
      };

      const timer = setTimeout(() => done(new Error(`desktop probe timed out after ${timeoutMs}ms`)), timeoutMs);
      const onAbort = (): void => done(new Error('desktop probe cancelled'));
      signal.addEventListener?.('abort', onAbort, { once: true });

      child = execFile(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (settled) return;
          if (err) {
            done(new Error(`powershell exited with error: ${String(err)} stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`));
            return;
          }
          fsPromises.readFile(outPath, 'utf8')
            .then((text) => { done(null, parseScriptJson(text) as Record<string, unknown>); })
            .catch((readErr: unknown) => { done(new Error(`failed to read probe output: ${String(readErr)}`)); });
        },
      );
    })();
  });
}

/**
 * Creates the real PowerShell-backed UIA probe. Live-validated on Windows 11
 * 2026-09-16; the deferred quality items in the T3 review are addressed here.
 *
 * `restrict_to_pid` is TEST-ONLY. When set, the script skips every top-level
 * window owned by another process before reading its native text or descending
 * into it (see the `restrictPid` block in DESKTOP_UIA_PS1). Native fixture
 * tests bind discovery to the window they themselves created with it, so the
 * probe never reads the operator's real applications. It is reachable only
 * through this factory option — never through an action input or a
 * configuration field.
 *
 * The restriction cannot fail open: a present `restrict_to_pid` that is not a
 * positive safe integer throws here, BEFORE PowerShell starts, so no malformed
 * value can be serialized into `input.json` and silently disable the guard in
 * the script. Absent or `null` means "no restriction" (the normal production
 * path).
 */
export function createPowerShellUiaProbe(options: {
  timeout_ms: number;
  restrict_to_pid?: number | null;
}): UiaProbe {
  const timeoutMs = options.timeout_ms;
  const restrictPid = options.restrict_to_pid ?? null;

  // Fail closed at the factory boundary: absent/null is "no restriction", but
  // any other present value must be a positive safe integer. NaN, Infinity,
  // floats, strings, booleans, zero and negatives are all rejected here.
  if (restrictPid !== null && (!Number.isSafeInteger(restrictPid) || restrictPid <= 0)) {
    throw new Error(
      `restrict_to_pid must be a positive safe integer when provided, got ${String(restrictPid)}`,
    );
  }

  return {
    async enumerateWindows(
      sessionScope: string,
      optsOrSignal?: { max_windows?: number } | AbortSignal,
      maybeSignal?: AbortSignal,
    ): Promise<
      | { readonly session_state: 'active'; readonly windows: readonly RawWindow[]; readonly truncated: boolean }
      | { readonly session_state: 'locked' | 'disconnected' }
    > {
      let maxWindows = 200;
      let signal: AbortSignal;
      if (optsOrSignal instanceof AbortSignal) {
        signal = optsOrSignal;
      } else {
        if (optsOrSignal && typeof optsOrSignal.max_windows === 'number') {
          maxWindows = optsOrSignal.max_windows;
        }
        signal = maybeSignal!;
      }

      const output = await runPowerShell(
        {
          action: 'enumerate_windows',
          session_scope: sessionScope,
          max_windows: maxWindows,
          ...(restrictPid !== null ? { restrict_to_pid: restrictPid } : {}),
        },
        timeoutMs,
        signal,
      );

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
        ...(typeof w['title'] === 'string' ? { title: w['title'].slice(0, 256) } : {}),
        process_name: typeof w['process_name'] === 'string' ? w['process_name'] : String(w['process_name'] ?? ''),
        z_order: typeof w['z_order'] === 'number' ? w['z_order'] : Number(w['z_order'] ?? 0),
        foreground: w['foreground'] === true,
      }));
      const truncated = output['truncated'] === true;

      return { session_state: 'active', windows, truncated };
    },

    async inspectWindow(nativeHandle: string, opts: { depth: number; max_controls: number }, signal: AbortSignal): Promise<
      | { readonly closed: true }
      | { readonly closed: false; readonly process_name: string; readonly controls: readonly RawControl[]; readonly truncated: boolean }
    > {
      const output = await runPowerShell(
        {
          action: 'inspect_window',
          native_handle: nativeHandle,
          depth: opts.depth,
          max_controls: opts.max_controls,
          ...(restrictPid !== null ? { restrict_to_pid: restrictPid } : {}),
        },
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
        ...(typeof c['automation_id'] === 'string' && c['automation_id'].length > 0
          ? { automation_id: c['automation_id'] }
          : {}),
        enabled: c['enabled'] === true,
        patterns: Array.isArray(c['patterns']) ? (c['patterns'] as readonly string[]) : [],
      }));

      const processName = typeof output['process_name'] === 'string' ? output['process_name'] : String(output['process_name'] ?? '');
      const truncated = output['truncated'] === true;

      return { closed: false, process_name: processName, controls, truncated };
    },
  };
}
