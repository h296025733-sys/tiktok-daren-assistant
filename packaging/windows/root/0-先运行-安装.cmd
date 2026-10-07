@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "TDA_EXIT=%ERRORLEVEL%"
echo.
if not "%TDA_EXIT%"=="0" echo Installation failed. See the message above.
pause
exit /b %TDA_EXIT%
