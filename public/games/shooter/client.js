const VIEW_W = 1200, VIEW_H = 750;
const INTERP_DELAY = 100;
const INPUT_RATE = 20;
const ANGLE_THRESHOLD = 0.08;
const LOCAL_SPEED = 240;

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window);
const COLORS = ['#22d3ee', '#f472b6', '#a78bfa', '#fbbf24', '#34d399', '#f87171', '#60a5fa', '#fb923c', '#e879f9', '#4ade80'];

let socket, myId, myName, myColor = COLORS[0], currentRoomId, currentRoomName;
let mapW = 1600, mapH = 1000, playerRadius = 18, bulletRadius = 5, maxHp = 100;
let WALLS = [], PILLARS = [];

// 🔑 Estado de jogo no cliente (espelha o servidor)
let gameState = 'lobby';       // 'lobby' | 'playing' | 'finished'
let currentRoundId = 0;
let isGameOver = false;

const input = { up: false, down: false, left: false, right: false, shoot: false, angle: 0 };
const keys = {}, mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const snapshots = [], killFeed = [];
let camera = { x: 0, y: 0 }, scale = 1, offsetX = 0, offsetY = 0;
let predX = 0, predY = 0, predInit = false, lastFrameTime = performance.now();
let ping = 0, connected = false, gameStartTime = 0, welcomeShown = false;

// 🔑 Pointer Events (substitui touch events — mais confiável)
const activePointers = new Map();
let analogMove = { x: 0, y: 0 }, analogAim = { x: 0, y: 0, active: false };
let lastAimAngle = 0, usingTouch = false;

const canvas = document.getElementById('canvas'), ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const mapCanvas = document.createElement('canvas'), mapCtx = mapCanvas.getContext('2d');

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }

function resolvePlayerWallsLocal(px, py, radius) {
  for (const w of WALLS) {
    const cx = clamp(px, w.x, w.x + w.w), cy = clamp(py, w.y, w.y + w.h);
    const dx = px - cx, dy = py - cy, d2 = dx * dx + dy * dy;
    if (d2 < radius * radius) {
      const d = Math.sqrt(d2);
      if (d > 0.001) { const o = radius - d; px += (dx / d) * o; py += (dy / d) * o; }
      else {
        const left = px - w.x, right = (w.x + w.w) - px, top = py - w.y, bottom = (w.y + w.h) - py;
        const min = Math.min(left, right, top, bottom);
        if (min === left) px = w.x - radius; else if (min === right) px = w.x + w.w + radius;
        else if (min === top) py = w.y - radius; else py = w.y + w.h + radius;
      }
    }
  }
  for (const p of PILLARS) {
    const dx = px - p.cx, dy = py - p.cy, d = Math.hypot(dx, dy), minD = radius + p.r;
    if (d < minD && d > 0.001) { const o = minD - d; px += (dx / d) * o; py += (dy / d) * o; }
  }
  return { x: px, y: py };
}

/* ================== 📦 BINARY SNAPSHOT DECODER ==================
   Espelho exato de games/shooter/server.js → encodeSnapshot().
   Converte o ArrayBuffer binário recebido em um objeto JS com a
   MESMA forma que o antigo payload JSON tinha, para que todo o
   restante do cliente funcione sem qualquer outra mudança.
   ================================================================= */
const _decoder = new TextDecoder();

