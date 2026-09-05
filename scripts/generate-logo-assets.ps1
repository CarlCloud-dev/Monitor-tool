$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $projectRoot 'src\renderer\assets'
New-Item -ItemType Directory -Path $assetDirectory -Force | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-LogoBitmap([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 256.0
  $outer = New-RoundedPath (14 * $scale) (14 * $scale) (228 * $scale) (228 * $scale) (58 * $scale)
  $surface = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.RectangleF]::new(14 * $scale, 14 * $scale, 228 * $scale, 228 * $scale),
    [System.Drawing.Color]::FromArgb(255, 32, 41, 43),
    [System.Drawing.Color]::FromArgb(255, 16, 21, 23),
    135
  )
  $graphics.FillPath($surface, $outer)
  $border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 57, 69, 72), (6 * $scale))
  $border.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
  $graphics.DrawPath($border, $outer)

  $pulsePoints = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(52 * $scale, 163 * $scale),
    [System.Drawing.PointF]::new(86 * $scale, 163 * $scale),
    [System.Drawing.PointF]::new(103 * $scale, 106 * $scale),
    [System.Drawing.PointF]::new(127 * $scale, 197 * $scale),
    [System.Drawing.PointF]::new(150 * $scale, 132 * $scale),
    [System.Drawing.PointF]::new(167 * $scale, 163 * $scale),
    [System.Drawing.PointF]::new(204 * $scale, 163 * $scale)
  )
  $pulse = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 174, 239, 54), (15 * $scale))
  $pulse.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pulse.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pulse.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLines($pulse, $pulsePoints)

  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 197, 255, 91))
  $dotSize = 18 * $scale
  $graphics.FillEllipse($dotBrush, (195 * $scale), (154 * $scale), $dotSize, $dotSize)
  $baseline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 107, 122, 120), (5 * $scale))
  $baseline.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $baseline.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($baseline, (52 * $scale), (193 * $scale), (204 * $scale), (193 * $scale))

  $outputPath = Join-Path $assetDirectory ("logo-mark-{0}.png" -f $size)
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $baseline.Dispose(); $dotBrush.Dispose(); $pulse.Dispose(); $border.Dispose(); $surface.Dispose(); $outer.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  return $outputPath
}

$png256 = New-LogoBitmap 256
$png32 = New-LogoBitmap 32
$icoPath = Join-Path $assetDirectory 'logo-mark.ico'
$icoBitmap = [System.Drawing.Bitmap]::FromFile($png256)
$iconHandle = $icoBitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$icoStream = [System.IO.File]::Create($icoPath)
try { $icon.Save($icoStream) } finally { $icoStream.Dispose() }
$icon.Dispose(); $icoBitmap.Dispose()
Write-Output "Generated $png256, $png32 and $icoPath"
