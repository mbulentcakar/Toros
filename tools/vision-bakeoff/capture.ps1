# capture.ps1 — fixed, parameter-free PowerShell script for Toros slice AU0a.
# Reads all parameters as data from the JSON file given by -ParamsFile (stripping any UTF-8 BOM).
# Never interpolates a window title, control name, or caller string into script source.
param(
  [Parameter(Mandatory = $false)]
  [string]$ParamsFile = (Join-Path $PSScriptRoot 'params.json')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TorosCaptureNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public const uint PW_RENDERFULLCONTENT = 0x00000002;
  public const int SW_RESTORE = 9;

  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

  public static void EnablePerMonitorDpi() {
    try {
      // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
      if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
        SetProcessDPIAware();
      }
    } catch {
      try { SetProcessDPIAware(); } catch { }
    }
  }

  public static int WindowPid(IntPtr hWnd) {
    uint pid = 0;
    GetWindowThreadProcessId(hWnd, out pid);
    return (int)pid;
  }
}
"@

[TorosCaptureNative]::EnablePerMonitorDpi()

if ([string]::IsNullOrWhiteSpace($ParamsFile) -or -not (Test-Path -LiteralPath $ParamsFile)) {
  throw "ParamsFile does not exist: $ParamsFile"
}

$rawParamsText = [System.IO.File]::ReadAllText($ParamsFile, [System.Text.Encoding]::UTF8)
if ($rawParamsText.Length -gt 0 -and [int][char]$rawParamsText[0] -eq 0xFEFF) {
  $rawParamsText = $rawParamsText.Substring(1)
}
$req = $rawParamsText | ConvertFrom-Json

$executable = [string]$req.executable
$imagePath  = [string]$req.image_path
$treePath   = [string]$req.tree_path
$metaPath   = [string]$req.meta_path
$timeoutMs  = if ($null -ne $req.timeout_ms -and [int]$req.timeout_ms -gt 0) { [int]$req.timeout_ms } else { 15000 }

