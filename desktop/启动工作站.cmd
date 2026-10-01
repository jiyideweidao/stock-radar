@echo off
rem Launch the stock workstation (server + app window)
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-station.ps1"
exit /b 0
