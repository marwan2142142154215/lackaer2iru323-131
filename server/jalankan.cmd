@echo off
chcp 65001 >nul
title Fleet Guard Server
cd /d "%~dp0"

echo ============================================================
echo   Fleet Guard Server  -  PC Anda
echo ============================================================
echo   Dashboard : http://192.168.100.118:8787/
echo   Health    : http://192.168.100.118:8787/healthz
echo   WS device : ws://192.168.100.118:8787/ws/v1/device
echo ============================================================
echo.
echo   Untuk menghentikan server: tekan Ctrl+C
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ada di PATH.
  echo Buka PowerShell lalu jalankan:
  echo   $env:Path += ";C:\Program Files\nodejs"
  pause
  exit /b 1
)

node src/index.js

echo.
echo Server berhenti.
pause