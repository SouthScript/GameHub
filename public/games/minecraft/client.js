// public/games/minecraft/client.js
// Three.js + Socket.IO — Minecraft clone otimizado
// ✅ FIX: fórmula de movimento local→mundo corrigida
// ✅ FIX: RemotePlayer Y position (pés no chão)
// ✅ FIX: highlight no mobile
// ✅ Mobile: joystick + look + botões

import * as THREE from 'three';

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════
const WORLD_SIZE         = 32;
const PLAYER_HEIGHT      = 1.8;
const PLAYER_HALF_W      = 0.3;
const PLAYER_EYE         = 1.6;
const GRAVITY            = -25;
const JUMP_VELOCITY      = 8.5;
const MOVE_SPEED         = 5.5;
const MAX_REACH          = 6;
const INTERP_DELAY_MS    = 100;
const STATE_SEND_HZ      = 20;
const MAX_DT             = 0.1;

const isTouch = matchMedia('(pointer: coarse)').matches
             || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);

const BLOCK_COLORS = { 1: 0x4ade80, 2: 0x8b5a3c, 3: 0x9ca3af, 4: 0x6b4423 };

// ════════════════════════════════════════════
// OBJECT POOLING
// ════════════════════════════════════════════
const _v3     = new THREE.Vector3();
const _v3b    = new THREE.Vector3();
const _mat4   = new THREE.Matrix4();
const _rayDir = new THREE.Vector3();

// ════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════
const state = {
  world: null,
  worldSize: WORLD_SIZE,
  blockMeshes: {},
  connected: false,
  inGame: false,
  selfId: null,
  roomId: null,
  playerName: 'Jogador',
  shirtColor: '#22d3ee',
  player: {
    x: 16, y: 24, z: 16, vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0, onGround: false,
  },
  rtt: 100,
  selectedBlock: 1,
  keys: {},
  locked: false,
};

const $ = (id) => document.getElementById(id);

// ════════════════════════════════════════════
// THREE.JS SETUP
// ════════════════════════════════════════════
const container = $('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 45, 90);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
container.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));

const highlightMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.005, 1.005, 1.005),
  new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.5 })
);
highlightMesh.visible = false;
scene.add(highlightMesh);

const blockGeo = new THREE.BoxGeometry(1, 1, 1);

