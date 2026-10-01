@echo off
rem One-click self check for the stock workstation
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-station.ps1" %*
exit /b %errorlevel%
