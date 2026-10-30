const socket = io('/air-hockey');   // 🆕 namespace próprio (não colide com shooter)

const screens = {
  splash: document.getElementById('splash-screen'),
  menu: document.getElementById('menu-screen'),
  lobby: document.getElementById('lobby-screen'),
  wait: document.getElementById('wait-screen'),
  game: document.getElementById('game-screen'),
};
const fadeOverlay = document.getElementById('fade-overlay');
const playerNameInput = document.getElementById('player-name');
const roomList = document.getElementById('room-list');
const roomCodeDisplay = document.getElementById('room-code-display');
const howToModal = document.getElementById('how-to-modal');
const gameOverModal = document.getElementById('game-over-modal');
const goTitle = document.getElementById('go-title');

let currentRoomId = null;
let isHost = false;
let myPlayerIdx = 0;

// --- TROCA DE TELA ---
function showScreen(name, instant = false) {
  if (instant) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    return;
  }
  fadeOverlay.classList.add('active');
  setTimeout(() => {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    if (name === 'game') initCanvas();
    setTimeout(() => fadeOverlay.classList.remove('active'), 100);
  }, 400);
}

// --- SPLASH ---
const phrases = [
  "> INICIALIZANDO MOTOR GRÁFICO...",
  "> CARREGANDO FÍSICA DE FLUIDOS...",
  "> CONECTANDO AO SERVIDOR...",
  "> SISTEMAS PRONTOS.",
  "> BEM-VINDO À ARENA."
];
let phraseIdx = 0, charIdx = 0;
const terminal = document.getElementById('terminal');

function typeText() {
  if (phraseIdx < phrases.length) {
    if (charIdx < phrases[phraseIdx].length) {
      terminal.innerHTML += phrases[phraseIdx].charAt(charIdx);
      charIdx++;
      setTimeout(typeText, 30);
    } else {
      terminal.innerHTML += "<br>";
      phraseIdx++; charIdx = 0;
      setTimeout(typeText, 400);
    }
  } else {
    setTimeout(() => showScreen('menu'), 800);
  }
}
setTimeout(typeText, 500);

// --- NAVEGAÇÃO ---
document.getElementById('btn-show-rooms').onclick = () => {
  if (!playerNameInput.value.trim()) return alert('Digite seu nome primeiro.');
  showScreen('lobby');
  socket.emit('join-lobby');
};

document.getElementById('btn-close-lobby').onclick = () => { showScreen('menu'); socket.emit('leave-lobby'); };
document.getElementById('btn-back-menu').onclick = () => { showScreen('menu'); socket.emit('leave-lobby'); };

document.getElementById('btn-create').onclick = () => {
  const name = playerNameInput.value.trim();
  if (!name) return alert('Digite seu nome primeiro.');
  socket.emit('create-room', { name });
};

document.getElementById('btn-how-to').onclick = () => howToModal.classList.add('active');
document.getElementById('btn-close-modal').onclick = () => howToModal.classList.remove('active');

document.getElementById('btn-copy').onclick = () => {
  navigator.clipboard.writeText(currentRoomId);
  document.getElementById('btn-copy').textContent = 'Copiado!';
  setTimeout(() => document.getElementById('btn-copy').textContent = 'Copiar Código', 2000);
};

function sairDaSala() {
  if (currentRoomId) {
    socket.emit('leave-room', { roomId: currentRoomId });
    currentRoomId = null;
  }
  gameOverModal.classList.remove('active');
  showScreen('menu');
}

document.getElementById('btn-leave-wait').onclick = sairDaSala;
document.getElementById('btn-exit-game').onclick = sairDaSala;
document.getElementById('btn-ready').onclick = () => socket.emit('toggle-ready', { roomId: currentRoomId });
document.getElementById('btn-start-game').onclick = () => socket.emit('start-game', { roomId: currentRoomId });

