@echo off
REM Connect preview only: Bank, CAS, broker placeholders; Gmail card.
REM Opens a fresh Edge InPrivate window with ?preview=demo, which loads the demo user with
REM onboarding already done (local preview only, never on the live site). Nothing is kept after you close it.
title Wealthfire preview - Connect
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/connect?preview=demo" || start "" "http://127.0.0.1:5180/connect?preview=demo"
