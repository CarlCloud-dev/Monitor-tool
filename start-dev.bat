@echo off
setlocal
chcp 65001 >nul

rem Monitor Tool development launcher
cd /d "%~dp0"

if not exist "package.json" (
  echo [ERROR] package.json was not found. Please keep this script in the project root.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js and run this script again.
  pause
  exit /b 1
)

echo Starting Monitor Tool development version...
call npm.cmd run dev
set "exitCode=%errorlevel%"

if not "%exitCode%"=="0" (
  echo.
  echo [ERROR] Development version exited with code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%
