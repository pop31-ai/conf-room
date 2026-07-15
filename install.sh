#!/bin/bash
# ============================================
# Автоматическая установка конференц-сервера
# Скопируйте ВСЁ и вставьте в веб-консоль
# ============================================

set -e

echo "=== Установка конференц-сервера ==="

# 1. Добавляем SSH-ключ
mkdir -p ~/.ssh
echo 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDJGxHKxdZK271tSBzVSDo7//9L7aWfaNcN313sU1qSjW5f2A/EnfaWR8qZB1EyzoCaTcSUr90FK+l0ZGaFQx+8qy1HTq2shU88H0UVywL4wTU8vJ6JeswSLTiZWtbiv2N3Te6s7V9SwD7pGmRodysPVe0uZkSWgxVRzkTIo5ZzoAWXwFMhxjDZYpVK5sqP60kzf62w4wvhNwZ3mAaAwxTlVqXbgxDvMjgCxS+eib18OnrgzYLnOcerepIo98a5QAdEZHzeSF/0fVm61vIacycgtEQOhGGcJ4QQTIHu1fYjq0yG6P7IW104aVbrfcuUe02ZRUnHuV6OfC284ZzD2RzD' >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
echo "[OK] SSH-ключ добавлен"

# 2. Установка Node.js (если нет)
if ! command -v node &> /dev/null; then
    echo "Установка Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "[OK] Node.js $(node --version)"

# 3. Создание директории проекта
mkdir -p /opt/conf-server/uploads
cd /opt/conf-server

# 4. Создание package.json
cat > package.json << 'PKGJSON'
{
  "name": "conf-room-server",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "ws": "^8.16.0",
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "uuid": "^9.0.0"
  }
}
PKGJSON

# 5. Создание сервера
cat > server.js << 'SERVERJS'
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const MAX_FILE_TTL_MS = 12 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const WEB_DIR = path.join(__dirname, 'web');

const app = express();
app.use(express.static(WEB_DIR));
app.use('/files', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const rooms = new Map();

function createRoom(code, ttlMs = 600000) {
  if (rooms.has(code)) return rooms.get(code);
  const timer = setTimeout(() => destroyRoom(code), ttlMs);
  const room = { code, peers: new Map(), createdAt: Date.now(), ttl: ttlMs, timer };
  rooms.set(code, room);
  console.log(`[ROOM] Создана "${code}" (TTL: ${ttlMs/1000}с)`);
  return room;
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.peers.forEach((ws) => { try { ws.send(JSON.stringify({type:'room_closed',reason:'Время истекло'})); ws.close(); } catch(e){} });
  rooms.delete(code);
  console.log(`[ROOM] Удалена "${code}"`);
}

function getOrCreateRoom(code, ttl) { return rooms.get(code) || createRoom(code, ttl); }

const server = http.createServer(app);
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'Нет файла'});
  const ttl = Math.min(parseInt(req.body.ttl)||3600000, MAX_FILE_TTL_MS);
  setTimeout(() => { try { if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e){} }, ttl);
  res.json({ url: `/files/${req.file.filename}`, name: req.file.originalname, size: req.file.size, ttl });
});

