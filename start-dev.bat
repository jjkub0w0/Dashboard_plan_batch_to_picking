@echo off
title Plan Batch to Picking [DEV]
chcp 65001 >nul
cd /d "%~dp0"
title Plan Batch to Picking [DEV]
color 0B

echo ==============================================================================
echo       Plan Batch to Picking - Development Mode (Live Hot-Reload)
echo ==============================================================================
echo.

:: ตรวจสอบ Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] ไม่พบการติดตั้ง Node.js ในเครื่อง!
    pause
    exit /b 1
)

:: ตรวจสอบ Dependencies
if not exist "node_modules\" (
    echo [Setup] กำลังติดตั้ง Dependencies ระบบหลัก...
    call npm install
    title Plan Batch to Picking [DEV]
    echo.
)

if not exist "backend\node_modules\" (
    echo [Setup] กำลังติดตั้ง Dependencies ของ Backend...
    cd backend
    call npm install
    title Plan Batch to Picking [DEV]
    cd ..
    echo.
)

title Plan Batch to Picking [DEV]
node backend\server.js --dev

pause
