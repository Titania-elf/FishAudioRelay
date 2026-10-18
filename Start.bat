@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Fish Audio Private Relay
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
echo 本机模式：只有这台电脑能访问中转。
echo 想让手机酒馆也能用，请改双击「Start-手机可用.bat」。
echo.
node server.js
pause
