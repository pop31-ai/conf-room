# Руководство администратора и разработчика

Система голосовых конференций — Voice Conference Server (VCS)

Версия 1.0

---

## 1. Общие сведения о системе

Voice Conference Server (VCS) — система голосовых конференций в режиме реального времени, работающая через браузер. Не требует установки дополнительного ПО на стороне клиента.

**Основные возможности:**

- Голосовые комнаты (room) с произвольным идентификатором
- Передача голоса в реальном времени через WebSocket
- Текстовый чат внутри комнаты
- Отправка файлов участникам
- Управление микрофоном (вкл/выкл)
- Адаптивный джиттер-буфер для стабильного воспроизведения
- Автоматическая очистка неактивных комнат

**Системные требования сервера:**

| Параметр | Значение |
|---|---|
| ОС | Debian 12 (Bookworm) |
| Процессор | 1 vCPU |
| RAM | от 512 МБ |
| Диск | от 5 ГБ |
| Node.js | 18.x |
| IP-адрес | 87.242.117.240 |

---

## 2. Архитектура сервера

Сервер располагается в каталоге `/opt/conf-server/` и состоит из одного процесса Node.js.

### 2.1. Структура файлов

```
/opt/conf-server/
├── server.js              # Основной код сервера
├── package.json           # Зависимости Node.js
├── node_modules/          # Установленные пакеты
├── ssl/
│   ├── key.pem            # Приватный ключ SSL (2048 бит RSA)
│   └── cert.pem           # Самоподписанный сертификат SSL
└── web/
    ├── index.html         # Главная страница клиента
    ├── css/
    │   └── style.css      # Стили
    ├── js/
    │   └── app.js         # Клиентское приложение
    └── uploads/           # Загруженные файлы
```

### 2.2. Компоненты сервера

`server.js` реализует следующие компоненты:

- **HTTP(S)-сервер Express** — обслуживает статические файлы из `web/` и обрабатывает загрузку файлов.
- **WebSocket-сервер (библиотека `ws`)** — работает на том же порту 8443, обрабатывает сигнальные сообщения и ретранслирует бинарные аудиоданные.
- **Менеджер комнат** — `Map<roomId, Room>`, где `Room` содержит:
  - `peers: Map<peerId, Peer>` — участники комнаты
  - `ttlTimer` — таймер автоматического удаления
  - `createdAt` — время создания
- **Модуль загрузки файлов** — `multer`, сохраняет файлы в `web/uploads/`, возвращает URL для скачивания.
- **Планировщик очистки** — удаляет просроченные комнаты и файлы.

### 2.3. Модель данных в памяти

Вся информация хранится в оперативной памяти. Постоянное хранение не предусмотрено.

```
Global State:
  rooms: Map<string, Room>       # Комнаты
  peerRooms: Map<string, string> # Связь peerId → roomId

Room:
  id: string              # Идентификатор комнаты
  peers: Map<string, Peer>
  createdAt: number        # Date.now()
  ttlTimer: Timeout       # Таймер удаления (TTL по умолчанию 30 мин)

Peer:
  id: string              # Уникальный идентификатор
  ws: WebSocket           # Соединение
  joinedAt: number        # Время подключения
```

---

## 3. Архитектура клиента

Клиент — одностраничное приложение (`web/js/app.js`), выполняющееся в браузере. Использует Web Audio API для захвата и воспроизведения звука.

### 3.1. Состояние приложения

```javascript
const state = {
  ws: null,              // WebSocket-соединение
  peerId: null,          // Идентификатор участника
  currentRoom: null,     // Текущая комната
  audioEnabled: true,    // Состояние микрофона
  audioCtx: null,        // AudioContext
  processor: null,       // ScriptProcessorNode
  micStream: null,       // MediaStream с микрофона
  playQueue: [],         // Очередь воспроизведения
  netQuality: 10,        // Качество сети (1–10)
  jitterBufferSize: 2    // Размер джиттер-буфера (в чанках)
};
```

### 3.2. Захват и отправка звука

Функция `joinRoom()`:

1. Запрашивает доступ к микрофону через `getUserMedia({ audio: true })`.
2. Создаёт `ScriptProcessorNode` с размером буфера 256 сэмплов.
3. В обработчике `onaudioprocess`:
   - Применяет подавление тишины (порог `peak < 0.02`).
   - Выполняет fade-in/out на 16 сэмплах.
   - Ресемплирует с частоты дискретизации AudioContext до 8000 Гц (линейная интерполяция).
   - Преобразует `Float32` → `Int16` (масштабирование на 32767).
   - Отправляет `ArrayBuffer` через WebSocket.

