@echo off
title Plan Batch to Picking
chcp 65001 >nul
cd /d "%~dp0"
title Plan Batch to Picking
color 0A

echo ==============================================================================
echo       Plan Batch to Picking - Warehouse Picking Verification System
echo ==============================================================================
echo.

:: 1. ตรวจสอบ Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] ไม่พบการติดตั้ง Node.js ในเครื่องคอมพิวเตอร์!
    echo กรุณาดาวน์โหลดและติดตั้ง Node.js จาก https://nodejs.org/ แล้วลองใหม่อีกครั้ง
    echo.
    pause
    exit /b 1
)

:: 2. ตรวจสอบ Dependencies ของระบบ
if not exist "node_modules\" (
    echo [Setup] ตรวจพบการใช้งานครั้งแรก กำลังติดตั้ง Dependencies ระบบหลัก...
    call npm install
    title Plan Batch to Picking
    echo.
)

if not exist "backend\node_modules\" (
    echo [Setup] ตรวจพบการใช้งานครั้งแรก กำลังติดตั้ง Dependencies ของ Backend...
    cd backend
    call npm install
    title Plan Batch to Picking
    cd ..
    echo.
)

:: 3. ตรวจสอบไฟล์ Production Build ของ Frontend
if not exist "dist\plan-batch-to-picking\browser\index.html" (
    echo [Setup] กำลังคอมไพล์ Frontend สำหรับพร้อมใช้งาน - เฉพาะการรันครั้งแรก...
    call npm run build
    title Plan Batch to Picking
    echo.
)

:: 4. แจ้งเตือนข้อแนะนำสำหรับ Windows QuickEdit
echo ------------------------------------------------------------------------------
echo   คำแนะนำ: หากหน้าเว็บหมุนค้างขณะใช้งาน ให้คลิกที่หน้าต่างนี้แล้วกดปุ่ม Enter 1 ครั้ง
echo   [เพื่อป้องกันโหมด QuickEdit Selection ของ Windows ที่จะสั่งหยุดโปรเซสชั่วคราว]
echo ------------------------------------------------------------------------------
echo.

:: 5. เริ่มต้นรันระบบผ่าน server.js
title Plan Batch to Picking
node backend\server.js

pause
