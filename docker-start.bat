@echo off
title Plan Batch to Picking [Docker]
chcp 65001 >nul
cd /d "%~dp0"
title Plan Batch to Picking [Docker]
color 0A

echo ==============================================================================
echo       Plan Batch to Picking - Docker Container Launcher
echo       Frontend Port: 9999  |  Backend Port: 8888
echo ==============================================================================
echo.

:: 1. ตรวจสอบว่ามี Docker ติดตั้งหรือไม่
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] ไม่พบการติดตั้ง Docker ในเครื่องนี้!
    echo กรุณาเปิด Docker Desktop หรือติดตั้งจาก https://www.docker.com/
    pause
    exit /b 1
)

:: 2. ตรวจสอบว่า Docker Daemon กำลังทำงานอยู่หรือไม่
docker info >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Docker Desktop ยังไม่ได้เปิดทำงาน หรือ Daemon ไม่พร้อม!
    echo กรุณาเปิดโปรแกรม Docker Desktop แล้วรอสักครู่ จากนั้นลองใหม่อีกครั้ง
    pause
    exit /b 1
)

:: 3. ตรวจสอบไฟล์ผลลัพธ์ Frontend build
if not exist "dist\plan-batch-to-picking\browser\index.html" (
    echo [1/2] กำลังคอมไพล์ Frontend สำหรับนำเข้า Docker...
    call npm run build
    title Plan Batch to Picking [Docker]
    echo.
)

:: 4. สั่งรัน Docker Compose
echo [2/2] กำลัง Build และ Start Docker Container...
docker compose up -d --build

if %errorlevel% neq 0 (
    echo [ERROR] ไม่สามารถเริ่มรัน Docker Container ได้
    pause
    exit /b 1
)

echo.
rem IP-FIX: the LAN address used to be hardcoded (wrong on other networks).
set LAN_IP=
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object PrefixOrigin -ne WellKnown ^| Select-Object -First 1 -ExpandProperty IPAddress)"') do set LAN_IP=%%i
if "%LAN_IP%"=="" set LAN_IP=localhost
echo ==============================================================================
echo  ✅ ระบบทำงานเรียบร้อยใน Docker Container!
echo.
echo  - เปิดใช้งานบนเครื่องนี้:         http://localhost:9999
echo  - สำหรับเครื่องอื่นในวง LAN (Wi-Fi): http://%LAN_IP%:9999
echo  - Backend API โดยตรง:             http://%LAN_IP%:8888/api
echo ==============================================================================
echo.

echo กดปุ่มใดๆ เพื่อดูสถานะการทำงาน (Logs) ของ Container...
echo (หากต้องการออกจากหน้าต่าง logs ให้กด Ctrl + C)
pause >nul
title Plan Batch to Picking [Docker Logs]
docker compose logs -f
