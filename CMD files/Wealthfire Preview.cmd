@echo off
REM The one Wealthfire preview launcher. Double-click to start the local preview at
REM http://127.0.0.1:5180 (this computer only) in a fresh Edge InPrivate window.
REM All test cases, including the demo scenarios, are in "Wealthfire Test Cases.csv" next to this file.
REM Close the "Wealthfire preview server" window to stop the preview.
title Wealthfire preview

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto open

where npx >nul 2>nul || (
  echo Node.js is not on PATH. Install Node.js LTS from https://nodejs.org and try again.
  pause
  exit /b 1
)

start "Wealthfire preview server - close to stop" /D "%~dp0..\apps\web" cmd /k "npx vite --host 127.0.0.1 --port 5180 --strictPort"
echo Starting the Wealthfire preview server...
powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep 1 }; exit 1"
if errorlevel 1 (
  echo The preview server did not start. Check the "Wealthfire preview server" window and copy the error into the chat.
  pause
  exit /b 1
)

:open
start "" msedge --inprivate "http://127.0.0.1:5180/" || start "" "http://127.0.0.1:5180/"
