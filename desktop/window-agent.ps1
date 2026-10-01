# ============================================================
#  股民舆情与商品看板 —— 原生窗口代理（常驻进程）
#  用法：powershell -NoProfile -File window-agent.ps1
#        从 stdin 逐行读取指令，向 stdout 输出一行 JSON 结果。
#  指令：state focus minimize maximize restore close
#        topmost-on topmost-off topmost-toggle quit
#  说明：只操作标题包含「股民舆情与商品看板」的窗口；优先选择
#        以 --app= 应用模式启动的窗口，避免误关普通浏览器标签页。
# ============================================================
$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$Marker       = '股民舆情与商品看板'
$AppFlag      = '--app='

if (-not ('WinApi' -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinApi {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
}

$SW_MINIMIZE  = 6
$SW_MAXIMIZE  = 3
$SW_RESTORE   = 9
$SW_SHOW      = 5
$WM_CLOSE     = 0x0010
$HWND_TOPMOST = -1
$HWND_NOTOP   = -2
$SWP_FLAGS    = 0x0003   # SWP_NOSIZE | SWP_NOMOVE

function Get-ProcCommandLine([int]$procId) {
  try {
    $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
    if ($p -and $p.CommandLine) { return [string]$p.CommandLine }
  } catch { }
  return ''
}

function Get-StationWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = [WinApi+EnumProc] {
    param([IntPtr]$h, [IntPtr]$l)
    try {
      if ([WinApi]::IsWindowVisible($h)) {
        $len = [WinApi]::GetWindowTextLengthW($h)
        if ($len -gt 0) {
          $sb = New-Object System.Text.StringBuilder ($len + 2)
          [void][WinApi]::GetWindowTextW($h, $sb, $sb.Capacity)
          $title = $sb.ToString()
          if ($title -and $title.Contains($Marker)) {
            $csb = New-Object System.Text.StringBuilder 256
            [void][WinApi]::GetClassNameW($h, $csb, $csb.Capacity)
            $pid32 = [uint32]0
            [void][WinApi]::GetWindowThreadProcessId($h, [ref]$pid32)
            $cmd = Get-ProcCommandLine ([int]$pid32)
            $isApp = ($cmd -like ('*' + $AppFlag + '*')) -or ($cmd -like '*--app*')
            [void]$list.Add([pscustomobject]@{
              hwnd     = [int64]$h
              title    = $title
              className = $csb.ToString()
              pid      = [int]$pid32
              app      = [bool]$isApp
              iconic   = [bool]([WinApi]::IsIconic($h))
              zoomed   = [bool]([WinApi]::IsZoomed($h))
            })
          }
        }
      }
    } catch { }
    return $true
  }
  [void][WinApi]::EnumWindows($cb, [IntPtr]::Zero)
  # 优先返回应用模式窗口；没有则退回普通窗口
  $apps = @($list | Where-Object { $_.app })
  if ($apps.Count -gt 0) { return $apps }
  return @($list)
}

function Invoke-Action([string]$action) {
  $wins = @(Get-StationWindows)
  $result = [ordered]@{
    ok      = $false
    action  = $action
    count   = $wins.Count
    windows = @($wins | ForEach-Object { [ordered]@{ title = $_.title; className = $_.className; pid = $_.pid; app = $_.app; iconic = $_.iconic; zoomed = $_.zoomed } })
    message = ''
  }
  if ($action -eq 'state' -or $action -eq 'list') {
    $result.ok = $true
    $result.message = "找到 $($wins.Count) 个工作站窗口"
    return $result
  }
  if ($wins.Count -eq 0) {
    $result.message = '没有找到工作站窗口（标题需包含「股民舆情与商品看板」）'
    return $result
  }

  $done = 0
  foreach ($w in $wins) {
    $h = [IntPtr]$w.hwnd
    try {
      switch ($action) {
        'focus'          { [void][WinApi]::ShowWindow($h, $SW_RESTORE); [void][WinApi]::SetForegroundWindow($h); [void][WinApi]::BringWindowToTop($h); $done++ }
        'minimize'       { [void][WinApi]::ShowWindow($h, $SW_MINIMIZE); $done++ }
        'maximize'       { if ([WinApi]::IsZoomed($h)) { [void][WinApi]::ShowWindow($h, $SW_RESTORE) } else { [void][WinApi]::ShowWindow($h, $SW_MAXIMIZE) }; $done++ }
        'restore'        { [void][WinApi]::ShowWindow($h, $SW_RESTORE); [void][WinApi]::SetForegroundWindow($h); $done++ }
        'close'          { [void][WinApi]::SendMessageW($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero); $done++ }
        'topmost-on'     { [void][WinApi]::SetWindowPos($h, [IntPtr]$HWND_TOPMOST, 0, 0, 0, 0, $SWP_FLAGS); $done++ }
        'topmost-off'    { [void][WinApi]::SetWindowPos($h, [IntPtr]$HWND_NOTOP, 0, 0, 0, 0, $SWP_FLAGS); $done++ }
        default          { $result.message = "未知指令: $action"; return $result }
      }
    } catch {
      $result.message = "操作失败: $($_.Exception.Message)"
      return $result
    }
  }
  Start-Sleep -Milliseconds 120
  $after = @(Get-StationWindows)
  $result.ok = ($done -gt 0)
  $result.count = $after.Count
  $result.windows = @($after | ForEach-Object { [ordered]@{ title = $_.title; className = $_.className; pid = $_.pid; app = $_.app; iconic = $_.iconic; zoomed = $_.zoomed } })
  if ($action -eq 'minimize') { $result.message = "已最小化 $done 个窗口" }
  elseif ($action -eq 'maximize') { $result.message = "已切换最大化/还原（$done 个窗口）" }
  elseif ($action -eq 'restore') { $result.message = "已还原并置前 $done 个窗口" }
  elseif ($action -eq 'close') { $result.message = "已发送关闭指令（$done 个窗口）" }
  elseif ($action -eq 'focus') { $result.message = "已聚焦工作站窗口" }
  else { $result.message = "已执行 $action" }
  return $result
}

while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  $cmd = $line.Trim().ToLowerInvariant()
  if ($cmd -eq '') { continue }
  if ($cmd -eq 'quit' -or $cmd -eq 'exit') { break }
  if ($cmd -eq 'topmost-toggle') {
    $w = @(Get-StationWindows)
    if ($w.Count -eq 0) { $cmd = 'topmost-off' } else { $cmd = 'topmost-on' }
  }
  $resp = $null
  try { $resp = Invoke-Action $cmd } catch { $resp = [ordered]@{ ok = $false; action = $cmd; message = "内部错误: $($_.Exception.Message)" } }
  Write-Output ($resp | ConvertTo-Json -Compress -Depth 5)
  try { [Console]::Out.Flush() } catch { }
}
