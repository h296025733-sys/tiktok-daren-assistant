@echo off
setlocal
echo WARNING: This removes the app, models, database, cache and logs.
echo Files previously saved through Chrome remain untouched.
choice /M "Delete all TikTok Daren Assistant local data"
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\uninstall.ps1" -RemoveUserData
