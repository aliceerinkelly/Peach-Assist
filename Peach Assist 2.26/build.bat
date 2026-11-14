@echo off
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\tools\node-v22.11.0-win-x64"
if exist "%NODE%\node.exe" set "PATH=%NODE%;%PATH%"

echo.
echo   Building Messenger.
echo   Step 1 of 2: installing the exact dependency versions (first run only, needs internet).
echo.
call npm ci
if errorlevel 1 goto failed

echo.
echo   Step 2 of 2: compiling the server into dist\.
echo.
call npm run build
if errorlevel 1 goto failed

echo.
echo   Build finished. Double-click start.bat to run Messenger.
echo.
pause
exit /b 0

:failed
echo.
echo   The build failed. The message above says why; nothing was changed.
echo.
pause
exit /b 1
