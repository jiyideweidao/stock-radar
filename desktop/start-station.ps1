# ============================================================
#  股民舆情与商品看板 —— 桌面启动器
#  1) 若本地服务没在运行，就在后台把它拉起来（端口被僵尸进程占住会先清理）
#  2) 若工作站窗口已经开着，就把它还原到最前（不会重复开窗）
#  3) 否则用「应用窗口」打开工作站：标题栏可最小化 / 最大化 / 关闭
#  参数：-ServerOnly  只保证后台服务在跑，不开窗口
#        -Force       即使已经有窗口，也再开一个新的
#        -Server      指定端口（默认 8787）
#  重要：本脚本可能在隐藏窗口里运行，所以**绝不使用 MessageBox**——
#        隐藏进程弹出的对话框没人能点，会把启动过程永久卡死，
#        用户看到的现象就是「双击了没反应、什么都没有」。
# ============================================================
param(
  [switch]$ServerOnly,
  [switch]$Force,
  [int]$Server = 8787
)
$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Port      = $Server
$Url       = "http://127.0.0.1:$Port"
$AppUrl    = "$Url/?app=1"
$OutLog    = Join-Path $Root 'server.log'
$ErrLog    = Join-Path $Root 'server.err.log'
$LastError = Join-Path $PSScriptRoot 'last-error.txt'
# 独立的浏览器配置目录放在用户目录下，避免污染项目文件夹
$Profile   = Join-Path $env:LOCALAPPDATA 'StockRadar\edge-profile'

function Show-Failure([string]$text) {
  try { Set-Content -LiteralPath $LastError -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + "`r`n" + $text) -Encoding UTF8 } catch { }
  Write-Host $text -ForegroundColor Red
  if ($env:STOCKRADAR_NO_POPUP -eq '1') { exit 1 }
  # 打开一个「可见」的窗口把错误摆出来，而不是弹一个没人能点的对话框
  try {
    # 同样要拼成一整条带引号的命令行：程序目录可能含空格（…\New project\…）。
    # 并把子进程输出重定向到文件，避免它继承调用方的管道句柄而让调用方假死。
    $show = "Write-Host '工作站启动失败，原因如下：' -ForegroundColor Red; " +
      "Get-Content -LiteralPath '$LastError' -Encoding UTF8; Write-Host ''; " +
      "Write-Host '服务错误日志（server.err.log）：' -ForegroundColor DarkGray; " +
      "Get-Content -LiteralPath '$ErrLog' -Tail 15 -ErrorAction SilentlyContinue"
    $argLine = '-NoProfile -NoExit -Command "' + $show + '"'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine `
      -RedirectStandardOutput (Join-Path $Root 'desktop-failure.log') `
      -RedirectStandardError (Join-Path $Root 'desktop-failure.err.log')
  } catch { }
  exit 1
}

function Test-Station {
  try {
    $r = Invoke-WebRequest "$Url/api/health" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Get-PortOwners {
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

function Start-StationServer {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Show-Failure "没有找到 node.exe。请先安装 Node.js（https://nodejs.org）再运行本程序。"
    return $false
  }
  if (-not (Test-Path (Join-Path $Root 'server\index.js'))) {
    Show-Failure "没有找到 $Root\server\index.js，请确认 desktop 文件夹和 server 在同一目录下。"
    return $false
  }

  # 端口被占：如果是我们自己的、已经不应答的 node 进程，先清掉；
  # 如果是别的程序，直接说清楚，而不是傻等 30 秒再卡住。
  foreach ($ownerPid in (Get-PortOwners)) {
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Write-Host "端口 $Port 被无响应的 node 进程占用（PID $ownerPid），先结束它…" -ForegroundColor Yellow
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    } else {
      $name = if ($proc) { $proc.ProcessName } else { '未知' }
      Show-Failure "端口 $Port 被其它程序占用（PID $ownerPid，$name）。请先关掉它，或换端口启动：start-station.ps1 -Server 8899"
      return $false
    }
  }
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-PortOwners).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }

  Start-Process -FilePath $node.Source -ArgumentList 'server/index.js' -WorkingDirectory $Root `
    -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Station) { return $true }
  }
  Show-Failure "服务在 30 秒内没有启动成功。"
  return $false
}

function Get-StationWindows {
  try { return [int](Invoke-RestMethod "$Url/api/window/state" -TimeoutSec 10).count }
  catch { return -1 }
}

function Focus-StationWindow {
  try { return [int](Invoke-RestMethod "$Url/api/window/focus" -Method Post -TimeoutSec 10).count }
  catch { return -1 }
}

# ---------- 1) 服务 ----------
if (-not (Test-Station)) {
  if (-not (Start-StationServer)) { exit 1 }
}
if ($ServerOnly) {
  Write-Host "工作站服务已在运行：$Url"
  exit 0
}

# ---------- 2) 已有窗口就聚焦，不重复开 ----------
if (-not $Force) {
  if ((Get-StationWindows) -gt 0) {
    if ((Focus-StationWindow) -gt 0) { exit 0 }
  }
}

# ---------- 3) 打开应用窗口 ----------
# 优先用 Edge 的「应用模式」——这样就是一个独立的程序窗口，而不是浏览器标签页
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge) {
  # Edge 的 stdout/stderr 重定向到文件，这样它就不会继承调用方的（可能是管道的）句柄。
  # 否则只要有人用管道接住本脚本的输出，就会一直等不到 EOF，表现为「双击后卡死、什么都没有」。
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=$AppUrl",
    "--user-data-dir=$Profile",
    '--window-size=1560,1020',
    '--window-position=60,30',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=9222'
  ) -RedirectStandardOutput (Join-Path $Root 'edge.log') -RedirectStandardError (Join-Path $Root 'edge.err.log')
} else {
  # 没装 Edge 就退回默认浏览器（窗口按钮在这种模式下不可用，界面会提示）
  Start-Process $AppUrl
}
