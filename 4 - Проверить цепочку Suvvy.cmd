@echo off
cd /d "%~dp0"
title RollsRoll Suvvy Check
node scripts\smoke-test.js
pause
