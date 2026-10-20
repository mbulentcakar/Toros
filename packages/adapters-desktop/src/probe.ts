import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ErrorCode, TorosError } from '@toros/contracts';

import { parseScriptJson } from './json.js';
import type { UiaProbe } from './adapter.js';
import type { AppIdentity } from '@toros/contracts';

/**
 * Raw data from the OS layer — native handles, real titles, and the OS-observed
 * identity of the owning process. Never leaves the adapter as-is: the identity
 * becomes a two-phase resolve target and the title is redacted by scope.
 */
export interface RawWindow {
  readonly native_handle: string;
  readonly title?: string;
  /** OS-observed identity of the owning process (amendment A8). */
  readonly identity: AppIdentity;
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
 * The fixed, parameter-free PowerShell script that drives read-only UIA discovery
 * and OS identity. Every input is read as *data* from `input.json` in the script's
 * own directory; no value is interpolated into this text. Titles come from
 * GetWindowText on the native handle (never UIA Name). The script reads control
 * METADATA only (type, automation_id, enabled, supported patterns) — never a
 * ValuePattern value and never UIA Name.
 *
 * F3b adds the OS-observed process identity the two-phase resolve (amendment A8)
 * needs: pid from GetWindowThreadProcessId (native, not UIA), creation time,
 * the canonical long image path from QueryFullProcessImageName, the SHA-256 of
 * that file, the Authenticode signature + subject CN, the version-resource
 * ProductName, and the session id from ProcessIdToSessionId. Any read failure
 * drops the window with a counted `identity_unavailable` — it never falls back
 * to a basename. Each (image path, file size, last-write time) is hashed once per
 * run.
 */
export const DESKTOP_UIA_PS1 = `# toros-desktop-uia.ps1 — fixed, parameter-free. Inputs via input.json; nothing is interpolated.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Security.Cryptography; using System.IO; using System.Diagnostics;
public class TorosNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder pv, uint n, out uint need);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformation(IntPtr hServer, uint sessionId, int wtsInfoClass, out IntPtr ppBuffer, out uint pBytesReturned);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr pMemory);
  public static string InputDesktopName() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return null;
    try { var sb = new StringBuilder(256); uint need; if (GetUserObjectInformation(d, 2, sb, 256, out need)) return sb.ToString(); return null; }
    finally { CloseDesktop(d); }
  }
  public static string WindowText(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return null;
    var sb = new StringBuilder(512);
    int len = GetWindowText(hWnd, sb, 512);
    if (len <= 0) return string.Empty;
    string s = sb.ToString();
    if (s.Length > 256) return s.Substring(0, 256);
    return s;
  }
  public static int WindowPid(IntPtr hWnd) {
    uint pid; GetWindowThreadProcessId(hWnd, out pid);
    return (int)pid;
  }
  public static string FullImagePath(int pid) {
    if (pid <= 0) return null;
    IntPtr h = OpenProcess(0x1000, false, (uint)pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return null;
    try {
      var sb = new StringBuilder(1024); uint size = (uint)sb.Capacity;
      if (!QueryFullProcessImageName(h, 0, sb, ref size)) return null;
      return sb.ToString();
    } finally { CloseHandle(h); }
  }
  public static int SessionId(int pid) {
    if (pid <= 0) return -1;
    uint sid; if (!ProcessIdToSessionId((uint)pid, out sid)) return -1;
    return (int)sid;
  }
  public static int ActiveConsoleSession() {
    return (int)WTSGetActiveConsoleSessionId();
  }
  public static string SessionConnectState() {
    uint sid = WTSGetActiveConsoleSessionId();
    if (sid == 0xFFFFFFFF) { sid = SessionId((int)Process.GetCurrentProcess().Id); }
    IntPtr buf; uint bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sid, 8, out buf, out bytes)) return "unknown";
    int state = Marshal.ReadInt32(buf);
    WTSFreeMemory(buf);
    switch (state) { case 0: return "active"; case 2: return "connected"; case 5: return "disconnected"; default: return "other"; }
  }
  public static string FileSha256(string path) {
    using (var sha = SHA256.Create())
    using (var fs = File.OpenRead(path)) { return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant(); }
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
  # Session proof (AR-04): the input desktop must be openable and named 'Default'.
  # Node Core's own session must be the active console session or an RDP session
  # whose connect state is WTSActive; otherwise discovery is unavailable.
  $deskName = [TorosNative]::InputDesktopName()
  if ($null -eq $deskName -or $deskName -ne 'Default') { Emit @{ session_state = 'locked' }; return }
  $connectState = [TorosNative]::SessionConnectState()
  if ($connectState -ne 'active' -and $connectState -ne 'connected') { Emit @{ session_state = 'disconnected' }; return }

  # Hashing cache: keyed by (path, size, last-write) so each file is hashed once
  # per run even when several windows share one image.
  $hashCache = @{}

  # Reads the identity of one window's owning process, returning $null on any
  # failure (access denied, process gone, hashing failed). Never falls back to a
  # basename. Emits all fields exactly as the Core validator requires them.
  function ReadIdentity($pid) {
    if ($pid -le 0) { return $null }
    $imagePath = [TorosNative]::FullImagePath($pid)
    if ($null -eq $imagePath -or $imagePath.Length -eq 0) { return $null }
    # Canonical long path: an absolute drive path with backslashes only, no
    # namespace prefix (\\?\ or \\.\), no UNC root, no forward slashes. Refuse
    # anything else rather than normalise a short name.
    if ($imagePath.StartsWith('\\\\?\\') -or $imagePath.StartsWith('\\\\.\\') -or $imagePath.StartsWith('\\\\')) { return $null }
    if ($imagePath -notmatch '^[A-Za-z]:[^/]*$') { return $null }
    $fi = $null; try { $fi = Get-Item -LiteralPath $imagePath -ErrorAction Stop } catch { return $null }
    $cacheKey = $imagePath + '|' + $fi.Length + '|' + $fi.LastWriteTimeUtc.Ticks
    $sha = $null
    if ($hashCache.ContainsKey($cacheKey)) { $sha = $hashCache[$cacheKey] }
    else { try { $sha = [TorosNative]::FileSha256($imagePath) } catch { return $null }; $hashCache[$cacheKey] = $sha }
    $sig = $null; try { $sig = Get-AuthenticodeSignature -FilePath $imagePath } catch { $sig = $null }
    $sigStatus = 'unsigned'; $signer = $null
    if ($null -ne $sig) {
      $status = [string]$sig.Status
      if ($status -eq 'Valid') {
        if ($null -ne $sig.SignerCertificate) {
          $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
          if (-not [string]::IsNullOrWhiteSpace([string]$cn)) { $sigStatus = 'valid'; $signer = [string]$cn }
        }
        if ($sigStatus -ne 'valid') {
          # A valid signature whose subject CN could not be read must not become
          # an unsigned identity: drop the window rather than misreport the signer.
          return $null
        }
      } elseif ($status -eq 'HashMismatch') {
        $sigStatus = 'invalid'
      } else {
        $sigStatus = 'unsigned'
      }
    }
    $product = $null; try { $product = [string]$fi.VersionInfo.ProductName } catch { }
    if ([string]::IsNullOrWhiteSpace($product)) { $product = $null }
    $proc = $null; try { $proc = Get-Process -Id $pid -ErrorAction Stop } catch { return $null }
    $createdAt = $proc.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $sessId = [TorosNative]::SessionId($pid)
    if ($sessId -lt 0) { return $null }
    return @{ pid=$pid; created_at=$createdAt; image_path=$imagePath; image_sha256=[string]$sha.ToLowerInvariant(); signature=$sigStatus; signer=$signer; product_name=$product; session_id=$sessId }
  }

  if ([string]$req.action -eq 'enumerate_windows') {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $walker = New-Object System.Windows.Automation.TreeWalker($cond)
    $maxw = [int]$req.max_windows
    if ($maxw -le 0) { $maxw = [int]::MaxValue }
    $ws = New-Object 'System.Collections.Generic.List[object]'
    $truncated = $false
    $z = 0
    $unavailable = 0
    $fg = [TorosNative]::GetForegroundWindow().ToInt64()
    $c = $null; try { $c = $walker.GetFirstChild($root) } catch { }
    while ($null -ne $c) {
      if ($ws.Count -ge $maxw) { $truncated = $true; break }
      $cPid = 0; try { $cPid = [int]$c.Current.ProcessId } catch { }
      if ($null -ne $restrictPid -and [int64]$cPid -ne $restrictPid) {
        try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
        continue
      }
      $hwnd = [int64]$c.Current.NativeWindowHandle
      $rid = ($c.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ','
      $nh = if ($hwnd -ne 0) { [string]$hwnd } else { 'rid:' + $rid }
      # pid comes from GetWindowThreadProcessId on the NATIVE handle, not the UIA
      # provider, so it cannot be spoofed by the UIA element tree.
      $pid = 0
      if ($hwnd -ne 0) { $pid = [TorosNative]::WindowPid([IntPtr]$hwnd) }
      $identity = ReadIdentity($pid)
      if ($null -eq $identity) { $unavailable++ }
      $w = @{ native_handle=$nh; z_order=$z; foreground=($hwnd -ne 0 -and $hwnd -eq $fg) }
      if ($null -ne $identity) { $w['identity'] = $identity }
      if ($hwnd -ne 0) {
        $wt = [TorosNative]::WindowText([IntPtr]$hwnd)
        if ($null -ne $wt) { $w['title'] = $wt }
      }
      [void]$ws.Add($w)
      $z++
      try { $c = $walker.GetNextSibling($c) } catch { $c = $null }
    }
    Emit @{ session_state='active'; windows=$ws.ToArray(); truncated=$truncated; identity_unavailable=$unavailable }
  }
  elseif ([string]$req.action -eq 'inspect_window') {
    $want = [string]$req.native_handle
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $walker = New-Object System.Windows.Automation.TreeWalker($cond)
    $target = $null
    $c = $null; try { $c = $walker.GetFirstChild($root) } catch { }
    while ($null -ne $c) {
      $cPid = 0; try { $cPid = [int]$c.Current.ProcessId } catch { }
      if ($null -ne $restrictPid -and [int64]$cPid -ne $restrictPid) {
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
    $pid = 0
    $hwndT = [int64]$target.Current.NativeWindowHandle
    if ($hwndT -ne 0) { $pid = [TorosNative]::WindowPid([IntPtr]$hwndT) }
    $identity = ReadIdentity($pid)
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
    $out = @{ closed=$false; controls=$controls.ToArray(); truncated=$truncated }
    if ($null -ne $identity) { $out['identity'] = $identity }
    Emit $out
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

/** A valid ISO-8601 UTC timestamp ending in `Z` (mirrors Core's validator). */
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isValidUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return (
    date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second)
  );
}

/**
 * Parses the identity object the PowerShell emitted into the `AppIdentity` shape
 * the adapter threads to Core. Because the adapter's normalisation is what Core's
 * validator then checks, every field is coerced to the exact contract spelling:
 * the hash already lower-cases; here the created_at and integer fields are
 * re-asserted so a script bug cannot smuggle a wrong shape past the adapter.
 */
export function parseIdentity(raw: Record<string, unknown>): AppIdentity | null {
  const pid = raw['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const created_at = raw['created_at'];
  if (typeof created_at !== 'string' || !isValidUtcTimestamp(created_at)) return null;
  const image_path = raw['image_path'];
  if (typeof image_path !== 'string' || image_path.length === 0) return null;
  const image_sha256 = raw['image_sha256'];
  if (typeof image_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image_sha256)) return null;
  const signature = raw['signature'];
  if (signature !== 'valid' && signature !== 'unsigned' && signature !== 'invalid') return null;
  const signer = raw['signer'];
  if (signature === 'valid') {
    if (typeof signer !== 'string' || signer.length === 0) return null;
  } else if (signer !== null && signer !== undefined) return null;
  const product_name = raw['product_name'];
  if (product_name !== null && product_name !== undefined && typeof product_name !== 'string') return null;
  const session_id = raw['session_id'];
  if (typeof session_id !== 'number' || !Number.isSafeInteger(session_id) || session_id < 0) return null;
  return {
    pid,
    created_at,
    image_path,
    image_sha256,
    signature,
    signer: signature === 'valid' ? (signer as string) : null,
    product_name: typeof product_name === 'string' ? product_name : null,
    session_id,
  };
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
 * the script. Only the ABSENCE of the property selects the unrestricted
 * production path. A present `null` or `undefined` throws.
 */
export function createPowerShellUiaProbe(options: {
  timeout_ms: number;
  restrict_to_pid?: number | null;
}): UiaProbe {
  const timeoutMs = options.timeout_ms;

  // Fail closed at the factory boundary: only the ABSENCE of restrict_to_pid
  // selects the unrestricted production path. A present value that is null,
  // undefined, or anything other than a positive safe integer throws here,
  // BEFORE PowerShell starts, so no malformed value can be serialized into
  // input.json and silently disable the guard in the script.
  const hasRestrictPid = 'restrict_to_pid' in options;
  const restrictPid = options.restrict_to_pid;

  if (hasRestrictPid) {
    if (restrictPid === null || restrictPid === undefined) {
      throw new Error(
        `restrict_to_pid must be absent (unrestricted) or a positive safe integer, got ${String(restrictPid)}`,
      );
    }
    if (!Number.isSafeInteger(restrictPid) || restrictPid <= 0) {
      throw new Error(
        `restrict_to_pid must be a positive safe integer when provided, got ${String(restrictPid)}`,
      );
    }
  }

  return {
    async enumerateWindows(
      opts: { max_windows?: number },
      signal: AbortSignal,
    ): Promise<
      | { readonly session_state: 'active'; readonly windows: readonly RawWindow[]; readonly truncated: boolean }
      | { readonly session_state: 'locked' | 'disconnected' }
    > {
      const maxWindows = (opts && typeof opts.max_windows === 'number') ? opts.max_windows : 200;

      const output = await runPowerShell(
        {
          action: 'enumerate_windows',
          max_windows: maxWindows,
          ...(hasRestrictPid ? { restrict_to_pid: restrictPid } : {}),
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
      // Windows whose identity could not be read (access denied, process gone,
      // hashing failed) are dropped here — the script already counts them in
      // `identity_unavailable`, and they are never returned, never basename-fell-back.
      const windows: RawWindow[] = [];
      for (const w of rawWindows) {
        const identity = typeof w['identity'] === 'object' && w['identity'] !== null
          ? parseIdentity(w['identity'] as Record<string, unknown>)
          : null;
        if (identity === null) continue;
        windows.push({
          native_handle: typeof w['native_handle'] === 'string' ? w['native_handle'] : String(w['native_handle'] ?? ''),
          ...(typeof w['title'] === 'string' ? { title: w['title'].slice(0, 256) } : {}),
          identity,
          z_order: typeof w['z_order'] === 'number' ? w['z_order'] : Number(w['z_order'] ?? 0),
          foreground: w['foreground'] === true,
        });
      }
      const truncated = output['truncated'] === true;

      return { session_state: 'active', windows, truncated };
    },

    async inspectWindow(nativeHandle: string, opts: { depth: number; max_controls: number }, signal: AbortSignal): Promise<
      | { readonly closed: true }
      | { readonly closed: false; readonly identity: AppIdentity | null; readonly controls: readonly RawControl[]; readonly truncated: boolean }
    > {
      const output = await runPowerShell(
        {
          action: 'inspect_window',
          native_handle: nativeHandle,
          depth: opts.depth,
          max_controls: opts.max_controls,
          ...(hasRestrictPid ? { restrict_to_pid: restrictPid } : {}),
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

      const identity = typeof output['identity'] === 'object' && output['identity'] !== null
        ? parseIdentity(output['identity'] as Record<string, unknown>)
        : null;
      const truncated = output['truncated'] === true;

      return { closed: false, identity, controls, truncated };
    },
  };
}