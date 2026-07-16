# Пояснительная записка №2

## Развёртывание и инфраструктура системы Voice Conference

**Версия:** 2.0
**Дата:** 2026-07-16

---

## 1. Назначение документа

Описание инфраструктуры сервера Voice Conference, процесса развёртывания, управления сервисом и средств обеспечения отказоустойчивости.

## 2. Серверное окружение

### 2.1. Параметры сервера

| Параметр | Значение |
|---|---|
| Платформа | Sber Cloud (ВМ) |
| Операционная система | Debian 12 (Bookworm), minimal install |
| Процессор | 1 vCPU |
| Оперативная память | 1 ГБ |
| Дисковое пространство | 10 ГБ |
| Внешний IP | 87.242.117.240 |
| Пользователь | `user1` (sudo без пароля) |

### 2.2. Выбор ОС

Debian 12 выбран вместо Ubuntu по следующим причинам:

| Критерий | Ubuntu 22.04 | Debian 12 |
|---|---|---|
| UFW | Устанавливается по умолчанию, конфликтует с Security Groups | Не установлен в minimal |
| SSH стабильность | SSH падает при конфликте UFW + Security Groups | Стабилен |
| Размер | Больше пакетов | Минимальный |
| Поддержка LTS | 5 лет | 5 лет |

**Вывод:** В облачной среде с Security Groups два файрвола (UFW + SG) создают неконфигурируемую проблему. Debian без UFW — предсказуемое поведение.

### 2.3. Сетевые порты

| Порт | Протокол | Назначение | Доступ |
|---|---|---|---|
| 8443 | TCP (HTTPS/WSS) | Основной — веб-клиент + WebSocket | 0.0.0.0/0 |
| 8080 | TCP (HTTP) | Редирект на HTTPS | 0.0.0.0/0 |
| 22 | TCP (SSH) | Администрирование | Только IP администратора |

## 3. Структура файлов на сервере

```
/opt/conf-server/
├── server.js                  # Серверный код (Node.js)
├── package.json               # Зависимости
├── package-lock.json
├── node_modules/
├── ssl/
│   ├── key.pem                # Приватный ключ RSA 2048
│   └── cert.pem               # Self-signed сертификат (365 дней)
├── web/
│   ├── index.html             # Клиент (lobby + room)
│   ├── css/style.css          # Стили (dark theme)
│   ├── js/app.js              # Клиентская логика (аудио, WS, UI)
│   └── uploads/               # Временные загрузки (TTL 12ч)
└── deploy.bat                 # Скрипт деплоя (Windows → SSH)
```

## 4. Процесс развёртывания

### 4.1. Инициальная установка

```bash
# 1. Подключение к серверу
ssh -i id_rsa user1@87.242.117.240

# 2. Установка Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs

# 3. Создание структуры
sudo mkdir -p /opt/conf-server/{ssl,web/{css,js,uploads}}

# 4. Генерация SSL
cd /opt/conf-server/ssl
openssl req -x509 -newkey rsa:2048 -keyout key.pem \
  -out cert.pem -days 365 -nodes \
  -subj "/C=RU/ST=Moscow/O=Conference/CN=87.242.117.240"

# 5. Установка зависимостей
cd /opt/conf-server
npm init -y
npm install express ws multer uuid

# 6. Копирование кода (server.js, web/*)
# 7. Настройка systemd
# 8. Запуск
```

### 4.2. systemd-сервис

**Файл:** `/etc/systemd/system/conf-server.service`

```ini
[Unit]
Description=Voice Conference Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/conf-server
ExecStart=/usr/bin/node /opt/conf-server/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Ключевые параметры:**
- `Restart=always` — автоматический перезапуск при падении
- `RestartSec=5` — задержка перед перезапуском 5 секунд
- `User=root` — доступ к портам <1024 без additional capabilities

### 4.3. Управление сервисом

```bash
sudo systemctl start conf-server      # Запуск
sudo systemctl stop conf-server       # Остановка
sudo systemctl restart conf-server    # Перезапуск
sudo systemctl status conf-server     # Статус
journalctl -u conf-server -f          # Логи в реальном времени
```

## 5. Процесс деплоя обновлений

### 5.1. Ручной деплой (deploy.bat)

```batch
@echo off
set SERVER=user1@87.242.117.240
set KEY=C:\Users\e\Desktop\conference\id_rsa

echo Clearing old files...
ssh -i %KEY% -o StrictHostKeyChecking=no %SERVER% "rm -rf /opt/conf-server/web/*"

echo Uploading...
scp -i %KEY% -o StrictHostKeyChecking=no -r C:\Users\e\Desktop\conference\web\* %SERVER%:/opt/conf-server/web/

echo Restarting...
ssh -i %KEY% -o StrictHostKeyChecking=no %SERVER% "sudo systemctl restart conf-server"

echo Done.
```

### 5.2. Полный цикл обновления

```
1. Изменение кода локально
2. Локальное тестирование (опционально)
3. git add -A && git commit -m "..." && git push
4. deploy.bat (загрузка + перезапуск)
5. Проверка на https://87.242.117.240:8443
```

## 6. SSL-сертификаты

### 6.1. Self-signed сертификат

| Параметр | Значение |
|---|---|
| Алгоритм | RSA |
| Длина ключа | 2048 бит |
| Срок действия | 365 дней |
| CN | 87.242.117.240 |

**Ограничение:** Браузер показывает предупреждение при первом подключении. Пользователь должен нажать «Продолжить».

### 6.2. Генерация нового сертификата

```bash
cd /opt/conf-server/ssl
openssl req -x509 -newkey rsa:2048 -keyout key.pem \
  -out cert.pem -days 365 -nodes \
  -subj "/C=RU/ST=Moscow/O=Conference/CN=87.242.117.240"
sudo systemctl restart conf-server
```

## 7. Отказоустойчивость

| Компонент | Механизм | Время восстановления |
|---|---|---|
| Процесс Node.js | systemd Restart=always | 5 секунд |
| WebSocket соединение | Клиент: auto-reconnect через 2 сек | 2 секунды |
| SSL-сертификат | Генерация при деплое | Ручное обновление раз в год |
| Файлы загрузок | Auto-delete по TTL (12 часов) | Автоматически |
| Комнаты | Auto-delete по TTL | Автоматически |

### 7.1. Мониторинг

```bash
# Статус сервиса
sudo systemctl status conf-server

# Последние логи
journalctl -u conf-server -n 50 --no-pager

# Использование памяти
ps aux | grep node

# Активные порты
ss -tlnp | grep -E '8443|8080'

# Список комнат (REST API)
curl -sk https://localhost:8443/api/rooms
```

## 8. Безопасность

| Мера | Реализация |
|---|---|
| Шифрование транспорта | TLS 1.2+ (self-signed) |
| Аутентификация | По коду комнаты (PIN) |
| Хранение данных | Только RAM, не пишется на диск |
| Логирование | Только события (join/leave), не содержимое |
| Ограничение размера файла | 100 МБ через multer |
| Backpressure | 2MB порог bufferedAmount, отключение при превышении |
| SSH доступ | Только с IP администратора |

## 9. Известные проблемы

| Проблема | Причина | Решение |
|---|---|---|
| SSH периодически падает | Sber Cloud Security Groups + systemd | Debian без UFW, перезапуск через консоль |
| Самоподписанный SSL | Нет доменного имени | Пользователь подтверждает вручную |
| Нет persistent storage | Архитектурное решение | При рестарте — потеря комнат и файлов |
