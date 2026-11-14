@echo off
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\tools\node-v22.11.0-win-x64"
if exist "%NODE%\node.exe" set "PATH=%NODE%;%PATH%"

if "%SESSION_SECRET%"=="" set "SESSION_SECRET=dev-secret-change-me-0123456789abcdef"
if "%OP_PASSWORD%"=="" set "OP_PASSWORD=peach123"
if "%OP_EMAIL%"=="" set "OP_EMAIL=operator@localhost"

echo.
echo   Messenger is starting.
echo   Open the address printed below (usually http://localhost:3000/login)
echo   Password: %OP_PASSWORD%
echo.
echo   To stop it, close this window or run stop.bat.
echo.

node --no-warnings --experimental-sqlite dist\server.js
echo.
echo   Messenger has stopped.
