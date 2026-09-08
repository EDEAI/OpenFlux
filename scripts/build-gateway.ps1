# build-gateway.ps1
# Prepare gateway for Tauri bundling
# Creates a production-ready gateway directory with flat node_modules
# (npm instead of pnpm to avoid deep .pnpm symlink nesting that causes stack overflow)

$ErrorActionPreference = 'Stop'
$workspace_dir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gateway_dir = Join-Path $workspace_dir 'gateway'
$prod_dir = Join-Path $workspace_dir 'gateway-prod'
$bundled_node = Join-Path $workspace_dir 'src-tauri\node.exe'
$verify_dependencies = Join-Path $PSScriptRoot 'verify-gateway-bundle.mjs'

# Only generated bundle contents may be deleted. Reject junctions/symlinks so
# a stale build directory cannot redirect cleanup outside this workspace.
function Remove-BundleItem([string]$Path) {
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if ($resolved -ne $prod_dir -and !$resolved.StartsWith($prod_dir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside gateway-prod: $resolved"
    }
    $current = $resolved
    while ($current.Length -ge $prod_dir.Length) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to clean a reparse point: $current"
            }
        }
        $current = Split-Path -Path $current -Parent
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

if (!(Test-Path -LiteralPath $bundled_node -PathType Leaf)) {
    throw "Bundled node.exe is required: $bundled_node"
}
$runtime = & $bundled_node -p 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $runtime.platform -ne 'win32' -or $runtime.arch -ne 'x64') {
    throw 'The Windows bundle requires a working win32/x64 bundled Node runtime.'
}
& $bundled_node $verify_dependencies --verify-lock $gateway_dir
if ($LASTEXITCODE -ne 0) { throw 'Gateway dependency lock validation failed.' }
& $bundled_node (Join-Path $PSScriptRoot 'validate-embedding-model.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bundled embedding model validation failed.' }
# npm.cmd can invoke its own Node even after PATH is changed (e.g. ServBay).
# Discover npm's CLI once, then run it explicitly with the packaged Node.
$npm_cli = (npm exec --offline --call 'node -p process.env.npm_execpath' | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $npm_cli -PathType Leaf)) {
    throw 'Could not resolve the installed npm CLI.'
}
$vc_runtime_dir = Join-Path $PSScriptRoot "..\src-tauri\resources\windows\vc-runtime"
$validate_vc_runtime = Join-Path $PSScriptRoot "validate-vc-runtime.ps1"

Write-Host "[build-gateway] Preparing production gateway bundle..."

# Clean old prod directory
if (Test-Path $prod_dir) {
    Write-Host "[build-gateway] Cleaning old gateway-prod..."
    Remove-BundleItem $prod_dir
}
New-Item -ItemType Directory -Path $prod_dir | Out-Null

# Copy gateway source
Write-Host "[build-gateway] Copying src/..."
Copy-Item -Path (Join-Path $gateway_dir "src") -Destination (Join-Path $prod_dir "src") -Recurse

# Keep package.json identical to its lock; npm ci omits dev packages itself.
Write-Host "[build-gateway] Copying package.json and package-lock.json..."
Copy-Item -LiteralPath (Join-Path $gateway_dir 'package.json'), (Join-Path $gateway_dir 'package-lock.json') -Destination $prod_dir

# Install production dependencies with npm (flat node_modules, no .pnpm nesting)
# NOTE: npm outputs warnings to stderr which PowerShell treats as errors
# so we temporarily set ErrorActionPreference to Continue
Write-Host "[build-gateway] Installing locked production dependencies with bundled Node $($runtime.version)..."
$oldEAP = $ErrorActionPreference
$oldPath = $env:PATH
$ErrorActionPreference = "Continue"
$env:PATH = "$(Split-Path $bundled_node -Parent);$env:PATH"

Push-Location $prod_dir
try {
    & $bundled_node $npm_cli ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        throw '[build-gateway] npm ci failed'
    }
    # tsx is already a locked production dependency. Rebuild only the native
    # addons whose lifecycle was skipped, using the runtime's Node ABI.
    Write-Host "[build-gateway] Rebuilding better-sqlite3 and Windows keysender..."
    & $bundled_node $npm_cli rebuild better-sqlite3 keysender 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw '[build-gateway] Native addon rebuild failed' }
}
finally {
    Pop-Location
    $env:PATH = $oldPath
    $ErrorActionPreference = $oldEAP
}

# Remove non-win32 platform binaries to reduce size
Write-Host "[build-gateway] Removing non-win32 platform binaries..."
$nm = Join-Path $prod_dir "node_modules"

# onnxruntime: keep only win32/x64
$onnx_root = & $bundled_node $verify_dependencies --onnx-root $prod_dir
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the packaged ONNX runtime.' }
$onnx_node = Join-Path $onnx_root 'bin'
if (Test-Path $onnx_node) {
    # Compatible with napi-v3 (1.14.x) and napi-v6 (1.21.x)
    Get-ChildItem $onnx_node -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $napi_dir_onnx = $_.FullName
        Get-ChildItem $napi_dir_onnx -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "win32" } |
        ForEach-Object { Remove-BundleItem $_.FullName }
        $win32_dir = Join-Path $napi_dir_onnx "win32"
        if (Test-Path $win32_dir) {
            Get-ChildItem $win32_dir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne "x64" } |
            ForEach-Object { Remove-BundleItem $_.FullName }
        }
    }
}

# sharp: remove non-win32 platform-specific packages (keep pure JS like @img/colour)
$img_dir = Join-Path $nm "@img"
if (Test-Path $img_dir) {
    Get-ChildItem $img_dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "(darwin|linux|android|freebsd|linuxmusl)" } |
    ForEach-Object { Remove-BundleItem $_.FullName }
}

