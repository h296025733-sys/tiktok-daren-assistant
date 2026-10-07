@echo off
setlocal
echo This removes the app but preserves downloaded models and saved assistant data.
choice /M "Continue"
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\uninstall.ps1"
