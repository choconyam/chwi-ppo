@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-chwi-ppo.ps1" -Auto
if errorlevel 1 echo [Chwi-ppo] Update check failed. Opening the current dashboard.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\generate-dashboard.ps1"
if errorlevel 1 (
  echo [Job Workbench] Failed to generate dashboard.
  pause
  exit /b 1
)
start "" "%~dp0career-dashboard.html"
