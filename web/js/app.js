/**
 * @fileoverview Голосовая комната — серверный ретранслятор
 * @description Голос через WebSocket binary relay.
 * Без WebRTC/STUN/TURN — работает за любым NAT/фаерволом.
 */

const SIGNAL_URL = location.protocol === 'https:'
  ? `wss://${location.hostname}:${location.port || 443}`
  : `ws://${location.hostname}:${location.port || 8080}`;
const UPLOAD_URL = `${location.origin}/upload`;

const state = {
  ws: null, peerId: null, currentRoom: null, audioEnabled: true,
  audioCtx: null, processor: null, micStream: null, nextPlayTime: 0,
  playQueue: [], netQuality: 5, packetTimes: [], lastPacketTime: 0,
  playGain: null, micActive: false
};

function init() {
  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('btn-leave').addEventListener('click', leaveRoom);
  document.getElementById('btn-send-chat').addEventListener('click', sendChatMessage);
  document.getElementById('btn-toggle-audio').addEventListener('click', toggleAudio);
  document.getElementById('file-input').addEventListener('change', handleFileUpload);
  document.getElementById('chat-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendChatMessage(); });
  document.getElementById('input-code').addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });
  initSpeakerToggle();
}

// ============================================================
// Вход в комнату
// ============================================================

async function joinRoom() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  const code = document.getElementById('input-code').value.trim();
  if (!code) { alert('Введите код комнаты'); return; }
  const ttl = (parseInt(document.getElementById('input-ttl').value) || 10) * 60 * 1000;

  setStatus('Подключение...');

  // Пытаемся захватить микрофон (не обязательно — можно слушать без него)
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }, video: false });

    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.audioCtx.createMediaStreamSource(state.micStream);

    const desired = Math.floor(state.audioCtx.sampleRate * 0.02);
    let bufSize = 256;
    while (bufSize < desired && bufSize < 4096) bufSize *= 2;
    state.processor = state.audioCtx.createScriptProcessor(bufSize, 1, 1);

    state.processor.onaudioprocess = (e) => {
      if (!state.audioEnabled) return;
      const input = e.inputBuffer.getChannelData(0);
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const v = Math.abs(input[i]);
        if (v > peak) peak = v;
      }

      const wasActive = state.micActive;
      state.micActive = peak >= 0.008;
      if (wasActive !== state.micActive && state.playGain) {
        state.playGain.gain.setTargetAtTime(
          state.micActive ? 0.6 : 1, state.audioCtx.currentTime, 0.1
        );
      }

      if (peak < 0.008) return;

      const targetRate = 4000;
      const srcRate = state.audioCtx.sampleRate;
      let samples;
      if (srcRate !== targetRate) {
        const ratio = srcRate / targetRate;
        const newLen = Math.round(input.length / ratio);
        samples = new Int16Array(newLen);
        for (let i = 0; i < newLen; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const val = idx + 1 < input.length
            ? input[idx] * (1 - (pos - idx)) + input[idx + 1] * (pos - idx)
            : input[idx] || 0;
          samples[i] = Math.max(-32768, Math.min(32767, val * 32767));
        }
      } else {
        samples = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, input[i] * 32767));
        }
      }

      const ch = samples.length;
      if (ch > 32) {
        const fadeLen = Math.min(16, Math.floor(ch / 4));
        for (let i = 0; i < fadeLen; i++) {
          const f = i / fadeLen;
          samples[i] = Math.round(samples[i] * f);
          samples[ch - 1 - i] = Math.round(samples[ch - 1 - i] * f);
        }
      }

      state.ws.send(samples.buffer);

      const micLamp = document.getElementById('mic-lamp');
      if (micLamp) { micLamp.classList.add('on'); clearTimeout(state._micLampOff); state._micLampOff = setTimeout(() => micLamp.classList.remove('on'), 150); }
    };

    src.connect(state.processor);
    const sink = state.audioCtx.createGain();
    sink.gain.value = 0;
    state.processor.connect(sink);
    sink.connect(state.audioCtx.destination);
  } catch (micErr) {
    console.warn('Микрофон недоступен, режим только чтения:', micErr.message);
  }

  // WebSocket
  state.ws = new WebSocket(SIGNAL_URL);
  state.ws.binaryType = 'arraybuffer';

  state.ws.onopen = () => {
    setStatus('Вход в комнату...');
    state.ws.send(JSON.stringify({ type: 'join', code, ttl }));
  };

  state.ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      playRemoteAudio(event.data);
      return;
    }
    try { handleMsg(JSON.parse(event.data)); } catch (e) {}
  };

  state.ws.onclose = () => {
    if (state.currentRoom && state.peerId) {
      setStatus('Переподключение...');
      setTimeout(() => {
        if (state.currentRoom && !state.ws) {
          const code = state.currentRoom;
          state.ws = new WebSocket(SIGNAL_URL);
          state.ws.binaryType = 'arraybuffer';
          state.ws.onopen = () => {
            state.ws.send(JSON.stringify({ type: 'join', code, ttl }));
          };
          state.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) { playRemoteAudio(event.data); return; }
            try { handleMsg(JSON.parse(event.data)); } catch (e) {}
          };
          state.ws.onclose = () => { setStatus('Соединение потеряно'); cleanup(); };
          state.ws.onerror = () => {};
        }
      }, 2000);
    } else {
      setStatus('Соединение потеряно');
      cleanup();
    }
  };
  state.ws.onerror = () => {};
}

