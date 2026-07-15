@echo off
title Конференц-комната (Десктоп)
echo ============================================
echo   Конференц-комната (Десктоп)
echo ============================================
echo.

cd /d "%~dp0desktop"

echo Проверка Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден!
    pause
    exit /b 1
)

echo Установка зависимостей...
if not exist node_modules (
    call npm install
)

echo.
echo Запуск десктопного клиента...
echo Убедитесь, что сервер запущен!
echo.
call npx electron .
pause
