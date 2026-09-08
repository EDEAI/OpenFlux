# uninstall-windows-task.ps1
# Stops and removes the Enterprise Runtime scheduled task. Env file and logs are kept.

param(
    [string]$TaskName = "NexusAI Enterprise Runtime"
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "计划任务 '$TaskName' 不存在，无需卸载。"
    exit 0
}
if ($task.State -eq "Running") {
    # Stop-ScheduledTask terminates the powershell launcher and its npm/node children.
    Stop-ScheduledTask -TaskName $TaskName
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已移除计划任务 '$TaskName'。"
