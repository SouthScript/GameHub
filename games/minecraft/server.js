// games/minecraft/server.js
// 🧠 Cérebro do Minecraft clone — autoridade do mundo + relay de jogadores
// Namespace isolado /minecraft. Chunks viajam em binário RLE.

const WORLD_SIZE = 32;
const MAX_PLAYERS = 8;
const BLOCK = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4 };
const DEFAULT_COLOR = '#22d3ee';

function idx(x, y, z) {
  return x + z * WORLD_SIZE + y * WORLD_SIZE * WORLD_SIZE;
}

function sanitizeColor(c) {
  if (typeof c !== 'string') return DEFAULT_COLOR;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return DEFAULT_COLOR;
}

function generateWorld(seed = 0) {
  const world = new Uint8Array(WORLD_SIZE * WORLD_SIZE * WORLD_SIZE);
  for (let x = 0; x < WORLD_SIZE; x++) {
    for (let z = 0; z < WORLD_SIZE; z++) {
      const h1 = Math.sin((x + seed) * 0.3) * 3;
      const h2 = Math.cos((z - seed) * 0.35) * 3;
      const h3 = Math.sin((x + z) * 0.15) * 2;
      const height = Math.max(2, Math.floor(8 + h1 + h2 + h3));
      for (let y = 0; y < WORLD_SIZE; y++) {
        let b = BLOCK.AIR;
        if (y < height - 3)      b = BLOCK.STONE;
        else if (y < height - 1) b = BLOCK.DIRT;
        else if (y < height)     b = BLOCK.GRASS;
        world[idx(x, y, z)] = b;
      }
    }
  }
  return world;
}

function rleEncode(data) {
  const out = [];
  const len = data.length;
  let i = 0;
  while (i < len) {
    const v = data[i];
    let run = 1;
    while (i + run < len && data[i + run] === v && run < 255) run++;
    out.push(run, v);
    i += run;
  }
  return new Uint8Array(out);
}

const rooms = new Map();
const socketToRoom = new Map();

class Room {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.players = new Map();
    this.world = generateWorld(Math.floor(Math.random() * 1000));
    this.compressedWorld = null;
    this.lastSnapshotAt = 0;
  }
  compressed() {
    if (!this.compressedWorld) this.compressedWorld = rleEncode(this.world);
    return this.compressedWorld;
  }
  snapshotInterval() {
    if (this.players.size === 0) return 1000 / 20;
    let sum = 0, n = 0;
    for (const p of this.players.values()) if (p.rtt > 0) { sum += p.rtt; n++; }
    const avg = n ? sum / n : 100;
    if (avg < 100) return 1000 / 60;
    if (avg < 200) return 1000 / 30;
    return 1000 / 20;
  }
}

