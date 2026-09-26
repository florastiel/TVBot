# The weekly programming pass (see PROGRAMMING.md): sync + tag the catalog, then Claude
# Code (headless, on the owner's subscription) curates the buckets and programming.yaml.
# Registered as a scheduled task by scripts\install-weekly-program.ps1. Log:
# logs\weekly-program-YYYY-MM-DD.log. If Claude Code fails (logged out, say), the TV keeps
# going: the grid still extends from programming.yaml, and new titles air from the
# catch-all buckets until the next good pass.
param([switch]$DryRun)
$ErrorActionPreference = "Continue"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root "logs\weekly-program-$(Get-Date -Format yyyy-MM-dd).log"
function Say($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Tee-Object -FilePath $log -Append }

Say "weekly programming pass: starting$(if ($DryRun) { ' (dry run: review and plan only)' })"
& "$root\tv.cmd" sync *>> $log
& "$root\tv.cmd" tag *>> $log

$claude = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
if (-not (Test-Path $claude)) { Say "Claude Code not found at $claude; skipping the programming pass"; exit 1 }
$prompt = if ($DryRun) {
  "Do steps 1 and 2 of PROGRAMMING.md only (review, then write data\program\plan.json and check it with tv.mjs apply WITHOUT --apply). Don't apply anything or edit programming.yaml. Then write data\program\last-run.md describing what you would change."
} else {
  "Run the weekly programming pass exactly as described in PROGRAMMING.md."
}
Say "running Claude Code"
# What the pass may do: read the project, write data\program\*, edit programming.yaml, and
# run scripts/program/tv.mjs through Bash (PowerShell's checker won't match a rule for a
# relative exe path, so it's off). Nothing else: no other commands, no web.
$allow = @("Read", "Glob", "Grep", "Edit(/programming.yaml)", "Write(/data/program/**)", "Edit(/data/program/**)",
  "Bash(tools/node/node.exe scripts/program/tv.mjs:*)")
$deny = @("PowerShell", "WebFetch", "WebSearch", "Edit(/config.yaml)", "Edit(/src/**)", "Read(/.env)")
& $claude -p $prompt --allowedTools $allow --disallowedTools $deny --output-format text *>> $log
$code = $LASTEXITCODE
Say "Claude Code exited with $code"

# Keep programming.yaml changes in git (local only).
if (-not $DryRun) {
  git -C $root add programming.yaml 2>&1 | Out-Null
  git -C $root diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git -C $root commit -q -m "Weekly programming pass $(Get-Date -Format yyyy-MM-dd)" 2>&1 | Out-Null; Say "committed programming.yaml changes" }
}
if (Test-Path "$root\data\program\last-run.md") { Say "summary: data\program\last-run.md" }
Say "weekly programming pass: done"
exit $code
