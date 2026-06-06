param(
  [string]$OutputIco = (Join-Path $PSScriptRoot '..\resources\icon.ico'),
  [string]$OutputPng = (Join-Path $PSScriptRoot '..\resources\icon.png')
)

Add-Type -AssemblyName System.Drawing

function New-Color {
  param([string]$Hex)
  [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function New-RoundedPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  $path
}

function New-ScaledPoint {
  param(
    [float]$X,
    [float]$Y,
    [float]$Scale
  )
  New-Object System.Drawing.PointF(($X * $Scale), ($Y * $Scale))
}

function New-IconPngBytes {
  param([int]$Size)

  $scale = $Size / 256.0
  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

  try {
    $bounds = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $bounds,
      (New-Color '#22c7b4'),
      (New-Color '#0b5f58'),
      45
    )
    $graphics.FillRectangle($background, $bounds)
    $background.Dispose()

    $softMint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(42, (New-Color '#dffbf6')))
    $topWave = New-Object System.Drawing.Drawing2D.GraphicsPath
    $topWave.AddBezier(
      (New-ScaledPoint 38 76 $scale),
      (New-ScaledPoint 78 24 $scale),
      (New-ScaledPoint 126 30 $scale),
      (New-ScaledPoint 164 46 $scale)
    )
    $topWave.AddBezier(
      (New-ScaledPoint 194 58 $scale),
      (New-ScaledPoint 213 50 $scale),
      (New-ScaledPoint 226 36 $scale),
      (New-ScaledPoint 226 36 $scale)
    )
    $topWave.AddLine((New-ScaledPoint 226 112 $scale), (New-ScaledPoint 40 152 $scale))
    $topWave.CloseFigure()
    $graphics.FillPath($softMint, $topWave)
    $topWave.Dispose()
    $softMint.Dispose()

    $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(45, (New-Color '#073c37')))
    $shadowPath = New-RoundedPath (72 * $scale) (72 * $scale) (120 * $scale) (150 * $scale) (26 * $scale)
    $graphics.FillPath($shadowBrush, $shadowPath)
    $shadowPath.Dispose()
    $shadowBrush.Dispose()

    $sheetPath = New-RoundedPath (66 * $scale) (58 * $scale) (120 * $scale) (154 * $scale) (26 * $scale)
    $sheetBounds = New-Object System.Drawing.RectangleF((66 * $scale), (58 * $scale), (120 * $scale), (154 * $scale))
    $sheetBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $sheetBounds,
      (New-Color '#ffffff'),
      (New-Color '#dffbf6'),
      90
    )
    $graphics.FillPath($sheetBrush, $sheetPath)
    $sheetBrush.Dispose()
    $sheetPath.Dispose()

    $clipShadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(54, (New-Color '#073c37')))
    $clipShadowPath = New-RoundedPath (86 * $scale) (50 * $scale) (84 * $scale) (42 * $scale) (18 * $scale)
    $graphics.FillPath($clipShadow, $clipShadowPath)
    $clipShadowPath.Dispose()
    $clipShadow.Dispose()

    $clipPath = New-RoundedPath (92 * $scale) (40 * $scale) (72 * $scale) (42 * $scale) (18 * $scale)
    $clipBrush = New-Object System.Drawing.SolidBrush((New-Color '#ecfff9'))
    $graphics.FillPath($clipBrush, $clipPath)
    $clipBrush.Dispose()
    $clipPath.Dispose()

    $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, (New-Color '#0f766e')))
    $line1 = New-RoundedPath (88 * $scale) (84 * $scale) (80 * $scale) (15 * $scale) (7.5 * $scale)
    $graphics.FillPath($lineBrush, $line1)
    $line1.Dispose()
    $lineBrush.Dispose()

    $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(62, (New-Color '#0f766e')))
    foreach ($line in @(
        @(88, 116, 56, 12),
        @(88, 140, 80, 12),
        @(88, 164, 62, 12)
      )) {
      $path = New-RoundedPath ($line[0] * $scale) ($line[1] * $scale) ($line[2] * $scale) ($line[3] * $scale) (6 * $scale)
      $graphics.FillPath($mutedBrush, $path)
      $path.Dispose()
    }
    $mutedBrush.Dispose()

    $slot = New-RoundedPath (110 * $scale) (56 * $scale) (36 * $scale) (10 * $scale) (5 * $scale)
    $slotBrush = New-Object System.Drawing.SolidBrush((New-Color '#0f8f83'))
    $graphics.FillPath($slotBrush, $slot)
    $slotBrush.Dispose()
    $slot.Dispose()

    $bolt = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bolt.AddPolygon([System.Drawing.PointF[]]@(
        (New-ScaledPoint 168 95 $scale),
        (New-ScaledPoint 131 148 $scale),
        (New-ScaledPoint 159 148 $scale),
        (New-ScaledPoint 146 202 $scale),
        (New-ScaledPoint 191 134 $scale),
        (New-ScaledPoint 162 134 $scale),
        (New-ScaledPoint 183 95 $scale)
      ))
    $boltBrush = New-Object System.Drawing.SolidBrush((New-Color '#f97316'))
    $graphics.FillPath($boltBrush, $bolt)
    $boltBrush.Dispose()
    $bolt.Dispose()

    $accentBrush = New-Object System.Drawing.SolidBrush((New-Color '#f97316'))
    $graphics.FillEllipse($accentBrush, (48 * $scale), (52 * $scale), (16 * $scale), (16 * $scale))
    $accentBrush.Dispose()

    $glowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(165, (New-Color '#9ff3e7')))
    $graphics.FillEllipse($glowBrush, (201 * $scale), (178 * $scale), (20 * $scale), (20 * $scale))
    $glowBrush.Dispose()
  }
  finally {
    $graphics.Dispose()
  }

  $stream = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream.ToArray()
  }
  finally {
    $stream.Dispose()
    $bitmap.Dispose()
  }
}

function Write-IconFile {
  param(
    [string]$Path,
    [object[]]$Images
  )

  $directory = Split-Path -Parent $Path
  if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $file = [System.IO.File]::Create($Path)
  $writer = New-Object System.IO.BinaryWriter($file)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$Images.Count)

    $offset = 6 + (16 * $Images.Count)
    foreach ($image in $Images) {
      $sizeByte = if ($image.Size -ge 256) { 0 } else { [byte]$image.Size }
      $writer.Write([byte]$sizeByte)
      $writer.Write([byte]$sizeByte)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$image.Bytes.Length)
      $writer.Write([UInt32]$offset)
      $offset += $image.Bytes.Length
    }

    foreach ($image in $Images) {
      $writer.Write([byte[]]$image.Bytes)
    }
  }
  finally {
    $writer.Dispose()
    $file.Dispose()
  }
}

$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = foreach ($size in $iconSizes) {
  [PSCustomObject]@{
    Size = $size
    Bytes = New-IconPngBytes -Size $size
  }
}

Write-IconFile -Path $OutputIco -Images $images
[System.IO.File]::WriteAllBytes($OutputPng, (New-IconPngBytes -Size 256))
Write-Host "Generated $OutputIco and $OutputPng"
