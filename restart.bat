@echo off
title Peach Assist Messenger restart
cd /d "%~dp0"

echo.
echo   Closing the old instance and waiting for it to release port 3000...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\restart-server.ps1"

echo.
echo   Restart finished. The window can be closed.
exit /b 0