// ============================================================
// Обработка сообщений
// ============================================================

function handleMsg(msg) {
  switch (msg.type) {
    case 'joined':
      state.peerId = msg.peerId;
      state.currentRoom = document.getElementById('input-code').value.trim();
      document.getElementById('lobby-screen').classList.add('hidden');
      document.getElementById('room-screen').classList.remove('hidden');
      startTimer(msg.roomRemaining);
      setStatus(`В комнате (${msg.peers.length + 1} чел.)`);
      msg.peers.forEach(id => addPeerIndicator(id));
      break;
    case 'peer_joined':
      addPeerIndicator(msg.peerId);
      setStatus(`${msg.peerId.slice(0, 6)} присоединился`);
      break;
    case 'peer_left':
      removePeerIndicator(msg.peerId);
      setStatus(`${msg.peerId.slice(0, 6)} вышел`);
      break;
    case 'media_control':
      updatePeerIndicator(msg.from, msg.kind, msg.muted);
      break;
    case 'chat':
      addChatMessage(msg.from, msg.text, msg.timestamp);
      break;
    case 'file_share':
      addFileMessage(msg.from, msg.fileName, msg.fileUrl, msg.fileSize, msg.timestamp);
      break;
    case 'room_closed':
      alert('Комната закрыта');
      cleanup();
      break;
    case 'error':
      alert(msg.message);
      break;
  }
}

// ============================================================
// Воспроизведение голоса — adaptive jitter-буфер
// ============================================================

let playTimerId = null;

function playRemoteAudio(data) {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (!state.playGain) {
    state.playGain = state.audioCtx.createGain();
    state.playGain.gain.value = 1;
    state.playGain.connect(state.audioCtx.destination);
  }
  try {
    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buf = state.audioCtx.createBuffer(1, float32.length, 4000);
    buf.getChannelData(0).set(float32);

    const rxLamp = document.getElementById('rx-lamp');
    if (rxLamp) { rxLamp.classList.add('on'); clearTimeout(state._rxLampOff); state._rxLampOff = setTimeout(() => rxLamp.classList.remove('on'), 150); }

    const now = Date.now();
    state.packetTimes.push(now);
    if (state.packetTimes.length > 20) state.packetTimes.shift();
    updateNetQuality(now);

    state.playQueue.push(buf);

    while (state.playQueue.length > 10) {
      state.playQueue.shift();
    }

    if (!playTimerId) schedulePlayback();
  } catch (e) {
    console.warn('Playback error:', e);
  }
}

