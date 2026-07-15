@echo off
echo Building Windows x64...
cd /d "%~dp0"
npm install
npx electron-builder --win --x64
echo.
echo Build complete: desktop\dist\
pause
