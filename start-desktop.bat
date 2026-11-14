@echo off
cd /d "%~dp0"
set "PATH=%USERPROFILE%\tools\node-v22.11.0-win-x64;%PATH%"
set "SESSION_SECRET=dev-secret-change-me-0123456789abcdef"
set "OP_PASSWORD=peach123"
set "OP_EMAIL=operator@localhost"
node --no-warnings --experimental-sqlite dist\server.js >> boot.log 2>&1
