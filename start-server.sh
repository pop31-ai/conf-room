#!/bin/bash
# ============================================
# Запуск сервера конференц-комнаты (Linux/AstraLinux)
# ============================================

echo "============================================"
echo "  Конференц-сервер"
echo "============================================"
echo ""

cd "$(dirname "$0")/server"

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "[ОШИБКА] Node.js не найден!"
    echo "Установите: sudo apt install nodejs npm"
    exit 1
fi

echo "Node.js: $(node --version)"

# Установка зависимостей
if [ ! -d "node_modules" ]; then
    echo "Установка зависимостей..."
    npm install
fi

echo ""
echo "Запуск сервера..."
echo "Веб-клиент: http://localhost:8080"
echo ""
node server.js