// ════════════════════════════════════════════
// BLOCK MESH
// ════════════════════════════════════════════
class BlockMesh {
  constructor(type, capacity) {
    this.type = type;
    this.mesh = new THREE.InstancedMesh(
      blockGeo,
      new THREE.MeshLambertMaterial({ color: BLOCK_COLORS[type] || 0xffffff }),
      capacity
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.freeSlots = [];
    this.map = new Map();
    scene.add(this.mesh);
  }
  add(bi, x, y, z) {
    let id = this.freeSlots.pop();
    if (id === undefined) {
      if (this.mesh.count >= this.mesh.instanceMatrix.count) return false;
      id = this.mesh.count++;
    }
    _mat4.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(id, _mat4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.map.set(bi, id);
    return true;
  }
  remove(bi) {
    const id = this.map.get(bi);
    if (id === undefined) return;
    _mat4.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(id, _mat4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.map.delete(bi);
    this.freeSlots.push(id);
  }
  dispose() {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

// ════════════════════════════════════════════
// WORLD
// ════════════════════════════════════════════
function idx(x, y, z) { return x + z * WORLD_SIZE + y * WORLD_SIZE * WORLD_SIZE; }

function rleDecode(compressed, len) {
  const out = new Uint8Array(len);
  let off = 0;
  for (let i = 0; i < compressed.length; i += 2) {
    const c = compressed[i], v = compressed[i + 1];
    for (let j = 0; j < c && off < len; j++) out[off++] = v;
  }
  while (off < len) out[off++] = 0;
  return out;
}

function buildWorld(buf, size) {
  for (const k in state.blockMeshes) state.blockMeshes[k].dispose();
  state.blockMeshes = {};
  state.world = rleDecode(new Uint8Array(buf), size * size * size);
  state.worldSize = size;

  const counts = {};
  for (let i = 0; i < state.world.length; i++) {
    const b = state.world[i];
    if (b) counts[b] = (counts[b] || 0) + 1;
  }
  for (const k in counts) {
    state.blockMeshes[k] = new BlockMesh(parseInt(k, 10), counts[k] + 500);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const b = state.world[idx(x, y, z)];
        if (b) state.blockMeshes[b].add(idx(x, y, z), x + 0.5, y + 0.5, z + 0.5);
      }
    }
  }
}

function isSolid(x, y, z) {
  if (!state.world) return false;
  if (x < 0 || x >= state.worldSize) return false;
  if (y < 0 || y >= state.worldSize) return false;
  if (z < 0 || z >= state.worldSize) return false;
  return state.world[idx(x, y, z)] !== 0;
}

function collides(px, py, pz) {
  const minX = Math.floor(px - PLAYER_HALF_W);
  const maxX = Math.floor(px + PLAYER_HALF_W);
  const minY = Math.floor(py);
  const maxY = Math.floor(py + PLAYER_HEIGHT - 0.001);
  const minZ = Math.floor(pz - PLAYER_HALF_W);
  const maxZ = Math.floor(pz + PLAYER_HALF_W);
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++)
        if (isSolid(x, y, z)) return true;
  return false;
}

function blockIntersectsPlayer(bx, by, bz) {
  const p = state.player;
  return !(
    p.x + PLAYER_HALF_W <= bx || p.x - PLAYER_HALF_W >= bx + 1 ||
    p.y + PLAYER_HEIGHT  <= by || p.y                    >= by + 1 ||
    p.z + PLAYER_HALF_W <= bz || p.z - PLAYER_HALF_W >= bz + 1
  );
}

// ════════════════════════════════════════════
// VOXEL RAYCAST (DDA)
// ════════════════════════════════════════════
const _hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, hit: false };
function raycastVoxel(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
  const tdx = sx !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tdz = sz !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tmx = sx > 0 ? (x + 1 - origin.x) / dir.x : sx < 0 ? (origin.x - x) / -dir.x : Infinity;
  let tmy = sy > 0 ? (y + 1 - origin.y) / dir.y : sy < 0 ? (origin.y - y) / -dir.y : Infinity;
  let tmz = sz > 0 ? (z + 1 - origin.z) / dir.z : sz < 0 ? (origin.z - z) / -dir.z : Infinity;
  let nx = 0, ny = 0, nz = 0, t = 0;
  while (t < maxDist) {
    if (isSolid(x, y, z)) {
      _hit.x = x; _hit.y = y; _hit.z = z;
      _hit.nx = nx; _hit.ny = ny; _hit.nz = nz;
      _hit.hit = true;
      return _hit;
    }
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz)          { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else                          { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
  }
  _hit.hit = false;
  return _hit;
}

// ════════════════════════════════════════════
// CHARACTER MODEL
// ════════════════════════════════════════════
const charGeo = {
  head: new THREE.BoxGeometry(0.5, 0.5, 0.5),
  body: new THREE.BoxGeometry(0.5, 0.7, 0.3),
  legs: new THREE.BoxGeometry(0.5, 0.6, 0.3),
};
const skinMat  = new THREE.MeshLambertMaterial({ color: 0xf0c090 });
const pantsMat = new THREE.MeshLambertMaterial({ color: 0x2c3e50 });

class RemotePlayer {
  constructor(id, name, shirtColor) {
    this.id = id;
    this.name = name;
    this.buffer = [];

    this.shirtMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(shirtColor || '#22d3ee') });

    const head = new THREE.Mesh(charGeo.head, skinMat);
    head.position.y = 1.55;
    const body = new THREE.Mesh(charGeo.body, this.shirtMat);
    body.position.y = 0.95;
    const legs = new THREE.Mesh(charGeo.legs, pantsMat);
    legs.position.y = 0.3;

    this.group = new THREE.Group();
    this.group.add(head, body, legs);
    this.group.position.set(0, -1000, 0);
    scene.add(this.group);

    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    this.nameTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    this.nameTag.scale.set(2, 0.5, 1);
    this.nameTag.position.y = 2.1;
    this.group.add(this.nameTag);
  }

  addSnapshot(s) {
    this.buffer.push({ t: performance.now(), x: s.x, y: s.y, z: s.z, yaw: s.yaw || 0 });
    const cutoff = performance.now() - 1000;
    while (this.buffer.length > 2 && this.buffer[0].t < cutoff) this.buffer.shift();
  }

