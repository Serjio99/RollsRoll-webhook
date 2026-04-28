@echo off

cd /d "%~dp0"
title RollsRoll logs
if exist logs\webhook-events.log (
  type logs\webhook-events.log
) else (
  echo Logs are empty yet. Send a test webhook first.
)
pause
