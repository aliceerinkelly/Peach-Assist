@echo off
setlocal
set "NODE=%USERPROFILE%\tools\node-v22.11.0-win-x64"
if not exist "%NODE%\node.exe" set "NODE=%~dp0node"
set "PATH=%NODE%;%PATH%"
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: set-password.bat "your new password"
  exit /b 1
)
node --experimental-sqlite scripts\set-password.mjs "%~1"
pause