function updateNetQuality(now) {
  const times = state.packetTimes;
  if (times.length < 4) { state.netQuality = 5; return; }

  let gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const expected = 60;
  const jitter = Math.abs(median - expected);
  let q = 10 - Math.floor(jitter / 15);
  if (q < 1) q = 1;
  if (q > 10) q = 10;
  state.netQuality = q;
  updateQualityIndicator(q);
}

function updateQualityIndicator(q) {
  const el = document.getElementById('quality-display');
  if (!el) return;
  const green = q >= 7;
  const yellow = q >= 4 && q < 7;
  el.style.color = green ? '#4caf50' : yellow ? '#ffa726' : '#e53935';
  el.textContent = 'Качество: ' + q + '/10';
}

function schedulePlayback() {
  if (state.playQueue.length === 0) {
    playTimerId = null;
    return;
  }

  const buf = state.playQueue.shift();
  const ch = buf.getChannelData(0);
  const len = ch.length;
  const fadeLen = Math.min(48, Math.floor(len / 6));

  for (let i = 0; i < fadeLen; i++) {
    const f = i / fadeLen;
    ch[i] *= f;
    ch[len - 1 - i] *= f;
  }

  const src = state.audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(state.playGain);

  const now = state.audioCtx.currentTime;
  const delay = state.nextPlayTime > now ? (state.nextPlayTime - now) * 0.5 : 0;
  src.start(now + delay);
  state.nextPlayTime = now + delay + buf.duration;

  playTimerId = setTimeout(schedulePlayback, (buf.duration * 0.5) * 1000);
}

// ============================================================
// Переключатель трубка/динамик (только Android)
// ============================================================

let isEarpiece = true;

function initSpeakerToggle() {
  if (!window.AndroidAudio) return;
  const btn = document.getElementById('btn-toggle-speaker');
  btn.classList.remove('hidden');
  isEarpiece = window.AndroidAudio.isEarpiece();
  updateSpeakerBtn();
  btn.addEventListener('click', toggleSpeaker);
}

function toggleSpeaker() {
  if (!window.AndroidAudio) return;
  if (isEarpiece) {
    window.AndroidAudio.setSpeaker();
    isEarpiece = false;
  } else {
    window.AndroidAudio.setEarpiece();
    isEarpiece = true;
  }
  updateSpeakerBtn();
}

function updateSpeakerBtn() {
  const btn = document.getElementById('btn-toggle-speaker');
  btn.textContent = isEarpiece ? '📞' : '🔊';
  btn.title = isEarpiece ? 'Трубка (нажмите для динамика)' : 'Динамик (нажмите для трубки)';
}

// ============================================================
// Контроль
// ============================================================

function toggleAudio() {
  state.audioEnabled = !state.audioEnabled;
  const btn = document.getElementById('btn-toggle-audio');
  btn.textContent = state.audioEnabled ? '🎤' : '🔇';
  btn.className = state.audioEnabled ? 'control-btn mic-btn' : 'control-btn mic-btn off';
  if (state.ws) state.ws.send(JSON.stringify({ type: 'media_control', kind: 'audio', muted: !state.audioEnabled }));
}

// ============================================================
// Чат
// ============================================================

function sendChatMessage() {
  const text = document.getElementById('chat-input').value.trim();
  if (!text || !state.ws) return;
  state.ws.send(JSON.stringify({ type: 'chat', text }));
  addChatMessage(state.peerId, text, Date.now(), true);
  document.getElementById('chat-input').value = '';
}

function addChatMessage(peerId, text, ts, isMine = false) {
  const m = document.createElement('div');
  m.className = 'chat-message ' + (isMine ? 'mine' : 'theirs');
  const t = new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  m.innerHTML = '<div class="chat-sender">' + (isMine ? 'Вы' : peerId.slice(0, 8)) + '</div><div class="chat-text">' + esc(text) + '</div><div class="chat-time">' + t + '</div>';
  const ch = document.getElementById('chat-messages');
  ch.appendChild(m);
  ch.scrollTop = ch.scrollHeight;
}

