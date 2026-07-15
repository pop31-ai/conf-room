@echo off
title Конференц-сервер
echo ============================================
echo   Конференц-сервер
echo ============================================
echo.

cd /d "%~dp0server"

echo Проверка Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден!
    echo Скачайте: https://nodejs.org
    pause
    exit /b 1
)

echo Установка зависимостей...
if not exist node_modules (
    call npm install
)

echo.
echo Запуск сервера...
echo Веб-клиент: http://localhost:8080
echo.
call node server.js
pause
