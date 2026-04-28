@echo off
cd /d "%~dp0"
title RollsRoll webhook service
node src\server.js
pause
