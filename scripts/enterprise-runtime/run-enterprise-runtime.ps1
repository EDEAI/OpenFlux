# run-enterprise-runtime.ps1
# Foreground launcher for the OpenFlux Enterprise Runtime (gateway TS worker).
# Loads KEY=VALUE pairs from an env file, validates the required secrets, then
# runs `npm --prefix gateway run nexusai:enterprise-runtime` and appends its
# output to a dated log file. The process stays attached on purpose: the
# Windows Scheduled Task (see install-windows-task.ps1) restarts this script
# whenever it exits, which is what gives the runtime crash recovery.

param(
    [string]$EnvFile = (Join-Path $env:ProgramData "NexusAI\enterprise-runtime\runtime.env"),
    [string]$LogDir = (Join-Path $env:ProgramData "NexusAI\enterprise-runtime\logs")
)

$ErrorActionPreference = "Stop"
$gatewayDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\gateway")).Path

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "未找到 Runtime 环境文件：$EnvFile（可从 runtime.env.example 复制）"
}

# Environment already present in the process wins; the file only fills gaps.
# Read as UTF-8 explicitly: PowerShell 5.1 would otherwise decode a BOM-less
# file with the ANSI code page and garble non-ASCII comments/values.
Get-Content -LiteralPath $EnvFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { return }
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

$required = @(
    "NEXUSAI_OS_RUNTIME_ENROLLMENT_TOKEN",
    "NEXUSAI_ENTERPRISE_RUNTIME_SERVICE_TOKEN",
    "NEXUSAI_ENTERPRISE_REPOSITORIES_JSON"
)
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, "Process") }
if ($missing) {
    throw "Runtime 环境缺少必需变量：$($missing -join ', ')。请在 $EnvFile 中补齐。"
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$logFile = Join-Path $LogDir ("enterprise-runtime-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$banner = "===== {0} start pid={1} runtime_id={2} os={3} =====" -f (Get-Date -Format "s"), $PID, $env:NEXUSAI_ENTERPRISE_RUNTIME_ID, $env:NEXUSAI_OS_URL
Add-Content -LiteralPath $logFile -Value $banner -Encoding utf8

# cmd.exe handles npm.cmd and stderr merging without PowerShell 5.1 wrapping
# stderr lines into ErrorRecords.
& cmd.exe /c "npm --prefix ""$gatewayDir"" run nexusai:enterprise-runtime >> ""$logFile"" 2>&1"
$exitCode = $LASTEXITCODE
Add-Content -LiteralPath $logFile -Value ("===== {0} exit code={1} =====" -f (Get-Date -Format "s"), $exitCode) -Encoding utf8
exit $exitCode