app.get('/api/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, code) => list.push({code, peers:room.peers.size, remaining:Math.max(0,room.ttl-(Date.now()-room.createdAt))}));
  res.json(list);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const peerId = uuidv4();
  let currentRoom = null;

  function sendTo(target, msg) { if(target.readyState===target.OPEN) target.send(JSON.stringify(msg)); }
  function broadcast(roomCode, msg, excludeId) {
    const room = rooms.get(roomCode);
    if(!room) return;
    room.peers.forEach((s,id) => { if(id!==excludeId) sendTo(s,msg); });
  }

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch(e) { return; }
    switch(msg.type) {
      case 'join': {
        const code = String(msg.code||'').trim();
        if(!code) { sendTo(ws,{type:'error',message:'Код не указан'}); return; }
        if(currentRoom) leaveCurrentRoom();
        const ttl = Math.min(Math.max(parseInt(msg.ttl)||600000,10000),MAX_FILE_TTL_MS);
        const room = getOrCreateRoom(code, ttl);
        if(room.peers.size>=8) { sendTo(ws,{type:'error',message:'Комната заполнена'}); return; }
        room.peers.set(peerId, ws);
        currentRoom = code;
        const existingPeers = [];
        room.peers.forEach((_,id) => { if(id!==peerId) existingPeers.push(id); });
        sendTo(ws,{type:'joined',peerId,peers:existingPeers,roomTTL:room.ttl,roomRemaining:Math.max(0,room.ttl-(Date.now()-room.createdAt))});
        broadcast(code,{type:'peer_joined',peerId},peerId);
        break;
      }
      case 'offer': { const room=rooms.get(currentRoom); if(!room)return; const t=room.peers.get(msg.to); if(t) sendTo(t,{type:'offer',from:peerId,sdp:msg.sdp}); break; }
      case 'answer': { const room=rooms.get(currentRoom); if(!room)return; const t=room.peers.get(msg.to); if(t) sendTo(t,{type:'answer',from:peerId,sdp:msg.sdp}); break; }
      case 'candidate': { const room=rooms.get(currentRoom); if(!room)return; const t=room.peers.get(msg.to); if(t) sendTo(t,{type:'candidate',from:peerId,candidate:msg.candidate}); break; }
      case 'media_control': broadcast(currentRoom,{type:'media_control',from:peerId,kind:msg.kind,muted:msg.muted},peerId); break;
      case 'chat': broadcast(currentRoom,{type:'chat',from:peerId,text:msg.text,timestamp:Date.now()}); break;
      case 'file_share': broadcast(currentRoom,{type:'file_share',from:peerId,fileName:msg.fileName,fileUrl:msg.fileUrl,fileSize:msg.fileSize,timestamp:Date.now()}); break;
      case 'leave': leaveCurrentRoom(); break;
    }
  });

  ws.on('close', () => leaveCurrentRoom());
  ws.on('error', (e) => console.error(`[WS] ${peerId}:`, e.message));

  function leaveCurrentRoom() {
    if(!currentRoom) return;
    const room = rooms.get(currentRoom);
    if(room) { room.peers.delete(peerId); broadcast(currentRoom,{type:'peer_left',peerId},peerId); if(room.peers.size===0) destroyRoom(currentRoom); }
    currentRoom = null;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Конференц-сервер запущен');
  console.log(`  http://0.0.0.0:${PORT}`);
  console.log('============================================');
});

process.on('SIGINT', () => { rooms.forEach((room)=>{clearTimeout(room.timer);room.peers.forEach((w)=>{try{w.close();}catch(e){}});}); rooms.clear(); server.close(); process.exit(0); });
SERVERJS

# 6. Создание веб-клиента
mkdir -p web/css web/js

cat > web/index.html << 'WEBHTML'
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Конференц-комната</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="lobby-screen" class="screen">
    <div class="lobby-card">
      <h1>Конференц-комната</h1>
      <p class="subtitle">Договоритесь о коде в прихожей</p>
      <div class="input-group">
        <label for="input-code">Код комнаты</label>
        <input type="text" id="input-code" placeholder="Например: 1234" maxlength="20" autocomplete="off" autofocus>
      </div>
      <div class="input-group">
        <label for="input-ttl">Время комнаты (минут)</label>
        <input type="number" id="input-ttl" value="10" min="1" max="720" placeholder="10">
      </div>
      <button id="btn-join" class="btn-primary">Войти</button>
      <p class="hint">Код — просто число или слово</p>
    </div>
  </div>
  <div id="room-screen" class="screen hidden">
    <div class="room-header">
      <div id="status-text" class="status">Подключение...</div>
      <div id="timer-display" class="timer">⏱ --:--:--</div>
    </div>
    <div id="video-grid" class="video-grid"></div>
    <div class="controls">
      <button id="btn-toggle-audio" class="control-btn" title="Микрофон">🎤</button>
      <button id="btn-toggle-video" class="control-btn" title="Камера">📷</button>
      <label class="control-btn" title="Файл">📎<input type="file" id="file-input" style="display:none" accept="*/*"></label>
      <button id="btn-leave" class="control-btn leave" title="Выйти">✕</button>
    </div>
    <div class="chat-panel">
      <div id="chat-messages" class="chat-messages"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Сообщение..." maxlength="1000">
        <button id="btn-send-chat" class="btn-send">→</button>
      </div>
    </div>
  </div>
  <script src="js/app.js"></script>
