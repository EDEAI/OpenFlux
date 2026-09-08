# status-windows-task.ps1
# Shows task state, last run result, the node process (if any) and the tail of today's log.

param(
    [string]$TaskName = "NexusAI Enterprise Runtime",
    [string]$LogDir = (Join-Path $env:ProgramData "NexusAI\enterprise-runtime\logs"),
    [int]$Tail = 30
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "计划任务 '$TaskName' 未安装。运行 install-windows-task.ps1 安装。"
    exit 1
}
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    Task          = $TaskName
    State         = $task.State
    LastRunTime   = $info.LastRunTime
    LastResult    = ("0x{0:X}" -f $info.LastTaskResult)
    NextRunTime   = $info.NextRunTime
    MissedRuns    = $info.NumberOfMissedRuns
} | Format-List

$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "enterprise-runtime-cli" }
if ($node) {
    Write-Host ("Runtime 进程：PID {0}，启动于 {1}" -f $node.ProcessId, $node.CreationDate)
} else {
    Write-Host "Runtime 进程：未运行"
}

$log = Get-ChildItem -LiteralPath $LogDir -Filter "enterprise-runtime-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) {
    Write-Host ""
    Write-Host ("---- {0}（最后 {1} 行）----" -f $log.FullName, $Tail)
    Get-Content -LiteralPath $log.FullName -Tail $Tail
} else {
    Write-Host "尚无日志：$LogDir"
}
