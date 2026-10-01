# 生成站点图标（station.ico）——纯 System.Drawing 绘制，不依赖任何外部素材
Add-Type -AssemblyName System.Drawing

$ico = Join-Path $PSScriptRoot 'station.ico'
$S = 256
$bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$r = 46
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($S - $r, 0, $r, $r, 270, 90)
$path.AddArc($S - $r, $S - $r, $r, $r, 0, 90)
$path.AddArc(0, $S - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 12, 17, 27))), $path)
$g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 48, 64, 96)), 4), $path)

$gridPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(50, 90, 120, 170)), 1
foreach ($y in 76, 128, 180) { $g.DrawLine($gridPen, 26, $y, $S - 26, $y) }

$upColor = [System.Drawing.Color]::FromArgb(255, 255, 77, 79)
$downColor = [System.Drawing.Color]::FromArgb(255, 23, 201, 100)
$candles = @(
  @{ x = 54; top = 152; bot = 198; hi = 138; lo = 212; up = $true },
  @{ x = 94; top = 130; bot = 170; hi = 118; lo = 184; up = $true },
  @{ x = 134; top = 120; bot = 160; hi = 106; lo = 172; up = $false },
  @{ x = 174; top = 100; bot = 144; hi = 88; lo = 158; up = $true },
  @{ x = 214; top = 82; bot = 124; hi = 70; lo = 138; up = $true }
)
foreach ($c in $candles) {
  $col = if ($c.up) { $upColor } else { $downColor }
  $pen = New-Object System.Drawing.Pen $col, 3
  $g.DrawLine($pen, $c.x, $c.hi, $c.x, $c.lo)
  $h = [Math]::Max(3, $c.bot - $c.top)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $col), $c.x - 9, $c.top, 18, $h)
  $pen.Dispose()
}
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()
$ms.Dispose()

$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
$bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
$bw.Write([UInt16]1); $bw.Write([UInt16]32)
$bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)
$bw.Write($png)
$bw.Flush(); $bw.Close()
Write-Host "图标已生成：$ico ($($png.Length) 字节 PNG 载荷)"