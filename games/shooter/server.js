// games/shooter/server.js
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const IDLE_SNAPSHOT_EVERY = 3;

const MAP_W = 1600, MAP_H = 1000;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 240;
const BULLET_SPEED = 750;
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 25;
const BULLET_LIFETIME = 1.5;
const FIRE_COOLDOWN = 220;
const MAX_HP = 100;
const RESPAWN_TIME = 2500;
const MAX_PLAYERS = 4;

const MODE_KILLS_LIMIT = 10;
const MODE_TIME_LIMIT_MS = 120000;

const ROOM_STATE = Object.freeze({ PLAYING: 'playing', FINISHED: 'finished' });

const WALLS = [
  { x: 650, y: 380, w: 130, h: 30 }, { x: 820, y: 380, w: 130, h: 30 },
  { x: 650, y: 590, w: 130, h: 30 }, { x: 820, y: 590, w: 130, h: 30 },
  { x: 650, y: 410, w: 30, h: 70 },  { x: 650, y: 520, w: 30, h: 70 },
  { x: 920, y: 410, w: 30, h: 70 },  { x: 920, y: 520, w: 30, h: 70 },
  { x: 100, y: 100, w: 100, h: 100 }, { x: 1400, y: 100, w: 100, h: 100 },
  { x: 100, y: 800, w: 100, h: 100 }, { x: 1400, y: 800, w: 100, h: 100 },
  { x: 350, y: 300, w: 30, h: 200 }, { x: 350, y: 500, w: 30, h: 200 },
  { x: 1220, y: 300, w: 30, h: 200 }, { x: 1220, y: 500, w: 30, h: 200 },
  { x: 700, y: 100, w: 200, h: 30 }, { x: 700, y: 870, w: 200, h: 30 },
];

const PILLARS = [
  { cx: 450, cy: 500, r: 55 }, { cx: 1150, cy: 500, r: 55 },
  { cx: 800, cy: 200, r: 45 }, { cx: 800, cy: 800, r: 45 },
];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------- Interseção de segmento (Line Intersection) ---------- */

