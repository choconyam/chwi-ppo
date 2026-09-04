@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-chwi-ppo.ps1" -Force
if errorlevel 1 (
  echo [Chwi-ppo] Update failed. Existing files were preserved or restored.
  pause
  exit /b 1
)
pause