function rgbToHex(r, g, b) {
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function decodeSnapshot(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    if (buffer && buffer.buffer instanceof ArrayBuffer) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else return null;
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let off = 0;

  // HEADER (13 bytes)
  const version    = view.getUint8(off);  off += 1;
  const stateByte  = view.getUint8(off);  off += 1;
  const modeByte   = view.getUint8(off);  off += 1;
  const playerCnt  = view.getUint8(off);  off += 1;
  const bulletCnt  = view.getUint8(off);  off += 1;
  const roundId    = view.getUint16(off, true); off += 2;
  const tick       = view.getUint32(off, true); off += 4;
  const timeLeftDc = view.getUint16(off, true); off += 2;

  const state = stateByte === 1 ? 'finished' : 'playing';
  const mode  = modeByte === 1 ? 'score' : modeByte === 2 ? 'time' : modeByte === 3 ? 'lms' : 'infinite';

  // FINISHED ONLY
  let reason = '';
  let winner = null;
  if (state === 'finished') {
    const rLen = view.getUint8(off); off += 1;
    if (rLen > 0) { reason = _decoder.decode(bytes.subarray(off, off + rLen)); off += rLen; }
    const wLen = view.getUint16(off, true); off += 2;
    let wName = '';
    if (wLen > 0) { wName = _decoder.decode(bytes.subarray(off, off + wLen)); off += wLen; }
    const wr = view.getUint8(off); off += 1;
    const wg = view.getUint8(off); off += 1;
    const wb = view.getUint8(off); off += 1;
    if (wName) winner = { name: wName, color: rgbToHex(wr, wg, wb) };
  }

  // PLAYERS
  const players = new Array(playerCnt);
  for (let i = 0; i < playerCnt; i++) {
    const idLen = view.getUint8(off); off += 1;
    const id    = _decoder.decode(bytes.subarray(off, off + idLen)); off += idLen;
    const nLen  = view.getUint8(off); off += 1;
    const name  = _decoder.decode(bytes.subarray(off, off + nLen)); off += nLen;
    const r = view.getUint8(off); off += 1;
    const g = view.getUint8(off); off += 1;
    const b = view.getUint8(off); off += 1;
    const x = view.getUint16(off, true); off += 2;
    const y = view.getUint16(off, true); off += 2;
    const a = view.getInt16(off, true) / 1000; off += 2;
    const h = view.getUint8(off); off += 1;
    const k = view.getUint8(off); off += 1;
    const d = view.getUint8(off); off += 1;
    const al = view.getUint8(off); off += 1;
    const resp = view.getUint32(off, true); off += 4;
    players[i] = { id, n: name, c: rgbToHex(r, g, b), x, y, a, h, k, d, al, r: resp };
  }

  // BULLETS
  const bullets = new Array(bulletCnt);
  for (let i = 0; i < bulletCnt; i++) {
    const id = view.getUint16(off, true); off += 2;
    const x  = view.getUint16(off, true); off += 2;
    const y  = view.getUint16(off, true); off += 2;
    const vx = view.getInt16(off, true); off += 2;
    const vy = view.getInt16(off, true); off += 2;
    const r = view.getUint8(off); off += 1;
    const g = view.getUint8(off); off += 1;
    const b = view.getUint8(off); off += 1;
    bullets[i] = { i: id, x, y, vx, vy, c: rgbToHex(r, g, b) };
  }

  return {
    state, mode, roundId, tick,
    timeLeft: timeLeftDc * 100,   // decasegundos → ms
    reason, winner, players, bullets,
  };
}

function showToast(msg, isError = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function buildColorPicker() {
  const c = $('color-picker'); c.innerHTML = '';
  COLORS.forEach((color, i) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (i === 0 ? ' selected' : '');
    btn.style.background = color; btn.style.color = color;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected'); myColor = color;
    });
    c.appendChild(btn);
  });
}

function buildMapCanvas() {
  mapCanvas.width = mapW; mapCanvas.height = mapH;
  mapCtx.fillStyle = '#0f1620'; mapCtx.fillRect(0, 0, mapW, mapH);
  mapCtx.strokeStyle = 'rgba(34, 211, 238, 0.06)'; mapCtx.lineWidth = 1;
  for (let x = 0; x < mapW; x += 50) { mapCtx.beginPath(); mapCtx.moveTo(x, 0); mapCtx.lineTo(x, mapH); mapCtx.stroke(); }
  for (let y = 0; y < mapH; y += 50) { mapCtx.beginPath(); mapCtx.moveTo(0, y); mapCtx.lineTo(mapW, y); mapCtx.stroke(); }
  mapCtx.strokeStyle = 'rgba(34, 211, 238, 0.4)'; mapCtx.lineWidth = 3; mapCtx.strokeRect(0, 0, mapW, mapH);

  for (const w of WALLS) {
    mapCtx.fillStyle = '#0d1420'; mapCtx.fillRect(w.x + 3, w.y + 3, w.w, w.h);
    mapCtx.fillStyle = '#1a2332'; mapCtx.fillRect(w.x, w.y, w.w, w.h);
    mapCtx.strokeStyle = 'rgba(34, 211, 238, 0.55)'; mapCtx.lineWidth = 2; mapCtx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
  }
  for (const p of PILLARS) {
    mapCtx.beginPath(); mapCtx.arc(p.cx + 3, p.cy + 3, p.r, 0, Math.PI * 2); mapCtx.fillStyle = '#0d1420'; mapCtx.fill();
    mapCtx.beginPath(); mapCtx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2); mapCtx.fillStyle = '#1a2332'; mapCtx.fill();
    mapCtx.strokeStyle = 'rgba(34, 211, 238, 0.55)'; mapCtx.lineWidth = 2; mapCtx.stroke();
  }
}

function resize() {
  // ✅ CAP DE DPR EM 2x — celulares com tela 3x/4x não sobrecarregam a GPU.
  //    Em rede ruim (o caso do rapaz na roça), evitar engasgo de render é
  //    tão importante quanto evitar lag de rede.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scale = Math.min(w / VIEW_W, h / VIEW_H);
  offsetX = (w - VIEW_W * scale) / 2; offsetY = (h - VIEW_H * scale) / 2;
}
window.addEventListener('resize', resize);