document.getElementById('btn-play-again').onclick = () => {
  socket.emit('play-again', { roomId: currentRoomId });
  stateSnapshots.length = 0;      // 🆕 limpa interpolação antiga
  gameOverModal.classList.remove('active');
  particles = [];
};

// --- SOCKET ---
socket.on('rooms', (list) => {
  roomList.innerHTML = '';
  if (list.length === 0) {
    roomList.innerHTML = '<p class="empty-msg">Nenhuma sala ativa no momento.</p>';
    return;
  }
  list.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item';
    const status = r.mode === 'waiting' ? 'Aguardando...' : 'Em Jogo';
    div.innerHTML = `
      <div class="room-info">
        <strong>${r.host} vs ${r.guest || '---'}</strong>
        <span>Status: ${status}</span>
      </div>
      <button class="btn primary" style="width:auto; padding:8px 16px; margin:0;" ${r.mode !== 'waiting' ? 'disabled' : ''}>Entrar</button>
    `;
    div.querySelector('button').onclick = () => socket.emit('join-room', { roomId: r.id, name: playerNameInput.value.trim() });
    roomList.appendChild(div);
  });
});

socket.on('room-joined', ({ roomId, isHost: host }) => {
  currentRoomId = roomId;
  isHost = host;
  myPlayerIdx = isHost ? 0 : 1;
  roomCodeDisplay.textContent = roomId;

  document.getElementById('btn-ready').style.display = isHost ? 'none' : 'block';
  document.getElementById('btn-start-game').style.display = isHost ? 'block' : 'none';

  showScreen('wait');
});

socket.on('room-update', ({ p1, p2 }) => {
  if (!p1) return;

  document.getElementById('wait-p1-name').textContent = p1.name + (p1.id === socket.id ? " (Você)" : "");
  document.getElementById('wait-p1-status').textContent = p1.id === socket.id ? "Pronto" : (p1.ready ? "Pronto" : "Não Pronto");
  document.getElementById('wait-p1-status').className = `p-status ${p1.ready ? 'ready' : ''}`;

  if (p2) {
    document.getElementById('wait-p2-name').textContent = p2.name + (p2.id === socket.id ? " (Você)" : "");
    document.getElementById('wait-p2-status').textContent = p2.ready ? "Pronto" : "Não Pronto";
    document.getElementById('wait-p2-status').className = `p-status ${p2.ready ? 'ready' : ''}`;

    if (!isHost) {
      const btnReady = document.getElementById('btn-ready');
      btnReady.textContent = p2.ready ? 'Cancelar Pronto' : 'Estou Pronto';
      btnReady.className = p2.ready ? 'btn secondary mt' : 'btn primary mt';
    }

    if (isHost) {
      const btnStart = document.getElementById('btn-start-game');
      btnStart.disabled = !p2.ready;
      btnStart.textContent = p2.ready ? 'Iniciar Jogo' : 'Aguardando Oponente...';
    }
  } else {
    document.getElementById('wait-p2-name').textContent = "Aguardando Oponente...";
    document.getElementById('wait-p2-status').textContent = "-";
    document.getElementById('wait-p2-status').className = "p-status";

    if (isHost) {
      const btnStart = document.getElementById('btn-start-game');
      btnStart.disabled = true;
      btnStart.textContent = 'Aguardando Oponente...';
    }
  }
});

socket.on('game-started', () => {
  stateSnapshots.length = 0;    // 🆕
  showScreen('game');
});

socket.on('error-msg', msg => alert(msg));

socket.on('room-closed', () => {
  alert('A sala foi fechada ou o oponente saiu.');
  currentRoomId = null;
  gameOverModal.classList.remove('active');
  showScreen('menu');
});

/* ================== 📡 RTT (alimenta o adaptive send rate) ================== */
socket.on('pong', (t) => {
  const rtt = Date.now() - t;
  if (rtt > 0 && rtt < 10000) socket.emit('rtt-report', rtt);
});

