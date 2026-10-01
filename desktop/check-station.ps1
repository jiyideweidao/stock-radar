# ============================================================
#  股民舆情与商品看板 —— 一键自检
#  1) 确保后台服务在运行（没起来就先拉起来）
#  2) 运行完整自检（本机 + HTTP 接口 + 外部数据源）
#  3) 把结果按分组打印在窗口里，并写出一份 selfcheck-report.txt
#  参数：-Fast  只做本机快速自检（不联网，秒级）
# ============================================================
param([switch]$Fast)
$ErrorActionPreference = 'Stop'

$Root  = Split-Path -Parent $PSScriptRoot
$Port  = 8787
$Url   = "http://127.0.0.1:$Port"
$Scope = if ($Fast) { 'local' } else { 'full' }
$ScopeLabel = if ($Fast) { '快速自检（仅本机）' } else { '完整自检（含联网数据源）' }
$Report = Join-Path $Root 'selfcheck-report.txt'

function Test-Station {
  try {
    $r = Invoke-WebRequest "$Url/api/health" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Wait-Close {
  # 由脚本或自检自动化调用时（STOCKRADAR_NO_PAUSE=1）不阻塞等待按键
  if ($env:STOCKRADAR_NO_PAUSE -eq '1') { return }
  Read-Host '按回车键关闭'
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  股民舆情与商品看板 · 工作站自检' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

if (-not (Test-Station)) {
  Write-Host '后台服务没有在运行，正在启动…' -ForegroundColor Yellow
  # 关键 1：用独立的隐藏进程拉起后台服务，不要用管道（|）接住 start-station.ps1，
  #         否则管道句柄会被孙进程（node）继承，本窗口会一直等不到 EOF 而假死。
  # 关键 2：本程序所在目录可能带空格（例如 …\New project\…）。用 -ArgumentList 数组时
  #         PowerShell 不会自动给含空格的路径加引号，-File 会被从空格处截断，
  #         报「-File 参数失败 … 路径中包含未转义的空白字符」，服务永远起不来。
  #         所以这里自己拼好一整条带引号的命令行，再用单个字符串交给 -ArgumentList。
  $launcher = Join-Path $PSScriptRoot 'start-station.ps1'
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -ServerOnly -Server ' + $Port
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root 'desktop-launch.log') `
    -RedirectStandardError (Join-Path $Root 'desktop-launch.err.log') `
    -ArgumentList $argLine
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Station) { break }
  }
  if (-not (Test-Station)) {
    Write-Host ('服务启动失败。请查看 ' + (Join-Path $Root 'desktop-launch.err.log') + ' 或 desktop\last-error.txt') -ForegroundColor Red
    Wait-Close
    exit 1
  }
}
Write-Host ('服务地址：' + $Url) -ForegroundColor DarkGray
Write-Host ('检查模式：' + $ScopeLabel) -ForegroundColor DarkGray
Write-Host '正在检查，请稍候…' -ForegroundColor DarkGray
Write-Host ''

try {
  $result = Invoke-RestMethod "$Url/api/selfcheck?scope=$Scope" -TimeoutSec 300
} catch {
  Write-Host ('自检请求失败：' + $_.Exception.Message) -ForegroundColor Red
  Wait-Close
  exit 1
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add('工作站自检报告 · ' + $result.startedAt + ' · ' + $ScopeLabel)
[void]$lines.Add(('通过 {0} / 检查 {1} 项，异常 {2} 项，未执行 {3} 项，耗时 {4:N1} 秒' -f $result.summary.ok, ($result.summary.ok + $result.summary.fail), $result.summary.fail, $result.summary.skip, ($result.durationMs / 1000)))
[void]$lines.Add('')

foreach ($g in $result.groups) {
  Write-Host ('【' + $g.group + '】') -ForegroundColor White
  [void]$lines.Add('【' + $g.group + '】')
  foreach ($c in $g.checks) {
    $mark = if ($c.status -eq 'ok') { '[ OK ]' } elseif ($c.status -eq 'fail') { '[失败]' } else { '[跳过]' }
    $color = if ($c.status -eq 'ok') { 'Green' } elseif ($c.status -eq 'fail') { 'Red' } else { 'DarkGray' }
    Write-Host ('  ' + $mark + ' ' + $c.name) -ForegroundColor $color -NoNewline
    Write-Host ('  ' + $c.detail) -ForegroundColor DarkGray
    [void]$lines.Add('  ' + $mark + ' ' + $c.name + ' —— ' + $c.detail)
  }
  Write-Host ''
  [void]$lines.Add('')
}

$summaryColor = if ($result.summary.fail -gt 0) { 'Yellow' } else { 'Green' }
Write-Host ('结论：' + $result.summary.ok + '/' + ($result.summary.ok + $result.summary.fail) + ' 项通过，异常 ' + $result.summary.fail + ' 项') -ForegroundColor $summaryColor
[void]$lines.Add('结论：' + $result.summary.ok + '/' + ($result.summary.ok + $result.summary.fail) + ' 项通过，异常 ' + $result.summary.fail + ' 项')
[void]$lines.Add('说明：自检只判断工作站各模块与数据源是否可用，不构成任何投资建议。')

try {
  Set-Content -Path $Report -Value $lines -Encoding UTF8
  Write-Host ('报告已保存：' + $Report) -ForegroundColor DarkGray
} catch {
  Write-Host '报告写入失败，可忽略。' -ForegroundColor DarkGray
}

Write-Host ''
Wait-Close