  update(now) {
    if (this.buffer.length === 0) return;
    const rt = now - INTERP_DELAY_MS;
    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].t <= rt && this.buffer[i + 1].t >= rt) {
        a = this.buffer[i]; b = this.buffer[i + 1]; break;
      }
    }
    let t = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 0;
    t = Math.max(0, Math.min(1, t));
    _v3.set(a.x, a.y, a.z);
    _v3b.set(b.x, b.y, b.z);
    _v3.lerp(_v3b, t);

    this.group.position.set(_v3.x, _v3.y, _v3.z);

    let dy = b.yaw - a.yaw;
    while (dy > Math.PI)  dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y = a.yaw + dy * t;
  }

  dispose() {
    scene.remove(this.group);
    this.shirtMat.dispose();
    this.nameTag.material.map.dispose();
    this.nameTag.material.dispose();
  }
}

const remotePlayers = new Map();

// ════════════════════════════════════════════
// SOCKET
// ════════════════════════════════════════════
const socket = io('/minecraft', { reconnection: true, reconnectionDelay: 1000 });
const toastEl = $('toast');

let toastTimer;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

socket.on('connect', () => {
  state.connected = true;
  socket.emit('list-rooms');
  startPing();
});
socket.on('disconnect', () => { state.connected = false; });
socket.on('rooms', renderRoomList);
socket.on('error-msg', (msg) => showToast(msg, true));

socket.on('world', ({ size, data, spawn }) => {
  buildWorld(data, size);

  const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
  let gy = spawn.y;
  while (gy > 0 && !isSolid(sx, Math.floor(gy) - 1, sz)) gy--;
  gy = Math.max(1, Math.floor(gy));

  state.player.x = spawn.x + 0.5;
  state.player.y = gy;
  state.player.z = spawn.z + 0.5;
  state.player.vx = state.player.vy = state.player.vz = 0;
  state.player.yaw = 0;
  state.player.pitch = 0;

  $('lobby').style.display = 'none';
  $('hud').style.display = 'block';
  state.inGame = true;

  if (isTouch) {
    $('mobile-controls').style.display = 'block';
    $('help').textContent = 'Joystick mover · Arraste olhar · Botões quebrar/colocar/pular';
  } else {
    showToast('Clique na tela para começar');
  }
});

socket.on('room-joined', ({ roomId, roomName, selfColor }) => {
  state.roomId = roomId;
  if (selfColor) state.shirtColor = selfColor;
  showToast(`Conectado em "${roomName}"`);
});

socket.on('existing-players', (players) => {
  for (const p of players) {
    if (p.id === state.selfId) continue;
    const rp = new RemotePlayer(p.id, p.name, p.shirtColor);
    rp.addSnapshot(p);
    remotePlayers.set(p.id, rp);
  }
});

socket.on('player-joined', (p) => {
  if (p.id === state.selfId) return;
  const rp = new RemotePlayer(p.id, p.name, p.shirtColor);
  rp.addSnapshot(p);
  remotePlayers.set(p.id, rp);
  showToast(`${p.name} entrou`);
});

socket.on('player-left', (id) => {
  const rp = remotePlayers.get(id);
  if (rp) { showToast(`${rp.name} saiu`); rp.dispose(); remotePlayers.delete(id); }
});

socket.on('snapshot', (players) => {
  for (const p of players) {
    if (p.id === state.selfId) continue;
    const rp = remotePlayers.get(p.id);
    if (rp) rp.addSnapshot(p);
  }
});

socket.on('block-change', ({ x, y, z, block }) => applyBlockChange(x, y, z, block));

// ════════════════════════════════════════════
// APPLY BLOCK
// ════════════════════════════════════════════
function applyBlockChange(x, y, z, newBlock) {
  if (!state.world) return;
  const i = idx(x, y, z);
  const old = state.world[i];
  if (old === newBlock) return;
  if (old !== 0 && state.blockMeshes[old]) state.blockMeshes[old].remove(i);
  state.world[i] = newBlock;
  if (newBlock !== 0) {
    if (!state.blockMeshes[newBlock]) {
      state.blockMeshes[newBlock] = new BlockMesh(newBlock, 1000);
    }
    state.blockMeshes[newBlock].add(i, x + 0.5, y + 0.5, z + 0.5);
  }
}