/* ================== GAME OVER / RESTART ================== */

function setGameOver(info) {
  if (isGameOver) return;
  isGameOver = true;
  gameState = 'finished';
  clearAllInputs(true);
  const reason = info?.reason || 'Fim de jogo';
  const winner = info?.winner || null;
  $('game-over-reason').textContent = reason;
  $('game-over-winner').textContent = winner ? `${winner.name} Venceu!` : 'Empate!';
  $('game-over-winner').style.color = winner ? winner.color : '#fff';
  $('game-over-overlay').classList.add('show');
}

function resetRoundState() {
  isGameOver = false;
  gameState = 'playing';
  snapshots.length = 0;
  killFeed.length = 0;
  predInit = false;
  lastAimAngle = 0;
  gameStartTime = Date.now();
  welcomeShown = false;
  $('game-over-overlay').classList.remove('show');
}

/* ================== SOCKET ================== */

function connect() {
  // ✅ BACKOFF EXPONENCIAL COM JITTER — em sinal de roça (ou RevHunter),
  //    o delay fixo de 800ms causava tempestade de reconexões. Agora
  //    espera 1s, 2s, 4s, 8s… até 15s, com ±50% de variação aleatória
  //    para evitar sincronia entre clientes.
  socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.5,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    connected = true; $('conn-status').classList.add('hidden');
    if (currentRoomId && myName) {
      socket.emit('join-room', { roomId: currentRoomId, name: myName, color: myColor }, (res) => {
        if (!res.success) { showToast('Sala fechada.', true); currentRoomId = null; switchScreen('screen-lobby'); socket.emit('list-rooms'); }
      });
    }
  });

  socket.on('disconnect', () => {
    connected = false;
    $('conn-status').classList.remove('hidden');
    $('conn-text').textContent = 'Reconectando...';
    clearAllInputs(false);
  });

  socket.on('rooms', (list) => renderRooms(list));

  socket.on('joined', (data) => {
    myId = data.playerId; currentRoomName = data.roomName;
    mapW = data.mapW; mapH = data.mapH;
    playerRadius = data.playerRadius; bulletRadius = data.bulletRadius; maxHp = data.maxHp;
    WALLS = data.walls || []; PILLARS = data.pillars || [];
    buildMapCanvas();
    resetRoundState();
    currentRoundId = data.roundId || 0;
    touchPointers_clear();
    switchScreen('screen-game');

    // Sala já finalizada (reconexão tardia)
    if (data.state === 'finished') {
      setGameOver({ winner: data.winner, reason: data.reason });
    } else {
      gameState = 'playing';
      showWelcome();
    }
  });

  // 📦 SNAPSHOT BINÁRIO → decodeSnapshot() → mesmo formato do JSON antigo
  socket.on('snapshot', (raw) => {
    const snap = decodeSnapshot(raw);
    if (!snap) return;
    snap._recvAt = performance.now();
    snapshots.push(snap);
    while (snapshots.length > 40) snapshots.shift();
    while (snapshots.length > 2 && snapshots[0]._recvAt < performance.now() - 2000) snapshots.shift();

    // 🔑 Estado final vindo pelo snapshot (não depende do evento separado)
    if (snap.state === 'finished') { setGameOver(snap); return; }
    if (isGameOver) return;

    const me = snap.players.find(p => p.id === myId);
    if (me && me.al) reconcile(me.x, me.y);
  });

  socket.on('kill', ({ killer, victim }) => killFeed.push({ text: `${killer} 💀 ${victim}`, time: Date.now() }));
  socket.on('pong', (t) => { ping = Date.now() - t; });
  socket.on('player-joined', ({ name }) => { if (name && name !== myName) showToast(`${name} entrou`); });
  socket.on('player-left', ({ id }) => { if (id !== myId) showToast('Jogador saiu'); });

  socket.on('game-over', (data) => setGameOver(data));

  socket.on('game-restarted', (data) => {
    currentRoundId = data?.roundId || 0;
    resetRoundState();
    showWelcome();
  });
}

setInterval(() => { if (socket && connected) socket.emit('ping', Date.now()); }, 2000);

// 📡 Alimenta o adaptive snapshot rate do servidor a cada ~5s.
//    Antes o cliente nunca enviava rtt-report → servidor ficava travado
//    em rate=1 (20 Hz) mesmo em rede ruim. Agora ele ajusta dinamicamente:
//      RTT < 150ms  → rate=1 → 20 snapshots/s
//      150–300ms   → rate=2 → 10 snapshots/s
//      > 300ms     → rate=3 →  6.6 snapshots/s (menos head-of-line)
setInterval(() => {
  if (socket && connected && currentRoomId && ping > 0) {
    socket.emit('rtt-report', ping);
  }
}, 5000);

