@echo off
rem Saves a state of the whole project as a timestamped rar on the Desktop,
rem and copies it to G:\My Drive\Project Archives when that drive is mounted.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\snapshot.ps1"
echo.
pause
