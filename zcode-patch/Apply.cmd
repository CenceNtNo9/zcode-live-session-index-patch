@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Invoke-ZCodePatch.ps1" -Mode Apply
set "patch_exit=%errorlevel%"
echo.
if not "%patch_exit%"=="0" echo Patch failed. Read the error above; no process was killed.
pause
exit /b %patch_exit%