/* ================== PREDIÇÃO / RECONCILIAÇÃO ================== */

function reconcile(serverX, serverY) {
  if (!predInit) { predX = serverX; predY = serverY; predInit = true; return; }
  const dx = serverX - predX, dy = serverY - predY;
  const dist = Math.hypot(dx, dy);
  if (dist > 120) {           // erro gigante → snap total
    predX = serverX; predY = serverY;
  } else if (dist > 6) {      // erro médio → correção agressiva
    predX += dx * 0.35; predY += dy * 0.35;
  }
}

function updatePrediction(dt) {
  if (!predInit || isGameOver) return;
  let dx = 0, dy = 0;
  if (usingTouch && activePointers.size > 0) { dx = analogMove.x; dy = analogMove.y; }
  else {
    if (input.up) dy -= 1; if (input.down) dy += 1;
    if (input.left) dx -= 1; if (input.right) dx += 1;
  }
  const len = Math.hypot(dx, dy);
  if (len > 0.1) {
    const spd = Math.min(len, 1) * LOCAL_SPEED;
    predX += (dx / len) * spd * dt;
    predY += (dy / len) * spd * dt;
    predX = clamp(predX, playerRadius, mapW - playerRadius);
    predY = clamp(predY, playerRadius, mapH - playerRadius);
    const r = resolvePlayerWallsLocal(predX, predY, playerRadius);
    predX = r.x; predY = r.y;
  }
}

/* ================== ♻️ OBJECT POOLING ==================
   getRenderState() era chamado a 60fps e criava ~N objetos novos
   por frame (players + bullets). Isso gerava micro-stutter de GC,
   muito visível em celular antigo / pouca RAM.

   Agora mantemos pools fixos (_playerPool / _bulletPool) e um único
   objeto _renderState que é mutado e devolvido. Zero alocação por frame.
   ========================================================= */
const _playerPool = [];
const _bulletPool = [];
const _renderState = { players: [], bullets: [], mode: null, timeLeft: 0 };
const _aBulletMap = new Map();

function _getPlayerSlot(i) {
  let p = _playerPool[i];
  if (!p) {
    p = { id: '', name: '', color: '', x: 0, y: 0, angle: 0,
          hp: 0, kills: 0, deaths: 0, alive: false, respawnAt: 0 };
    _playerPool[i] = p;
  }
  return p;
}
function _getBulletSlot(i) {
  let b = _bulletPool[i];
  if (!b) { b = { id: 0, x: 0, y: 0, color: '' }; _bulletPool[i] = b; }
  return b;
}

function getRenderState() {
  if (snapshots.length === 0) return null;
  const now = performance.now();
  const renderT = now - INTERP_DELAY;

  let a = snapshots[0], b = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length - 1; i++) {
    if (snapshots[i]._recvAt <= renderT && snapshots[i + 1]._recvAt >= renderT) {
      a = snapshots[i]; b = snapshots[i + 1]; break;
    }
    if (snapshots[i + 1]._recvAt < renderT) { a = b = snapshots[i + 1]; }
  }
  const span = b._recvAt - a._recvAt;
  const alpha = span > 0 ? clamp((renderT - a._recvAt) / span, 0, 1) : 0;

  const rs = _renderState;
  rs.mode = b.mode;
  rs.timeLeft = b.timeLeft;

  // ---- Players (pooled) ----
  const pLen = b.players.length;
  rs.players.length = pLen;
  for (let i = 0; i < pLen; i++) {
    const pb = b.players[i];
    const pa = a.players.find(p => p.id === pb.id) || pb;
    const p = _getPlayerSlot(i);
    p.id = pb.id; p.name = pb.n; p.color = pb.c;
    p.x = lerp(pa.x, pb.x, alpha);
    p.y = lerp(pa.y, pb.y, alpha);
    p.angle = lerpAngle(pa.a, pb.a, alpha);
    p.hp = pb.h; p.kills = pb.k; p.deaths = pb.d;
    p.alive = pb.al === 1; p.respawnAt = pb.r;
    rs.players[i] = p;
  }

  // ---- Bullets (pooled) ----
  _aBulletMap.clear();
  for (const bb of a.bullets) _aBulletMap.set(bb.i, bb);
  const bLen = b.bullets.length;
  rs.bullets.length = bLen;
  for (let i = 0; i < bLen; i++) {
    const bb = b.bullets[i];
    const ba = _aBulletMap.get(bb.i);
    const bl = _getBulletSlot(i);
    bl.id = bb.i; bl.color = bb.c;
    if (ba) { bl.x = lerp(ba.x, bb.x, alpha); bl.y = lerp(ba.y, bb.y, alpha); }
    else    { bl.x = bb.x; bl.y = bb.y; }
    rs.bullets[i] = bl;
  }
  return rs;
}