setInterval(() => {
  if (socket.connected && currentRoomId) socket.emit('ping', Date.now());
}, 5000);

/* ================== CANVAS ================== */
const W = 1000, H = 600;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let sx = 1, sy = 1, serverState = null, trail = [], shake = 0;
let particles = [];
let lastMode = '';

/* ================== INTERPOLAÇÃO (100ms de delay) ==================
   O server pode rodar a 60/30/20Hz (adaptive). O cliente guarda os
   últimos snapshots e desenha com delay fixo, interpolando posição
   entre os dois mais próximos do "agora - INTERP_DELAY". Fica suave
   em qualquer taxa, sem tremedeira.
   ================================================================== */
const stateSnapshots = [];
const INTERP_DELAY = 100;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

function getInterpState() {
  if (stateSnapshots.length === 0) return null;
  const now = performance.now();
  const renderT = now - INTERP_DELAY;

  let a = stateSnapshots[0], b = stateSnapshots[stateSnapshots.length - 1];
  for (let i = 0; i < stateSnapshots.length - 1; i++) {
    if (stateSnapshots[i]._recvAt <= renderT && stateSnapshots[i + 1]._recvAt >= renderT) {
      a = stateSnapshots[i]; b = stateSnapshots[i + 1]; break;
    }
    if (stateSnapshots[i + 1]._recvAt < renderT) { a = b = stateSnapshots[i + 1]; }
  }
  const span = b._recvAt - a._recvAt;
  const alpha = span > 0 ? clamp((renderT - a._recvAt) / span, 0, 1) : 0;

  const aS = a.state, bS = b.state;
  return {
    mode: bS.mode,
    countdown: bS.countdown,
    puck: {
      x: lerp(aS.puck.x, bS.puck.x, alpha),
      y: lerp(aS.puck.y, bS.puck.y, alpha),
      r: bS.puck.r,
    },
    p1: bS.p1 ? { ...bS.p1, x: aS.p1 ? lerp(aS.p1.x, bS.p1.x, alpha) : bS.p1.x, y: aS.p1 ? lerp(aS.p1.y, bS.p1.y, alpha) : bS.p1.y } : null,
    p2: bS.p2 ? { ...bS.p2, x: aS.p2 ? lerp(aS.p2.x, bS.p2.x, alpha) : bS.p2.x, y: aS.p2 ? lerp(aS.p2.y, bS.p2.y, alpha) : bS.p2.y } : null,
  };
}

function resize() {
  const wrap = document.getElementById('game-wrap');
  const r = wrap.getBoundingClientRect();
  // DPR cap em 2× — celular com tela 3x/4x não derrete a GPU
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  sx = canvas.width / W;
  sy = canvas.height / H;
}
new ResizeObserver(resize).observe(document.getElementById('game-wrap'));

function initCanvas() {
  resize();
  if (!window.isLooping) {
    window.isLooping = true;
    requestAnimationFrame(loop);
  }
}

function createConfetti() {
  const colors = ['#ff5c7a', '#3fd0ff', '#fff', '#ffdf5c', '#7ef0ff'];
  for (let i = 0; i < 150; i++) {
    particles.push({
      x: Math.random() * W,
      y: -20 - Math.random() * 100,
      vx: (Math.random() - 0.5) * 200,
      vy: Math.random() * 200 + 100,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 10,
    });
  }
}

