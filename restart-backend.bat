@echo off
chcp 65001 >nul
title 漫橙映画 - 重启后端（应用新代码）

echo 正在停止当前后端 ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10588 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo 正在启动后端（新代码生效）...
start "Toonflow 后端 (10588)" cmd /k "cd /d %~dp0Toonflow-app && npm run dev"

echo.
echo 后端已重启，浏览器刷新页面即可继续使用。
timeout /t 5 >nul
