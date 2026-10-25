<#
.SYNOPSIS
用 UI Automation 在 ZCode 桌面版里切换模型（ZCode 没有 /model 斜杠命令，只能点 UI）。

.DESCRIPTION
流程：附加到 ZCode 主窗口 -> 找到输入框右下角的模型按钮（形如「GLM-5.3 最高」）->
展开下拉 -> 在菜单里找到名字等于目标模型的那一行（RadioButton）->
点击选中 -> 回读按钮文字确认切换成功。
只使用系统自带的 UIAutomationClient，不安装第三方工具、不修改 ZCode 文件。

.PARAMETER Model
目标模型名，例如 GLM-5.3 / GLM-5.3-Flash。允许写不带「视觉」后缀的名字。

.PARAMETER ProcessName
目标进程名（不含 .exe），默认 ZCode。

.PARAMETER Probe
只列出模型按钮和菜单项，不做选择（结束前按 Esc 关掉菜单）。用于排错。

.PARAMETER QueryOnly
只读当前模型按钮的文字，不展开下拉（供钩子判断当前模型用）。

.PARAMETER TimeoutMs
等待下拉菜单出现的毫秒数，默认 6000。

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File zcode-switch-model.ps1 -Model GLM-5.3
#>
[CmdletBinding()]
param(
  [string]$Model = '',
  [string]$ProcessName = 'ZCode',
  [switch]$Probe,
  [switch]$QueryOnly,
  [int]$TimeoutMs = 6000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace ZacNative -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
'@

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$Scope = [System.Windows.Automation.TreeScope]
$AllCond = [System.Windows.Automation.Condition]::TrueCondition

function Get-TypeName($element) {
  try { return ($element.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '') } catch { return '?' }
}

function Click-Element($element) {
  foreach ($patternName in 'InvokePattern', 'SelectionItemPattern') {
    try {
      if ($patternName -eq 'InvokePattern') {
        $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } else {
        $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      }
      return $patternName
    } catch {
      continue
    }
  }
  try {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { throw '元素没有可点击区域' }
    $x = [int]($rect.X + $rect.Width / 2)
    $y = [int]($rect.Y + $rect.Height / 2)
    [void][ZacNative.Mouse]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 80
    [ZacNative.Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [ZacNative.Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return 'mouse'
  } catch {
    throw "点击失败：$($_.Exception.Message)"
  }
}

# 名字匹配：完全相等，或后面跟空格/结尾（避免 GLM-5.3 误中 GLM-5.3-Flash）
function Test-ModelName([string]$name, [string]$wanted) {
  if (-not $name) { return $false }
  if ($name -eq $wanted) { return $true }
  return $name -match ('^' + [regex]::Escape($wanted) + '(\s|$)')
}

function Get-ModelTrigger($window) {
  # 输入框右下角的模型按钮：Button + 名字以 GLM- 开头 + 可见，取最靠下的那个
  $best = $null
  $bestY = -1
  foreach ($b in $window.FindAll($Scope::Descendants, $AllCond)) {
    try {
      if ($b.Current.ControlType -ne $CT::Button) { continue }
      if ($b.Current.Name -notmatch '^GLM-') { continue }
      if ($b.Current.IsOffscreen) { continue }
      $rect = $b.Current.BoundingRectangle
      if ($rect.Width -le 0) { continue }
      if ($rect.Y -gt $bestY) { $best = $b; $bestY = $rect.Y }
    } catch {
      continue
    }
  }
  return $best
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { [Console]::Error.WriteLine("未找到 $ProcessName 窗口"); exit 1 }

$window = $AE::FromHandle($proc.MainWindowHandle)
if (-not $window) { [Console]::Error.WriteLine('UIA 无法附加到 ZCode 窗口'); exit 1 }

# 如果上次留下一个没关的模型下拉，先关掉，否则按钮会被判为不可见
try {
  $openMenus = $AE::RootElement.FindAll($Scope::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Menu)))
  foreach ($m in $openMenus) {
    try {
      if (-not $m.Current.IsOffscreen -and $m.Current.Name -match '^GLM-') {
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Milliseconds 400
        break
      }
    } catch { continue }
  }
} catch { }

$trigger = Get-ModelTrigger $window
if (-not $trigger) { [Console]::Error.WriteLine('未找到模型选择按钮（名字以 GLM- 开头的按钮）'); exit 1 }
$before = $trigger.Current.Name
Write-Output "当前模型按钮: '$before'"

if ($QueryOnly) { exit 0 }

# 展开下拉
try {
  [void][ZacNative.Mouse]::ShowWindowAsync($proc.MainWindowHandle, 9)
  [void][ZacNative.Mouse]::SetForegroundWindow($proc.MainWindowHandle)
} catch { }
Start-Sleep -Milliseconds 250
$how = Click-Element $trigger
Write-Output "已展开下拉（点击方式：$how）"

# 等菜单出现：Radix portal 可能挂成独立顶层窗口，所以从桌面根节点找可见 Menu
function Find-ModelMenu {
  $found = $null
  try {
    $menus = $AE::RootElement.FindAll($Scope::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Menu)))
  } catch {
    return $null
  }
  foreach ($m in $menus) {
    try {
      if ($m.Current.IsOffscreen) { continue }
      if ($m.Current.Name -notmatch '^GLM-') { continue }
      $found = $m
    } catch { continue }
  }
  return $found
}

