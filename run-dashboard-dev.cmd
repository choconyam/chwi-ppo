@echo off
setlocal
cd /d "%~dp0dashboard"
if not exist node_modules (
  echo [Job Workbench] Installing dashboard packages...
  call npm install
  if errorlevel 1 exit /b 1
)
echo [Job Workbench] Starting React development server...
call npm run dev -- --open
