@echo off
setlocal
chcp 65001 >nul

rem Monitor Tool Windows package builder
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

rem Use a mirror for Electron downloads when the default GitHub source is unavailable.
if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if "%ELECTRON_BUILDER_BINARIES_MIRROR%"=="" set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo Building Monitor Tool Windows installer...
echo Output directory: dist\
echo.
call npm.cmd run dist
set "exitCode=%errorlevel%"

echo.
if "%exitCode%"=="0" (
  echo [DONE] Installer created. Check the dist\ directory.
) else (
  echo [ERROR] Package build failed with code %exitCode%.
)

pause
endlocal & exit /b %exitCode%