</body>
</html>
WEBHTML

cat > web/css/style.css << 'WEBCSS'
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1a1a2e;--surface:#16213e;--surface2:#0f3460;--accent:#e94560;--accent2:#533483;--text:#eee;--text2:#aaa;--radius:12px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
.hidden{display:none!important}
.screen{width:100%;height:100vh;display:flex;align-items:center;justify-content:center}
.lobby-card{background:var(--surface);padding:40px;border-radius:var(--radius);text-align:center;max-width:400px;width:90%}
.lobby-card h1{font-size:1.6rem;margin-bottom:8px}
.subtitle{color:var(--text2);margin-bottom:24px;font-size:.9rem}
.input-group{margin-bottom:16px;text-align:left}
.input-group label{display:block;margin-bottom:6px;font-size:.85rem;color:var(--text2)}
.input-group input{width:100%;padding:12px 16px;border:2px solid var(--surface2);border-radius:8px;background:var(--bg);color:var(--text);font-size:1rem;outline:none;transition:border-color .2s}
.input-group input:focus{border-color:var(--accent)}
.btn-primary{width:100%;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:1.1rem;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-primary:hover{opacity:.9}
.hint{margin-top:16px;color:var(--text2);font-size:.78rem}
#room-screen{flex-direction:column;height:100vh}
.room-header{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--surface2)}
.status{font-size:.85rem;color:var(--text2)}
.timer{font-size:.9rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}
.video-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;padding:8px;overflow-y:auto;background:#111}
.video-container{position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:16/9}
.video-container video{width:100%;height:100%;object-fit:cover}
.video-container.local{position:fixed;bottom:80px;right:20px;width:180px;aspect-ratio:16/9;z-index:10;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.video-label{position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,.6);color:#fff;padding:2px 8px;border-radius:4px;font-size:.75rem}
.media-status{position:absolute;top:6px;right:8px;font-size:1.2rem}
.controls{display:flex;justify-content:center;gap:12px;padding:12px;background:var(--surface);border-top:1px solid var(--surface2)}
.control-btn{width:48px;height:48px;border:none;border-radius:50%;background:var(--surface2);color:var(--text);font-size:1.3rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s}
.control-btn:hover{background:var(--accent2)}
.control-btn.off{background:var(--accent)}
.control-btn.leave{background:#c0392b}
.control-btn.leave:hover{background:#e74c3c}
.chat-panel{position:fixed;right:0;top:50px;bottom:70px;width:320px;display:flex;flex-direction:column;background:rgba(22,33,62,.95);border-left:1px solid var(--surface2);z-index:20}
.chat-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.chat-message{padding:8px 12px;border-radius:8px;max-width:90%;word-wrap:break-word}
.chat-message.mine{background:var(--accent2);align-self:flex-end}
.chat-message.theirs{background:var(--surface2);align-self:flex-start}
.chat-sender{font-size:.7rem;color:var(--accent);margin-bottom:2px;font-weight:600}
.chat-text{font-size:.88rem}
.chat-time{font-size:.65rem;color:var(--text2);margin-top:4px;text-align:right}
.chat-file a{color:var(--accent);text-decoration:none;font-size:.85rem}
.chat-file a:hover{text-decoration:underline}
.chat-input-row{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--surface2)}
.chat-input-row input{flex:1;padding:10px;border:1px solid var(--surface2);border-radius:6px;background:var(--bg);color:var(--text);font-size:.88rem;outline:none}
.btn-send{padding:10px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:1.1rem;cursor:pointer}
@media(max-width:768px){.chat-panel{position:fixed;left:0;right:0;bottom:70px;top:auto;width:100%;height:45vh;border-left:none;border-top:1px solid var(--surface2);display:none}.chat-panel.show{display:flex}.video-container.local{width:120px;bottom:140px;right:10px}.lobby-card{padding:24px}.video-grid{grid-template-columns:1fr}}
WEBCSS

cat > web/js/app.js << 'WEBJS'
const SIGNAL_URL=`ws://${location.hostname}:${location.port||8080}`;
const UPLOAD_URL=`${location.origin}/upload`;
const ICE_CONFIG={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};
const MAX_FILE_SIZE=100*1024*1024;
const state={ws:null,peerId:null,currentRoom:null,peers:new Map(),remoteStreams:new Map(),localStream:null,audioEnabled:true,videoEnabled:true};
let timerInterval=null;

function init(){
  document.getElementById('btn-join').addEventListener('click',joinRoom);
  document.getElementById('btn-leave').addEventListener('click',leaveRoom);
  document.getElementById('btn-send-chat').addEventListener('click',sendChatMessage);
  document.getElementById('btn-toggle-audio').addEventListener('click',toggleAudio);
  document.getElementById('btn-toggle-video').addEventListener('click',toggleVideo);
  document.getElementById('file-input').addEventListener('change',handleFileUpload);
  document.getElementById('chat-input').addEventListener('keypress',(e)=>{if(e.key==='Enter')sendChatMessage()});
  document.getElementById('input-code').addEventListener('keypress',(e)=>{if(e.key==='Enter')joinRoom()});
}

async function joinRoom(){
  const code=document.getElementById('input-code').value.trim();
  if(!code){alert('Введите код комнаты');return}
  const ttl=(parseInt(document.getElementById('input-ttl').value)||10)*60*1000;
  setStatus('Запрос камеры...');
  try{state.localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true})}
  catch(err){state.localStream=new MediaStream()}
  setStatus('Подключение...');
  state.ws=new WebSocket(SIGNAL_URL);
  state.ws.onopen=()=>{setStatus('Вход в комнату...');state.ws.send(JSON.stringify({type:'join',code,ttl}))};
  state.ws.onmessage=async(e)=>{await handleSignalingMessage(JSON.parse(e.data))};
  state.ws.onclose=()=>{setStatus('Соединение потеряно');cleanup()};
  state.ws.onerror=()=>{setStatus('Ошибка соединения')};
}

