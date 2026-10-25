<#
探测 ZCode 窗口的 UI Automation 树，找出「模型选择」相关的可点击元素。
只读取，不点击。用于评估能否用 UIA 自动切换模型。
#>
[CmdletBinding()]
param(
  [string]$ProcessName = 'ZCode',
  [string]$Filter = 'GLM|模型|model|思考|额度',
  [int]$MaxDepth = 30
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { [Console]::Error.WriteLine("未找到 $ProcessName 窗口"); exit 1 }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { [Console]::Error.WriteLine('UIA 无法附加到窗口'); exit 1 }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$re = [regex]$Filter
$found = 0
$visited = 0

function Walk($element, $depth) {
  if ($depth -gt $script:MaxDepth) { return }
  $script:visited++
  try {
    $name = $element.Current.Name
    $type = $element.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $autoId = $element.Current.AutomationId
    if ($name -and $re.IsMatch($name)) {
      $script:found++
      $rect = $element.Current.BoundingRectangle
      Write-Output ("{0} depth={1} type={2} name='{3}' id='{4}' rect={5},{6},{7}x{8}" -f
        $script:found, $depth, $type, $name, $autoId,
        [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
    }
  } catch {
    return
  }
  $child = $walker.GetFirstChild($element)
  while ($child) {
    Walk $child ($depth + 1)
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}

Walk $root 0
Write-Output ("--- visited={0} matched={1} ---" -f $visited, $found)
