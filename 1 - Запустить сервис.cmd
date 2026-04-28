@echo off
cd /d "%~dp0"
title RollsRoll Webhook Gateway
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3010" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
node src\server.js
pause
