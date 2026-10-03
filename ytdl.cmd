@echo off
rem Tiny personal YouTube (or anything yt-dlp supports) downloader, using the same
rem cookies/JS-runtime setup as the TV's own downloader (src/catalog/download.js).
rem Saves to .\downloads\ (made if missing), best quality as one mp4.
rem
rem   ytdl <url>                 download it
rem   ytdl <url> "D:\some\dir"   download to a specific folder instead
setlocal
set "ROOT=%~dp0"
set "OUT=%~2"
if "%OUT%"=="" set "OUT=%ROOT%downloads"
if "%~1"=="" (
  echo usage: ytdl ^<url^> [output-dir]
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

set "COOKIES="
if exist "%ROOT%data\youtube-cookies.txt" set "COOKIES=--cookies "%ROOT%data\youtube-cookies.txt""

"%ROOT%tools\yt-dlp.exe" --js-runtimes "node:%ROOT%tools\node\node.exe" %COOKIES% ^
  -f "bv*+ba/b" --merge-output-format mp4 ^
  -o "%OUT%\%%(title)s.%%(ext)s" ^
  --no-playlist ^
  %1
