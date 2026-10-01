@echo off
rem Stop the background station service
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-station.ps1"
exit /b 0
