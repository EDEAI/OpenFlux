# build-gateway.ps1
# Prepare gateway for Tauri bundling
# Creates a production-ready gateway directory with flat node_modules
# (npm instead of pnpm to avoid deep .pnpm symlink nesting that causes stack overflow)

$gateway_dir = Join-Path $PSScriptRoot "..\gateway"
$prod_dir = Join-Path $PSScriptRoot "..\gateway-prod"
$vc_runtime_dir = Join-Path $PSScriptRoot "..\src-tauri\resources\windows\vc-runtime"
$validate_vc_runtime = Join-Path $PSScriptRoot "validate-vc-runtime.ps1"

Write-Host "[build-gateway] Preparing production gateway bundle..."

# Clean old prod directory
if (Test-Path $prod_dir) {
    Write-Host "[build-gateway] Cleaning old gateway-prod..."
    Remove-Item $prod_dir -Recurse -Force
}
New-Item -ItemType Directory -Path $prod_dir | Out-Null

# Copy gateway source
Write-Host "[build-gateway] Copying src/..."
Copy-Item -Path (Join-Path $gateway_dir "src") -Destination (Join-Path $prod_dir "src") -Recurse

# Copy package.json (remove devDependencies for npm install)
Write-Host "[build-gateway] Copying package.json..."
$pkg = Get-Content (Join-Path $gateway_dir "package.json") -Raw | ConvertFrom-Json
$pkg.PSObject.Properties.Remove("devDependencies")
$pkg | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $prod_dir "package.json") -Encoding UTF8

# Install production dependencies with npm (flat node_modules, no .pnpm nesting)
# NOTE: npm outputs warnings to stderr which PowerShell treats as errors
# so we temporarily set ErrorActionPreference to Continue
Write-Host "[build-gateway] Installing production dependencies with npm..."
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

Push-Location $prod_dir
try {
    npm install --omit=dev --ignore-scripts 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[build-gateway] ERROR: npm install failed"
        Pop-Location
        $ErrorActionPreference = $oldEAP
        exit 1
    }
    
    # tsx is needed at runtime to execute TypeScript source
    Write-Host "[build-gateway] Installing tsx..."
    npm install tsx@4.21.0 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[build-gateway] ERROR: tsx install failed"
        Pop-Location
        $ErrorActionPreference = $oldEAP
        exit 1
    }

    # better-sqlite3 需要 node-gyp 编译原生 addon (.node 文件)
    # --ignore-scripts 跳过了编译，这里单独 rebuild
    # 关键：必须使用内嵌的 node.exe 来编译，确保 NODE_MODULE_VERSION 与运行时一致
    $bundled_node = Join-Path $PSScriptRoot "..\src-tauri\node.exe"
    if (Test-Path $bundled_node) {
        $bundled_node_version = & $bundled_node --version
        Write-Host "[build-gateway] Rebuilding better-sqlite3 with bundled Node $bundled_node_version..."
        # 将内嵌 node 目录临时加到 PATH 最前面，使 npm/node-gyp 调用内嵌版本
        $bundled_node_dir = Split-Path $bundled_node -Parent
        $env:PATH = "$bundled_node_dir;$env:PATH"
        npm rebuild better-sqlite3 2>&1 | ForEach-Object { Write-Host "  $_" }
    }
    else {
        Write-Host "[build-gateway] WARNING: Bundled node.exe not found at $bundled_node, using system node"
        Write-Host "[build-gateway] Rebuilding better-sqlite3 native addon..."
        npm rebuild better-sqlite3 2>&1 | ForEach-Object { Write-Host "  $_" }
    }
}
finally {
    Pop-Location
}

$ErrorActionPreference = $oldEAP

# Remove non-win32 platform binaries to reduce size
Write-Host "[build-gateway] Removing non-win32 platform binaries..."
$nm = Join-Path $prod_dir "node_modules"

