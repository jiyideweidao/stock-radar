@echo off
rem Allow phones on the same Wi-Fi to reach the workstation (needs admin; will prompt UAC)
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0允许手机访问.ps1" %*
exit /b %errorlevel%
