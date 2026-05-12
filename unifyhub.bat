@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "NODE_SCRIPT=%SCRIPT_DIR%src\unifyhub.mjs"
set "INSTALLER_SCRIPT=%SCRIPT_DIR%install.ps1"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo UnifyHub needs Node.js 22 or newer.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

if "%~1"=="" goto installer_menu
if /I "%~1"=="menu" goto installer_menu
if /I "%~1"=="interactive" goto installer_menu
if /I "%~1"=="dev" goto dev_command

call :maybe_elevate %*
node "%NODE_SCRIPT%" %*
exit /b %ERRORLEVEL%

:dev_command
shift
if "%~1"=="" goto menu_dev
set "UH_REST="
:dev_collect_args
if "%~1"=="" goto dev_run
set "UH_REST=!UH_REST! "%~1""
shift
goto dev_collect_args
:dev_run
node "%NODE_SCRIPT%" !UH_REST! --target dev
exit /b %ERRORLEVEL%

:menu_auto
set "UH_TARGET=auto"
goto menu

:menu_dev
set "UH_TARGET=dev"
goto menu

:installer_menu
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_SCRIPT%" -KeepOpen
exit /b %ERRORLEVEL%

:menu
cls
echo.
echo   UnifyHub
echo   Unity Hub mod installer and plugin manager
echo.
node "%NODE_SCRIPT%" status --target %UH_TARGET%
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
echo   [1] Install or reapply UnifyHub
echo   [2] Restore original Unity Hub
echo   [3] Build patched file only
echo   [4] Start Unity Hub
echo   [5] List plugins
echo   [6] Show paths
echo   [Q] Quit
echo.
set /p "CHOICE=  Action: "
if /I "%CHOICE%"=="1" goto menu_apply
if /I "%CHOICE%"=="2" goto menu_restore
if /I "%CHOICE%"=="3" goto menu_build
if /I "%CHOICE%"=="4" goto menu_start
if /I "%CHOICE%"=="5" goto menu_plugins
if /I "%CHOICE%"=="6" goto menu_paths
if /I "%CHOICE%"=="Q" exit /b 0
goto menu

:menu_apply
call :maybe_elevate apply --target %UH_TARGET%
node "%NODE_SCRIPT%" apply --target %UH_TARGET%
pause
exit /b %ERRORLEVEL%

:menu_restore
call :maybe_elevate restore --target %UH_TARGET%
node "%NODE_SCRIPT%" restore --target %UH_TARGET%
pause
exit /b %ERRORLEVEL%

:menu_build
node "%NODE_SCRIPT%" build --target %UH_TARGET%
pause
exit /b %ERRORLEVEL%

:menu_start
node "%NODE_SCRIPT%" start --target %UH_TARGET%
pause
exit /b %ERRORLEVEL%

:menu_plugins
node "%NODE_SCRIPT%" plugins --target %UH_TARGET%
echo.
pause
goto menu

:menu_paths
node "%NODE_SCRIPT%" paths --target %UH_TARGET%
echo.
pause
goto menu

:maybe_elevate
set "UH_COMMAND=%~1"
set "UH_IS_DEV=0"
set "UH_PREV="
for %%A in (%*) do (
  if /I "!UH_PREV!"=="--target" if /I "%%~A"=="dev" set "UH_IS_DEV=1"
  set "UH_PREV=%%~A"
)
if "%UH_TARGET%"=="dev" set "UH_IS_DEV=1"
if /I not "%UH_COMMAND%"=="apply" if /I not "%UH_COMMAND%"=="install" if /I not "%UH_COMMAND%"=="restore" if /I not "%UH_COMMAND%"=="uninstall" if /I not "%UH_COMMAND%"=="auto" exit /b 0
if "%UH_IS_DEV%"=="1" exit /b 0
net session >nul 2>nul
if not errorlevel 1 exit /b 0
echo.
echo UnifyHub needs administrator permission to patch the installed Unity Hub.
echo Windows will ask for permission now.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList @('%*') -Verb RunAs -Wait"
exit /b %ERRORLEVEL%
