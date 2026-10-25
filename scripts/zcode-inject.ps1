<#
.SYNOPSIS
把一段文本键入到 ZCode 窗口（供额度不足时自动切换模型使用）。

.DESCRIPTION
流程：找到 ZCode 主窗口 -> 还原并置前 -> 等待 SettleMs -> 发送文本 ->（默认）回车。
只使用 Windows 自带能力，无需安装第三方工具。
成功退出码 0；失败退出码 1，并把原因写到 stderr。

.PARAMETER Text
要键入的文本，例如 "/model GLM-5.3"。

.PARAMETER ProcessName
目标进程名（不含 .exe），默认 ZCode。

.PARAMETER SettleMs
聚焦成功后等待的毫秒数，留给输入框获得焦点。

.PARAMETER NoEnter
只输入文本，不按回车。

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File zcode-inject.ps1 -Text "/model GLM-5.3"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$ProcessName = 'ZCode',
  [int]$SettleMs = 1500,
  [switch]$NoEnter
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace ZacNative -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@

Add-Type -AssemblyName System.Windows.Forms

function Find-ZcodeWindow {
  param([string]$Name)
  $processes = @(Get-Process -Name $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($processes.Count -eq 0) { return [IntPtr]::Zero }
  return $processes[0].MainWindowHandle
}

function Escape-SendKeys {
  param([string]$Value)
  $builder = New-Object System.Text.StringBuilder
  foreach ($ch in $Value.ToCharArray()) {
    switch ($ch) {
      '{' { [void]$builder.Append('{{}') }
      '}' { [void]$builder.Append('{}}') }
      '+' { [void]$builder.Append('{+}') }
      '^' { [void]$builder.Append('{^}') }
      '%' { [void]$builder.Append('{%}') }
      '~' { [void]$builder.Append('{~}') }
      '(' { [void]$builder.Append('{(}') }
      ')' { [void]$builder.Append('{)}') }
      '[' { [void]$builder.Append('{[}') }
      ']' { [void]$builder.Append('{]}') }
      default { [void]$builder.Append($ch) }
    }
  }
  return $builder.ToString()
}

$handle = [IntPtr]::Zero
for ($i = 0; $i -lt 12; $i++) {
  $handle = Find-ZcodeWindow -Name $ProcessName
  if ($handle -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}

if ($handle -eq [IntPtr]::Zero) {
  [Console]::Error.WriteLine("未找到 $ProcessName 的可见窗口")
  exit 1
}

try {
  if ([ZacNative.User32]::IsIconic($handle)) {
    [void][ZacNative.User32]::ShowWindowAsync($handle, 9) # SW_RESTORE
    Start-Sleep -Milliseconds 400
  }
  [void][ZacNative.User32]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds ([Math]::Max($SettleMs, 0))
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys -Value $Text))
  if (-not $NoEnter) {
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
