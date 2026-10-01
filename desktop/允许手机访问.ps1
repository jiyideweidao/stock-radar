# ============================================================
#  放行 / 撤销「手机访问工作站」的 Windows 防火墙入站规则
#
#  为什么需要这一步：Windows 防火墙默认不让人从别的设备连本机端口，
#  所以手机在同一 Wi-Fi 下也打不开 192.168.x.x:8787。放行一次即可，之后一直有效。
#
#  用法：右键本文件 ->「使用 PowerShell 运行」（会弹管理员授权，点「是」）
#        命令行：powershell -ExecutionPolicy Bypass -File 允许手机访问.ps1
#        撤销：  加 -Remove 参数
#  参数：-Port 8787   指定端口
#        -Remove     删除规则（恢复原状）
# ============================================================
param(
  [int]$Port = 8787,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$RuleName = "stock-radar 手机访问 (TCP $Port)"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 需要管理员权限：没提权就自己弹一次 UAC 再运行，而不是直接报错走人
if (-not (Test-Admin)) {
  Write-Host "需要管理员权限来修改防火墙规则，正在请求授权…" -ForegroundColor Yellow
  try {
    $myArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ("'" + $PSCommandPath + "'"), '-Port', $Port)
    if ($Remove) { $myArgs += '-Remove' }
    # 提权后的窗口要保持可见，用户才知道发生了什么（这不是后台任务）
    Start-Process -FilePath 'powershell.exe' -ArgumentList $myArgs -Verb RunAs
  } catch {
    Write-Host "已取消管理员授权，没有改动任何防火墙设置。" -ForegroundColor Red
    Write-Host "如果确实要放行，请右键本文件选择「使用 PowerShell 运行」并在弹窗里点「是」。" -ForegroundColor DarkGray
    exit 1
  }
  exit 0
}

Write-Host "工作站手机访问 · 防火墙规则" -ForegroundColor Cyan
Write-Host "规则名：$RuleName" -ForegroundColor DarkGray
Write-Host ""

if ($Remove) {
  $found = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
  if ($found.Count -eq 0) {
    Write-Host "没有找到该规则，无需删除（防火墙保持原样）。" -ForegroundColor Yellow
    exit 0
  }
  $found | Remove-NetFirewallRule
  Write-Host "已删除规则，已恢复原来的防火墙状态。" -ForegroundColor Green
  exit 0
}

# 先看看端口上有没有服务在监听，免得放行了一个空端口还以为成功
$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
if ($listening) {
  Write-Host "检测到端口 $Port 上已有服务在监听（工作站应该在运行）。" -ForegroundColor DarkGray
} else {
  Write-Host "提示：端口 $Port 上现在没有服务在监听。" -ForegroundColor Yellow
  Write-Host "      规则照样可以先放行，但请记得用桌面「启动工作站」把服务跑起来，否则手机还是连不上。" -ForegroundColor DarkGray
}

# 幂等：已经有同名规则就更新，不要越点越多
$existing = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  $existing | Remove-NetFirewallRule
  Write-Host "发现同名旧规则，已先清除，准备重建。" -ForegroundColor DarkGray
}

try {
  New-NetFirewallRule -DisplayName $RuleName 
    -Description '让同一局域网内的手机/平板打开本机的股民舆情工作站（TCP 端口入站）' 
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port 
    -Profile Private,Domain -Enabled True | Out-Null
} catch {
  Write-Host "用 New-NetFirewallRule 失败：$($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "改用 netsh 再试一次…" -ForegroundColor DarkGray
  $out = netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "netsh 也失败了：$out" -ForegroundColor Red
    Write-Host "没有改动成功，请手动在「Windows 安全中心 -> 防火墙和网络保护 -> 高级设置」里放行 TCP $Port。" -ForegroundColor Red
    exit 1
  }
}

$rule = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
if ($rule.Count -eq 0) {
  Write-Host "规则似乎没有建立成功，请到防火墙高级设置里确认。" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "已放行 TCP $Port 的入站连接（仅专用/域网络，公用网络不放开）。" -ForegroundColor Green

# 把手机该访问的地址一并打印出来，省得再回工作站里找
try {
  $net = Invoke-RestMethod "http://127.0.0.1:$Port/api/net" -TimeoutSec 5
  if ($net.primary) {
    Write-Host ""
    Write-Host "手机浏览器打开这个地址：" -ForegroundColor Cyan
    Write-Host "  $($net.primary.url)" -ForegroundColor White
    if ($net.hosts.Count -gt 1) {
      Write-Host "  其它可用地址：" -ForegroundColor DarkGray
      $net.hosts | Select-Object -Skip 1 | ForEach-Object { Write-Host "    $($_.url)  [$($_.iface)]" -ForegroundColor DarkGray }
    }
  } else {
    Write-Host ""
    Write-Host "没有检测到局域网地址（电脑可能没连 Wi-Fi / 网线），手机暂时访问不到。" -ForegroundColor Yellow
  }
} catch {
  Write-Host ""
  Write-Host "（取不到局域网地址，因为工作站服务没在运行；先启动工作站再看地址，或在工作站「帮助 -> 手机访问」里扫码。）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "注意：这一步只解决防火墙。还要保证手机和电脑连的是同一个 Wi-Fi，且服务在运行。" -ForegroundColor DarkGray
Write-Host "撤销：再运行一次本文件并加 -Remove 参数。" -ForegroundColor DarkGray
