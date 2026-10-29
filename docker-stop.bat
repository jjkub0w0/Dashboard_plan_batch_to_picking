@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Plan Batch to Picking [Stop Docker]
echo กำลังหยุดการทำงานของ Docker Container...
docker compose down
echo.
echo ปิดระบบเรียบร้อยแล้ว
pause