// ════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════
function tryBreak() {
  if (!state.inGame || !state.world) return;
  camera.getWorldDirection(_rayDir);
  const t = raycastVoxel(camera.position, _rayDir, MAX_REACH);
  if (!t.hit || t.y === 0) return;
  socket.emit('block-change', { x: t.x, y: t.y, z: t.z, block: 0 });
  applyBlockChange(t.x, t.y, t.z, 0);
}

function tryPlace() {
  if (!state.inGame || !state.world) return;
  camera.getWorldDirection(_rayDir);
  const t = raycastVoxel(camera.position, _rayDir, MAX_REACH);
  if (!t.hit) return;
  const px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
  if (px < 0 || px >= state.worldSize) return;
  if (py < 0 || py >= state.worldSize) return;
  if (pz < 0 || pz >= state.worldSize) return;
  if (isSolid(px, py, pz)) return;
  if (blockIntersectsPlayer(px, py, pz)) return;
  socket.emit('block-change', { x: px, y: py, z: pz, block: state.selectedBlock });
  applyBlockChange(px, py, pz, state.selectedBlock);
}

// ════════════════════════════════════════════
// INPUT — DESKTOP
// ════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  state.keys[e.code] = true;
  if (e.code === 'Digit1') setSelectedBlock(1);
  if (e.code === 'Digit2') setSelectedBlock(2);
  if (e.code === 'Digit3') setSelectedBlock(3);
  if (e.code === 'Digit4') setSelectedBlock(4);
  if (e.code === 'Space' && state.inGame) e.preventDefault();
});
document.addEventListener('keyup', (e) => { state.keys[e.code] = false; });

document.addEventListener('pointerlockchange', () => {
  state.locked = document.pointerLockElement === renderer.domElement;
  if (!state.locked && state.inGame && !isTouch) showToast('Clique na tela para retomar');
});

renderer.domElement.addEventListener('click', () => {
  if (!isTouch && state.inGame && !state.locked) {
    renderer.domElement.requestPointerLock();
  }
});

document.addEventListener('mousemove', (e) => {
  if (!state.locked) return;
  state.player.yaw   -= e.movementX * 0.002;
  state.player.pitch -= e.movementY * 0.002;
  const lim = Math.PI / 2 - 0.01;
  state.player.pitch = Math.max(-lim, Math.min(lim, state.player.pitch));
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (isTouch) return;
  if (!state.locked || !state.inGame) return;
  if (e.button === 0) tryBreak();
  else if (e.button === 2) tryPlace();
});

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ════════════════════════════════════════════
// INPUT — MOBILE
// ════════════════════════════════════════════
class TouchControls {
  constructor() {
    this.joystickEl = $('joystick');
    this.knobEl     = $('joystick-knob');
    this.jTouchId   = null;
    this.lookId     = null;
    this.lastLX = 0; this.lastLY = 0;
    this.startLX = 0; this.startLY = 0;
    this.startT = 0;
    this.tapCooldown = 0;

    this.bindJoystick();
    this.bindCanvas();
    this.bindButtons();
  }

