// server.js (na raiz do projeto)
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// 🧠 Importa os cérebros dos jogos
const shooterGame = require('./games/shooter/server');
const airHockeyGame = require('./games/air-hockey/server');
const minecraftGame = require('./games/minecraft/server');   // 🆕

const app = express();
const server = http.createServer(app);

// Libera o CSP
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src * 'unsafe-inline' ws: wss:; img-src * data: blob:; style-src * 'unsafe-inline';"
  );
  next();
});

// Libera a pasta public
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 25000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6, // 1MB — chunks binários comprimidos cabem fácil
});

// 🟢 INICIA OS JOGOS
shooterGame.initialize(io);
airHockeyGame.initialize(io);
minecraftGame.initialize(io);                                  // 🆕

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=================================`);
  console.log(`🎮 HUB:          http://localhost:${PORT}`);
  console.log(`🔫 Shooter:      http://localhost:${PORT}/games/shooter/`);
  console.log(`🏒 Air Hockey:   http://localhost:${PORT}/games/air-hockey/`);
  console.log(`⛏️  Minecraft:    http://localhost:${PORT}/games/minecraft/`);   // 🆕
  console.log(`=================================\n`);
});