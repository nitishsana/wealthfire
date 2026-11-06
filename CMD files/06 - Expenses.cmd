@echo off
REM Expenses preview only: Statement upload, manual spends, categories, Gmail card.
REM Opens a fresh Edge InPrivate window with ?preview=demo, which loads the demo user with
REM onboarding already done (local preview only, never on the live site). Nothing is kept after you close it.
title Wealthfire preview - Expenses
call "%~dp0_start-server.cmd" || exit /b 1
start "" msedge --inprivate "http://127.0.0.1:5180/expenses?preview=demo" || start "" "http://127.0.0.1:5180/expenses?preview=demo"
