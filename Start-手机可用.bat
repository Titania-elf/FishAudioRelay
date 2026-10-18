@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Fish Audio Private Relay (LAN)
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
echo 手机可用模式：同一 Wi-Fi 下的手机也能用中转。
echo.
echo 首次启动时，Windows 可能弹出防火墙询问是否允许 node.exe 联网，
echo 请勾选「专用网络」并点「允许访问」，否则手机会连不上。
echo.
echo 启动后请查看窗口里打印的「手机酒馆中转地址」，
echo 也可以在本机管理页复制这个地址。
echo.
set FISH_RELAY_LAN=1
node server.js
pause
