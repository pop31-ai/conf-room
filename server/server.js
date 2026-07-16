/**
 * @fileoverview Сервер конференц-комнаты с голосовым ретранслятором
 * @module conf-room-server
 * @description P2P-сигналинг НЕ используется — весь голос идёт через сервер
 * как ретранслятор (relay). Работает за любым NAT/фаерволом.
 * Данные не хранятся — всё в оперативной памяти.
 */

const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// Конфигурация
// ============================================================

/** Порт HTTP (редирект на HTTPS) */
const HTTP_PORT = process.env.PORT || 8080;
/** Порт HTTPS (основной) */
const HTTPS_PORT = process.env.SSL_PORT || 8443;
/** Максимальный TTL файлов: 12 часов */
const MAX_FILE_TTL_MS = 12 * 60 * 60 * 1000;
/** Директория загрузок */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
/** Директория веб-клиента */
const WEB_DIR = path.join(__dirname, 'web');
/** SSL */
const SSL_KEY = path.join(__dirname, 'ssl', 'key.pem');
const SSL_CERT = path.join(__dirname, 'ssl', 'cert.pem');

// ============================================================
// Express + статика
// ============================================================

const app = express();
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.static(WEB_DIR));
app.use('/files', express.static(UPLOAD_DIR));

// ============================================================
// Multer (загрузка файлов)
// ============================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * POST /upload — загрузка файла
 */
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const ttl = Math.min(parseInt(req.body.ttl) || 3600000, MAX_FILE_TTL_MS);
  setTimeout(() => {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
  }, ttl);
  res.json({ url: '/download/' + req.file.filename, name: req.file.originalname, size: req.file.size, ttl });
});

/**
 * GET /download/:filename — скачивание файла с правильными заголовками
 * Поддерживает Range-запросы (для продолжения обрванной загрузки)
 */
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.txt': 'text/plain', '.json': 'application/json'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  if (req.headers.range) {
    const parts = req.headers.range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Content-Disposition': 'attachment'
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Content-Disposition': 'attachment',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

/**
 * GET /api/rooms — список активных комнат
 */
app.get('/api/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, code) => {
    list.push({ code, peers: room.peers.size, remaining: Math.max(0, room.ttl - (Date.now() - room.createdAt)) });
  });
  res.json(list);
});

// ============================================================
// Хранилище комнат (только в памяти)
// ============================================================

/** @type {Map<string, {code:string, peers:Map<string,WebSocket>, createdAt:number, ttl:number, timer:NodeJS.Timeout}>} */
const rooms = new Map();

/**
 * Создаёт комнату
 * @param {string} code - Код комнаты
 * @param {number} [ttlMs=600000] - Время жизни (мс)
 */
function createRoom(code, ttlMs = 600000) {
  if (rooms.has(code)) return rooms.get(code);
  const timer = setTimeout(() => destroyRoom(code), ttlMs);
  const room = { code, peers: new Map(), createdAt: Date.now(), ttl: ttlMs, timer };
  rooms.set(code, room);
  console.log(`[ROOM] Создана "${code}" (TTL: ${ttlMs / 1000}с)`);
  return room;
}

/**
 * Уничтожает комнату
 * @param {string} code
 */
function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.peers.forEach((ws) => {
    try { ws.send(JSON.stringify({ type: 'room_closed' })); ws.close(); } catch (e) {}
  });
  rooms.delete(code);
  console.log(`[ROOM] Удалена "${code}"`);
}

// ============================================================
// HTTP/HTTPS серверы
// ============================================================

const hasSSL = fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT);

const httpServer = http.createServer((req, res) => {
  if (hasSSL) {
    const host = req.headers.host.replace(/:\d+$/, ':' + HTTPS_PORT);
    res.writeHead(301, { Location: 'https://' + host + req.url });
    res.end();
  } else {
    app(req, res);
  }
});

let httpsServer = null;
if (hasSSL) {
  httpsServer = https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app);
}

const server = httpsServer || httpServer;

// ============================================================
// WebSocket сервер
// ============================================================

const wss = new WebSocketServer({ server });

/**
 * Бинарные аудио-пакеты не парсим — просто ретранслируем.
 * Текстовые JSON-сообщения обрабатываем.
 */
