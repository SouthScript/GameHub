// games/air-hockey/server.js
// Cérebro do Air Hockey. Física roda a 60Hz no server.
// Envio é adaptativo (60/30/20Hz) conforme RTT médio da sala.
// Namespace '/air-hockey' para não colidir com os eventos do shooter.
// NÃO sobe servidor: recebe o `io` da raiz via initialize().

const W = 1000, H = 600;
const PAD_R = 36, PUCK_R = 17;

module.exports = {
  initialize: (rootIo) => {
    const io = rootIo.of('/air-hockey');       // 🆕 namespace próprio
    const rooms = {};

    function generateRoomId() {
      let id = '';
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < 4; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
      return rooms[id] ? generateRoomId() : id;
    }

    /* ================== 🎚️ ADAPTIVE SEND RATE ==================
       A física continua rodando a 60Hz SEMPRE (física boa, justa).
       O que muda é quantas vezes o SERVIDOR ENVIA o snapshot:
         RTT < 150ms  → sendRate=1 → 60Hz
         150-300ms    → sendRate=2 → 30Hz
         > 300ms      → sendRate=3 → 20Hz
       O cliente interpola com delay de 100ms, então mesmo a 20Hz
       a animação fica suave.

       ℹ️ O RTT fica guardado em room.players[sid].rtt (não em socket.data)
       para não depender de internals do socket.io e sobreviver a
       desconexões/reconexões entre um report e outro.
       ============================================================ */
    function updateRoomSendRate(room) {
      let sum = 0, count = 0;
      for (const sid of [room.hostId, room.guestId]) {
        if (!sid) continue;
        const p = room.players[sid];
        if (p && typeof p.rtt === 'number' && p.rtt > 0) {
          sum += p.rtt;
          count++;
        }
      }
      if (count === 0) { room.sendRate = 1; return; }
      const avg = sum / count;
      room.sendRate = avg > 300 ? 3 : avg > 150 ? 2 : 1;
    }

    /* ================== FÍSICA DA SALA ================== */
    class Room {
      constructor(id, hostId, hostName) {
        this.id = id;
        this.hostId = hostId;
        this.players = {
          [hostId]: {
            id: hostId, name: hostName, idx: 0, score: 0, ready: true,
            x: 150, y: 300, tx: 150, ty: 300, vx: 0, vy: 0,
            rtt: 0,
          },
        };
        this.mode = 'waiting';
        this.puck = { x: 500, y: 300, vx: 0, vy: 0, r: PUCK_R };
        this.goalTimer = 0;
        this.countdownTimer = 0;
        this.guestId = null;
        this.winScore = 7;
        this.sendRate = 1;
      }

      getPlayers() {
        return [this.players[this.hostId], this.guestId ? this.players[this.guestId] : null];
      }

      addPlayer(id, name) {
        this.guestId = id;
        this.players[id] = {
          id, name, idx: 1, score: 0, ready: false,
          x: 850, y: 300, tx: 850, ty: 300, vx: 0, vy: 0,
          rtt: 0,
        };
      }

      resetRound() {
        this.puck = { x: 500, y: 300, vx: 0, vy: 0, r: PUCK_R };
        this.getPlayers().forEach((p, i) => {
          if (p) {
            p.x = p.tx = (i === 0) ? 150 : 850;
            p.y = p.ty = 300;
            p.vx = p.vy = 0;
          }
        });
      }

      resetMatch() {
        this.resetRound();
        this.getPlayers().forEach(p => { if (p) p.score = 0; });
      }

      startGame() {
        this.resetMatch();
        this.mode = 'countdown';
        this.countdownTimer = 3.5;
      }

      step(dt) {
        const [p1, p2] = this.getPlayers();

        if (this.mode === 'countdown') {
          this.countdownTimer -= dt;
          if (this.countdownTimer <= 0) this.mode = 'play';
        }
        else if (this.mode === 'play' || this.mode === 'goal') {
          if (p1) this.updatePaddle(p1, dt);
          if (p2) this.updatePaddle(p2, dt);
        }

        if (this.mode === 'play') {
          this.updatePuck(dt, p1, p2);
        }
        else if (this.mode === 'goal') {
          this.goalTimer -= dt;
          if (this.goalTimer <= 0) {
            if (p1.score >= this.winScore || (p2 && p2.score >= this.winScore)) {
              this.mode = 'over';
            } else {
              this.resetRound();
              this.mode = 'play';
            }
          }
        }
      }

      updatePaddle(p, dt) {
        const px = p.x, py = p.y;
        const k = 1 - Math.exp(-dt * 20);
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;

        if (p.idx === 0) p.x = Math.max(PAD_R, Math.min(W / 2 - PAD_R, p.x));
        else p.x = Math.max(W / 2 + PAD_R, Math.min(W - PAD_R, p.x));
        p.y = Math.max(PAD_R, Math.min(H - PAD_R, p.y));

        p.vx = (p.x - px) / dt;
        p.vy = (p.y - py) / dt;
      }

      updatePuck(dt, p1, p2) {
        const puck = this.puck;
        puck.x += puck.vx * dt;
        puck.y += puck.vy * dt;

        puck.vx *= 0.998;
        puck.vy *= 0.998;

        if (p1) this.collide(p1);
        if (p2) this.collide(p2);

        const inGap = Math.abs(puck.y - H / 2) < 110;

        if (puck.y - puck.r < 0) { puck.y = puck.r; puck.vy = Math.abs(puck.vy) * 0.96; }
        if (puck.y + puck.r > H) { puck.y = H - puck.r; puck.vy = -Math.abs(puck.vy) * 0.96; }

        if (puck.x - puck.r < 0) {
          if (inGap && puck.x < 0) this.score(p1, p2, 1);
          else if (!inGap) { puck.x = puck.r; puck.vx = Math.abs(puck.vx) * 0.96; }
        }

        if (puck.x + puck.r > W) {
          if (inGap && puck.x > W) this.score(p1, p2, 0);
          else if (!inGap) { puck.x = W - puck.r; puck.vx = -Math.abs(puck.vx) * 0.96; }
        }
      }

      collide(p) {
        const puck = this.puck;
        const dx = puck.x - p.x;
        const dy = puck.y - p.y;
        let d = Math.hypot(dx, dy);
        if (d >= puck.r + PAD_R) return;
        if (d < 0.0001) d = 0.0001;

        const nx = dx / d, ny = dy / d;
        puck.x = p.x + nx * (puck.r + PAD_R);
        puck.y = p.y + ny * (puck.r + PAD_R);

        const rvx = puck.vx - p.vx, rvy = puck.vy - p.vy;
        const vn = rvx * nx + rvy * ny;

        if (vn < 0) {
          puck.vx -= 1.95 * vn * nx;
          puck.vy -= 1.95 * vn * ny;
        }
        const push = p.vx * nx + p.vy * ny;
        if (push > 0) { puck.vx += p.vx * 0.28; puck.vy += p.vy * 0.28; }
      }

      score(p1, p2, idx) {
        if (idx === 0 && p1) p1.score++;
        else if (idx === 1 && p2) p2.score++;

        this.mode = 'goal';
        this.goalTimer = 1.8;
        this.puck.vx = this.puck.vy = 0;
      }
    }

    /* ================== TICK 60Hz ================== */
    let tickCount = 0;
    setInterval(() => {
      tickCount++;
      for (let roomId in rooms) {
        const room = rooms[roomId];
        if (room.mode === 'waiting') continue;

        room.step(1 / 60);

        // 🎚️ Só envia conforme sendRate (60/30/20Hz). Cliente interpola.
        if (tickCount % room.sendRate === 0) {
          io.to(roomId).emit('state', {
            mode: room.mode,
            countdown: room.countdownTimer,
            puck: room.puck,
            p1: room.getPlayers()[0],
            p2: room.getPlayers()[1],
          });
        }
      }
    }, 1000 / 60);

    function broadcastRooms() {
      const list = Object.values(rooms).map(r => ({
        id: r.id,
        host: r.players[r.hostId]?.name || '???',
        guest: r.guestId ? r.players[r.guestId]?.name : null,
        mode: r.mode,
      }));
      io.to('lobby').emit('rooms', list);
    }

    /* ================== CONEXÕES ================== */
    io.on('connection', (socket) => {
      socket.data.roomId = null;

      // 📡 Responde o ping do cliente → ele mede RTT e reporta
      socket.on('ping', (t) => socket.emit('pong', t));

      // 📡 RTT reportado pelo cliente a cada 5s → alimenta o adaptive.
      //    Guarda o RTT no PRÓPRIO PLAYER (não em socket.data), assim
      //    sobrevive a reconexões e não depende do socket estar "vivo".
      socket.on('rtt-report', (rtt) => {
        if (typeof rtt !== 'number' || !isFinite(rtt) || rtt < 0 || rtt > 10000) return;
        const room = rooms[socket.data.roomId];
        if (!room) return;
        const p = room.players[socket.id];
        if (!p) return;
        p.rtt = rtt;
        updateRoomSendRate(room);
      });

      socket.on('join-lobby', () => { socket.join('lobby'); broadcastRooms(); });
      socket.on('leave-lobby', () => socket.leave('lobby'));

      socket.on('create-room', ({ name }) => {
        const id = generateRoomId();
        rooms[id] = new Room(id, socket.id, name);
        socket.data.roomId = id;
        socket.join(id); socket.leave('lobby');
        socket.emit('room-joined', { roomId: id, isHost: true });
        broadcastRooms();

        io.to(id).emit('room-update', {
          p1: rooms[id].getPlayers()[0],
          p2: rooms[id].getPlayers()[1],
        });
      });

      socket.on('join-room', ({ roomId, name }) => {
        const room = rooms[roomId];
        if (!room || room.guestId) return socket.emit('error-msg', 'Sala cheia ou inexistente.');
        room.addPlayer(socket.id, name);
        socket.data.roomId = roomId;
        socket.join(roomId); socket.leave('lobby');
        socket.emit('room-joined', { roomId, isHost: false });
        broadcastRooms();

        io.to(roomId).emit('room-update', {
          p1: room.getPlayers()[0],
          p2: room.getPlayers()[1],
        });
      });

      socket.on('toggle-ready', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.players[socket.id]) {
          room.players[socket.id].ready = !room.players[socket.id].ready;
          io.to(roomId).emit('room-update', {
            p1: room.getPlayers()[0],
            p2: room.getPlayers()[1],
          });
        }
      });

      socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.hostId === socket.id && room.mode === 'waiting') {
          if (room.guestId && room.players[room.guestId].ready) {
            room.startGame();
            io.to(roomId).emit('game-started');
            io.to(roomId).emit('state', {
              mode: room.mode, countdown: room.countdownTimer, puck: room.puck,
              p1: room.getPlayers()[0], p2: room.getPlayers()[1],
            });
          }
        }
      });

      socket.on('move', ({ roomId, x, y }) => {
        const room = rooms[roomId];
        if (room && room.players[socket.id] && room.mode === 'play') {
          room.players[socket.id].tx = Math.max(0, Math.min(W, x));
          room.players[socket.id].ty = Math.max(0, Math.min(H, y));
        }
      });

      socket.on('play-again', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.mode === 'over') {
          room.startGame();
          io.to(roomId).emit('game-started');
          io.to(roomId).emit('state', {
            mode: room.mode, countdown: room.countdownTimer, puck: room.puck,
            p1: room.getPlayers()[0], p2: room.getPlayers()[1],
          });
        }
      });

      socket.on('leave-room', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        socket.to(roomId).emit('room-closed');
        delete rooms[roomId];
        broadcastRooms();
        socket.leave(roomId);
        socket.data.roomId = null;
      });

      socket.on('disconnect', () => {
        for (let id in rooms) {
          const room = rooms[id];
          if (room.hostId === socket.id || room.guestId === socket.id) {
            io.to(id).emit('room-closed');
            delete rooms[id];
            broadcastRooms();
          }
        }
      });
    });
  },
};