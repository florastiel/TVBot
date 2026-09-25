@echo off
rem Runs tvchannel with the portable Node + ffmpeg in .\tools, no system install needed.
rem   tv.cmd sync                     a command (see: tv.cmd help)
rem   tv.cmd poc\stream.js <file>     or a script
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%ROOT%tools\ffmpeg\bin;%PATH%"
set "FFMPEG_PATH=%ROOT%tools\ffmpeg\bin\ffmpeg.exe"
set "FFPROBE_PATH=%ROOT%tools\ffmpeg\bin\ffprobe.exe"
cd /d "%ROOT%"
if /i "%~x1"==".js" goto script
if /i "%~x1"==".mjs" goto script
node src\cli.js %*
goto :eof
:script
node %*
