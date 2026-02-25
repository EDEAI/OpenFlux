# ============================================================
# OpenFlux-Rust - Reset to Factory Defaults
# ============================================================

param(
    [switch]$Force,
    [switch]$KeepBuild,
    [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host ""
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "  OpenFlux-Rust Reset to Factory"         -ForegroundColor Cyan
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host ""
Write-Host "Project: $ProjectRoot" -ForegroundColor Gray
Write-Host ""

# 1. Confirm
if (-not $Force) {
    Write-Host "Will clean:" -ForegroundColor Yellow
    Write-Host "  [1] server-config.json, settings.json"
    Write-Host "  [2] sessions/"
    Write-Host "  [3] openflux_memory.db"
    Write-Host "  [4] logs/"
    Write-Host "  [5] scheduler/"
    Write-Host "  [6] .workflows/"
    if (-not $KeepBuild) {
        Write-Host "  [7] dist/, gateway/dist/, src-tauri/target/"
        Write-Host "  [8] node_modules/, gateway/node_modules/"
    }
    if (-not $KeepConfig) {
        Write-Host "  [9] openflux.yaml (restore from example)" -ForegroundColor Red
    }
    Write-Host ""
    $confirm = Read-Host "Confirm? (y/N)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host "Cancelled." -ForegroundColor Gray
        exit 0
    }
}

Write-Host ""

# 2. Kill processes
Write-Host "[1/5] Stopping processes..." -ForegroundColor Cyan

$viteProcs = Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $viteProcs) {
    Write-Host "  Kill Vite PID=$pid" -ForegroundColor Yellow
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}

$gwProcs = Get-NetTCPConnection -LocalPort 18801 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $gwProcs) {
    Write-Host "  Kill Gateway PID=$pid" -ForegroundColor Yellow
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}

Get-Process -Name "openflux-rust" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  Kill openflux-rust.exe PID=$($_.Id)" -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Write-Host "  Done" -ForegroundColor Green

# 3. Clean runtime data
Write-Host "[2/5] Cleaning runtime data..." -ForegroundColor Cyan

$runtimeFiles = @(
    "server-config.json",
    "settings.json",
    "openflux_memory.db",
    "openflux_memory.db-wal",
    "openflux_memory.db-shm"
)

foreach ($item in $runtimeFiles) {
    $path = Join-Path $ProjectRoot $item
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  Deleted $item" -ForegroundColor Yellow
    }
}

$runtimeDirs = @(
    "sessions",
    "logs",
    "scheduler",
    ".workflows"
)

foreach ($dir in $runtimeDirs) {
    $path = Join-Path $ProjectRoot $dir
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
        Write-Host "  Deleted $dir/" -ForegroundColor Yellow
    }
}

$userDataDir = Join-Path $env:USERPROFILE ".openflux"
if (Test-Path $userDataDir) {
    Remove-Item $userDataDir -Recurse -Force
    Write-Host "  Deleted ~/.openflux/" -ForegroundColor Yellow
}

Write-Host "  Done" -ForegroundColor Green

# 4. Clean build artifacts (optional)
if (-not $KeepBuild) {
    Write-Host "[3/5] Cleaning build artifacts..." -ForegroundColor Cyan

    $buildDirs = @(
        "dist",
        "gateway\dist",
        "src-tauri\target",
        "node_modules",
        "gateway\node_modules"
    )

    foreach ($dir in $buildDirs) {
        $path = Join-Path $ProjectRoot $dir
        if (Test-Path $path) {
            Write-Host "  Deleting $dir/ ..." -ForegroundColor Yellow -NoNewline
            Remove-Item $path -Recurse -Force
            Write-Host " Done" -ForegroundColor Green
        }
    }
}
else {
    Write-Host "[3/5] Skip build clean (--KeepBuild)" -ForegroundColor Gray
}

# 5. Restore config (optional)
if (-not $KeepConfig) {
    Write-Host "[4/5] Restoring default config..." -ForegroundColor Cyan

    $exampleConfig = Join-Path $ProjectRoot "openflux.example.yaml"
    $mainConfig = Join-Path $ProjectRoot "openflux.yaml"

    if (Test-Path $exampleConfig) {
        Copy-Item $exampleConfig $mainConfig -Force
        Write-Host "  openflux.yaml <- openflux.example.yaml" -ForegroundColor Yellow
    }
    elseif (Test-Path $mainConfig) {
        $backupName = "openflux.yaml.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $mainConfig (Join-Path $ProjectRoot $backupName) -Force
        Write-Host "  Backed up: openflux.yaml -> $backupName" -ForegroundColor Yellow
    }
}
else {
    Write-Host "[4/5] Skip config restore (--KeepConfig)" -ForegroundColor Gray
}

# 6. Done
Write-Host "[5/5] Reset complete!" -ForegroundColor Cyan
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Factory Reset Done"                     -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

if (-not $KeepBuild) {
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host '  pnpm install' -ForegroundColor Gray
    Write-Host '  cd gateway; pnpm install; cd ..' -ForegroundColor Gray
    Write-Host '  pnpm tauri dev' -ForegroundColor Gray
}
else {
    Write-Host "Next step:" -ForegroundColor White
    Write-Host '  pnpm tauri dev' -ForegroundColor Gray
}
Write-Host ""