function initialize(io) {
  const ns = io.of('/minecraft');

  ns.on('connection', (socket) => {
    console.log(`[Minecraft] + ${socket.id}`);

    socket.on('list-rooms', () => {
      const list = [];
      for (const r of rooms.values()) {
        list.push({ id: r.id, name: r.name, players: r.players.size, maxPlayers: MAX_PLAYERS });
      }
      socket.emit('rooms', list);
    });

    socket.on('create-room', ({ name, playerName, shirtColor } = {}) => {
      if (rooms.size >= 50) return socket.emit('error-msg', 'Muitas salas abertas. Tente novamente.');
      const id = 'mc_' + Math.random().toString(36).slice(2, 10);
      const room = new Room(id, (name || 'Mundo').slice(0, 32));
      rooms.set(id, room);

      const spawn = { x: 16, y: 24, z: 16 };
      const player = {
        id: socket.id,
        name: (playerName || 'Jogador').slice(0, 16),
        shirtColor: sanitizeColor(shirtColor),
        ...spawn,
        yaw: 0, pitch: 0, rtt: 0,
      };
      room.players.set(socket.id, player);
      socketToRoom.set(socket.id, id);
      socket.join(id);

      const compressed = room.compressed();
      socket.emit('world', {
        size: WORLD_SIZE,
        data: compressed.buffer.slice(0),
        compressedLength: compressed.byteLength,
        spawn,
      });
      socket.emit('room-joined', {
        roomId: id, roomName: room.name, selfId: socket.id,
        selfColor: player.shirtColor,
      });
      broadcastRooms(ns);
    });

    socket.on('join-room', ({ roomId, playerName, shirtColor } = {}) => {
      const room = rooms.get(roomId);
      if (!room) return socket.emit('error-msg', 'Sala não encontrada.');
      if (room.players.size >= MAX_PLAYERS) return socket.emit('error-msg', 'Sala cheia.');

      const spawn = { x: 16, y: 24, z: 16 };
      const player = {
        id: socket.id,
        name: (playerName || 'Jogador').slice(0, 16),
        shirtColor: sanitizeColor(shirtColor),
        ...spawn,
        yaw: 0, pitch: 0, rtt: 0,
      };
      room.players.set(socket.id, player);
      socketToRoom.set(socket.id, roomId);
      socket.join(roomId);

      const compressed = room.compressed();
      socket.emit('world', {
        size: WORLD_SIZE,
        data: compressed.buffer.slice(0),
        compressedLength: compressed.byteLength,
        spawn,
      });

      const existing = [];
      for (const p of room.players.values()) {
        if (p.id !== socket.id) {
          existing.push({
            id: p.id, name: p.name, shirtColor: p.shirtColor,
            x: p.x, y: p.y, z: p.z, yaw: p.yaw,
          });
        }
      }
      socket.emit('existing-players', existing);
      socket.emit('room-joined', {
        roomId, roomName: room.name, selfId: socket.id,
        selfColor: player.shirtColor,
      });

      socket.to(roomId).emit('player-joined', {
        id: player.id, name: player.name, shirtColor: player.shirtColor,
        x: player.x, y: player.y, z: player.z, yaw: player.yaw,
      });
      broadcastRooms(ns);
    });

    socket.on('player-state', (s) => {
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const p = room.players.get(socket.id);
      if (!p || !s) return;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      if (Number.isFinite(s.x)) p.x = clamp(s.x, -8, WORLD_SIZE + 8);
      if (Number.isFinite(s.y)) p.y = clamp(s.y, -16, WORLD_SIZE + 16);
      if (Number.isFinite(s.z)) p.z = clamp(s.z, -8, WORLD_SIZE + 8);
      if (Number.isFinite(s.yaw))   p.yaw   = s.yaw;
      if (Number.isFinite(s.pitch)) p.pitch = s.pitch;
    });

    socket.on('block-change', (b) => {
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || !b) return;
      const x = Math.floor(b.x);
      const y = Math.floor(b.y);
      const z = Math.floor(b.z);
      const block = b.block | 0;
      if (x < 0 || x >= WORLD_SIZE) return;
      if (y < 0 || y >= WORLD_SIZE) return;
      if (z < 0 || z >= WORLD_SIZE) return;
      if (block < 0 || block > 4) return;
      room.world[idx(x, y, z)] = block;
      room.compressedWorld = null;
      // ⚠️ AQUI: inclui o remetente para evitar dessincronização
      // (o cliente aplica otimisticamente, mas o servidor é a verdade)
      ns.to(roomId).emit('block-change', { x, y, z, block });
    });

    socket.on('ping-time', (t) => socket.emit('pong-time', t));
    socket.on('update-rtt', (rtt) => {
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const p = room.players.get(socket.id);
      if (p && Number.isFinite(rtt)) p.rtt = rtt;
    });

    socket.on('disconnect', () => {
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.players.delete(socket.id);
      socketToRoom.delete(socket.id);
      socket.to(roomId).emit('player-left', socket.id);
      if (room.players.size === 0) rooms.delete(roomId);
      broadcastRooms(ns);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.players.size === 0) continue;
      const interval = room.snapshotInterval();
      if (now - room.lastSnapshotAt < interval) continue;
      room.lastSnapshotAt = now;
      const arr = [];
      for (const p of room.players.values()) {
        arr.push({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
      }
      ns.to(room.id).emit('snapshot', arr);
    }
  }, 10);

  function broadcastRooms(ns) {
    const list = [];
    for (const r of rooms.values()) {
      list.push({ id: r.id, name: r.name, players: r.players.size, maxPlayers: MAX_PLAYERS });
    }
    ns.emit('rooms', list);
  }

  console.log('[Minecraft] Namespace /minecraft pronto');
}

module.exports = { initialize };