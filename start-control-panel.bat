@echo off
echo 🎮 Starting VCGamers Seller API Control Panel...

cd /d "D:\Quality-Assurance\seller-api"

:: Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found! Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    npm install
)

:: Start the control panel
echo 🚀 Starting Control Panel on http://localhost:8000
node server.js

pause
