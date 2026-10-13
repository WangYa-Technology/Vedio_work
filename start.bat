@echo off
chcp 65001 >nul
title 漫橙映画 - 一键启动

echo ============================================
echo   漫橙映画 一键启动
echo   后端: http://localhost:10588
echo   前端: http://localhost:50188
echo ============================================
echo.

echo [1/2] 正在启动后端 Toonflow-app ...
start "Toonflow 后端 (10588)" cmd /k "cd /d %~dp0Toonflow-app && npm run dev"

echo [2/2] 正在启动前端 Toonflow-web ...
start "Toonflow 前端 (50188)" cmd /k "cd /d %~dp0Toonflow-web && npm run dev"

echo.
echo 等待服务就绪后自动打开浏览器 ...
timeout /t 10 /nobreak >nul
start http://localhost:50188

echo.
echo 启动完成！
echo   - 登录账号: admin / admin123
echo   - 关闭上面弹出的两个命令行窗口即可停止服务
echo   - 本窗口可以关闭
pause