/* ================== INPUT (DESKTOP) ================== */

const isTypingTarget = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  const k = e.key.toLowerCase(); keys[k] = true;
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (k === 'escape' && currentRoomId) leaveRoom();
});
window.addEventListener('keyup', (e) => { if (isTypingTarget(e.target)) return; keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; input.shoot = false; });
document.querySelectorAll('input, textarea, select').forEach(el =>
  el.addEventListener('focus', () => { for (const k in keys) keys[k] = false; input.shoot = false; }));

canvas.addEventListener('mousemove', (e) => { if (usingTouch) return; mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => { if (usingTouch) return; if (e.button === 0) input.shoot = true; });
window.addEventListener('mouseup', (e) => { if (usingTouch) return; if (e.button === 0) input.shoot = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ================== JOYSTICKS (POINTER EVENTS) ================== */

function showJoystick(id, x, y) {
  const c = $('mobile-joysticks');
  let el = c.querySelector(`[data-joy-id="${id}"]`);
  if (!el) { el = document.createElement('div'); el.className = 'joystick'; el.dataset.joyId = id; el.innerHTML = '<div class="knob"></div>'; c.appendChild(el); }
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.querySelector('.knob').style.transform = 'translate(-50%, -50%)';
}
function updateJoystick(id, sx, sy, cx, cy) {
  const el = $('mobile-joysticks').querySelector(`[data-joy-id="${id}"]`); if (!el) return;
  const dx = cx - sx, dy = cy - sy, dist = Math.hypot(dx, dy), maxD = 55, cl = Math.min(dist, maxD);
  const nx = dist > 0 ? (dx / dist) * cl : 0, ny = dist > 0 ? (dy / dist) * cl : 0;
  el.querySelector('.knob').style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
}
function hideJoystick(id) {
  const el = $('mobile-joysticks').querySelector(`[data-joy-id="${id}"]`);
  if (el) el.remove();
}

// 🔑 Limpa tudo (usado em touch end, blur, game-over, disconnect...)
function clearAllInputs(sendToServer) {
  const hadInput = (lastSent.shoot || lastSent.moveX !== 0 || lastSent.moveY !== 0 ||
                    input.up || input.down || input.left || input.right);
  activePointers.clear();
  $('mobile-joysticks').innerHTML = '';
  usingTouch = false;
  analogMove = { x: 0, y: 0 };
  analogAim = { x: 0, y: 0, active: false };
  input.up = input.down = input.left = input.right = input.shoot = false;

  if (sendToServer && hadInput && socket && connected && !isGameOver) {
    socket.emit('input', { moveX: 0, moveY: 0, shoot: false, angle: lastAimAngle });
    lastSent.moveX = 0; lastSent.moveY = 0; lastSent.shoot = false;
    lastSent.up = lastSent.down = lastSent.left = lastSent.right = false;
  }
}
function touchPointers_clear() { clearAllInputs(false); }

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  usingTouch = true;
  const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
  for (const [id, p] of [...activePointers]) {
    if (p.side === side) { activePointers.delete(id); hideJoystick(id); }
  }
  activePointers.set(e.pointerId, {
    side, startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY,
  });
  showJoystick(e.pointerId, e.clientX, e.clientY);
});

canvas.addEventListener('pointermove', (e) => {
  const p = activePointers.get(e.pointerId);
  if (!p) return;
  e.preventDefault();
  p.curX = e.clientX; p.curY = e.clientY;
  updateJoystick(e.pointerId, p.startX, p.startY, p.curX, p.curY);
});

function onPointerEnd(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);
  hideJoystick(e.pointerId);
  if (activePointers.size === 0) {
    clearAllInputs(true);
  }
}
canvas.addEventListener('pointerup', onPointerEnd);
canvas.addEventListener('pointercancel', onPointerEnd);
window.addEventListener('pointerup', onPointerEnd);
window.addEventListener('pointercancel', onPointerEnd);

window.addEventListener('blur', () => { if (activePointers.size > 0) clearAllInputs(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && activePointers.size > 0) clearAllInputs(true); });

