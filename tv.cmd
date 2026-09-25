@echo off
rem Runs a script with the portable Node + ffmpeg in .\tools, no system install needed.
rem Usage: tv.cmd poc\stream.js "D:\path\to\file.mkv"
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%ROOT%tools\ffmpeg\bin;%PATH%"
set "FFMPEG_PATH=%ROOT%tools\ffmpeg\bin\ffmpeg.exe"
set "FFPROBE_PATH=%ROOT%tools\ffmpeg\bin\ffprobe.exe"
cd /d "%ROOT%"
node %*
