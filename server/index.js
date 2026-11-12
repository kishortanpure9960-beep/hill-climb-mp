import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createTrack, randomSeed } from '../shared/track.js';
import { createCar, stepCar, respawnCar } from '../shared/physics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 4;
const RACE_LENGTH = 900;
const COUNTDOWN_MS = 3600;
const SNAPSHOT_EVERY = 3; // ticks -> 20 Hz
const TICK_MS = 1000 / 60;

const COLORS = ['#ff5c5c', '#4da6ff', '#ffd23f', '#5ce08a'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* static file server                                                  */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    const isShared = pathname.startsWith('/shared/');
    const base = isShared ? SHARED_DIR : PUBLIC_DIR;
    const rel = isShared ? pathname.slice('/shared/'.length) : pathname.slice(1);
    const file = path.resolve(base, rel);

    if (!file.startsWith(base + path.sep) && file !== base) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

/* ------------------------------------------------------------------ */
/* rooms                                                               */
/* ------------------------------------------------------------------ */

let nextPlayerId = 1;
const rooms = new Map();

const now = () => Date.now();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const cleanName = (name) =>
  String(name || '')
    .replace(/[^\w \-.]/g, '')
    .trim()
    .slice(0, 14) || 'Racer';

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    phase: 'lobby', // lobby | countdown | racing | finished
    seed: randomSeed(),
    track: null,
    countdownEnd: 0,
    raceStart: 0,
    raceEnd: 0,
    firstFinishAt: 0,
    tick: 0,
    results: null,
    hostId: null,
    lastActivity: now(),
  };
  rooms.set(code, room);
  return room;
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    host: p.id === room.hostId,
    finished: p.finished,
    time: p.finishTime,
  }));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const raw = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(raw);
  }
}

function lobbyState(room) {
  return {
    t: 'lobby',
    room: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: playerList(room),
    trackLength: RACE_LENGTH,
  };
}

function startCountdown(room, seed = randomSeed()) {
  room.seed = seed;
  room.track = createTrack(seed, RACE_LENGTH);
  room.phase = 'countdown';
  room.countdownEnd = now() + COUNTDOWN_MS;
  room.raceStart = 0;
  room.raceEnd = 0;
  room.results = null;
  room.finishOrder = [];
  room.firstFinishAt = 0;

  let index = 0;
  for (const p of room.players.values()) {
    const x = room.track.startX + index * 1.6;
    p.car = createCar(room.track, x);
    p.input = { throttle: 0 };
    p.finished = false;
    p.finishTime = 0;
    p.place = 0;
    index++;
  }

  broadcast(room, {
    t: 'countdown',
    seed,
    trackLength: RACE_LENGTH,
    startIn: COUNTDOWN_MS,
    cars: [...room.players.values()].map((p) => ({ id: p.id, x: p.car.x })),
  });
  broadcast(room, lobbyState(room));
}

function finishRace(room) {
  room.phase = 'finished';
  room.raceEnd = now();
  const list = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    time: p.finished ? p.finishTime : null,
    distance: p.car ? Math.min(p.car.x, RACE_LENGTH) : 0,
    place: p.place || 0,
  }));
  list.sort((a, b) => {
    if (a.time != null && b.time != null) return a.time - b.time;
    if (a.time != null) return -1;
    if (b.time != null) return 1;
    return b.distance - a.distance;
  });
  list.forEach((entry, i) => (entry.place = i + 1));
  room.results = list;
  broadcast(room, { t: 'results', results: list });
  broadcast(room, lobbyState(room));
}

