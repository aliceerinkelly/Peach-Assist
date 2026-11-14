@echo off
rem Double-click this to run the messenger as administrator, so the admin panel's
rem Firewall button can add Windows Firewall block rules by itself.
rem Windows will show one UAC prompt; say yes and the server starts in this window.
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
endlocal & call "%~dp0run-elevated.bat"
