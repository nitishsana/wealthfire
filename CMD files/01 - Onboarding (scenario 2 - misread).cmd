@echo off
REM Onboarding preview, scenario 2: the reader misreads one character of each number.
REM Opens a fresh Edge InPrivate window, so it always starts at sign in and leaves no data behind.
REM Order: sign in -> OTP -> your details -> Aadhaar OTP -> upload documents -> check your numbers.
REM Test values: mobile 9876543210, PAN ABCPS1234F with last name Sana, Aadhaar 234123412346 (valid),
REM or Aadhaar 234123470000 for "no linked mobile" at the Aadhaar OTP. OTP codes show in the yellow Demo banner.
REM Documents: any JPG/PNG selfie (Take photo or Upload), and JPG/PNG/PDF cards under 10 MB (nothing is really read).
REM Uses the demo reader (nothing is read) via ?reader=demo&mode=... in the URL (dev server only); never shown on screen.
REM To see it: finish Your details, Aadhaar OTP and Upload documents, then on Check your numbers each field shows "Doesn't match".
REM Fix PAN with "Use number from document", and Aadhaar with "Upload again" (strict re-read reads it right).
REM Expect: both fields "Match" -> Confirm -> "Your account is open and verified."
title Wealthfire preview - Onboarding scenario 2
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/?reader=demo&mode=misread" || start "" "http://127.0.0.1:5180/?reader=demo&mode=misread"