# onnxruntime: keep only win32/x64
$onnx_node = Join-Path $nm "onnxruntime-node\bin"
if (Test-Path $onnx_node) {
    # 兼容 napi-v3 (1.14.x) 和 napi-v6 (1.21.x)
    Get-ChildItem $onnx_node -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $napi_dir_onnx = $_.FullName
        Get-ChildItem $napi_dir_onnx -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "win32" } |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        $win32_dir = Join-Path $napi_dir_onnx "win32"
        if (Test-Path $win32_dir) {
            Get-ChildItem $win32_dir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne "x64" } |
            ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

# sharp: remove non-win32 platform-specific packages (keep pure JS like @img/colour)
$img_dir = Join-Path $nm "@img"
if (Test-Path $img_dir) {
    Get-ChildItem $img_dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "(darwin|linux|android|freebsd|linuxmusl)" } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# canvas: remove non-win32
$napi_dir = Join-Path $nm "@napi-rs"
if (Test-Path $napi_dir) {
    Get-ChildItem $napi_dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "*win32*" } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# onnxruntime-web: Node 端不需要 web 运行时
Write-Host "[build-gateway] Removing onnxruntime-web (not needed for Node)..."
$onnx_web = Join-Path $nm "onnxruntime-web"
if (Test-Path $onnx_web) { Remove-Item $onnx_web -Recurse -Force -ErrorAction SilentlyContinue }

# @huggingface/transformers 可能嵌套自己的 onnxruntime 副本 (npm 去重不完美)
Write-Host "[build-gateway] Cleaning nested onnxruntime duplicates..."
$hf_inner_nm = Join-Path $nm "@huggingface\transformers\node_modules"
if (Test-Path $hf_inner_nm) {
    @("onnxruntime-node", "onnxruntime-web", "onnxruntime-common") | ForEach-Object {
        $inner = Join-Path $hf_inner_nm $_
        if (Test-Path $inner) { Remove-Item $inner -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

# @huggingface/transformers: 删除 web 端 dist 文件 (Node 端只用 .node.mjs/.node.cjs)
$hf_dist = Join-Path $nm "@huggingface\transformers\dist"
if (Test-Path $hf_dist) {
    Get-ChildItem $hf_dist -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.web.*" -or $_.Name -like "*.min.*" } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}

# Validate and copy app-local VC++ CRT runtime for packaged onnxruntime-node
Write-Host "[build-gateway] Validating app-local VC++ CRT runtime..."
& $validate_vc_runtime -RuntimeDir $vc_runtime_dir

$onnxruntime_runtime_dir = Join-Path $nm "onnxruntime-node\bin\napi-v3\win32\x64"
if (!(Test-Path $onnxruntime_runtime_dir)) {
    Write-Host "[build-gateway] ERROR: onnxruntime runtime directory not found: $onnxruntime_runtime_dir"
    exit 1
}

Write-Host "[build-gateway] Copying app-local VC++ CRT runtime into onnxruntime-node..."
Copy-Item (Join-Path $vc_runtime_dir "*.dll") $onnxruntime_runtime_dir -Force

# Copy pre-downloaded embedding model to resources/
Write-Host "[build-gateway] Copying embedding model..."
$model_src = Join-Path $PSScriptRoot "..\src-tauri\resources\models"
$model_dest = Join-Path $prod_dir "resources\models"
if (Test-Path $model_src) {
    Copy-Item $model_src $model_dest -Recurse -Force
    Write-Host "[build-gateway] Embedding model copied."
}

# Report size
$total = (Get-ChildItem $prod_dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "[build-gateway] Production gateway size: $([math]::Round($total, 1))MB"

# Package as tar.gz for Tauri bundling
Write-Host "[build-gateway] Packaging gateway-bundle.tar.gz..."
$tar_output = Join-Path $PSScriptRoot "..\src-tauri\gateway-bundle.tar.gz"
if (Test-Path $tar_output) { Remove-Item $tar_output -Force }
tar -czf $tar_output -C $prod_dir .
$tar_size = [math]::Round((Get-Item $tar_output).Length / 1MB, 1)
Write-Host "[build-gateway] Done! gateway-bundle.tar.gz: ${tar_size}MB"