function processTouch() {
  analogMove = { x: 0, y: 0 };
  analogAim = { x: 0, y: 0, active: false };
  let rightTouched = false;
  for (const p of activePointers.values()) {
    const dx = p.curX - p.startX, dy = p.curY - p.startY;
    const dist = Math.hypot(dx, dy), deadZone = 8, maxD = 55;
    if (p.side === 'left') {
      if (dist >= deadZone) {
        const cl = Math.min(dist, maxD) / maxD;
        analogMove = { x: (dx / dist) * cl, y: (dy / dist) * cl };
      }
    } else {
      rightTouched = true;
      if (dist >= deadZone) {
        analogAim = { x: dx / dist, y: dy / dist, active: true };
        lastAimAngle = Math.atan2(dy, dx);
      }
    }
  }
  return rightTouched;
}

/* ================== LOOP DE INPUT (20Hz) ================== */

const lastSent = { up: false, down: false, left: false, right: false, shoot: false, angle: 0, moveX: 0, moveY: 0 };

setInterval(() => {
  if (!socket || !myId || !connected || isGameOver) return;

  if (usingTouch) {
    if (activePointers.size === 0) {
      clearAllInputs(true);
      return;
    }
    const rightTouched = processTouch();
    input.up = analogMove.y < -0.25; input.down = analogMove.y > 0.25;
    input.left = analogMove.x < -0.25; input.right = analogMove.x > 0.25;
    input.shoot = rightTouched;
    input.angle = lastAimAngle;

    const mChanged = Math.abs(analogMove.x - lastSent.moveX) > 0.05 ||
                     Math.abs(analogMove.y - lastSent.moveY) > 0.05;
    const angleChanged = Math.abs(input.angle - lastSent.angle) > ANGLE_THRESHOLD;
    if (mChanged || angleChanged || input.shoot !== lastSent.shoot) {
      socket.emit('input', { moveX: analogMove.x, moveY: analogMove.y, shoot: input.shoot, angle: input.angle });
      lastSent.moveX = analogMove.x; lastSent.moveY = analogMove.y;
      lastSent.shoot = input.shoot; lastSent.angle = input.angle;
    }
    return;
  }

  input.up = keys['w'] || keys['arrowup'];
  input.down = keys['s'] || keys['arrowdown'];
  input.left = keys['a'] || keys['arrowleft'];
  input.right = keys['d'] || keys['arrowright'];
  if (predInit) {
    const mx = camera.x + (mouse.x - offsetX) / scale;
    const my = camera.y + (mouse.y - offsetY) / scale;
    input.angle = Math.atan2(my - predY, mx - predX);
  }
  const angleChanged = Math.abs(input.angle - lastSent.angle) > ANGLE_THRESHOLD;
  const stateChanged = input.up !== lastSent.up || input.down !== lastSent.down ||
                       input.left !== lastSent.left || input.right !== lastSent.right ||
                       input.shoot !== lastSent.shoot;
  if (stateChanged || angleChanged) {
    socket.emit('input', { up: input.up, down: input.down, left: input.left, right: input.right, shoot: input.shoot, angle: input.angle });
    lastSent.up = input.up; lastSent.down = input.down;
    lastSent.left = input.left; lastSent.right = input.right;
    lastSent.shoot = input.shoot; lastSent.angle = input.angle;
  }
}, 1000 / INPUT_RATE);

/* ================== RENDER ================== */

function draw() {
  const now = performance.now(), dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  if (currentRoomId) updatePrediction(dt);

  const w = window.innerWidth, h = window.innerHeight;
  ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, w, h);

  const rs = getRenderState();
  const me = rs?.players.find(p => p.id === myId);

  if (predInit && me) {
    camera.x = clamp(predX - VIEW_W / 2, 0, Math.max(0, mapW - VIEW_W));
    camera.y = clamp(predY - VIEW_H / 2, 0, Math.max(0, mapH - VIEW_H));
  }

  ctx.save();
  ctx.translate(offsetX, offsetY); ctx.scale(scale, scale); ctx.translate(-camera.x, -camera.y);
  ctx.drawImage(mapCanvas, 0, 0);

  if (rs) {
    const blur = isMobile ? 0 : 10;
    for (const b of rs.bullets) {
      ctx.beginPath(); ctx.arc(b.x, b.y, bulletRadius, 0, Math.PI * 2);
      ctx.fillStyle = b.color; ctx.shadowColor = b.color; ctx.shadowBlur = blur; ctx.fill();
    }
    ctx.shadowBlur = 0;

    for (const p of rs.players) {
      if (!p.alive) continue;
      const isMe = p.id === myId;
      const px = isMe && predInit ? predX : p.x;
      const py = isMe && predInit ? predY : p.y;
      ctx.beginPath(); ctx.arc(px, py, playerRadius, 0, Math.PI * 2); ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = isMobile ? 0 : (isMe ? 20 : 10); ctx.fill(); ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(p.angle) * (playerRadius + 14), py + Math.sin(p.angle) * (playerRadius + 14));
      ctx.strokeStyle = p.color; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();

      const bw = 40, bh = 5, hpPct = p.hp / maxHp;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(px - bw / 2, py - playerRadius - 14, bw, bh);
      ctx.fillStyle = hpPct > 0.5 ? '#34d399' : hpPct > 0.25 ? '#fbbf24' : '#f87171';
      ctx.fillRect(px - bw / 2, py - playerRadius - 14, bw * hpPct, bh);
      ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? p.color : '#fff';
      ctx.fillText(p.name, px, py - playerRadius - 22);
    }
  }
  ctx.restore();
  if (rs && me) drawHUD(rs, me, w, h, now);
  requestAnimationFrame(draw);
}

