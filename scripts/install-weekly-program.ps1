# Registers the weekly programming pass (scripts\weekly-program.ps1) as a scheduled task:
# Sundays 04:00, as the current user, whether or not you're logged on (S4U: no password
# stored; the task still has internet). Run once in PowerShell as that user:
#   powershell -ExecutionPolicy Bypass -File scripts\install-weekly-program.ps1
# Remove: Unregister-ScheduledTask -TaskName tvchannel-weekly-program
$root = Split-Path $PSScriptRoot -Parent
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\weekly-program.ps1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "04:00"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "tvchannel-weekly-program" -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "tvchannel: weekly catalog sync + Claude Code programming pass (PROGRAMMING.md)" -Force | Out-Null
Get-ScheduledTask -TaskName "tvchannel-weekly-program" | Select-Object TaskName, State, @{n = "Next run"; e = { (Get-ScheduledTaskInfo $_).NextRunTime } }
