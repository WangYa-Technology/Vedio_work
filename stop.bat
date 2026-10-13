@echo off
chcp 65001 >nul
title 漫橙映画 - 停止服务

echo 正在停止后端 (端口 10588) ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10588 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

echo 正在停止前端 (端口 50188) ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":50188 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

echo.
echo 服务已停止。
pause