async function handleSignalingMessage(msg){
  switch(msg.type){
    case 'joined':
      state.peerId=msg.peerId;state.currentRoom=document.getElementById('input-code').value.trim();
      document.getElementById('lobby-screen').classList.add('hidden');
      document.getElementById('room-screen').classList.remove('hidden');
      showLocalVideo();startTimer(msg.roomRemaining);
      setStatus(`В комнате. Участников: ${msg.peers.length+1}`);
      for(const p of msg.peers) await createPeerConnection(p,true);
      break;
    case 'peer_joined': setStatus(`Участник ${msg.peerId.slice(0,8)} пришёл`);await createPeerConnection(msg.peerId,true);break;
    case 'peer_left':removePeer(msg.peerId);setStatus(`Участник ${msg.peerId.slice(0,8)} вышел`);break;
    case 'offer':await handleOffer(msg.from,msg.sdp);break;
    case 'answer':await handleAnswer(msg.from,msg.sdp);break;
    case 'candidate':await handleCandidate(msg.from,msg.candidate);break;
    case 'media_control':handleMediaControl(msg.from,msg.kind,msg.muted);break;
    case 'chat':addChatMessage(msg.from,msg.text,msg.timestamp);break;
    case 'file_share':addFileMessage(msg.from,msg.fileName,msg.fileUrl,msg.fileSize,msg.timestamp);break;
    case 'room_closed':alert(msg.reason||'Комната закрыта');cleanup();break;
    case 'error':alert(msg.message);break;
  }
}