  bindJoystick() {
    const el = this.joystickEl;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this.jTouchId !== null) return;
      const t = e.changedTouches[0];
      this.jTouchId = t.identifier;
      this.updateJoy(t);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.jTouchId) this.updateJoy(t);
      }
    }, { passive: false });

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.jTouchId) {
          this.jTouchId = null;
          this.resetJoy();
        }
      }
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  updateJoy(t) {
    const rect = this.joystickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = rect.width / 2 - 6;
    let dx = t.clientX - cx;
    let dy = t.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > maxR) { dx = dx / d * maxR; dy = dy / d * maxR; }
    this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    const nx = dx / maxR, ny = dy / maxR;
    const dead = 0.2;
    state.keys['KeyW'] = ny < -dead;
    state.keys['KeyS'] = ny >  dead;
    state.keys['KeyA'] = nx < -dead;
    state.keys['KeyD'] = nx >  dead;
  }

  resetJoy() {
    this.knobEl.style.transform = 'translate(-50%, -50%)';
    state.keys['KeyW'] = state.keys['KeyS'] = state.keys['KeyA'] = state.keys['KeyD'] = false;
  }

  bindCanvas() {
    const canvas = renderer.domElement;

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.target !== canvas) return;
      if (this.lookId !== null) return;
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lastLX = this.startLX = t.clientX;
      this.lastLY = this.startLY = t.clientY;
      this.startT = performance.now();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        const dx = t.clientX - this.lastLX;
        const dy = t.clientY - this.lastLY;
        this.lastLX = t.clientX;
        this.lastLY = t.clientY;
        state.player.yaw   -= dx * 0.005;
        state.player.pitch -= dy * 0.005;
        const lim = Math.PI / 2 - 0.01;
        state.player.pitch = Math.max(-lim, Math.min(lim, state.player.pitch));
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        const dx = t.clientX - this.startLX;
        const dy = t.clientY - this.startLY;
        const dist = Math.hypot(dx, dy);
        const dt = performance.now() - this.startT;
        if (dist < 12 && dt < 250 && performance.now() > this.tapCooldown) {
          this.tapCooldown = performance.now() + 200;
          tryBreak();
        }
        this.lookId = null;
      }
    });
    canvas.addEventListener('touchcancel', () => { this.lookId = null; });
  }

  bindButtons() {
    const bindPress = (id, onDown, onUp) => {
      const el = $(id);
      let active = false;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (active) return;
        active = true;
        el.style.transform = 'scale(0.9)';
        onDown();
      }, { passive: false });
      el.addEventListener('touchend', (e) => {
        e.preventDefault();
        active = false;
        el.style.transform = '';
        onUp?.();
      }, { passive: false });
      el.addEventListener('touchcancel', () => {
        active = false;
        el.style.transform = '';
        onUp?.();
      });
    };

    bindPress('btn-jump',  () => { state.keys['Space'] = true; }, () => { state.keys['Space'] = false; });
    bindPress('btn-place', () => tryPlace());
    bindPress('btn-break', () => tryBreak());
  }
}

if (isTouch) new TouchControls();

// ════════════════════════════════════════════
// HOTBAR
// ════════════════════════════════════════════
function setSelectedBlock(b) {
  state.selectedBlock = b;
  document.querySelectorAll('.slot').forEach((el) => {
    el.classList.toggle('active', parseInt(el.dataset.block, 10) === b);
  });
}
document.querySelectorAll('.slot').forEach((el) => {
  el.addEventListener('click', () => setSelectedBlock(parseInt(el.dataset.block, 10)));
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    setSelectedBlock(parseInt(el.dataset.block, 10));
  }, { passive: false });
});
setSelectedBlock(1);

// ════════════════════════════════════════════
// LOBBY — color picker
// ════════════════════════════════════════════
const nameInput = $('player-name');
nameInput.value = 'Jogador' + Math.floor(Math.random() * 900 + 100);

document.querySelectorAll('.color-swatch').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('active'));
    el.classList.add('active');
    state.shirtColor = el.dataset.color;
  });
});

// ════════════════════════════════════════════
// LOBBY — create/join
// ════════════════════════════════════════════
const createBtn = $('create-btn');
createBtn.addEventListener('click', () => {
  if (!state.connected) return showToast('Sem conexão com o servidor', true);
  if (createBtn.disabled) return;
  createBtn.disabled = true;
  const name = nameInput.value.trim() || 'Jogador';
  state.playerName = name;
  socket.emit('create-room', {
    name: `${name}'s World`,
    playerName: name,
    shirtColor: state.shirtColor,
  });
  setTimeout(() => { createBtn.disabled = false; }, 2000);
});

const refreshBtn = $('refresh-btn');
refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spinning');
  socket.emit('list-rooms');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
});

