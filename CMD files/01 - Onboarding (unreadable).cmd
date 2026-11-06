@echo off
REM Onboarding preview: the reader cannot read the cards.
REM Opens a fresh Edge InPrivate window, so it always starts at sign in and leaves no data behind.
REM Order: sign in -> OTP -> your details -> Aadhaar OTP -> upload documents -> check your numbers.
REM Test values: mobile 9876543210, PAN ABCPS1234F with last name Sana, Aadhaar 234123412346 (valid),
REM or Aadhaar 234123470000 for "no linked mobile" at the Aadhaar OTP. OTP codes show in the yellow Demo banner.
REM Documents: any JPG/PNG selfie (Take photo or Upload), and JPG/PNG/PDF cards under 10 MB (nothing is really read).
REM Uses the demo reader (nothing is read) via ?reader=demo&mode=... in the URL (dev server only); never shown on screen.
REM To see it: add all three documents and press Continue on Upload documents.
REM Expect under each card: "We couldn't read your PAN card. Upload a clearer photo or PDF." (and Aadhaar card),
REM and the step stays on Upload documents.
title Wealthfire preview - Onboarding unreadable
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/?reader=demo&mode=unreadable" || start "" "http://127.0.0.1:5180/?reader=demo&mode=unreadable"
