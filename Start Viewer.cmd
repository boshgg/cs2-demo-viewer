@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0bin\cs2-viewer.exe" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
"%~dp0bin\cs2-viewer.exe" -open %*
if errorlevel 1 pause
