Add-Type -AssemblyName System.Drawing
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $base "src-tauri\icons\icon_256.png"
$sizes = @(16, 32, 80)
$plugins = @("word", "excel")
$img = [System.Drawing.Image]::FromFile($src)
foreach ($plugin in $plugins) {
    $assetsDir = Join-Path $base "src-tauri\resources\plugins\$plugin\assets"
    New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.DrawImage($img, 0, 0, $size, $size)
        $g.Dispose()
        $outPath = Join-Path $assetsDir "icon-$size.png"
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "Created: $outPath"
    }
}
$img.Dispose()
Write-Host "Done."