**Ключевой фрагмент — отправка звука:**

```javascript
const inputData = event.inputBuffer.getChannelData(0);
const peak = Math.max(...inputData.map(Math.abs));
if (peak < 0.02) return; // подавление тишины

// fade-in (первые 16 сэмплов)
for (let i = 0; i < 16 && i < inputData.length; i++) {
  inputData[i] *= i / 16;
}
// fade-out (последние 16 сэмплов)
const len = inputData.length;
for (let i = len - 16; i < len; i++) {
  inputData[i] *= (len - i) / 16;
}

const resampled = resample(inputData, audioCtx.sampleRate, 8000);
const int16 = new Int16Array(resampled.length);
for (let i = 0; i < resampled.length; i++) {
  int16[i] = Math.max(-32768, Math.min(32767, resampled[i] * 32767));
}
ws.send(int16.buffer);
```

### 3.3. Приём и воспроизведение звука

Функция `playRemoteAudio(data)`:

1. Преобразует `Int16` → `Float32` (деление на 32768).
2. Ресемплирует с 8000 Гц до частоты AudioContext.
3. Создаёт `AudioBuffer` и планирует воспроизведение через `AudioBufferSourceNode`.
4. Использует адаптивный джиттер-буфер: измеряет межпакетные интервалы, при росте джиттера увеличивает буфер до 8 чанков, при снижении — уменьшает до 2.
5. Применяет fade-in/out на 48 сэмплах для устранения кликов.

### 3.4. Адаптивный джиттер-буфер

```javascript
function updateJitterBuffer() {
  const now = Date.now();
  if (lastPacketTime) {
    const interval = now - lastPacketTime;
    const deviation = Math.abs(interval - avgInterval);
    avgInterval = avgInterval * 0.9 + interval * 0.1;
    jitter = jitter * 0.9 + deviation * 0.1;
  }
  lastPacketTime = now;

  if (jitter > 100 && state.jitterBufferSize < 8) state.jitterBufferSize++;
  else if (jitter < 30 && state.jitterBufferSize > 2) state.jitterBufferSize--;

  state.netQuality = Math.max(1, Math.min(10, Math.round(10 - jitter / 20)));
}
```

### 3.5. Пользовательский интерфейс

- Индикатор качества сети (1–10) обновляется в реальном времени.
- Кнопка включения/выключения микрофона.
- Список участников комнаты.
- Текстовый чат с поддержкой отправки файлов.

---

## 4. Протокол обмена данными

