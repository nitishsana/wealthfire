@echo off
REM Onboarding preview, scenario 3: the documents hold different numbers.
REM Opens a fresh Edge InPrivate window, so it always starts at sign in and leaves no data behind.
REM Order: sign in -> OTP -> your details -> Aadhaar OTP -> upload documents -> check your numbers.
REM Test values: mobile 9876543210, PAN ABCPS1234F with last name Sana, Aadhaar 234123412346 (valid),
REM or Aadhaar 234123470000 for "no linked mobile" at the Aadhaar OTP. OTP codes show in the yellow Demo banner.
REM Documents: any JPG/PNG selfie (Take photo or Upload), and JPG/PNG/PDF cards under 10 MB (nothing is really read).
REM Uses the demo reader (nothing is read) via ?reader=demo&mode=... in the URL (dev server only); never shown on screen.
REM The reader returns PAN AAAPZ9999Z and Aadhaar 499118665246.
REM To see it: on Check your numbers press "Upload again" (or "Edit number" keeping your number); the re-check still differs
REM and shows "We'll check this by hand." -> Confirm -> "We're checking your details by hand...".
REM Then Settings -> Demo reviewer -> Approve (Verified) or Reject with a reason, and Settings -> Account -> "Redo documents".
title Wealthfire preview - Onboarding scenario 3
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/?reader=demo&mode=different" || start "" "http://127.0.0.1:5180/?reader=demo&mode=different"
