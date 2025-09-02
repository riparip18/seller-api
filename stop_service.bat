@echo off
echo Stopping Seller API Service...

:: Kill all related processes
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM ngrok.exe >nul 2>&1

echo Service stopped!
pause