function addFileMessage(peerId, name, url, size, ts) {
  const m = document.createElement('div');
  m.className = 'chat-message file-message';
  const t = new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fullUrl = url.startsWith('http') ? url : location.origin + url;
  m.innerHTML = '<div class="chat-sender">' + peerId.slice(0, 8) + '</div><div class="chat-file"><a href="' + fullUrl + '" target="_blank" download="' + esc(name) + '" onclick="return downloadFile(this)">📎 ' + esc(name) + ' (' + (size / 1024).toFixed(1) + ' КБ)</a></div><div class="chat-time">' + t + '</div>';
  const ch = document.getElementById('chat-messages');
  ch.appendChild(m);
  ch.scrollTop = ch.scrollHeight;
}

function downloadFile(link) {
  const url = link.href;
  const name = link.getAttribute('download');
  fetch(url).then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.blob();
  }).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }).catch(err => {
    fetch(url).then(r => {
      if (!r.ok) throw new Error('Повтор не удался');
      return r.blob();
    }).then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(() => alert('Не удалось скачать файл. Попробуйте ещё раз.'));
  });
  return false;
}

// ============================================================
// Файлы
// ============================================================

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { alert('Файл слишком большой'); return; }
  setStatus('Загрузка...');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('ttl', '3600000');
    const r = await fetch(UPLOAD_URL, { method: 'POST', body: fd });
    const res = await r.json();
    if (res.url) {
      if (state.ws) state.ws.send(JSON.stringify({ type: 'file_share', fileName: file.name, fileUrl: res.url, fileSize: file.size }));
      addFileMessage(state.peerId, file.name, res.url, file.size, Date.now());
      setStatus('Файл загружен');
    }
  } catch (err) { alert('Ошибка загрузки'); }
  e.target.value = '';
}

// ============================================================
// Участники
// ============================================================

function addPeerIndicator(id) {
  const el = document.createElement('div');
  el.className = 'peer-indicator';
  el.id = 'peer-' + id;
  el.innerHTML = '<span class="peer-dot"></span><span>' + id.slice(0, 6) + '</span>';
  document.getElementById('peers-list').appendChild(el);
}

function removePeerIndicator(id) {
  const el = document.getElementById('peer-' + id);
  if (el) el.remove();
}

function updatePeerIndicator(id, kind, muted) {
  const el = document.getElementById('peer-' + id);
  if (!el) return;
  const dot = el.querySelector('.peer-dot');
  if (dot) dot.style.background = muted ? '#666' : '#4caf50';
}

// ============================================================
// Таймер
// ============================================================

let timerInterval = null;
function startTimer(remainingMs) {
  if (timerInterval) clearInterval(timerInterval);
  let remaining = remainingMs;
  function tick() {
    const s = Math.floor(remaining / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    document.getElementById('timer-display').textContent = '⏱ ' +
      String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    if (remaining <= 0) { clearInterval(timerInterval); document.getElementById('timer-display').textContent = '⏱ Время вышло!'; }
    remaining -= 1000;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ============================================================
// Очистка
// ============================================================

function leaveRoom() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'leave' }));
  cleanup();
}

function cleanup() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (state.processor) { try { state.processor.disconnect(); } catch (e) {} state.processor = null; }
  if (state.micStream) { state.micStream.getTracks().forEach(t => t.stop()); state.micStream = null; }
  if (state.audioCtx) { try { state.audioCtx.close(); } catch (e) {} state.audioCtx = null; }
  if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  if (state.playGain) { try { state.playGain.disconnect(); } catch (e) {} state.playGain = null; }
  state.peerId = null;
  state.currentRoom = null;
  state.nextPlayTime = 0;
  state.playQueue = [];
  state.packetTimes = [];
  state.netQuality = 5;
  state.lastPacketTime = 0;
  state.micActive = false;
  if (playTimerId) { clearTimeout(playTimerId); playTimerId = null; }
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('peers-list').innerHTML = '';
  document.getElementById('room-screen').classList.add('hidden');
  document.getElementById('lobby-screen').classList.remove('hidden');
  setStatus('Готов к подключению');
}

function setStatus(t) { const s = document.getElementById('status-text'); if (s) s.textContent = t; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.addEventListener('DOMContentLoaded', init);
