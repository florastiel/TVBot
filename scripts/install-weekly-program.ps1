# Registers the weekly programming pass (scripts\weekly-program.ps1) as a scheduled task:
# Sundays 04:00, as the current user. Run once in PowerShell as that user:
#   powershell -ExecutionPolicy Bypass -File scripts\install-weekly-program.ps1
# By default it runs while you're logged on (a disconnected remote session counts), which
# needs no admin. -WhenLoggedOff runs it even when nobody is logged on (S4U, no password
# stored), which needs an elevated (admin) PowerShell.
# If a run was missed (machine off), it runs as soon as it can.
# Remove: Unregister-ScheduledTask -TaskName tvchannel-weekly-program
param([switch]$WhenLoggedOff)
$root = Split-Path $PSScriptRoot -Parent
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\weekly-program.ps1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "04:00"
$logon = if ($WhenLoggedOff) { "S4U" } else { "Interactive" }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $logon -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "tvchannel-weekly-program" -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "tvchannel: weekly catalog sync + Claude Code programming pass (PROGRAMMING.md)" -Force | Out-Null
Get-ScheduledTask -TaskName "tvchannel-weekly-program" | Select-Object TaskName, State, @{n = "Runs"; e = { $logon } }, @{n = "Next run"; e = { (Get-ScheduledTaskInfo $_).NextRunTime } }