Клиент и сервер обмениваются JSON-сообщениями и бинарными аудиоданными через WebSocket (wss://87.242.117.240:8443).

### 4.1. Сигнальные сообщения (JSON)

Все JSON-сообщения имеют поле `type`.

| Тип | Направление | Описание |
|---|---|---|
| `join` | Клиент → Сервер | Запрос на подключение к комнате |
| `leave` | Клиент → Сервер | Выход из комнаты |
| `chat` | Оба направления | Текстовое сообщение |
| `file_share` | Клиент → Сервер | Информация о файле |
| `media_control` | Оба направления | Управление медиа (микрофон) |
| `peers` | Сервер → Клиент | Список участников комнаты |
| `error` | Сервер → Клиент | Сообщение об ошибке |

### 4.2. Форматы сообщений

**join:**
```json
{
  "type": "join",
  "room": "room123",
  "peerId": "user-abc"
}
```

**leave:**
```json
{
  "type": "leave",
  "room": "room123"
}
```

**chat:**
```json
{
  "type": "chat",
  "room": "room123",
  "peerId": "user-abc",
  "text": "Привет всем!"
}
```

**file_share:**
```json
{
  "type": "file_share",
  "room": "room123",
  "peerId": "user-abc",
  "fileName": "presentation.pdf",
  "fileUrl": "/uploads/1712345678-presentation.pdf",
  "fileSize": 204800
}
```

**media_control:**
```json
{
  "type": "media_control",
  "room": "room123",
  "peerId": "user-abc",
  "audioEnabled": false
}
```

**peers (сервер → клиент):**
```json
{
  "type": "peers",
  "room": "room123",
  "peers": ["user-abc", "user-def", "user-ghi"]
}
```

**error:**
```json
{
  "type": "error",
  "message": "Room not found"
}
```

### 4.3. Аудиоданные (бинарные)

После установки соединения и входа в комнату клиенты отправляют бинарные фреймы WebSocket, содержащие аудиоданные в формате:

| Поле | Тип | Описание |
|---|---|---|
| Аудиосэмплы | `Int16Array` | PCM 16-bit signed, моно, 8000 Гц |
| Размер чанка | 256 сэмплов | Фиксированный размер до ресемплинга |
| Частота | 8000 Гц | После ресемплинга на клиенте |

Сервер не интерпретирует содержимое бинарных сообщений — он ретранслирует `ArrayBuffer` всем остальным участникам комнаты.

---

## 5. Установка и развёртывание

### 5.1. Подготовка сервера

```bash
# Обновление пакетов
apt update && apt upgrade -y

# Установка Node.js 18
apt install -y curl gnupg
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Проверка версий
node -v   # ожидается v18.x
npm -v    # ожидается 9.x

# Создание структуры каталогов
mkdir -p /opt/conf-server/ssl
mkdir -p /opt/conf-server/web/css
mkdir -p /opt/conf-server/web/js
mkdir -p /opt/conf-server/web/uploads
```

### 5.2. Копирование файлов приложения

Файлы приложения копируются в `/opt/conf-server/`:

```bash
# Предполагается, что файлы доступны на сервере через SCP или git
# Пример с SCP (с локальной машины):
scp server.js package.json index.html root@87.242.117.240:/opt/conf-server/
scp -r css/* root@87.242.117.240:/opt/conf-server/web/css/
scp -r js/* root@87.242.117.240:/opt/conf-server/web/js/
```

### 5.3. Установка зависимостей

```bash
cd /opt/conf-server
npm install express ws multer
```

Зависимости в `package.json`:

```json
{
  "name": "conf-server",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "multer": "^1.4.5-lts.1"
  }
}
```

### 5.4. Генерация SSL-сертификата

```bash
cd /opt/conf-server/ssl
openssl req -x509 -newkey rsa:2048 -keyout key.pem \
  -out cert.pem -days 365 -nodes \
  -subj "/C=RU/ST=Moscow/L=Moscow/O=Conference/CN=87.242.117.240"
```

### 5.5. Создание systemd-сервиса

`/etc/systemd/system/conf-server.service`:

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

### 5.6. Запуск сервиса

```bash
systemctl daemon-reload
systemctl enable conf-server
systemctl start conf-server
systemctl status conf-server
```

### 5.7. Проверка работоспособности

```bash
# Проверка HTTP → HTTPS редиректа
curl -I http://87.242.117.240:8080

# Проверка HTTPS
curl -k https://87.242.117.240:8443

# Проверка WebSocket (через wscat — установить при необходимости)
npm install -g wscat
wscat -c wss://87.242.117.240:8443
```

Ожидаемый ответ: HTML-страница интерфейса конференции.

---

## 6. Управление сервисом

### 6.1. Основные команды systemd

```bash
# Статус сервиса
systemctl status conf-server

# Запуск
systemctl start conf-server

# Остановка
systemctl stop conf-server

# Перезапуск
systemctl restart conf-server

# Автозапуск при загрузке
systemctl enable conf-server

# Отключение автозапуска
systemctl disable conf-server

# Просмотр логов
journalctl -u conf-server -f

# Последние 50 строк лога
journalctl -u conf-server -n 50 --no-pager
```

### 6.2. Обновление приложения на работающем сервере

```bash
cd /opt/conf-server

# Копирование новых файлов (server.js, web/js/app.js и т.д.)

# Проверка синтаксиса
node -c server.js

# Перезапуск сервиса
systemctl restart conf-server

# Проверка логов после перезапуска
journalctl -u conf-server -n 20 --no-pager
```

---

## 7. SSL-сертификаты

### 7.1. Генерация самоподписанного сертификата

При развёртывании:

```bash
cd /opt/conf-server/ssl
openssl req -x509 -newkey rsa:2048 -keyout key.pem \
  -out cert.pem -days 365 -nodes \
  -subj "/C=RU/ST=Moscow/L=Moscow/O=Conference/CN=87.242.117.240"
```

Параметры:

| Параметр | Значение |
|---|---|
| Алгоритм | RSA |
| Длина ключа | 2048 бит |
| Срок действия | 365 дней |
| CN | 87.242.117.240 (внешний IP) |

### 7.2. Просмотр информации о сертификате

```bash
openssl x509 -in /opt/conf-server/ssl/cert.pem -text -noout
```

### 7.3. Обновление сертификата

Сертификат необходимо обновлять раз в год (или чаще, в зависимости от политики безопасности):

```bash
# Бэкап старого сертификата
cd /opt/conf-server/ssl
cp key.pem key.pem.bak.$(date +%Y%m%d)
cp cert.pem cert.pem.bak.$(date +%Y%m%d)

# Генерация нового сертификата
openssl req -x509 -newkey rsa:2048 -keyout key.pem \
  -out cert.pem -days 365 -nodes \
  -subj "/C=RU/ST=Moscow/L=Moscow/O=Conference/CN=87.242.117.240"

# Перезапуск сервера для применения нового сертификата
systemctl restart conf-server
```

### 7.4. Замена на сертификат от Let's Encrypt (рекомендуется для продакшна)

```bash
# Установка certbot
apt install -y certbot

# Получение сертификата (требуется доменное имя)
certbot certonly --standalone -d conference.example.com

# Копирование сертификатов
cp /etc/letsencrypt/live/conference.example.com/fullchain.pem \
  /opt/conf-server/ssl/cert.pem
cp /etc/letsencrypt/live/conference.example.com/privkey.pem \
  /opt/conf-server/ssl/key.pem

# Перезапуск сервера
systemctl restart conf-server
```

Для автоматического обновления:

```bash
# Тестирование автоматического обновления
certbot renew --dry-run

# certbot добавляет задачу в systemd timer автоматически
# Проверка:
systemctl list-timers | grep certbot
```

---

## 8. Настройка Security Groups (Sber Cloud)

В Sber Cloud (и других облачных провайдерах) доступ к серверу контролируется через Security Groups (группы безопасности). **ufw не используется, так как Debian установлен в минимальной конфигурации.**

Серверу требуется открыть следующие порты:

| Направление | Протокол | Порт | Назначение | Источник |
|---|---|---|---|---|
| Входящий | TCP | 8443 | HTTPS + WebSocket Secure | 0.0.0.0/0 |
| Входящий | TCP | 8080 | HTTP → HTTPS редирект | 0.0.0.0/0 |
| Входящий | TCP | 22 | SSH (доступ администратора) | Ваш IP-адрес |

**Рекомендации:**

- Порт 22 (SSH) следует открывать только для IP-адресов администраторов, либо через bastion-хост.
- Порты 8443 и 8080 открыты для всех (`0.0.0.0/0`), так как клиенты подключаются из произвольных сетей.
- Исходящий трафик обычно разрешён полностью (All traffic, 0.0.0.0/0).

**Настройка через консоль Sber Cloud (Cloud Console):**

1. Перейти в раздел **Виртуальные сети → Группы безопасности**.
2. Выбрать группу безопасности, привязанную к серверу.
3. Добавить правила:

```
Правило 1: TCP, порт 8443, источник 0.0.0.0/0, описание "HTTPS + WSS"
Правило 2: TCP, порт 8080, источник 0.0.0.0/0, описание "HTTP redirect"
Правило 3: TCP, порт 22, источник <IP администратора>/32, описание "SSH admin"
```

Не рекомендуется добавлять другие правила без необходимости.

---

## 9. Мониторинг и логирование

### 9.1. Логи сервера (journald)

Сервер не использует отдельную систему логирования — все сообщения выводятся в `stdout`/`stderr` и собираются `journald`.

```bash
# Просмотр логов в реальном времени
journalctl -u conf-server -f

# Фильтр по времени
journalctl -u conf-server --since "1 hour ago"

# Фильтр по приоритету (только ошибки)
journalctl -u conf-server -p err

# Экспорт логов в файл
journalctl -u conf-server > /tmp/conf-server.log
```

### 9.2. Метрики для мониторинга

Сервер не предоставляет встроенных метрик. Рекомендуется добавить эндпоинт `/metrics` для сбора данных Prometheus. Ключевые показатели:

- Количество активных комнат (`rooms.size`)
- Количество подключённых пиров (сумма `room.peers.size` по всем комнатам)
- Количество переданных аудиосообщений
- Количество загруженных файлов
- Использование памяти процесса Node.js (`process.memoryUsage()`)

### 9.3. Пример: добавление эндпоинта мониторинга

В `server.js` добавить:

```javascript
app.get('/metrics', (req, res) => {
  const mem = process.memoryUsage();
  const totalPeers = Array.from(rooms.values())
    .reduce((sum, room) => sum + room.peers.size, 0);
  res.json({
    rooms: rooms.size,
    peers: totalPeers,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB'
    },
    uptime: process.uptime()
  });
});
```

Доступ по `https://87.242.117.240:8443/metrics` (нужно ограничить доступ по IP или токену).

### 9.4. Проверка состояния вручную

```bash
# Проверка использования портов
ss -tlnp | grep -E '8443|8080'

# Использование памяти процессом
ps aux | grep node

# Дисковое пространство
df -h /opt/conf-server/web/uploads/
```

---

## 10. Модификация и расширение

### 10.1. Локализация кода

Все комментарии и пользовательские строки в коде следует локализовать через отдельный модуль или объект с переводами. Примерная структура:

```javascript
const i18n = {
  ru: {
    roomNotFound: 'Комната не найдена',
    peerJoined: 'пользователь подключился',
    peerLeft: 'пользователь отключился'
  },
  en: {
    roomNotFound: 'Room not found',
    peerJoined: 'peer joined',
    peerLeft: 'peer left'
  }
};
```

### 10.2. Типичные сценарии доработки

**Изменение TTL комнаты:**

В `server.js`:

```javascript
const ROOM_TTL = 30 * 60 * 1000; // 30 минут
const FILE_TTL = 60 * 60 * 1000; // 1 час
```

**Изменение частоты дискретизации:**

В `app.js`, функция `joinRoom()`:

```javascript
const TARGET_SAMPLE_RATE = 8000; // изменить на 16000 для лучшего качества
```

**Добавление нового типа сигнального сообщения:**

В `server.js`, обработчик `ws.on('message')`:

```javascript
if (data.type === 'new_command') {
  // обработка
}
```

В `app.js`:

```javascript
ws.send(JSON.stringify({
  type: 'new_command',
  room: state.currentRoom,
  peerId: state.peerId,
  // дополнительные поля
}));
```

### 10.3. Добавление поддержки комнат с паролем

На сервере добавить поле `password` в объект комнаты:

```javascript
// Создание комнаты
rooms.set(roomId, {
  id: roomId,
  password: 'secret',
  peers: new Map(),
  createdAt: Date.now(),
  ttlTimer: null
});

// Проверка при join
if (room.password && data.password !== room.password) {
  ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' }));
  return;
}
```

### 10.4. Добавление ограничения числа участников

```javascript
const MAX_PEERS_PER_ROOM = 10;

// В обработчике join
if (room.peers.size >= MAX_PEERS_PER_ROOM) {
  ws.send(JSON.stringify({ type: 'error', message: 'Комната переполнена' }));
  return;
}
```

---

## 11. Известные ограничения

### 11.1. Технические ограничения

| Ограничение | Описание |
|---|---|
| Отсутствие постоянного хранения | При перезапуске сервера все комнаты, участники и история чата теряются |
| Одно соединение на peer | Один участник — одно WebSocket-соединение. Переоткрытие страницы создаёт нового peer |
| Самоподписанный SSL | Браузер предупреждает о небезопасном соединении при первом подключении |
| Отсутствие аутентификации | Любой может подключиться к любой комнате, зная её ID |
| Нет записи конференций | Аудиопоток не сохраняется |
| Ограничение по участникам | Не тестировалось более 10 одновременных участников в одной комнате |
| Нет шумоподавления | Используется только подавление тишины; фоновый шум передаётся |
| Использование ScriptProcessorNode | Этот API считается устаревшим, но остаётся наиболее совместимым для работы с PCM |

### 11.2. Ограничения безопасности

- **Нет шифрования аудио на уровне приложения** — безопасность обеспечивается исключительно на уровне транспортного (WSS/TLS).
- **Нет проверки типов файлов** — в `web/uploads/` можно загрузить любой файл. Рекомендуется добавить валидацию MIME-типов.
- **Размер загружаемых файлов** ограничен только настройками `multer` (по умолчанию 10 МБ).
- **Отсутствие rate limiting** — возможна отправка большого количества сигнальных сообщений.

### 11.3. Рекомендации по улучшению

1. **Добавить аутентификацию** — хотя бы базовую (токен в URL комнаты).
2. **Перейти на AudioWorklet** вместо `ScriptProcessorNode` для снижения задержки.
3. **Добавить Opus-кодирование** — передача голоса через Opus существенно снизит использование полосы пропускания (текущий PCM 8k — 128 Кбит/с на участника).
4. **Реализовать хранение сессий** — подключить Redis или SQLite для постоянного хранения комнат.
5. **Добавить мониторинг** — Prometheus/Grafana для отслеживания состояния сервера.
6. **Заменить самоподписанный сертификат** на Let's Encrypt при использовании доменного имени.