function renderRoomList(rooms) {
  const list = $('room-list');
  if (!rooms || rooms.length === 0) {
    list.innerHTML = '<div class="empty">Nenhuma sala — crie a primeira!</div>';
    return;
  }
  list.innerHTML = rooms.map((r) => {
    const full = r.players >= r.maxPlayers;
    return `
      <div class="room-item" data-id="${r.id}" data-full="${full}">
        <div>
          <div class="room-name">${escapeHTML(r.name)}</div>
          <div class="room-meta">${r.players}/${r.maxPlayers} jogadores</div>
        </div>
        <div class="room-players ${full ? 'full' : ''}">${full ? 'CHEIA' : 'ENTRAR'}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.room-item').forEach((el) => {
    const handler = () => {
      if (el.dataset.full === 'true') return showToast('Sala cheia', true);
      const name = nameInput.value.trim() || 'Jogador';
      state.playerName = name;
      socket.emit('join-room', {
        roomId: el.dataset.id,
        playerName: name,
        shirtColor: state.shirtColor,
      });
    };
    el.addEventListener('click', handler);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); handler(); }, { passive: false });
  });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

// ════════════════════════════════════════════
// PING
// ════════════════════════════════════════════
let _pingTimer;
function startPing() {
  clearInterval(_pingTimer);
  const fire = () => state.connected && socket.emit('ping-time', performance.now());
  fire();
  _pingTimer = setInterval(fire, 2000);
}
socket.on('pong-time', (t) => {
  state.rtt = performance.now() - t;
  if (state.inGame) socket.emit('update-rtt', Math.round(state.rtt));
});

// ════════════════════════════════════════════
// PLAYER UPDATE — ✅ FÓRMULA CORRIGIDA
// ════════════════════════════════════════════
// CONVENÇÃO THREE.JS (right-handed, +Y up):
//   forward = (-sin(yaw), 0, -cos(yaw))
//   right   = ( cos(yaw), 0, -sin(yaw))
//
// INPUT LOCAL → MUNDO:
//   vx =  mx * cosY + mz * sinY
//   vz = -mx * sinY + mz * cosY
let _lastSend = 0;

function updatePlayer(dt) {
  const p = state.player;

  // 1) Input local
  let mx = 0, mz = 0;
  if (state.keys['KeyW']) mz -= 1;
  if (state.keys['KeyS']) mz += 1;
  if (state.keys['KeyA']) mx -= 1;
  if (state.keys['KeyD']) mx += 1;

  // 2) Normaliza diagonal
  const len = Math.hypot(mx, mz);
  if (len > 0) { mx /= len; mz /= len; }

  // 3) Converte local → mundo (✅ CORRETO)
  const cosY = Math.cos(p.yaw);
  const sinY = Math.sin(p.yaw);
  p.vx = ( mx * cosY + mz * sinY) * MOVE_SPEED;
  p.vz = (-mx * sinY + mz * cosY) * MOVE_SPEED;

  // 4) Pulo
  if (state.keys['Space'] && p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
  }

  // 5) Gravidade
  p.vy += GRAVITY * dt;
  if (p.vy < -30) p.vy = -30;

  // 6) Colisão por eixo
  const ny = p.y + p.vy * dt;
  if (!collides(p.x, ny, p.z)) {
    p.y = ny;
    p.onGround = false;
  } else {
    if (p.vy < 0) p.onGround = true;
    p.vy = 0;
  }

  const nx = p.x + p.vx * dt;
  if (!collides(nx, p.y, p.z)) p.x = nx;
  else p.vx = 0;

  const nz = p.z + p.vz * dt;
  if (!collides(p.x, p.y, nz)) p.z = nz;
  else p.vz = 0;

  // 7) Failsafe
  if (p.y < -10) {
    p.x = state.worldSize / 2;
    p.y = state.worldSize + 2;
    p.z = state.worldSize / 2;
    p.vy = 0;
  }

  // 8) Câmera
  camera.position.set(p.x, p.y + PLAYER_EYE, p.z);
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch;

  // 9) Envia estado
  const now = performance.now();
  if (now - _lastSend >= 1000 / STATE_SEND_HZ) {
    _lastSend = now;
    socket.emit('player-state', {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    });
  }
}

// ════════════════════════════════════════════
// GAME LOOP
// ════════════════════════════════════════════
let _last = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  let dt = (now - _last) / 1000;
  _last = now;
  if (dt > MAX_DT) dt = MAX_DT;

  if (state.inGame) {
    updatePlayer(dt);
    for (const rp of remotePlayers.values()) rp.update(now);

    const canLook = state.locked || isTouch;
    if (state.world && canLook) {
      camera.getWorldDirection(_rayDir);
      const t = raycastVoxel(camera.position, _rayDir, MAX_REACH);
      if (t.hit) {
        highlightMesh.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
        highlightMesh.visible = true;
      } else highlightMesh.visible = false;
    } else highlightMesh.visible = false;
  }

  renderer.render(scene, camera);
}
animate();

// ════════════════════════════════════════════
// RESIZE
// ════════════════════════════════════════════
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
});