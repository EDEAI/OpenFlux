$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$debugRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'src-tauri\target\debug'))
$sourceNode = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'src-tauri\node.exe'))
$devRuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.openflux-dev-runtime'))
$devRuntimeNode = [System.IO.Path]::GetFullPath((Join-Path $devRuntimeRoot 'node.exe'))
$ownedExecutables = @(
    [System.IO.Path]::GetFullPath((Join-Path $debugRoot 'openflux-rust.exe'))
    [System.IO.Path]::GetFullPath((Join-Path $debugRoot 'node.exe'))
    $sourceNode
    $devRuntimeNode
)

# A previously closed dev window can leave the Tauri executable or its legacy
# bundled Node sidecar alive. Windows then prevents the next Tauri build from
# refreshing target\debug\node.exe. Only stop processes whose executable path
# is exactly inside this workspace's debug output; system Node processes and
# other OpenFlux worktrees are left untouched.
$staleProcesses = Get-Process -Name 'openflux-rust', 'node' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $ownedExecutables -contains [System.IO.Path]::GetFullPath($_.Path) }

foreach ($process in $staleProcesses) {
    # Stopping the Tauri parent can make its Node child disappear before this
    # snapshot reaches the next entry. Re-check both the PID and executable
    # path so an already-exited process (or a reused PID) cannot fail startup.
    $currentProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($null -eq $currentProcess) {
        continue
    }
    $currentPath = $currentProcess.Path
    if (-not $currentPath -or $ownedExecutables -notcontains [System.IO.Path]::GetFullPath($currentPath)) {
        continue
    }

    Write-Host ("Stopping stale OpenFlux dev process {0} ({1})" -f $currentProcess.Id, $currentPath)
    try {
        Stop-Process -Id $currentProcess.Id -Force -ErrorAction Stop
    } catch {
        # A sibling/parent process may have completed the cleanup concurrently.
        # Ignore only the benign "already exited" race; preserve real failures
        # such as access denied.
        if ($null -ne (Get-Process -Id $currentProcess.Id -ErrorAction SilentlyContinue)) {
            throw
        }
    }
}

if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf)) {
    throw "Bundled Node runtime is missing: $sourceNode"
}

New-Item -ItemType Directory -Path $devRuntimeRoot -Force | Out-Null
$sourceInfo = Get-Item -LiteralPath $sourceNode
$copyRequired = -not (Test-Path -LiteralPath $devRuntimeNode -PathType Leaf)
if (-not $copyRequired) {
    $runtimeInfo = Get-Item -LiteralPath $devRuntimeNode
    $copyRequired = $runtimeInfo.Length -ne $sourceInfo.Length -or
        $runtimeInfo.LastWriteTimeUtc -ne $sourceInfo.LastWriteTimeUtc
}
if ($copyRequired) {
    Write-Host "Preparing isolated Node runtime for Tauri development"
    Copy-Item -LiteralPath $sourceNode -Destination $devRuntimeNode -Force
    (Get-Item -LiteralPath $devRuntimeNode).LastWriteTimeUtc = $sourceInfo.LastWriteTimeUtc
}
