@echo off
rem TV control menu: numbered shortcuts for tv.cmd and the two Windows services.
rem Double-click it, or run menu.cmd from a terminal.
setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"
title TV Channel Control
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "C_HEAD=%ESC%[96m"
set "C_DIM=%ESC%[90m"
set "C_WARN=%ESC%[93m"
set "C_OK=%ESC%[92m"
set "C_OFF=%ESC%[0m"
mode con: cols=100 lines=50 >nul 2>&1

:menu
cls
echo.
echo %C_HEAD%   ============================================================%C_OFF%
echo %C_HEAD%                     TV CHANNEL  -  CONTROL MENU%C_OFF%
echo %C_HEAD%   ============================================================%C_OFF%
call :statusline
echo.
echo %C_HEAD%   RUNNING%C_OFF%
echo     [1]  Status: services, what's on air, recent log lines
echo     [2]  Restart player   %C_DIM%(waits for the next commercial break, or now if off)%C_OFF%
echo     [3]  Restart bot      %C_DIM%(re-registers slash commands)%C_OFF%
echo     [4]  Restart both
echo.
echo %C_HEAD%   CATALOG%C_OFF%
echo     [5]  Sync catalog     %C_DIM%(Plex + local + Real-Debrid; can take a long while)%C_OFF%
echo     [6]  Catalog stats
echo     [7]  Rebuild catalog.html
echo     [8]  Tag new items with Claude
echo.
echo %C_HEAD%   SCHEDULE%C_OFF%
echo     [9]  Today's guide
echo     [10] Fill schedule    %C_DIM%(days ahead, keeps existing picks)%C_OFF%
echo     [11] New picks for upcoming blocks   %C_DIM%(--replace)%C_OFF%
echo     [12] New weekly grid from Claude     %C_DIM%(--replan)%C_OFF%
echo     [13] Plan a special / marathon
echo.
echo %C_HEAD%   COMMERCIALS AND CLIPS%C_OFF%
echo     [14] Add a commercial or clip by link
echo     [15] Rotation report: how often each has aired
echo.
echo %C_HEAD%   LOGS AND FILES%C_OFF%
echo     [16] Follow the player log live   %C_DIM%(Ctrl+C to stop)%C_OFF%
echo     [17] Follow the bot log live      %C_DIM%(Ctrl+C to stop)%C_OFF%
echo     [18] Show BADBOT flags   %C_DIM%(moments flagged with /rocks)%C_OFF%
echo     [19] Open the logs folder
echo     [20] Open the Real-Debrid re-add list
echo.
echo     [0]  Exit
echo.
set "pick="
set /p "pick=   Choose an option: "
if not defined pick goto menu
if "%pick%"=="0" goto :end
if "%pick%"=="1" goto :status
if "%pick%"=="2" goto :restart_player
if "%pick%"=="3" goto :restart_bot
if "%pick%"=="4" goto :restart_both
if "%pick%"=="5" goto :sync
if "%pick%"=="6" call :run stats & goto menu
if "%pick%"=="7" call :run catalog --html & goto menu
if "%pick%"=="8" goto :tag
if "%pick%"=="9" call :run guide & goto menu
if "%pick%"=="10" goto :fill
if "%pick%"=="11" goto :replace
if "%pick%"=="12" goto :replan
if "%pick%"=="13" goto :special
if "%pick%"=="14" goto :add
if "%pick%"=="15" goto :spots
if "%pick%"=="16" goto :tail_player
if "%pick%"=="17" goto :tail_bot
if "%pick%"=="18" goto :badbot
if "%pick%"=="19" start "" explorer "%ROOT%logs" & goto menu
if "%pick%"=="20" goto :readd
echo.
echo    %C_WARN%Not an option: %pick%%C_OFF%
timeout /t 1 >nul
goto menu

:statusline
set "P=stopped"
set "B=stopped"
sc query tvchannel-player 2>nul | find "RUNNING" >nul && set "P=running"
sc query tvchannel-bot 2>nul | find "RUNNING" >nul && set "B=running"
echo    player: %P%    bot: %B%
exit /b

:run
echo.
call "%ROOT%tv.cmd" %*
echo.
pause
exit /b

:pause_back
echo.
pause
goto menu

