@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\open-extension-setup.ps1"
if errorlevel 1 pause