function segmentAABB(x1, y1, x2, y2, rx, ry, rw, rh) {
  const dx = x2 - x1, dy = y2 - y1;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x1 < rx || x1 > rx + rw) return false;
  } else {
    let t1 = (rx - x1) / dx, t2 = (rx + rw - x1) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y1 < ry || y1 > ry + rh) return false;
  } else {
    let t1 = (ry - y1) / dy, t2 = (ry + rh - y1) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

function segmentCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const fx = x1 - cx, fy = y1 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return (fx * fx + fy * fy) <= r * r;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

function segmentHitsWorld(x1, y1, x2, y2, padding = 0) {
  for (const w of WALLS) {
    if (segmentAABB(x1, y1, x2, y2,
      w.x - padding, w.y - padding, w.w + padding * 2, w.h + padding * 2)) return true;
  }
  for (const p of PILLARS) {
    if (segmentCircle(x1, y1, x2, y2, p.cx, p.cy, p.r + padding)) return true;
  }
  return false;
}

function isInsideAnyWallOrPillar(x, y, r) {
  for (const w of WALLS) {
    if (x >= w.x - r && x <= w.x + w.w + r && y >= w.y - r && y <= w.y + w.h + r) return true;
  }
  for (const p of PILLARS) {
    if (Math.hypot(x - p.cx, y - p.cy) < p.r + r) return true;
  }
  return false;
}

function resolvePlayerWalls(px, py, radius) {
  for (const w of WALLS) {
    const closestX = clamp(px, w.x, w.x + w.w), closestY = clamp(py, w.y, w.y + w.h);
    const dx = px - closestX, dy = py - closestY, d2 = dx * dx + dy * dy;
    if (d2 < radius * radius) {
      const d = Math.sqrt(d2);
      if (d > 0.001) {
        const overlap = radius - d;
        px += (dx / d) * overlap; py += (dy / d) * overlap;
      } else {
        const left = px - w.x, right = (w.x + w.w) - px, top = py - w.y, bottom = (w.y + w.h) - py;
        const min = Math.min(left, right, top, bottom);
        if (min === left) px = w.x - radius; else if (min === right) px = w.x + w.w + radius;
        else if (min === top) py = w.y - radius; else py = w.y + w.h + radius;
      }
    }
  }
  for (const p of PILLARS) {
    const dx = px - p.cx, dy = py - p.cy, d = Math.hypot(dx, dy), minD = radius + p.r;
    if (d < minD && d > 0.001) {
      const overlap = minD - d;
      px += (dx / d) * overlap; py += (dy / d) * overlap;
    }
  }
  return { x: px, y: py };
}

/* ================================================================
   📦 PAYLOAD BINÁRIO — substitui JSON por ArrayBuffer
   Layout (little-endian, todos os campos em sequência):

   [HEADER 13 bytes]
     u8  version        = 1
     u8  state          = 0 (playing) | 1 (finished)
     u8  mode           = 0 (inf) | 1 (score) | 2 (time) | 3 (lms)
     u8  playerCount
     u8  bulletCount
     u16 roundId
     u32 tick (ms mod 2^32)
     u16 timeLeftDecasec   (timeLeftMs / 100, 0-6553s)

   [FINISHED ONLY — só se state === 1]
     u8  reasonLen, reason bytes (UTF-8)
     u16 winnerNameLen, winnerName bytes (UTF-8)
     u8  winnerR, u8 winnerG, u8 winnerB

   [PLAYERS — playerCount × var]
     u8  idLen, id bytes
     u8  nameLen, name bytes
     u8  r, u8 g, u8 b   (cor)
     u16 x, u16 y
     i16 angle × 1000
     u8  hp, u8 kills, u8 deaths, u8 alive
     u32 respawnAt

   [BULLETS — bulletCount × 13]
     u16 id, u16 x, u16 y
     i16 vx, i16 vy
     u8  r, u8 g, u8 b
   ================================================================ */

const _encoder = new TextEncoder();

function modeToByte(mode) {
  return mode === 'score' ? 1 : mode === 'time' ? 2 : mode === 'lms' ? 3 : 0;
}
function byteToMode(b) {
  return b === 1 ? 'score' : b === 2 ? 'time' : b === 3 ? 'lms' : 'infinite';
}
function hexToRgb(hex) {
  if (typeof hex !== 'string' || hex.length < 7) return { r: 0, g: 0, b: 0 };
  const n = parseInt(hex.slice(1, 7), 16);
  return { r: (n >> 16) & 0xFF, g: (n >> 8) & 0xFF, b: n & 0xFF };
}

function encodeSnapshot(room, now) {
  const players = Array.from(room.players.values());
  const bullets = room.bullets;
  const isFinished = room.state === ROOM_STATE.FINISHED;

  const reason = isFinished ? (room.endReason || '') : '';
  const winnerName = isFinished && room.winner ? room.winner.name : '';
  const winnerColor = isFinished && room.winner ? room.winner.color : '#000000';

  const reasonBytes = reason ? _encoder.encode(reason) : null;
  const winnerNameBytes = winnerName ? _encoder.encode(winnerName) : null;

  // Pré-codifica IDs e nomes dos jogadores uma vez
  const playerBufs = new Array(players.length);
  let playerBytesSize = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const idB = _encoder.encode(p.id);
    const nameB = _encoder.encode(p.name);
    playerBufs[i] = { p, idB, nameB };
    // idLen(1) + id + nameLen(1) + name + cor(3) + x(2) + y(2) + angle(2)
    // + hp(1) + k(1) + d(1) + alive(1) + respawn(4)
    playerBytesSize += 1 + idB.length + 1 + nameB.length + 3 + 2 + 2 + 2 + 1 + 1 + 1 + 1 + 4;
  }

  // Tamanho total
  let size = 13; // header
  if (isFinished) {
    size += 1 + (reasonBytes ? reasonBytes.length : 0);
    size += 2 + (winnerNameBytes ? winnerNameBytes.length : 0);
    size += 3;
  }
  size += playerBytesSize;
  size += Math.min(bullets.length, 255) * 13;

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  // ---- HEADER ----
  view.setUint8(off, 1); off += 1;                                // version
  view.setUint8(off, isFinished ? 1 : 0); off += 1;                // state
  view.setUint8(off, modeToByte(room.mode)); off += 1;             // mode
  view.setUint8(off, Math.min(255, players.length)); off += 1;     // playerCount
  view.setUint8(off, Math.min(255, bullets.length)); off += 1;     // bulletCount
  view.setUint16(off, room.roundId & 0xFFFF, true); off += 2;      // roundId
  view.setUint32(off, now & 0xFFFFFFFF, true); off += 4;           // tick
  const timeLeftMs = room.mode === 'time'
    ? Math.max(0, MODE_TIME_LIMIT_MS - (now - room.startedAt)) : 0;
  view.setUint16(off, Math.min(65535, Math.round(timeLeftMs / 100)), true); off += 2;

  // ---- FINISHED INFO ----
  if (isFinished) {
    const rLen = reasonBytes ? reasonBytes.length : 0;
    view.setUint8(off, Math.min(255, rLen)); off += 1;
    if (rLen) { bytes.set(reasonBytes.subarray(0, 255), off); off += Math.min(255, rLen); }

    const wLen = winnerNameBytes ? winnerNameBytes.length : 0;
    view.setUint16(off, Math.min(65535, wLen), true); off += 2;
    if (wLen) { bytes.set(winnerNameBytes.subarray(0, 65535), off); off += Math.min(65535, wLen); }

    const wc = hexToRgb(winnerColor);
    view.setUint8(off, wc.r); off += 1;
    view.setUint8(off, wc.g); off += 1;
    view.setUint8(off, wc.b); off += 1;
  }

  // ---- PLAYERS ----
  for (let i = 0; i < playerBufs.length; i++) {
    const { p, idB, nameB } = playerBufs[i];

    view.setUint8(off, Math.min(255, idB.length)); off += 1;
    bytes.set(idB.subarray(0, 255), off); off += Math.min(255, idB.length);

    view.setUint8(off, Math.min(255, nameB.length)); off += 1;
    bytes.set(nameB.subarray(0, 255), off); off += Math.min(255, nameB.length);

    const c = hexToRgb(p.color);
    view.setUint8(off, c.r); off += 1;
    view.setUint8(off, c.g); off += 1;
    view.setUint8(off, c.b); off += 1;

    view.setUint16(off, Math.max(0, Math.min(65535, Math.round(p.x))), true); off += 2;
    view.setUint16(off, Math.max(0, Math.min(65535, Math.round(p.y))), true); off += 2;
    view.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(p.angle * 1000))), true); off += 2;

    view.setUint8(off, Math.max(0, Math.min(255, Math.round(p.hp)))); off += 1;
    view.setUint8(off, Math.min(255, p.kills)); off += 1;
    view.setUint8(off, Math.min(255, p.deaths)); off += 1;
    view.setUint8(off, p.alive ? 1 : 0); off += 1;
    view.setUint32(off, (p.respawnAt || 0) & 0xFFFFFFFF, true); off += 4;
  }

  // ---- BULLETS (máx 255 pra não estourar o bulletCount do header) ----
  const bulletLimit = Math.min(bullets.length, 255);
  for (let i = 0; i < bulletLimit; i++) {
    const b = bullets[i];
    view.setUint16(off, b.id & 0xFFFF, true); off += 2;
    view.setUint16(off, Math.max(0, Math.min(65535, Math.round(b.x))), true); off += 2;
    view.setUint16(off, Math.max(0, Math.min(65535, Math.round(b.y))), true); off += 2;
    view.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(b.vx))), true); off += 2;
    view.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(b.vy))), true); off += 2;
    const c = hexToRgb(b.color);
    view.setUint8(off, c.r); off += 1;
    view.setUint8(off, c.g); off += 1;
    view.setUint8(off, c.b); off += 1;
  }

  return buf;
}

