@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
rem Usage: release.cmd 1.0.1            (commit, push, and create the GitHub release)
rem        release.cmd 1.0.1 --dry-run  (rehearsal: checks, version bump, ZIP build, then revert)
rem        release.cmd                  (asks for the version)
set "VER=%~1"
set "EXTRA="
if /i "%~2"=="--dry-run" set "EXTRA=-DryRun"
if /i "%~1"=="--dry-run" (
  set "VER="
  set "EXTRA=-DryRun"
)
if "%VER%"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" %EXTRA%
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Version "%VER%" %EXTRA%
)
if errorlevel 1 (
  echo [release] Failed. See the messages above.
  pause
  exit /b 1
)
pause
