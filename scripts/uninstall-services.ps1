# Removes the TV services (as Administrator). The code and data stay where they are.
foreach ($svc in @("tvchannel-bot", "tvchannel-player")) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    nssm stop $svc | Out-Null
    nssm remove $svc confirm | Out-Null
    Write-Host "removed $svc"
  }
}
