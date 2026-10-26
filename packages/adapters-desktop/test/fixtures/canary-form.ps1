param(
  [string]$Title = "TorosCanaryFixture",
  [string]$Canary1 = "CANARY_PWD_DEFAULT",
  [string]$Canary2 = "CANARY_TXT_DEFAULT",
  [string]$Canary3 = "CANARY_LBL_DEFAULT",
  [int]$ExtraControls = 0,
  [int]$ExtraWindows = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Size = New-Object System.Drawing.Size(400, 300)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(150, 150)

# 1. UseSystemPasswordChar text box with synthetic canary 1
$pwd = New-Object System.Windows.Forms.TextBox
$pwd.UseSystemPasswordChar = $true
$pwd.Text = $Canary1
$pwd.Name = "pwdBox"
$pwd.Location = New-Object System.Drawing.Point(20, 20)
$pwd.Size = New-Object System.Drawing.Size(200, 24)
$form.Controls.Add($pwd)

# 2. Normal text box with second canary
$norm = New-Object System.Windows.Forms.TextBox
$norm.Text = $Canary2
$norm.Name = "normBox"
$norm.Location = New-Object System.Drawing.Point(20, 60)
$norm.Size = New-Object System.Drawing.Size(200, 24)
$form.Controls.Add($norm)

# 3. Label positioned outside the client area with third canary
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = $Canary3
$lbl.Name = "offLabel"
$lbl.Location = New-Object System.Drawing.Point(20, 1000)
$lbl.Size = New-Object System.Drawing.Size(200, 24)
$form.Controls.Add($lbl)

# Optional extra controls to exercise probe-side collection caps
if ($ExtraControls -gt 0) {
  for ($i = 0; $i -lt $ExtraControls; $i++) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = "ExtraBtn$i"
    $btn.Name = "extraBtn_$i"
    $y = 100 + ($i * 25)
    $btn.Location = New-Object System.Drawing.Point(20, $y)
    $form.Controls.Add($btn)
  }
}

$form.Add_Shown({
  # Optional extra TOP-LEVEL windows from the SAME process, so the fixture can
  # own more than one window for probe-side enumeration cap tests while every
  # window still belongs to the single PID the test binds to. Shown BEFORE the
  # READY line so that by the time the test reads our identity, the extra forms
  # already exist; the short sleep lets UIA observe them.
  if ($ExtraWindows -gt 0) {
    for ($i = 0; $i -lt $ExtraWindows; $i++) {
      $extra = New-Object System.Windows.Forms.Form
      $extra.Text = "TorosExtraWindow_$i"
      $extra.Size = New-Object System.Drawing.Size(200, 100)
      $extra.StartPosition = 'Manual'
      $extra.Location = New-Object System.Drawing.Point((600 + ($i * 30)), (150 + ($i * 30)))
      $extra.Show()
      [void]$extra.Handle
    }
    Start-Sleep -Milliseconds 400
  }
  $hwnd = $form.Handle.ToInt64()
  $procId = [System.Diagnostics.Process]::GetCurrentProcess().Id
  $procName = [System.Diagnostics.Process]::GetCurrentProcess().ProcessName
  [Console]::WriteLine("READY:" + [string]$hwnd + ":" + [string]$procId + ":" + $procName)
  [Console]::Out.Flush()
})

[System.Windows.Forms.Application]::Run($form)
