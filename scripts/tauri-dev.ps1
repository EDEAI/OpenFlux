$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'prepare-tauri-dev.ps1')

$devNode = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.openflux-dev-runtime\node.exe'))
$tauri = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'node_modules\.bin\tauri.cmd'))
if (-not (Test-Path -LiteralPath $tauri -PathType Leaf)) {
    throw "Tauri CLI is missing. Run pnpm install first: $tauri"
}

$env:OPENFLUX_DEV_NODE = $devNode
# Dev only: expose the app's WebView2 (main window and the panel's embedded
# browser tabs alike — one browser process) over the Chrome DevTools Protocol
# on localhost, so the embedded browser can be driven and inspected from
# outside the app. WebView2 appends this env var to its own launch arguments.
if (-not $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
}
& $tauri dev
exit $LASTEXITCODE
