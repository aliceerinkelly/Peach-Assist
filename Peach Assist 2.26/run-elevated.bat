@echo off
rem Runs the messenger as administrator, so the admin panel's "Firewall" button can
rem add block rules without asking for elevation each time. Everything it prints goes to
rem server.log; stop it from an elevated prompt with stop.ps1.
cd /d "%~dp0"

set "NODE=%USERPROFILE%\tools\node-v22.11.0-win-x64"
if exist "%NODE%\node.exe" set "PATH=%NODE%;%PATH%"

if "%SESSION_SECRET%"=="" set "SESSION_SECRET=dev-secret-change-me-0123456789abcdef"
if "%OP_PASSWORD%"=="" set "OP_PASSWORD=peach123"
if "%OP_EMAIL%"=="" set "OP_EMAIL=operator@localhost"

net session >nul 2>&1
if errorlevel 1 (
  echo This launcher must be started with administrator rights.
  pause
  exit /b 1
)

echo. >> server.log
echo   [elevated] starting %DATE% %TIME% >> server.log
node --no-warnings --experimental-sqlite dist\server.js >> server.log 2>&1
echo   [elevated] stopped %DATE% %TIME% >> server.log
