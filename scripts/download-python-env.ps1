# Download Python embeddable + uv.exe for OpenFlux bundling
# Run once before building the installer:
#   powershell -ExecutionPolicy Bypass -File scripts/download-python-env.ps1
#
# Output:
#   src-tauri/resources/python/python-embed.zip   (~11MB)
#   src-tauri/resources/python/uv.exe             (~12MB)

param(
    [string]$PythonVersion = "3.11.9",
    [string]$OutputDir = "$PSScriptRoot\..\src-tauri\resources\python"
)

$ErrorActionPreference = "Stop"

$resolvedDir = Resolve-Path "$PSScriptRoot\..\src-tauri\resources\python" -ErrorAction SilentlyContinue
if ($resolvedDir) {
    $OutputDir = $resolvedDir.Path
} else {
    $OutputDir = "$PSScriptRoot\..\src-tauri\resources\python"
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "[OpenFlux] Downloading Python $PythonVersion embeddable..." -ForegroundColor Cyan
$pythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$pythonOut = Join-Path $OutputDir "python-embed.zip"

if (Test-Path $pythonOut) {
    Write-Host "  python-embed.zip already exists, skipping." -ForegroundColor Yellow
} else {
    Write-Host "  Downloading from $pythonUrl"
    Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonOut -UseBasicParsing
    $size = (Get-Item $pythonOut).Length / 1MB
    Write-Host "  Done. Size: $([math]::Round($size, 1)) MB" -ForegroundColor Green
}

Write-Host ""
Write-Host "[OpenFlux] Downloading uv.exe (latest release)..." -ForegroundColor Cyan
$uvZipUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
$uvOut    = Join-Path $OutputDir "uv.exe"

if (Test-Path $uvOut) {
    Write-Host "  uv.exe already exists, skipping." -ForegroundColor Yellow
} else {
    $uvZipTmp = Join-Path $env:TEMP "uv-download.zip"
    $uvExtTmp = Join-Path $env:TEMP "uv-extracted"
    Write-Host "  Downloading from $uvZipUrl"
    Invoke-WebRequest -Uri $uvZipUrl -OutFile $uvZipTmp -UseBasicParsing
    if (Test-Path $uvExtTmp) { Remove-Item $uvExtTmp -Recurse -Force }
    Expand-Archive -Path $uvZipTmp -DestinationPath $uvExtTmp -Force
    # uv releases contain uv.exe at root or in a subdirectory
    $uvExe = Get-ChildItem -Path $uvExtTmp -Filter "uv.exe" -Recurse | Select-Object -First 1
    if (-not $uvExe) { throw "uv.exe not found in downloaded archive" }
    Copy-Item $uvExe.FullName $uvOut -Force
    Remove-Item $uvZipTmp -Force
    Remove-Item $uvExtTmp -Recurse -Force
    $size = (Get-Item $uvOut).Length / 1MB
    Write-Host "  Done. Size: $([math]::Round($size, 1)) MB" -ForegroundColor Green
}

Write-Host ""
Write-Host "[OpenFlux] Python environment assets ready:" -ForegroundColor Green
Write-Host "  $pythonOut"
Write-Host "  $uvOut"

# ── file_reader 工具依赖预装（~15MB，无 magika/onnxruntime/numpy）─────────────
# 按格式直接调用对应库，支持：docx / xlsx / xls / pptx / pdf / csv / html / epub
# ─────────────────────────────────────────────────────────────────────────────
$baseDir = Join-Path $OutputDir "base"
$pythonExe = Join-Path $baseDir "python.exe"
$uvExe = $uvOut

if (Test-Path $pythonExe) {
    Write-Host ""
    Write-Host "[OpenFlux] Installing file_reader dependencies into bundled Python..." -ForegroundColor Cyan

    $deps = @(
        @{ name = "python-docx";        desc = "DOCX (Word)" },
        @{ name = "openpyxl";           desc = "XLSX/XLS (Excel)" },
        @{ name = "python-pptx";        desc = "PPTX (PowerPoint)" },
        @{ name = "pdfminer.six";       desc = "PDF text extraction" },
        @{ name = "beautifulsoup4";      desc = "HTML parsing" },
        @{ name = "soupsieve";          desc = "bs4 internal dep" },
        @{ name = "markdownify";        desc = "HTML → Markdown" },
        @{ name = "ebooklib";           desc = "EPUB" },
        @{ name = "defusedxml";         desc = "safe XML parsing" },
        @{ name = "charset-normalizer"; desc = "encoding detection" },
        @{ name = "lxml";               desc = "fast XML (docx/epub)" },
        @{ name = "olefile";            desc = ".doc/.xls legacy" }
    )

    foreach ($dep in $deps) {
        Write-Host "  $($dep.name.PadRight(22)) ($($dep.desc))..." -NoNewline
        $null = & $uvExe pip install $dep.name --python $pythonExe 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " OK" -ForegroundColor Green
        } else {
            Write-Host " WARN (non-fatal)" -ForegroundColor Yellow
        }
    }

    # 验证核心模块
    $checks = @("docx", "openpyxl", "pptx", "pdfminer", "bs4", "markdownify")
    $allOk = $true
    foreach ($mod in $checks) {
        $result = & $pythonExe -c "import $mod" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: $mod import failed" -ForegroundColor Yellow
            $allOk = $false
        }
    }

    $afterSize = (Get-ChildItem $baseDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
    if ($allOk) {
        Write-Host "[OpenFlux] file_reader deps ready. Python base: $([math]::Round($afterSize, 1)) MB" -ForegroundColor Green
    } else {
        Write-Host "[OpenFlux] file_reader deps installed (some warnings). Python base: $([math]::Round($afterSize, 1)) MB" -ForegroundColor Yellow
    }
} else {
    Write-Host "[OpenFlux] WARNING: base/python.exe not found, skipping file_reader deps install." -ForegroundColor Yellow
    Write-Host "  Run this script AFTER extracting the Python embeddable zip."
}