wss.on('connection', (ws) => {
  const peerId = uuidv4();
  let currentRoom = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log(`[WS] + ${peerId}`);

  /**
   * Отправить JSON-сообщение одному пиру
   */
  function sendTo(target, msg) {
    if (target.readyState === target.OPEN) {
      try { target.send(JSON.stringify(msg)); } catch (e) {}
    }
  }

  /**
   * Рассылка бинарных данных (аудио) всем в комнате кроме отправителя
   * Аудио имеет приоритет — отправляется без ожидания
   */
  function broadcastBinary(roomCode, data, excludeId) {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.peers.forEach((s, id) => {
      if (id === excludeId) return;
      if (s.readyState !== s.OPEN) return;
      if (s.bufferedAmount > 2 * 1024 * 1024) {
        try { s.close(); } catch (e) {}
        return;
      }
      try { s.send(data); } catch (e) {
        try { s.close(); } catch (e2) {}
      }
    });
  }

  /**
   * Рассылка JSON всем в комнате кроме отправителя
   * Файлы и чат — низкий приоритет
   */
  function broadcastText(roomCode, msg, excludeId) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const json = JSON.stringify(msg);
    room.peers.forEach((s, id) => {
      if (id === excludeId) return;
      if (s.readyState !== s.OPEN) return;
      try { s.send(json); } catch (e) {}
    });
  }

  /**
   * Покидание комнаты
   */
  function leaveRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.peers.delete(peerId);
      broadcastText(currentRoom, { type: 'peer_left', peerId });
      console.log(`[ROOM] ${peerId.slice(0, 8)} вышел из "${currentRoom}" (осталось: ${room.peers.size})`);
      if (room.peers.size === 0) destroyRoom(currentRoom);
    }
    currentRoom = null;
  }

  ws.on('message', (data, isBinary) => {
    // ============================================================
    // БИНАРНЫЕ ДАННЫЕ = аудио-пакет → ретрансляция
    // ============================================================
    if (isBinary) {
      if (currentRoom) {
        broadcastBinary(currentRoom, data, peerId);
      }
      return;
    }

    // ============================================================
    // ТЕКСТОВЫЕ JSON-СООБЩЕНИЯ
    // ============================================================
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    switch (msg.type) {
      // ---- Вход в комнату ----
      case 'join': {
        const code = String(msg.code || '').trim();
        if (!code) { sendTo(ws, { type: 'error', message: 'Код не указан' }); return; }
        if (currentRoom) leaveRoom();

        const ttl = Math.min(Math.max(parseInt(msg.ttl) || 600000, 10000), MAX_FILE_TTL_MS);
        const room = createRoom(code, ttl);

        if (room.peers.size >= 8) {
          sendTo(ws, { type: 'error', message: 'Комната заполнена (макс. 8)' });
          return;
        }

        room.peers.set(peerId, ws);
        currentRoom = code;

        const existingPeers = [];
        room.peers.forEach((_, id) => { if (id !== peerId) existingPeers.push(id); });

        sendTo(ws, {
          type: 'joined', peerId, peers: existingPeers,
          roomTTL: room.ttl,
          roomRemaining: Math.max(0, room.ttl - (Date.now() - room.createdAt))
        });
        broadcastText(code, { type: 'peer_joined', peerId }, peerId);
        console.log(`[ROOM] ${peerId.slice(0, 8)} вошёл в "${code}" (${room.peers.size} участников)`);
        break;
      }

      // ---- Текстовый чат ----
      case 'chat':
        broadcastText(currentRoom, { type: 'chat', from: peerId, text: msg.text, timestamp: Date.now() });
        break;

      // ---- Уведомление о файле ----
      case 'file_share':
        broadcastText(currentRoom, {
          type: 'file_share', from: peerId,
          fileName: msg.fileName, fileUrl: msg.fileUrl, fileSize: msg.fileSize, timestamp: Date.now()
        });
        break;

      // ---- Контроль медиа (индикатор) ----
      case 'media_control':
        broadcastText(currentRoom, { type: 'media_control', from: peerId, kind: msg.kind, muted: msg.muted }, peerId);
        break;

      // ---- Выход ----
      case 'leave':
        leaveRoom();
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[WS] - ${peerId.slice(0, 8)}`);
    leaveRoom();
  });

  ws.on('error', (e) => console.error(`[WS] ${peerId.slice(0, 8)}: ${e.message}`));
});

// ============================================================
// Запуск
// ============================================================

const PING_INTERVAL = 30000;

if (httpsServer) {
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`  HTTP (редирект): http://0.0.0.0:${HTTP_PORT}`);
  });
}

server.listen(httpsServer ? HTTPS_PORT : HTTP_PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Конференц-сервер (голосовой ретранслятор)');
  if (httpsServer) console.log(`  HTTPS: https://0.0.0.0:${HTTPS_PORT}`);
  console.log(`  HTTP:  http://0.0.0.0:${httpsServer ? HTTP_PORT : HTTPS_PORT}`);
  console.log('  Голос: WebSocket binary relay');
  console.log('============================================');
});

// Ping/pong для обнаружения мёртвых соединений
const pingTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`[PING] Мёртвое соединение, отключение`);
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, PING_INTERVAL);
wss.on('close', () => clearInterval(pingTimer));

process.on('SIGINT', () => {
  rooms.forEach((room) => {
    clearTimeout(room.timer);
    room.peers.forEach((w) => { try { w.close(); } catch (e) {} });
  });
  rooms.clear();
  server.close();
  process.exit(0);
});
