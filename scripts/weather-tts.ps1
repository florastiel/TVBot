# Speaks a text file into a .wav with a built-in Windows (SAPI) voice. Used by the weather report.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\weather-tts.ps1 -TextFile a.txt -Out a.wav -Voice "Microsoft Zira Desktop" -Rate -1
param([Parameter(Mandatory)][string]$TextFile, [Parameter(Mandatory)][string]$Out, [string]$Voice = "Microsoft Zira Desktop", [int]$Rate = 0)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch { }   # not installed: the default voice
$s.Rate = $Rate
$s.SetOutputToWaveFile($Out)
$s.Speak([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8))
$s.Dispose()
