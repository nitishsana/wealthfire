@echo off
REM Helper used by the other preview files. Starts the Wealthfire preview server once,
REM in its own window, at http://127.0.0.1:5180 (this computer only). Close that window to stop it.

call :listening && exit /b 0

where npx >nul 2>nul || (
  echo Node.js is not on PATH. Install Node.js LTS from https://nodejs.org and try again.
  pause
  exit /b 1
)

start "Wealthfire preview server - close to stop" /D "%~dp0..\apps\web" cmd /k "npx vite --host 127.0.0.1 --port 5180 --strictPort"
echo Starting the Wealthfire preview server...

REM Wait up to 60 seconds for the server to come up.
powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep 1 }; exit 1"
if errorlevel 1 (
  echo The preview server did not start. Check the "Wealthfire preview server" window for the error and copy it into the chat.
  pause
  exit /b 1
)
exit /b 0

:listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
exit /b %errorlevel%