async function createPeerConnection(remotePeerId,isInitiator){
  if(state.peers.has(remotePeerId))return state.peers.get(remotePeerId);
  const pc=new RTCPeerConnection(ICE_CONFIG);state.peers.set(remotePeerId,pc);
  if(state.localStream)state.localStream.getTracks().forEach(t=>pc.addTrack(t,state.localStream));
  pc.onicecandidate=(e)=>{if(e.candidate&&state.ws)state.ws.send(JSON.stringify({type:'candidate',to:remotePeerId,candidate:e.candidate}))};
  pc.ontrack=(e)=>addRemoteStream(remotePeerId,e.streams[0]);
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'||pc.connectionState==='disconnected')removePeer(remotePeerId)};
  if(isInitiator){try{const o=await pc.createOffer();await pc.setLocalDescription(o);if(state.ws)state.ws.send(JSON.stringify({type:'offer',to:remotePeerId,sdp:pc.localDescription}))}catch(e){}}
  return pc;
}

async function handleOffer(from,sdp){
  const pc=await createPeerConnection(from,false);
  try{await pc.setRemoteDescription(new RTCSessionDescription(sdp));const a=await pc.createAnswer();await pc.setLocalDescription(a);if(state.ws)state.ws.send(JSON.stringify({type:'answer',to:from,sdp:pc.localDescription}))}catch(e){}
}
async function handleAnswer(from,sdp){const pc=state.peers.get(from);if(!pc)return;try{await pc.setRemoteDescription(new RTCSessionDescription(sdp))}catch(e){}}
async function handleCandidate(from,candidate){const pc=state.peers.get(from);if(!pc)return;try{await pc.addIceCandidate(new RTCIceCandidate(candidate))}catch(e){}}

function addRemoteStream(peerId,stream){
  state.remoteStreams.set(peerId,stream);
  const old=document.getElementById(`video-${peerId}`);if(old)old.remove();
  const c=document.createElement('div');c.className='video-container';c.id=`video-${peerId}`;
  const v=document.createElement('video');v.autoplay=true;v.playsinline=true;v.srcObject=stream;
  const l=document.createElement('div');l.className='video-label';l.textContent=peerId.slice(0,8);
  c.appendChild(v);c.appendChild(l);document.getElementById('video-grid').appendChild(c);
}
function removePeer(peerId){const pc=state.peers.get(peerId);if(pc){pc.close();state.peers.delete(peerId)}state.remoteStreams.delete(peerId);const e=document.getElementById(`video-${peerId}`);if(e)e.remove()}

function showLocalVideo(){
  const c=document.createElement('div');c.className='video-container local';c.id='local-video';
  const v=document.createElement('video');v.autoplay=true;v.playsinline=true;v.muted=true;v.srcObject=state.localStream;
  const l=document.createElement('div');l.className='video-label';l.textContent='Вы';
  c.appendChild(v);c.appendChild(l);document.getElementById('video-grid').appendChild(c);
}

function toggleAudio(){if(!state.localStream)return;state.audioEnabled=!state.audioEnabled;state.localStream.getAudioTracks().forEach(t=>{t.enabled=state.audioEnabled});const b=document.getElementById('btn-toggle-audio');b.textContent=state.audioEnabled?'🎤':'🔇';b.className=state.audioEnabled?'control-btn':'control-btn off';if(state.ws)state.ws.send(JSON.stringify({type:'media_control',kind:'audio',muted:!state.audioEnabled}))}
function toggleVideo(){if(!state.localStream)return;state.videoEnabled=!state.videoEnabled;state.localStream.getVideoTracks().forEach(t=>{t.enabled=state.videoEnabled});const b=document.getElementById('btn-toggle-video');b.className=state.videoEnabled?'control-btn':'control-btn off';if(state.ws)state.ws.send(JSON.stringify({type:'media_control',kind:'video',muted:!state.videoEnabled}))}
function handleMediaControl(from,kind,muted){const c=document.getElementById(`video-${from}`);if(!c)return;let s=c.querySelector('.media-status')||document.createElement('div');s.className='media-status';s.textContent=muted?(kind==='audio'?'🔇':'📷❌'):'';s.style.display=muted?'block':'none';if(!c.querySelector('.media-status'))c.appendChild(s)}

