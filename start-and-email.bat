@echo off
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\tools\node-v22.11.0-win-x64"
if exist "%NODE%\node.exe" set "PATH=%NODE%;%PATH%"

if "%SESSION_SECRET%"=="" set "SESSION_SECRET=dev-secret-change-me-0123456789abcdef"
if "%OP_PASSWORD%"=="" set "OP_PASSWORD=peach123"
if "%OP_EMAIL%"=="" set "OP_EMAIL=operator@localhost"

echo.
echo   Messenger is starting, and the live link will be emailed.
echo   Close this window or run stop.bat to stop it.
echo.

start "Peach Assist Messenger link mailer" /min cmd /c "node --no-warnings --experimental-sqlite tools\notify-url.mjs && powershell -NoProfile -ExecutionPolicy Bypass -File tools\send-url.ps1"

node --no-warnings --experimental-sqlite dist\server.js

echo.
echo   Messenger has stopped.
