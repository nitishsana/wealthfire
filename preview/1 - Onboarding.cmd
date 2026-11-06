@echo off
REM Onboarding preview only: sign in -> OTP -> your details -> Aadhaar OTP -> "You're all set".
REM Opens a fresh Edge InPrivate window, so it always starts at sign in and leaves no data behind.
REM Test values: Aadhaar 234123412346 (or 234123470000 for "no linked mobile"),
REM PAN ABCPS1234F with last name Sana. OTP codes show in the yellow Demo banner.
title Wealthfire preview - Onboarding
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/" || start "" "http://127.0.0.1:5180/"