function drawHUD(rs, me, w, h, now) {
  const barW = Math.min(300, w * 0.7), barH = 20, bx = w / 2 - barW / 2, by = h - 50;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(bx, by, barW, barH);
  const hpPct = me.hp / maxHp;
  ctx.fillStyle = hpPct > 0.5 ? '#34d399' : hpPct > 0.25 ? '#fbbf24' : '#f87171';
  ctx.fillRect(bx, by, barW * hpPct, barH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, barW, barH);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`HP ${Math.max(0, me.hp)} / ${maxHp}`, w / 2, by + 15);

  ctx.textAlign = 'right'; ctx.font = 'bold 26px system-ui, sans-serif'; ctx.fillStyle = '#fff';
  if (rs.mode === 'score') ctx.fillText(`💀 ${me.kills} / 10`, w - 30, 52);
  else if (rs.mode === 'lms') {
    const alive = rs.players.filter(p => p.alive).length;
    ctx.fillText(rs.players.length === 1 ? 'Esperando...' : `Vivos: ${alive}`, w - 30, 52);
  } else if (rs.mode === 'time') {
    const secs = Math.ceil(rs.timeLeft / 1000), m = Math.floor(secs / 60), s = secs % 60;
    ctx.fillText(`⏱ ${m}:${s.toString().padStart(2, '0')}`, w - 30, 52);
  } else ctx.fillText(`💀 ${me.kills}`, w - 30, 52);

  ctx.font = 'bold 15px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(`mortes: ${me.deaths}`, w - 30, 76);

  ctx.textAlign = 'left'; ctx.font = 'bold 15px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText(`Sala: ${currentRoomName}`, 100, 40);
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillStyle = ping < 80 ? '#34d399' : ping < 180 ? '#fbbf24' : '#f87171';
  ctx.fillText(`${ping}ms`, 100, 62);

  while (killFeed.length && now - killFeed[0].time > 5000) killFeed.shift();
  ctx.textAlign = 'center'; ctx.font = 'bold 15px system-ui, sans-serif';
  killFeed.forEach((k, i) => {
    const alpha = 1 - (now - k.time) / 5000;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.9})`;
    ctx.fillText(k.text, w / 2, 100 + i * 24);
  });

  if (!me.alive && rs.mode !== 'lms' && !isGameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f87171'; ctx.font = 'bold 72px system-ui, sans-serif';
    ctx.fillText('VOCÊ MORREU', w / 2, h / 2 - 20);
    const secs = Math.max(0, Math.ceil((me.respawnAt - Date.now()) / 1000));
    ctx.fillStyle = '#fff'; ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.fillText(`Respawn em ${secs}s`, w / 2, h / 2 + 40);
  } else if (!me.alive && rs.mode === 'lms' && !isGameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f87171'; ctx.font = 'bold 72px system-ui, sans-serif';
    ctx.fillText('VOCÊ MORREU', w / 2, h / 2 - 20);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.fillText('Aguardando o fim da partida...', w / 2, h / 2 + 40);
  }

  if (!welcomeShown && gameStartTime && !isGameOver) {
    const elapsed = (Date.now() - gameStartTime) / 1000;
    if (elapsed < 3.5) { $('countdown').textContent = Math.ceil(3.5 - elapsed) || 'GO!'; }
    else { welcomeShown = true; $('welcome-overlay').classList.remove('show'); }
  }
}

function showWelcome() {
  $('welcome-name').textContent = `Bem-vindo, ${myName}!`;
  $('countdown').textContent = '3';
  $('welcome-overlay').classList.add('show');
}

/* ================== LOBBY ================== */

let roomCardsCache = new Map();
function renderRooms(list) {
  const c = $('rooms-list');
  if (!list || list.length === 0) {
    c.innerHTML = '<p class="empty-msg">Nenhuma sala ativa. Crie a primeira!</p>';
    roomCardsCache.clear(); return;
  }
  const ids = list.map(r => r.id).sort().join(','), cachedIds = Array.from(roomCardsCache.keys()).sort().join(',');
  if (ids !== cachedIds) {
    c.innerHTML = ''; roomCardsCache.clear();
    list.forEach((room, i) => {
      const card = createRoomCard(room);
      card.style.animationDelay = `${i * 0.06}s`;
      c.appendChild(card); roomCardsCache.set(room.id, card);
    });
  } else {
    list.forEach(room => {
      const card = roomCardsCache.get(room.id); if (!card) return;
      const countEl = card.querySelector('.room-count');
      const isFull = room.players >= room.maxPlayers;
      countEl.textContent = `${room.players}/${room.maxPlayers} 👤`;
      countEl.className = 'room-count' + (isFull ? ' full' : '');
      card.classList.toggle('full', isFull);
    });
  }
}

function createRoomCard(room) {
  const card = document.createElement('div');
  const isFull = room.players >= room.maxPlayers;
  card.className = 'room-card' + (isFull ? ' full' : '');
  let modeText = '♾️ Infinito';
  if (room.mode === 'score') modeText = '🎯 10 Kills';
  if (room.mode === 'time') modeText = '⏱️ 2 Min';
  if (room.mode === 'lms') modeText = '💀 Sobrevivência';
  card.innerHTML = `
    <div class="room-info">
      <span class="room-name">${escapeHtml(room.name)} ${room.state === 'finished' ? '(Finalizada)' : ''}</span>
      <span class="room-id">${modeText} · ID: ${room.id}</span>
    </div>
    <span class="room-count ${isFull ? 'full' : ''}">${room.players}/${room.maxPlayers} 👤</span>
  `;
  if (!isFull) card.addEventListener('click', () => joinRoom(room.id));
  return card;
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function getPlayerName() { return $('name').value.trim() || 'Jogador'; }

function joinRoom(roomId) {
  myName = getPlayerName(); currentRoomId = roomId;
  switchScreen('screen-loading'); $('loading-text').textContent = 'Entrando na sala...';
  socket.emit('join-room', { roomId, name: myName, color: myColor }, (res) => {
    if (!res.success) { showToast(res.error, true); currentRoomId = null; switchScreen('screen-lobby'); }
  });
}

function leaveRoom() {
  socket.emit('leave-room');
  currentRoomId = null; predInit = false;
  snapshots.length = 0; killFeed.length = 0;
  isGameOver = false; gameState = 'lobby';
  $('game-over-overlay').classList.remove('show');
  clearAllInputs(false);
  switchScreen('screen-lobby');
}

$('refresh-rooms').addEventListener('click', () => { socket.emit('list-rooms'); showToast('Lista atualizada'); });
$('create-room').addEventListener('click', () => { $('room-name').value = ''; $('modal-create').classList.add('active'); setTimeout(() => $('room-name').focus(), 100); });
$('modal-cancel').addEventListener('click', () => $('modal-create').classList.remove('active'));
$('room-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('modal-create-confirm').click(); });

$('modal-create-confirm').addEventListener('click', () => {
  const roomName = $('room-name').value.trim() || 'Sala';
  const mode = $('room-mode').value;
  myName = getPlayerName();
  $('modal-create').classList.remove('active'); switchScreen('screen-loading');
  $('loading-text').textContent = 'Criando sala...';
  socket.emit('create-room', { name: myName, color: myColor, roomName, mode }, (res) => {
    if (res.success) currentRoomId = res.roomId;
    else { showToast('Erro ao criar sala', true); switchScreen('screen-lobby'); }
  });
});

$('quick-play').addEventListener('click', () => {
  myName = getPlayerName();
  socket.emit('list-rooms');
  socket.once('rooms', (list) => {
    const available = list.find(r => r.players < r.maxPlayers);
    if (available) { joinRoom(available.id); }
    else {
      const modes = ['score', 'time', 'lms'];
      const randomMode = modes[Math.floor(Math.random() * modes.length)];
      switchScreen('screen-loading'); $('loading-text').textContent = 'Criando sala...';
      socket.emit('create-room', { name: myName, color: myColor, roomName: 'Quick Match', mode: randomMode }, (res) => {
        if (res.success) currentRoomId = res.roomId;
        else { showToast('Erro', true); switchScreen('screen-lobby'); }
      });
    }
  });
});

$('leave-btn').addEventListener('click', leaveRoom);
$('btn-return-lobby').addEventListener('click', leaveRoom);
$('btn-restart').addEventListener('click', () => { socket.emit('restart-game'); });

resize(); buildColorPicker(); connect(); requestAnimationFrame(draw);