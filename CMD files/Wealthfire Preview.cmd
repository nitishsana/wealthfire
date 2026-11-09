@echo off
REM The one Wealthfire preview launcher. Double-click to start, on this computer only:
REM   http://127.0.0.1:5180  the app (Vite, mode localkyc: talks to the local KYC server)
REM   http://127.0.0.1:5181  the local KYC server (real KYC service, no AWS, no SMS or email)
REM   http://127.0.0.1:5182  the review console ("Sign in as demo reviewer"), served by the local KYC server
REM Then it opens "Wealthfire Test Cases.html" (next to this file) and the Local test home http://127.0.0.1:5181/
REM in a fresh Edge InPrivate window: sign in as a test user there, or as the demo reviewer.
REM In this preview only: http://127.0.0.1:5180/?persona=<id> opens a test user, ?server=off runs the app without a server.
REM Close the "Wealthfire preview server" and "Wealthfire local KYC server" windows to stop the preview.
REM Test data is kept between runs; the "Reset local data" link in the test cases wipes it.
title Wealthfire preview

where node >nul 2>nul || goto nonode
where npm >nul 2>nul || goto nonode
where npx >nul 2>nul || goto nonode

REM ---------- 1. local KYC server (5181, also serves the review console on 5182) ----------
call :listening 5181
if not errorlevel 1 goto kycrunning

REM The console must be built in local mode (writes dist\config.json) before the server can serve it.
if exist "%~dp0..\services\kyc\review-console\dist\config.json" goto consoleready
echo Building the review console for local mode...
pushd "%~dp0.."
node services\kyc\review-console\build.mjs --local
if errorlevel 1 (
  popd
  echo The review console did not build. Copy the error above into the chat.
  pause
  exit /b 1
)
popd
:consoleready

start "Wealthfire local KYC server - close to stop" /D "%~dp0.." cmd /k "npm run local -w @wealthfire/kyc-service"
echo Starting the Wealthfire local KYC server...
:kycrunning

REM ---------- 2. app (Vite in localkyc mode, 5180) ----------
call :listening 5180
if errorlevel 1 goto startvite
echo The app is already running on port 5180. If sign-in shows no DEMO code, close the "Wealthfire preview server" window and run this file again.
goto viterunning
:startvite
start "Wealthfire preview server - close to stop" /D "%~dp0..\apps\web" cmd /k "npx vite --mode localkyc --host 127.0.0.1 --port 5180 --strictPort"
echo Starting the Wealthfire preview server...
:viterunning

REM ---------- 3. wait for all three ports ----------
call :waitfor 5181 "Wealthfire local KYC server" || goto failed
call :waitfor 5182 "Wealthfire local KYC server" || goto failed
call :waitfor 5180 "Wealthfire preview server" || goto failed

REM ---------- 4. open the test cases and the Local test home ----------
start "" "%~dp0Wealthfire Test Cases.html"
start "" msedge --inprivate "http://127.0.0.1:5181/" || start "" "http://127.0.0.1:5181/"
exit /b 0

:nonode
echo Node.js is not on PATH. Install Node.js LTS from https://nodejs.org and try again.
pause
exit /b 1

:failed
pause
exit /b 1

REM ---------- helpers ----------
REM call :listening PORT  -> errorlevel 0 when something listens on PORT, else 1
:listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
exit /b %errorlevel%

REM call :waitfor PORT "window name"  -> waits up to 90 seconds; errorlevel 1 with a message if PORT never opens
:waitfor
powershell -NoProfile -Command "for ($i=0; $i -lt 90; $i++) { if (Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep 1 }; exit 1"
if not errorlevel 1 exit /b 0
echo Port %1 did not open. Check the "%~2" window and copy the error into the chat.
exit /b 1