# canvas: keep the platform-neutral loader package plus Windows native binaries.
# pdfjs-dist imports @napi-rs/canvas at startup; deleting the loader while keeping
# only canvas-win32-* makes the packaged Gateway exit before it can open its port.
$napi_dir = Join-Path $nm "@napi-rs"
if (Test-Path $napi_dir) {
    Get-ChildItem $napi_dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "canvas" -and $_.Name -notlike "*win32*" } |
    ForEach-Object { Remove-BundleItem $_.FullName }

    $requiredCanvasPackages = @("canvas", "canvas-win32-x64-msvc")
    foreach ($packageName in $requiredCanvasPackages) {
        if (!(Test-Path (Join-Path $napi_dir $packageName))) {
            throw "Required packaged dependency is missing: @napi-rs/$packageName"
        }
    }
}

# onnxruntime-web: Node side does not require web runtime
Write-Host "[build-gateway] Removing onnxruntime-web (not needed for Node)..."
$onnx_web = Join-Path $nm "onnxruntime-web"
if (Test-Path $onnx_web) { Remove-BundleItem $onnx_web }

# Preserve nested node/common dependencies: npm's lock can require them here.
# Only the web runtime is unused by transformers.node.mjs.
Write-Host "[build-gateway] Cleaning nested web runtime..."
$hf_inner_nm = Join-Path $nm "@huggingface\transformers\node_modules"
if (Test-Path $hf_inner_nm) {
    @("onnxruntime-web") | ForEach-Object {
        $inner = Join-Path $hf_inner_nm $_
        if (Test-Path $inner) { Remove-BundleItem $inner }
    }
}

# @huggingface/transformers: Delete the dist file on the web side (only use.node.mjs/.node.cjs on the Node side)
$hf_dist = Join-Path $nm "@huggingface\transformers\dist"
if (Test-Path $hf_dist) {
    Get-ChildItem $hf_dist -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.web.*" -or $_.Name -like "*.min.*" } |
    ForEach-Object { Remove-BundleItem $_.FullName }
}

# Validate and copy app-local VC++ CRT runtime for packaged onnxruntime-node
Write-Host "[build-gateway] Validating app-local VC++ CRT runtime..."
& $validate_vc_runtime -RuntimeDir $vc_runtime_dir

$onnxruntime_runtime_dirs = @(Get-ChildItem -LiteralPath $onnx_node -Directory | ForEach-Object {
    $candidate = Join-Path $_.FullName 'win32\x64'
    if (Test-Path -LiteralPath $candidate -PathType Container) { $candidate }
})
if ($onnxruntime_runtime_dirs.Count -eq 0) { throw 'No win32/x64 ONNX runtime directory was packaged.' }

Write-Host "[build-gateway] Copying app-local VC++ CRT runtime into onnxruntime-node..."
foreach ($onnxruntime_runtime_dir in $onnxruntime_runtime_dirs) {
    Copy-Item (Join-Path $vc_runtime_dir "*.dll") $onnxruntime_runtime_dir -Force
}

# Copy pre-downloaded embedding model to resources/
Write-Host "[build-gateway] Copying embedding model..."
$model_src = Join-Path $PSScriptRoot "..\src-tauri\resources\models"
$model_dest = Join-Path $prod_dir "resources\models"
if (Test-Path $model_src) {
    New-Item -ItemType Directory -Force -Path (Split-Path $model_dest -Parent) | Out-Null
    Copy-Item $model_src $model_dest -Recurse -Force
    Write-Host "[build-gateway] Embedding model copied."
}

& $bundled_node $verify_dependencies --verify-bundle $prod_dir
if ($LASTEXITCODE -ne 0) { throw 'Packaged gateway dependency smoke test failed.' }

# Report size
$total = (Get-ChildItem $prod_dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "[build-gateway] Production gateway size: $([math]::Round($total, 1))MB"

# Package as tar.gz for Tauri bundling
Write-Host "[build-gateway] Packaging gateway-bundle.tar.gz..."
$tar_output = Join-Path $PSScriptRoot "..\src-tauri\gateway-bundle.tar.gz"
if (Test-Path $tar_output) { Remove-Item $tar_output -Force }

# Write gateway build ID (source fingerprint + build time) into the bundle.
# The build-time component is intentional: production dependency pruning can
# change the bundle even when gateway/src timestamps do not. A fresh ID makes a
# same-version reinstall re-extract the corrected Gateway instead of reusing it.
$srcDir = Join-Path $prod_dir "src"
$srcFiles = Get-ChildItem $srcDir -Recurse -File | Sort-Object FullName
$sourceFingerprint = ($srcFiles | ForEach-Object {
    "$($_.FullName):$($_.LastWriteTimeUtc.Ticks)"
}) -join "`n"
$hashInput = "$sourceFingerprint`nbuild:$([DateTime]::UtcNow.Ticks)"
$hashBytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hashHex = ($sha.ComputeHash($hashBytes) | ForEach-Object { $_.ToString("x2") }) -join ""
$buildId = $hashHex.Substring(0, 16)  # 16-char prefix is enough
$buildId | Set-Content (Join-Path $prod_dir "gateway-build-id.txt") -NoNewline
Write-Host "[build-gateway] Gateway build ID: $buildId"

tar -czf $tar_output -C $prod_dir .
if ($LASTEXITCODE -ne 0) { throw 'Gateway archive creation failed.' }
$tar_size = [math]::Round((Get-Item $tar_output).Length / 1MB, 1)
Write-Host "[build-gateway] Done! gateway-bundle.tar.gz: ${tar_size}MB"
