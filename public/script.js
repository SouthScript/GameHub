/* ============================================================
   GameHub — Hub script (POO)
   Classes: Toast · AnimatedCounter · PingMonitor · StatsPanel
            RoomsTracker · HubShortcuts · MultiNamespaceClient · Hub
   - Integra namespace default (Shooter/AirHockey) + /minecraft
   - Zero dependências externas
   - Preserva 100% do comportamento original
   ============================================================ */

'use strict';

const $ = (id) => document.getElementById(id);

// ---------- Toast ----------
class Toast {
  constructor({ duration = 3800 } = {}) {
    this.duration = duration;
    this.timer = null;
    this.el = null;
  }
  ensureEl() {
    if (this.el && this.el.isConnected) return this.el;
    let el = $('hub-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hub-toast';
      el.className = 'hub-toast';
      document.body.appendChild(el);
    }
    this.el = el;
    return el;
  }
  show(msg) {
    const el = this.ensureEl();
    el.textContent = msg;
    void el.offsetWidth; // força reflow para reiniciar a transição
    el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => el.classList.remove('show'), this.duration);
  }
}

// ---------- AnimatedCounter ----------
class AnimatedCounter {
  constructor(el, { duration = 380 } = {}) {
    this.el = el;
    this.duration = duration;
    this.value = 0;
    this.rafId = null;
  }
  set(target, color) {
    if (!this.el) return;
    target = Number(target) || 0;
    if (this.value === target) {
      if (color) this.el.style.color = color;
      return;
    }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    const from = this.value;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / this.duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.el.textContent = Math.round(from + (target - from) * eased);
      if (t < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.el.textContent = target;
        this.value = target;
        this.rafId = null;
      }
    };
    this.rafId = requestAnimationFrame(step);
    if (color) this.el.style.color = color;
  }
  setInstant(target) {
    if (!this.el) return;
    this.value = Number(target) || 0;
    this.el.textContent = this.value;
  }
}

// ---------- Ping colors ----------
const PingColor = {
  of(ms) {
    if (ms < 80) return '#34d399';
    if (ms < 180) return '#fbbf24';
    return '#f87171';
  },
  label(ms) {
    if (ms < 80) return 'ótimo';
    if (ms < 180) return 'ok';
    if (ms < 400) return 'ruim';
    return 'horrível';
  },
};

// ---------- StatsPanel ----------
class StatsPanel {
  constructor() {
    this.root = $('live-stats');
    this.players = new AnimatedCounter($('stat-players'));
    this.rooms = new AnimatedCounter($('stat-rooms'));
    this.pingEl = $('stat-ping');
    this.firstUpdate = true;
  }
  update({ players, rooms }) {
    if (this.firstUpdate) {
      this.players.setInstant(players);
      this.rooms.setInstant(rooms);
      this.firstUpdate = false;
    } else {
      this.players.set(players, players > 0 ? '#34d399' : null);
      this.rooms.set(rooms, rooms > 0 ? '#22d3ee' : null);
    }
    this.root?.classList.remove('offline');
    this.root?.classList.add('loaded');
  }
  updatePing(ms) {
    if (!this.pingEl) return;
    this.pingEl.textContent = ms;
    this.pingEl.style.color = PingColor.of(ms);
    this.pingEl.title = `Latência: ${PingColor.label(ms)}`;
  }
  setOffline() {
    this.root?.classList.add('offline');
    if (this.pingEl) this.pingEl.textContent = '—';
  }
}

