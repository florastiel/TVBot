# Installs the TV as two Windows services that start with the machine and restart
# themselves if they crash. Run once, in PowerShell *as Administrator*:
#   powershell -ExecutionPolicy Bypass -File D:\discord\tvchannel\scripts\install-services.ps1
# Safe to re-run (it updates the existing services).

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$node = Join-Path $root "tools\node\node.exe"
$ffbin = Join-Path $root "tools\ffmpeg\bin"
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Host "Installing NSSM (service helper) with Chocolatey..."
  choco install nssm -y --no-progress
  $env:Path += ";C:\ProgramData\chocolatey\bin"
}

foreach ($part in @("player", "bot")) {
  $svc = "tvchannel-$part"
  if (-not (Get-Service $svc -ErrorAction SilentlyContinue)) {
    nssm install $svc $node "src\cli.js" $part | Out-Null
  }
  nssm set $svc Application $node | Out-Null
  nssm set $svc AppParameters "src\cli.js $part" | Out-Null
  nssm set $svc AppDirectory $root | Out-Null
  nssm set $svc DisplayName "TV channel ($part)" | Out-Null
  nssm set $svc Description "Discord TV channel $part. Logs: $logs" | Out-Null
  nssm set $svc Start SERVICE_AUTO_START | Out-Null
  nssm set $svc AppEnvironmentExtra "FFMPEG_PATH=$ffbin\ffmpeg.exe" "FFPROBE_PATH=$ffbin\ffprobe.exe" | Out-Null
  # Crash -> restart after 10 s. Console output (library chatter) goes to a file too.
  nssm set $svc AppExit Default Restart | Out-Null
  nssm set $svc AppRestartDelay 10000 | Out-Null
  nssm set $svc AppStdout "$logs\$part-console.log" | Out-Null
  nssm set $svc AppStderr "$logs\$part-console.log" | Out-Null
  nssm set $svc AppRotateFiles 1 | Out-Null
  nssm set $svc AppRotateBytes 10485760 | Out-Null
  Write-Host "configured $svc"
}
# The bot needs the player; start the player first.
nssm set tvchannel-bot DependOnService tvchannel-player | Out-Null

# Switch over from copies started by hand, without cutting off anyone watching:
# wait for the TV to be off, stop the old copies, start the services.
$secret = Get-Content (Join-Path $root "data\local-secret.txt") -ErrorAction SilentlyContinue
function TvIsOn {
  try { (Invoke-RestMethod "http://127.0.0.1:7651/status" -Headers @{ "x-tv-secret" = $secret } -TimeoutSec 3).state -ne "off" }
  catch { $false }
}
while ((Get-Service tvchannel-player).Status -ne "Running" -and (TvIsOn)) {
  Write-Host "The TV is on right now; waiting for it to be turned off before switching over (checks every 30 s)..."
  Start-Sleep 30
}
if ((Get-Service tvchannel-player).Status -ne "Running") {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root\tools\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Back to the real schedule (the test playlist was only for trying things out).
  Remove-Item (Join-Path $root "data\playlist.json") -ErrorAction SilentlyContinue
}
# Already-running services are left alone (restarting would cut off the stream).
# After changing settings: Restart-Service tvchannel-player -Force (when the TV is off).
Start-Service tvchannel-player, tvchannel-bot
Get-Service tvchannel-player, tvchannel-bot | Format-Table Name, Status, StartType

Write-Host "Done. The TV now starts with Windows and restarts itself if it crashes."
Write-Host "Logs: $logs"
