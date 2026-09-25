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

Write-Host ""
Write-Host "Done. Stop any copies running in terminals first, then start them:"
Write-Host "  Start-Service tvchannel-player, tvchannel-bot"