if ([string]::IsNullOrWhiteSpace($executable)) {
  throw "executable parameter is required"
}
if ([string]::IsNullOrWhiteSpace($imagePath) -or [string]::IsNullOrWhiteSpace($treePath) -or [string]::IsNullOrWhiteSpace($metaPath)) {
  throw "image_path, tree_path, and meta_path parameters are required"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonFile([string]$path, $obj) {
  $parent = [System.IO.Path]::GetDirectoryName($path)
  if (-not [string]::IsNullOrEmpty($parent) -and -not (Test-Path -LiteralPath $parent)) {
    [void][System.IO.Directory]::CreateDirectory($parent)
  }
  # ConvertTo-Json, not JavaScriptSerializer: the latter fails on PSObject-wrapped values
  # ("circular reference ... PSParameterizedProperty") on Windows PowerShell 5.1.
  $json = ConvertTo-Json -InputObject $obj -Depth 64 -Compress
  [System.IO.File]::WriteAllText($path, $json, $utf8NoBom)
}

# Build candidate process names from process_names array + executable base name
$candidateNames = New-Object 'System.Collections.Generic.List[string]'
if ($null -ne $req.process_names) {
  foreach ($pn in @($req.process_names)) {
    $s = ([string]$pn).Trim()
    if ($s.Length -gt 0 -and -not $candidateNames.Contains($s)) {
      [void]$candidateNames.Add($s)
    }
  }
}
$exeBase = [System.IO.Path]::GetFileNameWithoutExtension($executable)
if (-not [string]::IsNullOrWhiteSpace($exeBase) -and -not $candidateNames.Contains($exeBase)) {
  [void]$candidateNames.Add($exeBase)
}

function Get-CandidatePids([string[]]$names) {
  $pids = New-Object 'System.Collections.Generic.List[int]'
  foreach ($n in $names) {
    try {
      $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
      foreach ($p in $procs) {
        if (-not $pids.Contains([int]$p.Id)) {
          [void]$pids.Add([int]$p.Id)
        }
      }
    } catch { }
  }
  return $pids.ToArray()
}

# Find top-level window strictly by process ID (never by window title).
# Also checks immediate child elements for packaged UWP apps hosted in ApplicationFrameHost.exe.
function Find-TopLevelWindowByPids([int[]]$targetPids) {
  if ($null -eq $targetPids -or $targetPids.Count -eq 0) { return $null }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $w = $null
  try { $w = $walker.GetFirstChild($root) } catch { $w = $null }
  while ($null -ne $w) {
    $hwnd = 0L
    try { $hwnd = [int64]$w.Current.NativeWindowHandle } catch { $hwnd = 0L }
    if ($hwnd -ne 0 -and [TorosCaptureNative]::IsWindowVisible([IntPtr]$hwnd)) {
      $nativePid = [TorosCaptureNative]::WindowPid([IntPtr]$hwnd)
      $uiaPid = 0
      try { $uiaPid = [int]$w.Current.ProcessId } catch { $uiaPid = 0 }
      if ($targetPids -contains $nativePid) {
        return @{ Element = $w; Hwnd = $hwnd; Pid = $nativePid }
      }
      if ($targetPids -contains $uiaPid) {
        return @{ Element = $w; Hwnd = $hwnd; Pid = $uiaPid }
      }
      # Check immediate children for packaged CoreWindow owned by the target PID
      $child = $null
      try { $child = $walker.GetFirstChild($w) } catch { $child = $null }
      while ($null -ne $child) {
        $childPid = 0
        try { $childPid = [int]$child.Current.ProcessId } catch { $childPid = 0 }
        if ($targetPids -contains $childPid) {
          return @{ Element = $w; Hwnd = $hwnd; Pid = $childPid }
        }
        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
      }
    }
    try { $w = $walker.GetNextSibling($w) } catch { $w = $null }
  }
  return $null
}

$launchedByUs = $false
$startedProcess = $null
$beforePids = Get-CandidatePids $candidateNames.ToArray()
$spawnedPids = New-Object 'System.Collections.Generic.List[int]'

try {
  $found = Find-TopLevelWindowByPids $beforePids
  if ($null -eq $found) {
    $launchedByUs = $true
    $startedProcess = Start-Process -FilePath $executable -PassThru
    if ($null -ne $startedProcess -and [int]$startedProcess.Id -gt 0) {
      [void]$spawnedPids.Add([int]$startedProcess.Id)
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
      $currentPids = Get-CandidatePids $candidateNames.ToArray()
      foreach ($cp in $currentPids) {
        if ($beforePids -notcontains $cp -and -not $spawnedPids.Contains($cp)) {
          [void]$spawnedPids.Add($cp)
        }
      }
      $found = Find-TopLevelWindowByPids $spawnedPids.ToArray()
      if ($null -ne $found) {
        Start-Sleep -Milliseconds 600
        break
      }
      Start-Sleep -Milliseconds 200
    }
  }

  if ($null -eq $found) {
    throw "Could not find top-level window for executable '$executable' by process ID within ${timeoutMs}ms"
  }

  $hwnd = [int64]$found.Hwnd
  $winPid = [int]$found.Pid
  $winElement = $found.Element

  if ([TorosCaptureNative]::IsIconic([IntPtr]$hwnd)) {
    [void][TorosCaptureNative]::ShowWindow([IntPtr]$hwnd, [TorosCaptureNative]::SW_RESTORE)
    Start-Sleep -Milliseconds 300
  }

  $rect = New-Object TorosCaptureNative+RECT
  if (-not [TorosCaptureNative]::GetWindowRect([IntPtr]$hwnd, [ref]$rect)) {
    throw "GetWindowRect failed for HWND $hwnd"
  }

  $winWidth  = [int]($rect.Right - $rect.Left)
  $winHeight = [int]($rect.Bottom - $rect.Top)
  if ($winWidth -le 0 -or $winHeight -le 0) {
    throw "Invalid window dimensions (${winWidth}x${winHeight}) for HWND $hwnd"
  }

  $dpi = [int][TorosCaptureNative]::GetDpiForWindow([IntPtr]$hwnd)
  if ($dpi -le 0) { $dpi = 96 }

  # Capture window via PrintWindow(hwnd, PW_RENDERFULLCONTENT)
  $parentDir = [System.IO.Path]::GetDirectoryName($imagePath)
  if (-not [string]::IsNullOrEmpty($parentDir) -and -not (Test-Path -LiteralPath $parentDir)) {
    [void][System.IO.Directory]::CreateDirectory($parentDir)
  }

  $bmp = New-Object System.Drawing.Bitmap($winWidth, $winHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $hdc = $gfx.GetHdc()
      try {
        $ok = [TorosCaptureNative]::PrintWindow([IntPtr]$hwnd, $hdc, [TorosCaptureNative]::PW_RENDERFULLCONTENT)
        if (-not $ok) {
          throw "PrintWindow(PW_RENDERFULLCONTENT) returned false for HWND $hwnd"
        }
      } finally {
        $gfx.ReleaseHdc($hdc)
      }
    } finally {
      $gfx.Dispose()
    }
    $bmp.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }

  # Walk UIA tree and build element list with Spec V selector paths
  $cwalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $elements = New-Object 'System.Collections.Generic.List[object]'
  $maxDepth = 25
  $maxElements = 2500

  $actionableTypes = @('Button', 'MenuItem', 'ListItem', 'TabItem', 'Hyperlink', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'SplitButton')
  $atomicActionableTypes = @('Button', 'MenuItem', 'CheckBox', 'RadioButton', 'Hyperlink')

  function Normalize-ControlType($el) {
    $ct = ''
    try { $ct = [string]$el.Current.ControlType.ProgrammaticName } catch { $ct = 'ControlType.Custom' }
    if ($ct.StartsWith('ControlType.')) {
      return $ct.Substring(12)
    }
    return $ct
  }

  function Read-ElementInfo($el) {
    $ct = Normalize-ControlType $el
    $aid = $null
    try {
      $rawAid = [string]$el.Current.AutomationId
      if (-not [string]::IsNullOrEmpty($rawAid)) { $aid = $rawAid }
    } catch { }
    $nm = $null
    try {
      $rawNm = [string]$el.Current.Name
      if (-not [string]::IsNullOrEmpty($rawNm)) { $nm = $rawNm }
    } catch { }
    $enabled = $false
    try { $enabled = [bool]$el.Current.IsEnabled } catch { }
    $offscreen = $false
    try { $offscreen = [bool]$el.Current.IsOffscreen } catch { $offscreen = $true }

    $bLeft = 0; $bTop = 0; $bRight = 0; $bBottom = 0; $bWidth = 0; $bHeight = 0
    try {
      $br = $el.Current.BoundingRectangle
      if (-not $br.IsEmpty -and -not [double]::IsInfinity($br.Left) -and -not [double]::IsNaN($br.Left) -and $br.Width -gt 0 -and $br.Height -gt 0) {
        $bLeft   = [int][Math]::Round($br.Left)
        $bTop    = [int][Math]::Round($br.Top)
        $bWidth  = [int][Math]::Round($br.Width)
        $bHeight = [int][Math]::Round($br.Height)
        $bRight  = $bLeft + $bWidth
        $bBottom = $bTop + $bHeight
      } else {
        $offscreen = $true
      }
    } catch {
      $offscreen = $true
    }

    return @{
      control_type  = $ct
      automation_id = $aid
      name          = $nm
      enabled       = $enabled
      is_offscreen  = $offscreen
      bounding_rect = @{
        left   = $bLeft
        top    = $bTop
        right  = $bRight
        bottom = $bBottom
        width  = $bWidth
        height = $bHeight
      }
    }
  }

  function Walk-UiaNode($el, [object[]]$parentSelector, [int]$depth, [int]$siblingIndex) {
    if ($elements.Count -ge $maxElements -or $depth -gt $maxDepth) { return }
    $info = Read-ElementInfo $el
    $step = @{
      control_type  = $info.control_type
      automation_id = $info.automation_id
      name          = $info.name
      index         = $siblingIndex
    }
    $currentSelector = New-Object 'System.Collections.Generic.List[object]'
    foreach ($ps in $parentSelector) { [void]$currentSelector.Add($ps) }
    [void]$currentSelector.Add($step)

    $record = @{
      control_type  = $info.control_type
      automation_id = $info.automation_id
      name          = $info.name
      bounding_rect = $info.bounding_rect
      enabled       = $info.enabled
      is_offscreen  = $info.is_offscreen
      selector      = $currentSelector
    }
    [void]$elements.Add($record)

    $isAtomicParent = ($atomicActionableTypes -contains $info.control_type)
    $siblingCounts = @{}
    $child = $null
    try { $child = $cwalker.GetFirstChild($el) } catch { $child = $null }
    while ($null -ne $child) {
      if ($elements.Count -ge $maxElements) { break }
      $childInfo = Read-ElementInfo $child
      # Inside atomic actionable controls (Button, MenuItem, etc.), skip decorative Text/Image children
      # unless the child itself is an actionable control.
      if (-not $isAtomicParent -or ($actionableTypes -contains $childInfo.control_type)) {
        $sigKey = "$($childInfo.control_type)|$($childInfo.automation_id)|$($childInfo.name)"
        $idx = 0
        if ($siblingCounts.ContainsKey($sigKey)) {
          $idx = [int]$siblingCounts[$sigKey] + 1
        }
        $siblingCounts[$sigKey] = $idx
        Walk-UiaNode $child $currentSelector ($depth + 1) $idx
      }
      try { $child = $cwalker.GetNextSibling($child) } catch { $child = $null }
    }
  }

  Walk-UiaNode $winElement @() 0 0

  Write-JsonFile $treePath $elements

  $scaleFactor = [Math]::Round(($dpi / 96.0), 4)
  $meta = @{
    executable   = $executable
    pid          = [int]$winPid
    hwnd         = $(if ($hwnd -is [System.IntPtr]) { $hwnd.ToInt64() } else { [int64]$hwnd })
    dpi          = $dpi
    scale_factor = $scaleFactor
    window_rect  = @{
      left   = [int]$rect.Left
      top    = [int]$rect.Top
      right  = [int]$rect.Right
      bottom = [int]$rect.Bottom
      width  = $winWidth
      height = $winHeight
    }
    image_size   = @{
      width  = $winWidth
      height = $winHeight
    }
    element_count = $elements.Count
    captured_at   = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
  }
  Write-JsonFile $metaPath $meta
}
finally {
  # Close the app ONLY if this script launched it.
  if ($launchedByUs) {
    foreach ($spid in $spawnedPids) {
      if ($beforePids -notcontains $spid) {
        try {
          $p = Get-Process -Id $spid -ErrorAction SilentlyContinue
          if ($null -ne $p) {
            [void]$p.CloseMainWindow()
            Start-Sleep -Milliseconds 200
            if (-not $p.HasExited) {
              Stop-Process -Id $spid -Force -ErrorAction SilentlyContinue
            }
          }
        } catch { }
      }
    }
  }
}