module.exports = {
  initialize: (io) => {
    const rooms = new Map();

    function getRoomsList() {
      return Array.from(rooms.values())
        .filter(r => r.players.size > 0)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(r => ({
          id: r.id, name: r.name, players: r.players.size,
          maxPlayers: MAX_PLAYERS, mode: r.mode, state: r.state,
        }));
    }

    function broadcastRooms() { io.to('__lobby_shooter__').emit('rooms', getRoomsList()); }
    function genRoomId() { let id; do { id = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (rooms.has(id)); return id; }

    function findSafeSpawn(room) {
      let best = null, bestDist = -1;
      for (let i = 0; i < 60; i++) {
        const x = PLAYER_RADIUS + 20 + Math.random() * (MAP_W - (PLAYER_RADIUS + 20) * 2);
        const y = PLAYER_RADIUS + 20 + Math.random() * (MAP_H - (PLAYER_RADIUS + 20) * 2);
        if (isInsideAnyWallOrPillar(x, y, PLAYER_RADIUS + 6)) continue;
        let minD = Infinity;
        for (const other of room.players.values()) {
          if (other.alive) minD = Math.min(minD, Math.hypot(other.x - x, other.y - y));
        }
        if (minD > bestDist) { bestDist = minD; best = { x, y }; }
      }
      return best || { x: MAP_W / 2, y: 50 };
    }

    // ============================================================
    // 🎚️ ADAPTIVE SNAPSHOT RATE
    // ============================================================
    // A física continua rodando a 20Hz SEMPRE (tick fixo, justo).
    // O que muda é a frequência com que o SERVIDOR ENVIA snapshots.
    //   - Rede boa  (avg RTT < 150ms):  rate=1 → 20 snapshots/s
    //   - Rede média (150–300ms):       rate=2 → 10 snapshots/s
    //   - Rede ruim (> 300ms):          rate=3 →  6.6 snapshots/s
    // Em rede ruim, mandar menos snapshots reduz o acúmulo na fila
    // TCP (head-of-line blocking) e economiza banda.
    // ============================================================
    function updateAdaptiveSnapshotRate(room) {
      if (room.players.size === 0) { room.snapshotRate = 1; return; }
      let sum = 0, count = 0;
      for (const p of room.players.values()) {
        if (typeof p.rtt === 'number' && p.rtt > 0) { sum += p.rtt; count++; }
      }
      if (count === 0) { room.snapshotRate = 1; return; }
      const avgRtt = sum / count;
      if (avgRtt > 300)      room.snapshotRate = 3;
      else if (avgRtt > 150) room.snapshotRate = 2;
      else                   room.snapshotRate = 1;
    }

    function sendSnapshot(room, now, volatile = true) {
      const payload = encodeSnapshot(room, now);
      if (volatile) io.to(room.id).volatile.emit('snapshot', payload);
      else io.to(room.id).emit('snapshot', payload);
    }

    /* ---------- Máquina de estados ---------- */

    function endGame(room, winner, reason) {
      if (room.state === ROOM_STATE.FINISHED) return;
      room.state = ROOM_STATE.FINISHED;
      room.winner = winner || null;
      room.endReason = reason || 'Fim de jogo';
      room.bullets = [];
      for (const p of room.players.values()) {
        p.input = { analog: false, moveX: 0, moveY: 0, up: false, down: false, left: false, right: false, shoot: false, angle: p.angle };
      }
      io.to(room.id).emit('game-over', {
        winner: room.winner ? { name: room.winner.name, color: room.winner.color } : null,
        reason: room.endReason,
        roundId: room.roundId,
      });
      // Snapshot final VOLATILE (mantém o que já existia).
      // Fallback: o cliente também detecta FINISHED via snap.state
      // e via evento 'game-over' — se os dois falharem, a reconexão
      // (com backoff exponencial) resolve.
      sendSnapshot(room, Date.now(), true);
    }

    function startRound(room) {
      room.state = ROOM_STATE.PLAYING;
      room.roundId++;
      room.startedAt = Date.now();
      room.bullets = [];
      room.bulletIdCounter = 0;
      room.winner = null;
      room.endReason = null;
      room.hadActivity = true;
      for (const p of room.players.values()) {
        const pos = findSafeSpawn(room);
        p.x = pos.x; p.y = pos.y; p.angle = 0;
        p.hp = MAX_HP; p.alive = true;
        p.kills = 0; p.deaths = 0; p.respawnAt = 0; p.lastShot = 0;
        p.input = { analog: false, moveX: 0, moveY: 0, up: false, down: false, left: false, right: false, shoot: false, angle: 0 };
      }
    }

    function joinRoom(socket, room, name, color) {
      socket.leave('__lobby_shooter__'); socket.join(room.id); socket.data.roomId = room.id;
      const player = {
        id: socket.id, name, color, x: 0, y: 0, angle: 0,
        hp: MAX_HP, kills: 0, deaths: 0, alive: true, respawnAt: 0, lastShot: 0,
        rtt: 0,
        input: { analog: false, moveX: 0, moveY: 0, up: false, down: false, left: false, right: false, shoot: false, angle: 0 },
      };
      const pos = findSafeSpawn(room); player.x = pos.x; player.y = pos.y;
      room.players.set(socket.id, player);

      socket.emit('joined', {
        roomId: room.id, roomName: room.name, playerId: socket.id, mode: room.mode,
        state: room.state, roundId: room.roundId,
        mapW: MAP_W, mapH: MAP_H, playerRadius: PLAYER_RADIUS,
        bulletRadius: BULLET_RADIUS, maxHp: MAX_HP, tickRate: TICK_RATE,
        walls: WALLS, pillars: PILLARS,
        ...(room.state === ROOM_STATE.FINISHED ? {
          winner: room.winner ? { name: room.winner.name, color: room.winner.color } : null,
          reason: room.endReason || '',
        } : {}),
      });
      io.to(room.id).emit('player-joined', { id: socket.id, name, color });
    }

    function leaveRoom(socket) {
      const roomId = socket.data.roomId; if (!roomId) return;
      const room = rooms.get(roomId);
      if (room) {
        room.players.delete(socket.id);
        io.to(roomId).emit('player-left', { id: socket.id });
        if (room.players.size === 0) rooms.delete(roomId);
        else {
          updateAdaptiveSnapshotRate(room);
          if (room.state === ROOM_STATE.PLAYING && room.mode === 'lms' && room.players.size === 1) {
            const winner = Array.from(room.players.values())[0];
            if (winner.alive) endGame(room, winner, 'Último sobrevivente!');
          }
        }
      }
      socket.leave(roomId); socket.join('__lobby_shooter__'); socket.data.roomId = null;
    }

    io.on('connection', (socket) => {
      socket.join('__lobby_shooter__'); socket.emit('rooms', getRoomsList());

      socket.on('list-rooms', () => socket.emit('rooms', getRoomsList()));
      socket.on('ping', (t) => socket.emit('pong', t));

      // 📡 RTT reportado pelo cliente a cada ~5s → alimenta o adaptive rate
      socket.on('rtt-report', (rtt) => {
        if (typeof rtt !== 'number' || !isFinite(rtt) || rtt < 0 || rtt > 10000) return;
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        const p = room.players.get(socket.id);
        if (!p) return;
        p.rtt = rtt;
        updateAdaptiveSnapshotRate(room);
      });

      socket.on('create-room', ({ name, color, roomName, mode }, cb) => {
        name = (name || 'Jogador').slice(0, 16);
        color = color || '#22d3ee';
        roomName = (roomName || 'Sala').slice(0, 20).trim() || 'Sala';
        mode = mode || 'infinite';
        const room = {
          id: genRoomId(), name: roomName, mode,
          players: new Map(), bullets: [], bulletIdCounter: 0,
          createdAt: Date.now(), startedAt: Date.now(),
          hadActivity: true, state: ROOM_STATE.PLAYING, roundId: 0,
          winner: null, endReason: null,
          snapshotRate: 1,
        };
        rooms.set(room.id, room);
        joinRoom(socket, room, name, color);
        if (cb) cb({ success: true, roomId: room.id });
        broadcastRooms();
      });

      socket.on('join-room', ({ roomId, name, color }, cb) => {
        roomId = (roomId || '').toUpperCase().trim();
        const room = rooms.get(roomId);
        if (!room) return cb && cb({ success: false, error: 'Sala não encontrada.' });
        if (room.players.size >= MAX_PLAYERS) return cb && cb({ success: false, error: 'Sala cheia.' });
        joinRoom(socket, room, (name || 'Jogador').slice(0, 16), color || '#22d3ee');
        if (cb) cb({ success: true, roomId: room.id });
        broadcastRooms();
      });

      socket.on('restart-game', () => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.state !== ROOM_STATE.FINISHED) return;
        startRound(room);
        io.to(room.id).emit('game-restarted', { roundId: room.roundId });
        broadcastRooms();
      });

      socket.on('leave-room', () => { leaveRoom(socket); socket.emit('rooms', getRoomsList()); });

      socket.on('input', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.state !== ROOM_STATE.PLAYING) return;
        const p = room.players.get(socket.id);
        if (!p) return;

        if (typeof data.moveX === 'number' && typeof data.moveY === 'number') {
          p.input.analog = true;
          p.input.moveX = clamp(data.moveX, -1, 1);
          p.input.moveY = clamp(data.moveY, -1, 1);
          p.input.up = p.input.down = p.input.left = p.input.right = false;
        } else {
          p.input.analog = false;
          p.input.up = !!data.up; p.input.down = !!data.down;
          p.input.left = !!data.left; p.input.right = !!data.right;
        }
        p.input.shoot = !!data.shoot;
        if (typeof data.angle === 'number' && isFinite(data.angle)) p.input.angle = data.angle;
        room.hadActivity = true;
      });

      socket.on('disconnect', () => { leaveRoom(socket); broadcastRooms(); });
    });

    let tickCount = 0;
    setInterval(() => {
      tickCount++;
      const now = Date.now();
      const dt = TICK_MS / 1000;

      for (const room of rooms.values()) {
        if (room.state !== ROOM_STATE.PLAYING) continue;

        if (room.mode === 'time' && (now - room.startedAt) >= MODE_TIME_LIMIT_MS) {
          let best = null;
          for (const p of room.players.values()) if (!best || p.kills > best.kills) best = p;
          endGame(room, best, 'Tempo esgotado!');
          continue;
        }

        let aliveCount = 0;
        for (const p of room.players.values()) {
          if (!p.alive) {
            if (room.mode !== 'lms' && now >= p.respawnAt) {
              const pos = findSafeSpawn(room);
              p.x = pos.x; p.y = pos.y; p.hp = MAX_HP; p.alive = true;
              room.hadActivity = true;
            }
            continue;
          }
          aliveCount++;

          let dx = 0, dy = 0;
          if (p.input.analog) { dx = p.input.moveX; dy = p.input.moveY; }
          else {
            if (p.input.up) dy -= 1; if (p.input.down) dy += 1;
            if (p.input.left) dx -= 1; if (p.input.right) dx += 1;
          }
          const len = Math.hypot(dx, dy);
          if (len > 0.1) {
            const spd = Math.min(len, 1) * PLAYER_SPEED;
            p.x += (dx / len) * spd * dt;
            p.y += (dy / len) * spd * dt;
            room.hadActivity = true;
          }
          p.x = clamp(p.x, PLAYER_RADIUS, MAP_W - PLAYER_RADIUS);
          p.y = clamp(p.y, PLAYER_RADIUS, MAP_H - PLAYER_RADIUS);
          const r = resolvePlayerWalls(p.x, p.y, PLAYER_RADIUS);
          p.x = r.x; p.y = r.y;
          p.angle = p.input.angle;

          if (p.input.shoot && now - p.lastShot >= FIRE_COOLDOWN) {
            p.lastShot = now;
            room.bullets.push({
              id: room.bulletIdCounter++, ownerId: p.id,
              x: p.x, y: p.y,
              vx: Math.cos(p.angle) * BULLET_SPEED,
              vy: Math.sin(p.angle) * BULLET_SPEED,
              life: BULLET_LIFETIME, color: p.color,
            });
            room.hadActivity = true;
          }
        }

        if (room.mode === 'lms' && room.players.size > 1 && aliveCount <= 1) {
          const winner = Array.from(room.players.values()).find(p => p.alive);
          endGame(room, winner || null, 'Último sobrevivente!');
          continue;
        }

        const aliveBullets = [];
        for (const b of room.bullets) {
          const oldX = b.x, oldY = b.y;
          b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
          if (b.life <= 0) continue;
          if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) continue;

          if (segmentHitsWorld(oldX, oldY, b.x, b.y, BULLET_RADIUS)) continue;

          let hitPlayer = false;
          for (const p of room.players.values()) {
            if (!p.alive || p.id === b.ownerId) continue;
            if (segmentCircle(oldX, oldY, b.x, b.y, p.x, p.y, PLAYER_RADIUS + BULLET_RADIUS)) {
              p.hp -= BULLET_DAMAGE;
              hitPlayer = true;
              if (p.hp <= 0) {
                p.hp = 0; p.alive = false; p.deaths++;
                p.respawnAt = room.mode === 'lms' ? 0 : now + RESPAWN_TIME;
                const killer = room.players.get(b.ownerId);
                if (killer) {
                  killer.kills++;
                  io.to(room.id).emit('kill', { killer: killer.name, victim: p.name });
                  if (room.mode === 'score' && killer.kills >= MODE_KILLS_LIMIT) {
                    endGame(room, killer, 'Limite de abates!');
                  }
                }
              }
              break;
            }
          }
          if (!hitPlayer) aliveBullets.push(b);
          else room.hadActivity = true;
        }
        room.bullets = aliveBullets;

        // 🎚️ REGRA DE ENVIO ADAPTATIVA
        // rate=1 (20Hz): comportamento clássico (activity-driven + idle fallback)
        // rate>1 (10Hz/6.6Hz): frequência fixa reduzida, ignora activity
        if (room.state === ROOM_STATE.PLAYING) {
          const rate = room.snapshotRate || 1;
          const shouldSend = rate > 1
            ? (tickCount % rate === 0)
            : (room.hadActivity || tickCount % IDLE_SNAPSHOT_EVERY === 0);
          if (shouldSend) {
            sendSnapshot(room, now, true);
            room.hadActivity = false;
          }
        }
      }
    }, TICK_MS);
  }
};