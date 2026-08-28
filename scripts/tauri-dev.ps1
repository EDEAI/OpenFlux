$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'prepare-tauri-dev.ps1')

$devNode = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.openflux-dev-runtime\node.exe'))
$tauri = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'node_modules\.bin\tauri.cmd'))
if (-not (Test-Path -LiteralPath $tauri -PathType Leaf)) {
    throw "Tauri CLI is missing. Run pnpm install first: $tauri"
}

$env:OPENFLUX_DEV_NODE = $devNode
& $tauri dev
exit $LASTEXITCODE
