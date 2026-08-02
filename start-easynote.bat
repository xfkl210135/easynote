@echo off
chcp 65001 >nul
title EasyNote
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-easynote.ps1"
if errorlevel 1 (
  echo.
  echo EasyNote could not start. Please keep this window open and check the message above.
  pause
)