function sendChatMessage(){const t=document.getElementById('chat-input').value.trim();if(!t||!state.ws)return;state.ws.send(JSON.stringify({type:'chat',text:t}));addChatMessage(state.peerId,t,Date.now(),true);document.getElementById('chat-input').value=''}
function addChatMessage(p,t,ts,isMine=false){
  const m=document.createElement('div');m.className=`chat-message ${isMine?'mine':'theirs'}`;
  const tm=new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  m.innerHTML=`<div class="chat-sender">${isMine?'Вы':p.slice(0,8)}</div><div class="chat-text">${escapeHtml(t)}</div><div class="chat-time">${tm}</div>`;
  const ch=document.getElementById('chat-messages');ch.appendChild(m);ch.scrollTop=ch.scrollHeight;
}
function addFileMessage(p,name,url,size,ts){
  const m=document.createElement('div');m.className='chat-message file-message';
  const tm=new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  m.innerHTML=`<div class="chat-sender">${p.slice(0,8)}</div><div class="chat-file"><a href="${url}" target="_blank" download="${escapeHtml(name)}">📎 ${escapeHtml(name)} (${(size/1024).toFixed(1)} КБ)</a></div><div class="chat-time">${tm}</div>`;
  const ch=document.getElementById('chat-messages');ch.appendChild(m);ch.scrollTop=ch.scrollHeight;
}

async function handleFileUpload(e){
  const file=e.target.files[0];if(!file)return;
  if(file.size>MAX_FILE_SIZE){alert('Файл слишком большой');return}
  setStatus(`Загрузка "${file.name}"...`);
  try{const fd=new FormData();fd.append('file',file);fd.append('ttl',String((parseInt(document.getElementById('input-ttl').value)||10)*60*1000));
  const r=await fetch(UPLOAD_URL,{method:'POST',body:fd});const res=await r.json();
  if(res.url){if(state.ws)state.ws.send(JSON.stringify({type:'file_share',fileName:file.name,fileUrl:res.url,fileSize:file.size}));addFileMessage(state.peerId,file.name,res.url,file.size,Date.now());setStatus('Файл загружен');}else alert('Ошибка');
  }catch(e){alert('Ошибка загрузки')}e.target.value='';
}

function startTimer(remainingMs){
  if(timerInterval)clearInterval(timerInterval);let remaining=remainingMs;
  function fmt(ms){const t=Math.floor(ms/1000);return `${String(Math.floor(t/3600)).padStart(2,'0')}:${String(Math.floor((t%3600)/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`}
  function tick(){document.getElementById('timer-display').textContent=`⏱ ${fmt(remaining)}`;if(remaining<=0){clearInterval(timerInterval);document.getElementById('timer-display').textContent='⏱ Время вышло!'}remaining-=1000}
  tick();timerInterval=setInterval(tick,1000);
}

function leaveRoom(){if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'leave'}));cleanup()}
function cleanup(){
  if(timerInterval){clearInterval(timerInterval);timerInterval=null}
  state.peers.forEach(pc=>{try{pc.close()}catch(e){}});state.peers.clear();state.remoteStreams.clear();
  if(state.localStream){state.localStream.getTracks().forEach(t=>t.stop());state.localStream=null}
  if(state.ws){try{state.ws.close()}catch(e){}state.ws=null}
  const vg=document.getElementById('video-grid');if(vg)vg.innerHTML='';
  const cm=document.getElementById('chat-messages');if(cm)cm.innerHTML='';
  state.peerId=null;state.currentRoom=null;
  document.getElementById('room-screen').classList.add('hidden');
  document.getElementById('lobby-screen').classList.remove('hidden');
  setStatus('Готов к подключению');
}
function setStatus(t){const s=document.getElementById('status-text');if(s)s.textContent=t}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
document.addEventListener('DOMContentLoaded',init);
WEBJS

# 7. Установка зависимостей
npm install

# 8. Настройка systemd сервиса
cat > /etc/systemd/system/conf-server.service << 'SVC'
[Unit]
Description=Conference Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/conf-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable conf-server
systemctl start conf-server

echo ""
echo "============================================"
echo "  УСТАНОВКА ЗАВЕРШЕНА!"
echo "  Сервер: http://87.242.117.240:8080"
echo "  Статус: systemctl status conf-server"
echo "============================================"
