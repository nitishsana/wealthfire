@echo off
REM Onboarding preview with REAL document reading: sign in -> OTP -> your details -> Aadhaar OTP
REM -> upload documents -> check your numbers -> "You're all set".
REM Opens a fresh Edge InPrivate window, so it always starts at sign in and leaves no data behind.
REM Test values: mobile 9876543210, PAN ABCPS1234F with last name Sana, Aadhaar 234123412346 (valid),
REM or Aadhaar 234123470000 for "no linked mobile" at the Aadhaar OTP. OTP codes show in the yellow Demo banner.
REM Documents are read in this browser (Tesseract + pdf.js, nothing is uploaded). The first read loads
REM about 7 MB of reading files, so it takes a few seconds; "Reading your documents... NN%" shows progress.
REM What it catches: a file that is not a PAN / Aadhaar card ("This doesn't look like a PAN card..."),
REM a masked Aadhaar (XXXX XXXX 1234), a blurry photo with no readable number ("We couldn't read..."),
REM and a card whose number differs from what you typed (Check your numbers shows "Doesn't match").
REM To see "Match", type the numbers printed on the cards you upload; the test numbers above won't match a real card.
REM Use clear, flat, well-lit photos or PDFs of real cards. "Upload again" re-reads with extra passes
REM (larger, black/white and rotated copies) for sideways or faint photos.
REM Demo-reader scenarios (nothing is read): the "01 - Onboarding (...)" files next to this one.
REM Google Drive link stays disabled until GOOGLE_API_KEY and GOOGLE_APP_ID are set.
title Wealthfire preview - Onboarding
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/" || start "" "http://127.0.0.1:5180/"