function stepRoom(room, dt) {
  if (room.phase === 'countdown' && now() >= room.countdownEnd) {
    room.phase = 'racing';
    room.raceStart = now();
    broadcast(room, { t: 'go', at: room.raceStart });
  }

  if (room.phase !== 'racing') return;

  room.tick++;
  const elapsed = (now() - room.raceStart) / 1000;

  for (const p of room.players.values()) {
    if (!p.car) continue;
    if (p.finished) {
      // let finished cars coast to a stop out of the way
      stepCar(p.car, { throttle: -0.4 }, room.track, dt);
      continue;
    }
    stepCar(p.car, p.input, room.track, dt);
    if (p.car.x >= room.track.finishX) {
      p.finished = true;
      p.finishTime = Math.round(elapsed * 100) / 100;
      p.place = room.finishOrder.length + 1;
      room.finishOrder.push(p.id);
      broadcast(room, { t: 'finished', id: p.id, time: p.finishTime, place: p.place });
    }
  }

  if (room.tick % SNAPSHOT_EVERY === 0) {
    const cars = [];
    for (const p of room.players.values()) {
      const c = p.car;
      if (!c) continue;
      cars.push([
        p.id,
        Math.round(c.x * 100) / 100,
        Math.round(c.y * 100) / 100,
        Math.round(c.angle * 1000) / 1000,
        Math.round(c.wheelRot * 100) / 100,
        Math.round(c.speed * 100) / 100,
        c.grounded ? 1 : 0,
      ]);
    }
    broadcast(room, { t: 'snap', time: Math.round(elapsed * 100) / 100, cars });
  }

  const allFinished = [...room.players.values()].every((p) => p.finished);
  if (allFinished) {
    finishRace(room);
    return;
  }
  // give stragglers 25s after the winner crosses the line
  if (room.finishOrder.length > 0 && !room.firstFinishAt) {
    room.firstFinishAt = now();
  }
  if (room.firstFinishAt && now() - room.firstFinishAt > 25_000) {
    finishRace(room);
    return;
  }
  // hard cap so a stuck lobby still ends
  if (elapsed > 180) finishRace(room);
}

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  let player = null;
  let room = null;

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (player) return;
      const requested = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      room = requested ? rooms.get(requested) || createRoom(requested) : createRoom(makeRoomCode());

      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: 'error', message: 'That room is full (4 players max).' });
        return;
      }
      if (room.phase === 'racing' || room.phase === 'countdown') {
        send(ws, { t: 'error', message: 'That race already started. Try again in a moment.' });
        return;
      }

      player = {
        id: nextPlayerId++,
        name: cleanName(msg.name),
        color: COLORS[room.players.size % COLORS.length],
        ws,
        input: { throttle: 0 },
        car: null,
        finished: false,
        finishTime: 0,
        place: 0,
        connectedAt: now(),
      };
      room.players.set(player.id, player);
      room.lastActivity = now();
      if (!room.hostId) room.hostId = player.id;

      send(ws, {
        t: 'welcome',
        you: player.id,
        room: room.code,
        phase: room.phase,
        hostId: room.hostId,
        players: playerList(room),
        trackLength: RACE_LENGTH,
        seed: room.seed,
      });
      broadcast(room, lobbyState(room));
      console.log(`[room ${room.code}] ${player.name} joined (${room.players.size}/${MAX_PLAYERS})`);
      return;
    }

    if (!player || !room) return;

    if (msg.t === 'start') {
      if (player.id !== room.hostId) {
        send(ws, { t: 'error', message: 'Only the host can start the race.' });
        return;
      }
      if (room.phase !== 'lobby' && room.phase !== 'finished') return;
      startCountdown(room);
      return;
    }

    if (msg.t === 'rematch') {
      if (player.id !== room.hostId) return;
      if (room.phase !== 'finished') return;
      startCountdown(room);
      return;
    }

    if (msg.t === 'input') {
      if (room.phase !== 'racing' || !player.car || player.finished) return;
      player.input.throttle = clamp(Number(msg.throttle) || 0, -1, 1);
      return;
    }

    if (msg.t === 'respawn') {
      if (room.phase === 'racing' && player.car && !player.finished) {
        respawnCar(player.car, room.track);
        send(ws, { t: 'respawned' });
      }
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong', time: msg.time });
    }
  });

  ws.on('close', () => {
    if (!player || !room) return;
    room.players.delete(player.id);
    room.lastActivity = now();
    console.log(`[room ${room.code}] ${player.name} left (${room.players.size}/${MAX_PLAYERS})`);

    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) {
      room.hostId = room.players.keys().next().value;
    }
    broadcast(room, lobbyState(room));
  });
});

/* ------------------------------------------------------------------ */
/* game loop                                                           */
/* ------------------------------------------------------------------ */

let lastTick = performance.now();
let tickAcc = 0;
setInterval(() => {
  const t = performance.now();
  let dt = (t - lastTick) / 1000;
  lastTick = t;
  dt = Math.min(dt, 0.25);
  tickAcc += dt;

  let steps = 0;
  while (tickAcc >= TICK_MS / 1000 && steps < 6) {
    for (const room of rooms.values()) stepRoom(room, TICK_MS / 1000);
    tickAcc -= TICK_MS / 1000;
    steps++;
  }
  if (steps === 6) tickAcc = 0;

  for (const room of rooms.values()) {
    if (room.players.size === 0 && now() - room.lastActivity > 60_000) {
      rooms.delete(room.code);
    }
  }
}, TICK_MS);

// keep connections alive through NAT / proxies
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

server.listen(PORT, '0.0.0.0', () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) nets.push(net.address);
    }
  }
  console.log('');
  console.log('  Hill Climb MP server running');
  console.log(`     Local:   http://localhost:${PORT}`);
  for (const ip of nets) console.log(`     Network: http://${ip}:${PORT}`);
  console.log('');
});
