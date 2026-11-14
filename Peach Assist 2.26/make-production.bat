@echo off
rem Builds a clean production model: the code without this machine's database,
rem certificates, logs or secrets. It starts at first-run setup.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-production.ps1"
echo.
pause
