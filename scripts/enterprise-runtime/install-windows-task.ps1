# install-windows-task.ps1
# Registers the OpenFlux Enterprise Runtime as a Windows Scheduled Task that
# starts at boot and is restarted automatically when the process exits.
# No third-party service wrapper (NSSM/WinSW) is required.
#
#   .\install-windows-task.ps1                       # run as the current user (S4U, no password prompt)
#   .\install-windows-task.ps1 -RunAsSystem          # run as LocalSystem
#   .\install-windows-task.ps1 -EnvFile D:\cfg\runtime.env -LogDir D:\logs\runtime
#
# Must be run from an elevated PowerShell.

param(
    [string]$TaskName = "NexusAI Enterprise Runtime",
    [string]$EnvFile = (Join-Path $env:ProgramData "NexusAI\enterprise-runtime\runtime.env"),
    [string]$LogDir = (Join-Path $env:ProgramData "NexusAI\enterprise-runtime\logs"),
    [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$RunAsSystem,
    [int]$RestartIntervalMinutes = 1
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "请在管理员 PowerShell 中运行此脚本。" }

$launcher = Join-Path $PSScriptRoot "run-enterprise-runtime.ps1"
if (-not (Test-Path -LiteralPath $launcher)) { throw "未找到启动器：$launcher" }

$envDir = Split-Path -Parent $EnvFile
New-Item -ItemType Directory -Path $envDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $EnvFile)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "runtime.env.example") -Destination $EnvFile
    Write-Warning "已生成 $EnvFile，请先填入令牌和代码库登记，再重新运行本脚本或直接 Start-ScheduledTask。"
}

$argument = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -EnvFile "{1}" -LogDir "{2}"' -f $launcher, $EnvFile, $LogDir
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory (Split-Path -Parent $launcher)
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd

if ($RunAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
    # S4U: runs without a stored password and without an interactive session.
    # Local HTTP calls to OS/Studio work; network shares are not reachable.
    $principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Highest
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

$ready = $true
foreach ($key in @("NEXUSAI_OS_RUNTIME_ENROLLMENT_TOKEN", "NEXUSAI_ENTERPRISE_RUNTIME_SERVICE_TOKEN", "NEXUSAI_ENTERPRISE_REPOSITORIES_JSON")) {
    $line = Select-String -LiteralPath $EnvFile -Pattern ("^\s*{0}\s*=\s*\S" -f [regex]::Escape($key)) -Quiet
    if (-not $line) { $ready = $false; Write-Warning "$EnvFile 尚未设置 $key" }
}
if ($ready) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "已注册并启动计划任务 '$TaskName'。日志：$LogDir"
} else {
    Write-Host "已注册计划任务 '$TaskName'，补齐环境文件后运行：Start-ScheduledTask -TaskName '$TaskName'"
}