// ---------- PingMonitor ----------
class PingMonitor {
  constructor(socket, { pingEvent, pongEvent, intervalMs = 3000 } = {}) {
    this.socket = socket;
    this.pingEvent = pingEvent;
    this.pongEvent = pongEvent;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.handlers = [];
    socket.on(pongEvent, (t) => {
      const ms = Date.now() - t;
      this.handlers.forEach((cb) => cb(ms));
    });
  }
  onPing(cb) { this.handlers.push(cb); }
  start() {
    this.stop();
    this.fire();
    this.timer = setInterval(() => this.fire(), this.intervalMs);
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  fire() {
    if (this.socket.connected) this.socket.emit(this.pingEvent, Date.now());
  }
}

// ---------- RoomsTracker ----------
class RoomsTracker {
  constructor(source, { onNewRoom } = {}) {
    this.source = source;
    this.onNewRoom = onNewRoom;
    this.prevIds = new Set();
    this.ready = false;
  }
  process(list) {
    if (!this.ready) {
      this.prevIds = new Set(list.map((r) => r.id));
      this.ready = true;
      return;
    }
    for (const r of list) {
      if (!this.prevIds.has(r.id)) {
        this.onNewRoom?.(r, this.source);
        break;
      }
    }
    this.prevIds = new Set(list.map((r) => r.id));
  }
}

// ---------- HubShortcuts ----------
class HubShortcuts {
  constructor({ scrollBtnId = 'scroll-games', scrollTargetId = 'games', enterSelector = 'a.game-card.featured' } = {}) {
    $(scrollBtnId)?.addEventListener('click', () => {
      $(scrollTargetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.target.closest('input, textarea, select')) {
        document.querySelector(enterSelector)?.click();
      }
    });
  }
}

// ---------- MultiNamespaceClient ----------
class MultiNamespaceClient {
  constructor(namespaces) {
    this.namespaces = namespaces;
    this.sockets = new Map();
    this.perNs = new Map();
    this.connectedCount = 0;
    this.onAggregate = null;
    this.onAllOffline = null;
    this.onPing = null;
    this.onNewRoom = null;
  }
  connect() {
    for (const ns of this.namespaces) {
      const socket = ns.path
        ? io(ns.path, { reconnection: true, reconnectionDelay: 1000 })
        : io({ reconnection: true, reconnectionDelay: 1000 });

      this.sockets.set(ns.name, socket);
      this.perNs.set(ns.name, { players: 0, rooms: 0 });

      // Ping
      if (ns.pingEvent) {
        const monitor = new PingMonitor(socket, {
          pingEvent: ns.pingEvent,
          pongEvent: ns.pongEvent,
          intervalMs: 3000,
        });
        monitor.onPing((ms) => this.onPing?.(ms));
        socket.on('connect', () => monitor.start());
        socket.on('disconnect', () => monitor.stop());
      }

      // Rooms
      const tracker = new RoomsTracker(ns.name, {
        onNewRoom: (r, s) => this.onNewRoom?.(r, s),
      });

      socket.on('connect', () => {
        this.connectedCount++;
        socket.emit('list-rooms');
      });
      socket.on('disconnect', () => {
        this.connectedCount = Math.max(0, this.connectedCount - 1);
        if (this.connectedCount === 0) this.onAllOffline?.();
      });
      socket.on('rooms', (list) => {
        const stats = this.perNs.get(ns.name) || { players: 0, rooms: 0 };
        stats.players = list.reduce((s, r) => s + (r.players || 0), 0);
        stats.rooms = list.length;
        this.perNs.set(ns.name, stats);
        this.recompute();
        tracker.process(list);
      });
    }
  }
  recompute() {
    let players = 0, rooms = 0;
    for (const s of this.perNs.values()) {
      players += s.players;
      rooms += s.rooms;
    }
    this.onAggregate?.({ players, rooms });
  }
}

// ---------- Hub (orquestrador) ----------
class Hub {
  constructor() {
    this.toast = new Toast();
    this.stats = new StatsPanel();
    this.shortcuts = new HubShortcuts();

    this.multi = new MultiNamespaceClient([
      { name: 'default',   path: null,         pingEvent: 'ping',      pongEvent: 'pong' },
      { name: 'minecraft', path: '/minecraft', pingEvent: 'ping-time', pongEvent: 'pong-time' },
    ]);

    this.multi.onAggregate   = (agg) => this.stats.update(agg);
    this.multi.onAllOffline  = ()    => this.stats.setOffline();
    this.multi.onPing        = (ms)  => this.stats.updatePing(ms);
    this.multi.onNewRoom     = (r, s)=> this.showNewRoomToast(r, s);
  }
  start() {
    this.multi.connect();
  }
  showNewRoomToast(room, source) {
    const icons = { default: '🎮', minecraft: '⛏️' };
    const icon = icons[source] || '🎮';
    const mode = room.mode === 'score' ? ' · 10 Kills'
               : room.mode === 'time'  ? ' · 2 Min'
               : room.mode === 'lms'   ? ' · Sobrevivência'
               : '';
    this.toast.show(`${icon} "${room.name}" criada${mode}`);
  }
}

// ---------- Bootstrap ----------
(() => {
  const init = () => new Hub().start();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();