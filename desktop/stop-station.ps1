# 停止后台的看板服务：只结束监听 8787 端口的 node 进程，不动其它 node 程序
param([int]$Port = 8787, [int]$WaitSec = 10)

function Get-PortOwners([int]$p) {
  @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

$owners = Get-PortOwners $Port
if ($owners.Count -eq 0) {
  Write-Host "工作站服务当前没有在运行（$Port 端口空闲）。"
  exit 0
}

$stopped = 0
foreach ($ownerPid in $owners) {
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Write-Host "已停止 node 进程 (PID $ownerPid)"
    $stopped++
  } else {
    $name = if ($proc) { $proc.ProcessName } else { '未知' }
    Write-Host "端口 $Port 被非 node 进程占用（PID $ownerPid，$name），未做任何操作。"
  }
}

# 等端口真正释放：否则「刚停就启动」时新进程抢不到端口，会白等 30 秒
if ($stopped -gt 0) {
  for ($i = 0; $i -lt ($WaitSec * 2); $i++) {
    if ((Get-PortOwners $Port).Count -eq 0) { Write-Host "端口 $Port 已释放。"; exit 0 }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "警告：等待 $WaitSec 秒后端口 $Port 仍被占用，请稍后再启动。"
}
