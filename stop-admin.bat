@echo off
rem Stops an elevated messenger. A process started as administrator cannot be
rem stopped from an ordinary prompt, so this asks for rights the same way.
setlocal
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
endlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
echo   Messenger stopped.
pause