:status
echo.
sc query tvchannel-player | find "STATE"
sc query tvchannel-bot | find "STATE"
echo.
echo %C_HEAD%On air:%C_OFF%
powershell -NoProfile -Command "$f = Get-ChildItem 'logs\player-20*.log' | Sort-Object LastWriteTime | Select-Object -Last 1; if ($f) { Get-Content $f -Tail 400 | Select-String 'player: (now|break):|left voice|joined|paused|resumed' | Select-Object -Last 4 | ForEach-Object { $_.Line } } else { 'no player log yet' }"
echo.
echo %C_HEAD%Last player log lines:%C_OFF%
powershell -NoProfile -Command "$f = Get-ChildItem 'logs\player-20*.log' | Sort-Object LastWriteTime | Select-Object -Last 1; if ($f) { Get-Content $f -Tail 8 | ForEach-Object { $_.Substring(0, [Math]::Min(180, $_.Length)) } }"
echo.
echo %C_HEAD%Last bot log lines:%C_OFF%
powershell -NoProfile -Command "$f = Get-ChildItem 'logs\bot-20*.log' | Sort-Object LastWriteTime | Select-Object -Last 1; if ($f) { Get-Content $f -Tail 8 | ForEach-Object { $_.Substring(0, [Math]::Min(180, $_.Length)) } }"
goto pause_back

:restart_player
call :run restart player
goto menu

:restart_bot
call :run restart bot
goto menu

:restart_both
echo.
call "%ROOT%tv.cmd" restart player
call "%ROOT%tv.cmd" restart bot
goto pause_back

:sync
echo.
echo    %C_WARN%A full sync re-reads Plex, the drives and Real-Debrid. It can take an hour or more%C_OFF%
echo    %C_WARN%and /schedule may wait behind it. Don't restart the bot or player meanwhile.%C_OFF%
set "yn="
set /p "yn=   Run it? (y/N): "
if /i not "%yn%"=="y" goto menu
call :run sync
goto menu

:tag
echo.
echo    Uses Claude on the untagged items only.
set "yn="
set /p "yn=   Run it? (y/N): "
if /i not "%yn%"=="y" goto menu
call :run tag
goto menu

:fill
set "days=7"
set /p "days=   How many days ahead? (default 7): "
call :run schedule %days%
goto menu

:replace
echo.
echo    Reshuffles the picks for the blocks that haven't aired yet.
set "yn="
set /p "yn=   Do it? (y/N): "
if /i not "%yn%"=="y" goto menu
call :run schedule --replace
goto menu

:replan
echo.
echo    Asks Claude for a brand new week of block types, then refills the schedule.
set "yn="
set /p "yn=   Do it? (y/N): "
if /i not "%yn%"=="y" goto menu
call :run schedule --replan
goto menu

:special
echo.
echo    Example: Scream marathon Saturday 8pm   (leave empty to let Claude pick)
set "req="
set /p "req=   Request: "
if defined req (call :run special "%req%") else (call :run special)
goto menu

:add
echo.
set "kind="
set /p "kind=   commercial or clip? (c = commercial, l = clip): "
if /i "%kind%"=="c" set "kind=commercial"
if /i "%kind%"=="l" set "kind=clip"
if /i not "%kind%"=="commercial" if /i not "%kind%"=="clip" goto menu
set "urls="
set /p "urls=   Link(s), space separated: "
if not defined urls goto menu
call :run add %kind% %urls%
goto menu

:spots
echo.
set "which="
set /p "which=   commercial, clip, eyecatch, or Enter for all: "
set "dir="
set /p "dir=   Most played first instead? (y/N): "
set "flag="
if /i "%dir%"=="y" set "flag=--desc"
call :run spots %which% %flag%
goto menu

:tail_player
echo.
powershell -NoProfile -Command "$f = Get-ChildItem 'logs\player-20*.log' | Sort-Object LastWriteTime | Select-Object -Last 1; Get-Content $f -Tail 25 -Wait"
goto menu

:tail_bot
echo.
powershell -NoProfile -Command "$f = Get-ChildItem 'logs\bot-20*.log' | Sort-Object LastWriteTime | Select-Object -Last 1; Get-Content $f -Tail 25 -Wait"
goto menu

:badbot
echo.
if exist "logs\badbot.log" (
  powershell -NoProfile -Command "Get-Content 'logs\badbot.log' -Tail 25"
) else (
  echo    No flags recorded yet.
)
goto pause_back

:readd
if exist "data\readd_links.txt" (
  start "" notepad "data\readd_links.txt"
) else (
  echo.
  echo    data\readd_links.txt doesn't exist yet.
  pause
)
goto menu

:end
endlocal
exit /b 0
