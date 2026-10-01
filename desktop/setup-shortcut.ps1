# 一次性安装：生成图标 + 在桌面创建快捷方式（启动 + 自检）
$here = $PSScriptRoot
$root = Split-Path -Parent $here

& (Join-Path $here 'make-icon.ps1')

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

function New-DesktopShortcut([string]$cmdName, [string]$lnkName, [string]$desc) {
  $cmd = Join-Path $here $cmdName
  if (-not (Test-Path -LiteralPath $cmd)) { Write-Host "找不到 $cmd"; return }
  $lnk = Join-Path $desktop $lnkName
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $cmd
  $sc.WorkingDirectory = $root
  $sc.Description = $desc
  if (Test-Path -LiteralPath (Join-Path $here 'station.ico')) { $sc.IconLocation = (Join-Path $here 'station.ico') }
  $sc.WindowStyle = 1
  $sc.Save()
  Write-Host "桌面快捷方式已创建：$lnk"
}

New-DesktopShortcut '启动工作站.cmd' '股民舆情工作站.lnk' '股民舆情与商品看板：新闻 / 选股建议 / 股吧 / 煤炭库存与进口 / 个股体检'
New-DesktopShortcut '自检工作站.cmd' '股民舆情工作站-自检.lnk' '工作站自检：本机 + 接口 + 外部数据源逐项检查'
New-DesktopShortcut '停止工作站.cmd' '股民舆情工作站-停止.lnk' '停止工作站后台服务（只结束占用 8787 端口的 node 进程）'