socket.on('state', (state) => {
  stateSnapshots.push({ state, _recvAt: performance.now() });
  while (stateSnapshots.length > 30) stateSnapshots.shift();
  while (stateSnapshots.length > 2 && stateSnapshots[0]._recvAt < performance.now() - 2000) stateSnapshots.shift();

  serverState = state;

  document.getElementById('score1').textContent = state.p1 ? state.p1.score : 0;
  document.getElementById('score2').textContent = state.p2 ? state.p2.score : 0;
  if (state.p1) document.getElementById('name1').textContent = state.p1.name;
  if (state.p2) document.getElementById('name2').textContent = state.p2.name;

  if (state.mode === 'goal' && lastMode !== 'goal') {
    const flash = document.getElementById('flash');
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
    shake = 20;

    const golX = state.puck.x < 500 ? 0 : W;
    for (let i = 0; i < 40; i++) {
      particles.push({
        x: golX, y: H / 2 + (Math.random() - 0.5) * 100,
        vx: (golX === 0 ? 1 : -1) * (Math.random() * 300 + 100),
        vy: (Math.random() - 0.5) * 400,
        size: Math.random() * 6 + 2,
        color: golX === 0 ? '#3fd0ff' : '#ff5c7a',
        rot: 0, vr: 0,
      });
    }
  }

  if (state.mode === 'over' && lastMode !== 'over') {
    const iWin = (myPlayerIdx === 0 && state.p1.score > state.p2.score) || (myPlayerIdx === 1 && state.p2.score > state.p1.score);
    goTitle.textContent = iWin ? 'VOCÊ GANHOU!' : 'VOCÊ PERDEU';
    goTitle.style.color = iWin ? '#3fd0ff' : '#ff5c7a';
    document.getElementById('go-sub').textContent = `Placar: ${state.p1.score} x ${state.p2.score}`;

    createConfetti();
    gameOverModal.classList.add('active');
  }

  lastMode = state.mode;
});

/* 🆕 Throttle de 60 msg/s no `move` — antes, um mouse rápido mandava
   150+ por segundo e entupia a fila TCP em rede fraca. */
let lastMoveSent = 0;
const MOVE_RATE = 60;

canvas.addEventListener('pointermove', e => {
  if (!serverState || serverState.mode !== 'play') return;
  const now = performance.now();
  if (now - lastMoveSent < 1000 / MOVE_RATE) return;
  lastMoveSent = now;

  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W;
  const y = ((e.clientY - r.top) / r.height) * H;
  if (currentRoomId) socket.emit('move', { roomId: currentRoomId, x, y });
});

function loop(now) {
  requestAnimationFrame(loop);
  if (!serverState) return;

  const rs = getInterpState() || serverState;

  ctx.setTransform(sx, 0, 0, sy, 0, 0);

  if (shake > 0.5) {
    ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
    shake *= 0.9;
  }

  ctx.fillStyle = '#0d1424'; ctx.fillRect(-50, -50, W + 100, H + 100);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 100, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = 'rgba(255,92,122,0.2)'; ctx.fillRect(0, H / 2 - 110, 40, 220);
  ctx.fillStyle = 'rgba(63,208,255,0.2)'; ctx.fillRect(W - 40, H / 2 - 110, 40, 220);

  drawPaddle(rs.p1, '#ff5c7a');
  drawPaddle(rs.p2, '#3fd0ff');

  if (rs.puck && rs.mode !== 'over') {
    const p = rs.puck;
    trail.push({ x: p.x, y: p.y });
    if (trail.length > 12) trail.shift();
    for (let i = 0; i < trail.length; i++) {
      ctx.globalAlpha = (i / trail.length) * 0.2;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(trail[i].x, trail[i].y, 17, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * (1 / 60);
    p.y += p.vy * (1 / 60);
    p.vy += 300 * (1 / 60);
    p.rot += p.vr * (1 / 60);

    if (p.y > H + 50) { particles.splice(i, 1); continue; }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.5);
    ctx.restore();
  }

  if (rs.mode === 'countdown') {
    const num = Math.ceil(rs.countdown);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 150px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#3fd0ff';
    ctx.shadowBlur = 30;

    if (num > 0 && num <= 3) ctx.fillText(num, W / 2, H / 2);
    else if (num <= 0) ctx.fillText('VAI!', W / 2, H / 2);

    ctx.shadowBlur = 0;
  }
}

function drawPaddle(p, color) {
  if (!p) return;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 20;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(p.x, p.y, 36, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(p.x - 8, p.y - 8, 10, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}