$menu = $null
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  $menu = Find-ModelMenu
  if ($menu) { break }
}

# 第一次点击可能因窗口刚激活而落空，重试一次
if (-not $menu) {
  Write-Output '第一次点击没弹出菜单，重试一次'
  Start-Sleep -Milliseconds 300
  try {
    [void][ZacNative.Mouse]::SetForegroundWindow($proc.MainWindowHandle)
    $trigger = Get-ModelTrigger $window
    if ($trigger) { $how = Click-Element $trigger }
  } catch { }
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $menu = Find-ModelMenu
    if ($menu) { break }
  }
}

if (-not $menu) {
  [Console]::Error.WriteLine('下拉菜单没有出现（可能窗口未聚焦或被遮挡）')
  exit 1
}

# 收集候选行：RadioButton / MenuItem / ListItem
$rows = @()
foreach ($e in $menu.FindAll($Scope::Descendants, $AllCond)) {
  try {
    $type = $e.Current.ControlType
    if ($type -ne $CT::RadioButton -and $type -ne $CT::MenuItem -and $type -ne $CT::ListItem) { continue }
    $rows += $e
  } catch {
    continue
  }
}

if ($Probe) {
  foreach ($row in $rows) {
    try {
      $rect = $row.Current.BoundingRectangle
      Write-Output ("row: type={0} name='{1}' rect={2},{3} {4}x{5}" -f (Get-TypeName $row),
        $row.Current.Name, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
    } catch { continue }
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Model)) {
  [Console]::Error.WriteLine('-Model 不能为空')
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  exit 1
}

$target = $null
foreach ($row in $rows) {
  try {
    if (Test-ModelName $row.Current.Name $Model) { $target = $row; break }
  } catch {
    continue
  }
}

if (-not $target) {
  $names = ($rows | ForEach-Object { try { $_.Current.Name } catch { '' } }) -join ' | '
  [Console]::Error.WriteLine("菜单里没有模型「$Model」。可见项：$names")
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  exit 1
}

$matched = $target.Current.Name
$how2 = Click-Element $target
Start-Sleep -Milliseconds 300

# 有些实现点选后菜单不自动关闭：补一个 Esc，再回读按钮文字
try { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') } catch { }

$after = ''
$deadline = (Get-Date).AddMilliseconds(2500)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  try {
    $again = Get-ModelTrigger $window
    if ($again) {
      $after = $again.Current.Name
      if (Test-ModelName $after $Model) { break }
    }
  } catch { }
}

if (-not $after) {
  Write-Output ("warning: 点击后读不到模型按钮文字，无法确认是否切换成功（点击方式：$how2，目标：$matched）")
} elseif (-not (Test-ModelName $after $Model)) {
  Write-Output "warning: 点击后按钮文字为 '$after'，与目标 '$Model' 不一致"
}

Write-Output ("selected='$matched' via $how2; button='$before' -> '$after'")

if ($after -and (Test-ModelName $after $Model)) { exit 0 }
exit 1
