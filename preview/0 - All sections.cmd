@echo off
REM Consolidated preview: the whole Wealthfire app, in your normal browser.
REM Your data from earlier previews is kept (it lives in this browser only).
title Wealthfire preview - All sections
call "%~dp0_start-server.cmd" || exit /b 1
start "" "http://127.0.0.1:5180/"
