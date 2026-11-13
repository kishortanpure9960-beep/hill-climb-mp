import { createTrack } from '/shared/track.js';
import { createCar, stepCar, respawnCar } from '/shared/physics.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const TAU = Math.PI * 2;
const FIXED_DT = 1 / 60;

// Uploaded character artwork: the circular head rides along as the driver and
// the full-body standee lines the track as roadside spectators.
const charFace = new Image();
charFace.src = '/assets/character_face.png';
const charStandee = new Image();
charStandee.src = '/assets/character_standee.png';

// Orthographic side render of the user's Blender car (hillclimb_car.blend),
// cropped to its alpha bounds. The numbers below are the model's own world
// extents, so the sprite can be placed exactly on the physics footprint.
const carSide = new Image();
carSide.src = '/assets/car_side.png';

const CAR_SPRITE = {
  worldW: 3.5315, // model Y extent of the cropped render
  worldH: 2.0405, // model Z extent of the cropped render
  scale: 0.9, // game units per model unit
  ground: 0.78, // wheel contact sits this far below the chassis centre
  head: { y: -0.23, z: 1.86 }, // driver head centre in model space
};

const imgReady = (img) => img.complete && img.naturalWidth > 0;

const ui = {
  menu: $('menu'),
  lobby: $('lobby'),
  hud: $('hud'),
  results: $('results'),
  name: $('nameInput'),
  room: $('roomInput'),
  play: $('playBtn'),
  menuError: $('menuError'),
  roomCode: $('roomCode'),
  playerList: $('playerList'),
  start: $('startBtn'),
  waitMsg: $('waitMsg'),
  leave: $('leaveBtn'),
  timer: $('timer'),
  dist: $('dist'),
  speed: $('speed'),
  rank: $('rank'),
  countdown: $('countdown'),
  finishBanner: $('finishBanner'),
  touch: $('touchControls'),
  btnGas: $('btnGas'),
  btnBrake: $('btnBrake'),
  resultList: $('resultList'),
  rematch: $('rematchBtn'),
  rematchHint: $('rematchHint'),
  leaveResults: $('leaveResultsBtn'),
  toast: $('toast'),
};

const state = {
  ws: null,
  you: null,
  room: null,
  hostId: null,
  players: [],
  phase: 'menu', // menu | lobby | countdown | racing | finished
  track: null,
  seed: 0,
  trackLength: 900,
  cars: new Map(),
  self: null,
  selfId: null,
  selfFinished: false,
  results: null,
  countdownEndsAt: 0,
  raceTime: 0,
  acc: 0,
  lastInputAt: 0,
  lastRankAt: 0,
  lastRankKey: '',
  keys: { gas: false, brake: false },
  touch: { gas: false, brake: false },
  cam: { x: 8, y: 60, scale: 26, init: false },
  particles: [],
  prevGrounded: true,
  lastFrame: performance.now(),
  connected: false,
  countdownText: '',
};

/* ------------------------------------------------------------------ net */

function connect(name, roomCode) {
  let url;
  const custom = (window.HC_SERVER || '').trim();
  if (custom) {
    url = custom.replace(/\/+$/, '');
    if (!/^wss?:\/\//i.test(url)) {
      url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
    }
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    url = `${proto}://${location.host}`;
  }

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    ui.menuError.textContent = 'Could not open a connection to the server.';
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    ws.send(JSON.stringify({ t: 'join', name, room: roomCode }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    if (state.phase !== 'menu') {
      toast('Disconnected from the server');
      setTimeout(() => location.reload(), 1200);
    }
  });

  ws.addEventListener('error', () => {
    ui.menuError.textContent = 'Cannot reach the server. Is it running?';
  });
}

function send(msg) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      state.you = msg.you;
      state.selfId = msg.you;
      state.room = msg.room;
      state.hostId = msg.hostId;
      state.players = msg.players;
      state.trackLength = msg.trackLength || 900;
      state.seed = msg.seed;
      state.phase = 'lobby';
      showScreen('lobby');
      renderLobby();
      break;
    }

    case 'lobby': {
      state.players = msg.players;
      state.hostId = msg.hostId;
      state.room = msg.room;
      state.trackLength = msg.trackLength || state.trackLength;

      // drop cars of players who left
      if (state.cars.size > 0) {
        const ids = new Set(msg.players.map((p) => p.id));
        for (const id of [...state.cars.keys()]) {
          if (!ids.has(id)) state.cars.delete(id);
        }
      }

      if (state.phase === 'lobby' || state.phase === 'finished') {
        state.phase = msg.phase === 'finished' ? 'finished' : 'lobby';
        if (state.phase === 'lobby') showScreen('lobby');
        renderLobby();
      }
      break;
    }

    case 'countdown': {
      startRace(msg);
      break;
    }

    case 'go': {
      if (state.phase === 'countdown') beginRacing();
      break;
    }

    case 'snap': {
      applySnapshot(msg);
      break;
    }

    case 'finished': {
      if (msg.id === state.selfId) {
        state.selfFinished = true;
        showFinishBanner(msg.place, msg.time);
      }
      break;
    }

    case 'results': {
      state.phase = 'finished';
      state.results = msg.results;
      showResults(msg.results);
      break;
    }

    case 'respawned': {
      if (state.self) {
        respawnCar(state.self.car, state.track);
      }
      break;
    }

    case 'error': {
      toast(msg.message || 'Server error');
      if (state.phase === 'menu') ui.menuError.textContent = msg.message || 'Server error';
      break;
    }
  }
}

/* ------------------------------------------------------------------- ui */

function showScreen(name) {
  ui.menu.classList.toggle('hidden', name !== 'menu');
  ui.lobby.classList.toggle('hidden', name !== 'lobby');
  ui.results.classList.toggle('hidden', name !== 'results');
  ui.hud.classList.toggle('hidden', name !== 'race');
  if (name !== 'race') ui.countdown.classList.add('hidden');
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => ui.toast.classList.add('hidden'), 2600);
}

function avatarFor(color) {
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = '/assets/character_face.png';
  img.alt = '';
  img.style.color = color;
  return img;
}

function renderLobby() {
  ui.roomCode.textContent = state.room || '----';
  ui.playerList.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === state.you ? ' (you)' : '');
    li.append(avatarFor(p.color), name);
    if (p.host) {
      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = 'host';
      li.append(host);
    }
    ui.playerList.append(li);
  }
  for (let i = state.players.length; i < 4; i++) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Open slot';
    ui.playerList.append(li);
  }

  const isHost = state.hostId === state.you;
  ui.start.disabled = !isHost;
  ui.start.textContent = isHost ? 'Start race' : 'Waiting for host';
  ui.waitMsg.textContent = isHost
    ? state.players.length < 2
      ? 'You can race solo to test the track, or wait for friends.'
      : `${state.players.length} players ready.`
    : 'The host starts the race.';
}

function showResults(results) {
  showScreen('results');
  ui.resultList.innerHTML = '';
  const medals = ['1st', '2nd', '3rd', '4th'];
  results.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'win';
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = medals[r.place - 1] || String(r.place);
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = r.name + (r.id === state.you ? ' (you)' : '');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = r.time != null ? `${r.time.toFixed(2)}s` : `${Math.round(r.distance)} m`;
    li.append(place, avatarFor(r.color), name, time);
    ui.resultList.append(li);
  });

  const isHost = state.hostId === state.you;
  ui.rematch.classList.toggle('hidden', !isHost);
  ui.rematchHint.textContent = isHost
    ? 'Everyone in the room stays for the next race.'
    : 'Waiting for the host to start a rematch…';
}

function showFinishBanner(place, time) {
  const medals = ['1st', '2nd', '3rd', '4th'];
  ui.finishBanner.innerHTML = `${medals[place - 1] || place + 'th'} place!<small>${time.toFixed(2)} s — waiting for the others…</small>`;
  ui.finishBanner.classList.remove('hidden');
}

/* ----------------------------------------------------------------- race */

function startRace(msg) {
  state.seed = msg.seed;
  state.trackLength = msg.trackLength || 900;
  state.track = createTrack(state.seed, state.trackLength);
  state.cars.clear();
  state.particles.length = 0;
  state.self = null;
  state.selfFinished = false;
  state.results = null;
  state.raceTime = 0;
  state.acc = 0;
  state.cam.init = false;

  for (const spawn of msg.cars) {
    const player = state.players.find((p) => p.id === spawn.id) || { id: spawn.id, name: 'Racer', color: '#fff' };
    const car = createCar(state.track, spawn.x);
    const entry = { id: spawn.id, name: player.name, color: player.color, car, snaps: [], prev: null };
    state.cars.set(spawn.id, entry);
    if (spawn.id === state.selfId) state.self = entry;
  }

  state.phase = 'countdown';
  state.countdownEndsAt = performance.now() + (msg.startIn || 3600);
  state.countdownText = '';
  ui.finishBanner.classList.add('hidden');
  showScreen('race');
  ui.countdown.classList.remove('hidden');
  ui.countdown.textContent = '3';
  void ui.countdown.offsetWidth;
}

function beginRacing() {
  state.phase = 'racing';
  state.raceTime = 0;
  state.acc = 0;
  ui.countdown.textContent = 'GO!';
  ui.countdown.classList.add('go');
  clearTimeout(beginRacing._timer);
  beginRacing._timer = setTimeout(() => {
    ui.countdown.classList.add('hidden');
    ui.countdown.classList.remove('go');
  }, 700);
}

function applySnapshot(msg) {
  const t = performance.now();
  state.raceTime = Math.max(state.raceTime, msg.time || 0);

  for (const row of msg.cars) {
    const [id, x, y, a, w, v, g] = row;
    const entry = state.cars.get(id);
    if (!entry) continue;

    entry.snaps.push({ t, x, y, a, w, v, g: !!g });
    if (entry.snaps.length > 24) entry.snaps.shift();

    if (id === state.selfId && !state.selfFinished) {
      const car = entry.car;
      const err = Math.hypot(car.x - x, car.y - y);
      if (err > 3.5) {
        car.x = x;
        car.y = y;
        car.angle = a;
        car.vx = 0;
        car.vy = 0;
        car.omega = 0;
      } else {
        const k = 0.22;
        car.x += (x - car.x) * k;
        car.y += (y - car.y) * k;
        let da = a - car.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        car.angle += da * k;
      }
      car.wheelRot = w;
      car.speed = v;
      car.grounded = !!g;
    }
  }
}

function interpolated(entry) {
  const snaps = entry.snaps;
  if (snaps.length === 0) return entry.car;
  const target = performance.now() - 110;
  if (snaps.length === 1 || target <= snaps[0].t) return snaps[0];
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].t >= target) {
      const a = snaps[i - 1];
      const b = snaps[i];
      const f = Math.min(1, Math.max(0, (target - a.t) / Math.max(1, b.t - a.t)));
      let da = b.a - a.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        a: a.a + da * f,
        w: a.w + (b.w - a.w) * f,
        v: b.v,
        g: b.g,
      };
    }
  }
  return snaps[snaps.length - 1];
}

/* --------------------------------------------------------------- input */

function throttleValue() {
  const gas = state.keys.gas || state.touch.gas;
  const brake = state.keys.brake || state.touch.brake;
  return (gas ? 1 : 0) + (brake ? -1 : 0);
}

function bindHold(el, key) {
  const on = (e) => {
    e.preventDefault();
    state.touch[key] = true;
  };
  const off = (e) => {
    e.preventDefault();
    state.touch[key] = false;
  };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

bindHold(ui.btnGas, 'gas');
bindHold(ui.btnBrake, 'brake');

window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'ArrowRight':
    case 'KeyD':
      state.keys.gas = true;
      e.preventDefault();
      break;
    case 'ArrowLeft':
    case 'KeyA':
      state.keys.brake = true;
      e.preventDefault();
      break;
    case 'KeyR':
      if (state.phase === 'racing' && !state.selfFinished) {
        send({ t: 'respawn' });
      }
      break;
  }
});

window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowRight':
    case 'KeyD':
      state.keys.gas = false;
      break;
    case 'ArrowLeft':
    case 'KeyA':
      state.keys.brake = false;
      break;
  }
});

window.addEventListener('blur', () => {
  state.keys.gas = false;
  state.keys.brake = false;
});

/* ---------------------------------------------------------------- setup */

ui.play.addEventListener('click', () => {
  const name = ui.name.value.trim() || 'Racer';
  const room = ui.room.value.trim().toUpperCase();
  ui.menuError.textContent = '';
  ui.play.disabled = true;
  localStorage.setItem('hc-name', name);
  connect(name, room);
  setTimeout(() => (ui.play.disabled = false), 4000);
});

ui.room.addEventListener('input', () => {
  ui.room.value = ui.room.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

ui.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.play.click();
});
ui.room.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.play.click();
});

ui.start.addEventListener('click', () => send({ t: 'start' }));
ui.rematch.addEventListener('click', () => send({ t: 'rematch' }));
ui.leave.addEventListener('click', () => location.reload());
ui.leaveResults.addEventListener('click', () => location.reload());

ui.name.value = localStorage.getItem('hc-name') || '';
if (matchMedia('(pointer: coarse)').matches) ui.touch.classList.remove('hidden');

/* ---------------------------------------------------------------- loop */

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function update(dt, now) {
  if (state.phase === 'countdown') {
    const remain = state.countdownEndsAt - now;
    if (remain <= 0) {
      beginRacing();
    } else {
      const n = String(Math.min(3, Math.ceil(remain / 1000)));
      if (n !== state.countdownText) {
        state.countdownText = n;
        ui.countdown.textContent = n;
        ui.countdown.classList.remove('go');
        ui.countdown.classList.remove('hidden');
        ui.countdown.style.animation = 'none';
        void ui.countdown.offsetWidth;
        ui.countdown.style.animation = '';
      }
    }
  }

  if (state.phase === 'racing') {
    state.raceTime += dt;

    if (state.self && !state.selfFinished) {
      state.acc += dt;
      let steps = 0;
      const throttle = throttleValue();
      while (state.acc >= FIXED_DT && steps < 6) {
        stepCar(state.self.car, { throttle }, state.track, FIXED_DT);
        state.acc -= FIXED_DT;
        steps++;
      }
      if (steps === 6) state.acc = 0;

      const car = state.self.car;
      if (car.grounded && Math.abs(throttle) > 0 && car.speed > 2 && Math.random() < 0.5) {
        spawnDust(car, throttle > 0 ? -1.25 : 1.25);
      }
      if (!state.prevGrounded && car.grounded) {
        for (let i = 0; i < 7; i++) spawnDust(car, -1.2, 1.4);
      }
      state.prevGrounded = car.grounded;
    }

    if (now - state.lastInputAt > 50) {
      state.lastInputAt = now;
      send({ t: 'input', throttle: throttleValue() });
    }
  }

  // particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      state.particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 5 * dt;
    p.vx *= 0.96;
  }

  updateCamera(dt);

  if (state.phase === 'racing' || state.phase === 'finished') {
    if (now - state.lastRankAt > 140) {
      state.lastRankAt = now;
      updateHud();
    }
  }
}

function spawnDust(car, offsetX, power = 1) {
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  const lx = offsetX;
  const ly = 0.36;
  const x = car.x + cos * lx - sin * ly;
  const y = car.y + sin * lx + cos * ly + 0.3;
  state.particles.push({
    x,
    y,
    vx: -car.vx * 0.15 + (Math.random() - 0.5) * 2,
    vy: -Math.random() * 1.6 * power,
    life: 0.5 + Math.random() * 0.5,
    maxLife: 1,
    size: 0.14 + Math.random() * 0.24,
  });
}

function updateCamera(dt) {
  const focus = state.self ? state.self.car : null;
  if (!focus) return;
  const w = innerWidth;
  const viewBase = w < 700 ? 26 : 40;
  const targetScale = w / (viewBase + Math.min(14, Math.abs(focus.vx) * 0.45));
  const targetX = focus.x + 2.2 + focus.vx * 0.12;
  const targetY = focus.y - 1.4;

  if (!state.cam.init) {
    state.cam.x = targetX;
    state.cam.y = targetY;
    state.cam.scale = targetScale;
    state.cam.init = true;
    return;
  }

  const k = 1 - Math.pow(0.0005, dt);
  state.cam.x += (targetX - state.cam.x) * Math.min(1, k * 1.2);
  state.cam.y += (targetY - state.cam.y) * Math.min(1, k);
  state.cam.scale += (targetScale - state.cam.scale) * Math.min(1, k * 0.6);
}

function updateHud() {
  const self = state.self;
  if (!self) return;
  const car = state.selfFinished ? interpolated(self) : self.car;
  const dist = Math.max(0, Math.min(state.trackLength, car.x - (state.track?.startX || 8)));
  ui.timer.textContent = `${state.raceTime.toFixed(1)}s`;
  ui.dist.textContent = `${Math.round(dist)} / ${state.trackLength} m`;
  ui.speed.textContent = String(Math.round((car.v || Math.hypot(car.vx || 0, car.vy || 0)) * 3.6));

  const order = [...state.cars.values()].map((entry) => {
    const c = entry.id === state.selfId && !state.selfFinished ? entry.car : interpolated(entry);
    return { entry, x: c.x, finished: state.results?.find((r) => r.id === entry.id)?.time != null };
  });
  order.sort((a, b) => {
    if (a.finished && b.finished) return a.x - b.x;
    return b.x - a.x;
  });

  const key = order.map((o) => o.entry.id + ':' + Math.round(o.x)).join('|');
  if (key === state.lastRankKey) return;
  state.lastRankKey = key;

  ui.rank.innerHTML = '';
  order.forEach((o, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (o.entry.id === state.selfId ? ' me' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = o.entry.name;
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = `${i + 1}. ${Math.round(Math.max(0, o.x - (state.track?.startX || 8)))}m`;
    row.append(avatarFor(o.entry.color), nm, pos);
    ui.rank.append(row);
  });
}

/* -------------------------------------------------------------- drawing */

function w2s(x, y) {
  return [(x - state.cam.x) * state.cam.scale + innerWidth / 2, (y - state.cam.y) * state.cam.scale + innerHeight * 0.62];
}

function render() {
  const w = innerWidth;
  const h = innerHeight;
  ctx.clearRect(0, 0, w, h);

  drawSky(w, h);

  const track = state.track;
  if (!track) return;

  ctx.save();
  ctx.translate(w / 2, h * 0.62);
  ctx.scale(state.cam.scale, state.cam.scale);
  ctx.translate(-state.cam.x, -state.cam.y);

  drawTerrain(track);
  drawCrowd(track);
  drawMarkers(track);
  drawFinish(track);

  for (const p of state.particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = '#d8c39a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const entries = [...state.cars.values()];
  const drawList = entries.filter((e) => e.id !== state.selfId);
  if (state.self) drawList.push(state.self);
  for (const entry of drawList) {
    const c = entry.id === state.selfId && !state.selfFinished ? entry.car : interpolated(entry);
    drawCar(entry, c);
  }

  ctx.restore();

  // name tags + self marker in screen space
  for (const entry of drawList) {
    const c = entry.id === state.selfId && !state.selfFinished ? entry.car : interpolated(entry);
    drawTag(entry, c);
  }

  drawMinimap(w, h);
}

function drawSky(w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#3f8fd2');
  sky.addColorStop(0.55, '#9fd0ee');
  sky.addColorStop(1, '#e8f4fb');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // sun
  const sunX = w * 0.78;
  const sunY = h * 0.14;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 160);
  glow.addColorStop(0, 'rgba(255, 245, 200, 0.95)');
  glow.addColorStop(0.25, 'rgba(255, 236, 170, 0.5)');
  glow.addColorStop(1, 'rgba(255, 236, 170, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - 160, sunY - 160, 320, 320);
  ctx.fillStyle = '#fff8d8';
  ctx.beginPath();
  ctx.arc(sunX, sunY, 34, 0, TAU);
  ctx.fill();

  const camX = state.cam.x;

  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  for (let i = 0; i < 7; i++) {
    const seedX = i * 620 + 90;
    const x = ((seedX - camX * 6) % (w + 900) + w + 900) % (w + 900) - 300;
    const y = 50 + ((i * 73) % 130);
    const s = 0.7 + (i % 3) * 0.35;
    ctx.beginPath();
    ctx.ellipse(x, y, 70 * s, 24 * s, 0, 0, TAU);
    ctx.ellipse(x + 50 * s, y + 8 * s, 48 * s, 18 * s, 0, 0, TAU);
    ctx.ellipse(x - 46 * s, y + 10 * s, 40 * s, 15 * s, 0, 0, TAU);
    ctx.fill();
  }

  drawHillLayer(w, h, 0.12, h * 0.63, 46, 0.0042, '#7fb9a4', 0.55);
  drawHillLayer(w, h, 0.22, h * 0.72, 30, 0.0075, '#5d9c85', 0.75);
  drawHillLayer(w, h, 0.36, h * 0.82, 22, 0.012, '#3f7d68', 0.9);
}

function drawHillLayer(w, h, parallax, baseY, amp, freq, color, alpha) {
  const camX = state.cam.x * parallax;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let sx = 0; sx <= w + 10; sx += 10) {
    const wx = camX + sx;
    const y = baseY + Math.sin(wx * freq) * amp + Math.sin(wx * freq * 2.7 + 1.3) * amp * 0.35;
    ctx.lineTo(sx, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawTerrain(track) {
  const w = innerWidth;
  const h = innerHeight;
  const scale = state.cam.scale;
  const stepPx = 4;
  const left = state.cam.x - w / 2 / scale - 2;
  const right = state.cam.x + w / 2 / scale + 2;

  const points = [];
  for (let wx = left; wx <= right; wx += stepPx / scale) {
    points.push([wx, track.heightAt(wx)]);
  }

  const bottom = state.cam.y + (h * 0.6) / scale;

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.lineTo(points[points.length - 1][0], bottom);
  ctx.lineTo(points[0][0], bottom);
  ctx.closePath();

  const dirt = ctx.createLinearGradient(0, state.cam.y - 4, 0, state.cam.y + 14);
  dirt.addColorStop(0, '#7a5634');
  dirt.addColorStop(0.35, '#5d3f26');
  dirt.addColorStop(1, '#33220f');
  ctx.fillStyle = dirt;
  ctx.fill();

  // grass cap
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.lineWidth = 0.42;
  ctx.strokeStyle = '#4f9c45';
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1] - 0.18);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1] - 0.18);
  ctx.lineWidth = 0.22;
  ctx.strokeStyle = '#79c96a';
  ctx.stroke();
}

function drawCrowd(track) {
  if (!imgReady(charStandee)) return;
  const scale = state.cam.scale;
  const left = state.cam.x - innerWidth / 2 / scale - 4;
  const right = state.cam.x + innerWidth / 2 / scale + 4;
  const startX = (track.startX || 8) + 18;
  const step = 24;

  const first = Math.max(0, Math.floor((left - startX) / step) - 1);
  for (let i = first; ; i++) {
    const x = startX + i * step + rand01(i * 13 + 3) * 16;
    if (x > right) break;
    if (x < left) continue;

    const h = 1 + rand01(i * 7 + 11) * 0.6;
    const w = h * (charStandee.width / charStandee.height);
    const y = track.heightAt(x);

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.82;

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(0, 0.03, w * 0.42, 0.09, 0, 0, TAU);
    ctx.fill();

    ctx.drawImage(charStandee, -w / 2, -h - 0.08, w, h);
    ctx.restore();
  }
}

// Deterministic pseudo-random in [0,1) so every client sees the same crowd.
function rand01(n) {
  const s = Math.sin(n * 12.9898 + state.seed * 0.0137) * 43758.5453;
  return s - Math.floor(s);
}

function drawMarkers(track) {
  const first = Math.max(100, Math.floor((state.cam.x - 40) / 100) * 100);
  for (let x = first; x <= Math.min(track.finishX, state.cam.x + 60); x += 100) {
    const y = track.heightAt(x);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 2.6);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '600 0.9px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${x} m`, x + 0.25, y - 2.2);
  }
}

function drawFinish(track) {
  const x = track.finishX;
  if (x < state.cam.x - 60 || x > state.cam.x + 80) return;
  const y = track.heightAt(x);

  ctx.fillStyle = 'rgba(20,24,32,0.85)';
  ctx.fillRect(x - 0.12, y - 5.4, 0.24, 5.4);
  ctx.fillRect(x + 3.2, y - 5.4, 0.24, 5.4);

  const cols = 8;
  const rows = 3;
  const cw = 3.2 / cols;
  const ch = 0.42;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f4f4' : '#1c1f26';
      ctx.fillRect(x + c * cw, y - 5.4 + r * ch, cw, ch);
    }
  }

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '800 1px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FINISH', x + 1.6, y - 5.8);
}

function drawCar(entry, c) {
  const x = c.x;
  const y = c.y;
  const angle = c.a ?? c.angle ?? 0;
  const wheelRot = c.w ?? c.wheelRot ?? 0;

  ctx.save();
  ctx.translate(x, y);

  // soft ground shadow
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 0.72, 1.6, 0.33, angle * 0.4, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.rotate(angle);

  if (imgReady(carSide)) {
    drawCarSprite(entry);
  } else {
    drawCarVector(entry, wheelRot);
  }

  // driver — the uploaded character rides along in every car
  const sprite = imgReady(carSide);
  const headX = sprite ? CAR_SPRITE.head.y * CAR_SPRITE.scale : -0.34;
  const headY = sprite ? CAR_SPRITE.ground - CAR_SPRITE.head.z * CAR_SPRITE.scale : -0.8;
  const headR = 0.43;

  if (imgReady(charFace)) {
    ctx.drawImage(charFace, headX - headR, headY - headR, headR * 2, headR * 2);
  } else {
    ctx.beginPath();
    ctx.arc(headX, headY, 0.17, 0, TAU);
    ctx.fillStyle = '#f2c9a0';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(headX, headY - 0.06, 0.17, Math.PI, TAU);
    ctx.fillStyle = shade(entry.color, 0.7);
    ctx.fill();
  }

  ctx.restore();
}

function drawCarSprite(entry) {
  const w = CAR_SPRITE.worldW * CAR_SPRITE.scale;
  const h = CAR_SPRITE.worldH * CAR_SPRITE.scale;
  const bottom = CAR_SPRITE.ground;

  // player-coloured aura keeps four identical-looking cars distinguishable
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = entry.color;
  ctx.shadowColor = entry.color;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.ellipse(0, bottom - 0.35, 1.45, 0.5, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.drawImage(carSide, -w / 2, bottom - h, w, h);
}

function drawCarVector(entry, wheelRot) {
  // wheels
  for (const wx of [-1.2, 1.2]) {
    ctx.save();
    ctx.translate(wx, 0.36);
    ctx.rotate(wheelRot);
    ctx.beginPath();
    ctx.arc(0, 0, 0.42, 0, TAU);
    ctx.fillStyle = '#171a21';
    ctx.fill();
    ctx.lineWidth = 0.06;
    ctx.strokeStyle = '#0b0d12';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 0.21, 0, TAU);
    ctx.fillStyle = '#c9d2e2';
    ctx.fill();

    ctx.strokeStyle = '#8b95a8';
    ctx.lineWidth = 0.045;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -0.2, Math.sin(a) * -0.2);
      ctx.lineTo(Math.cos(a) * 0.2, Math.sin(a) * 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // chassis
  const bodyGrad = ctx.createLinearGradient(0, -0.5, 0, 0.5);
  bodyGrad.addColorStop(0, shade(entry.color, 1.25));
  bodyGrad.addColorStop(0.5, entry.color);
  bodyGrad.addColorStop(1, shade(entry.color, 0.62));

  ctx.beginPath();
  ctx.moveTo(-1.35, 0.28);
  ctx.lineTo(-1.3, -0.16);
  ctx.lineTo(-0.55, -0.32);
  ctx.lineTo(-0.2, -0.72);
  ctx.lineTo(0.55, -0.72);
  ctx.lineTo(0.95, -0.3);
  ctx.lineTo(1.35, -0.12);
  ctx.lineTo(1.35, 0.28);
  ctx.closePath();
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 0.07;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();

  // window
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.62);
  ctx.lineTo(0.48, -0.62);
  ctx.lineTo(0.75, -0.32);
  ctx.lineTo(-0.16, -0.32);
  ctx.closePath();
  ctx.fillStyle = 'rgba(210,240,255,0.85)';
  ctx.fill();

  // headlight
  ctx.beginPath();
  ctx.arc(1.2, -0.02, 0.1, 0, TAU);
  ctx.fillStyle = '#fff3b0';
  ctx.fill();
}

function drawTag(entry, c) {
  const [sx, sy] = w2s(c.x, c.y);
  const isSelf = entry.id === state.selfId;
  if (sx < -80 || sx > innerWidth + 80) return;
  const y = sy - 34;

  ctx.font = isSelf ? '700 12px "Segoe UI", sans-serif' : '600 12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(8,10,16,0.75)';
  ctx.strokeText(entry.name, sx, y);
  ctx.fillStyle = isSelf ? '#fff' : 'rgba(240,245,255,0.92)';
  ctx.fillText(entry.name, sx, y);

  if (isSelf) {
    ctx.beginPath();
    ctx.moveTo(sx - 5, y + 6);
    ctx.lineTo(sx + 5, y + 6);
    ctx.lineTo(sx, y + 12);
    ctx.closePath();
    ctx.fillStyle = entry.color;
    ctx.fill();
  }
}

function drawMinimap(w, h) {
  const track = state.track;
  if (!track) return;
  const barW = Math.min(460, w * 0.62);
  const x0 = (w - barW) / 2;
  const y0 = 18 + (matchMedia('(display-mode: standalone)').matches ? 8 : 0);

  ctx.save();
  ctx.fillStyle = 'rgba(10,13,20,0.5)';
  roundRect(x0 - 10, y0 - 8, barW + 20, 24, 12);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(x0, y0 + 2, barW, 4, 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,207,77,0.9)';
  ctx.fillRect(x0 + barW - 2, y0 - 2, 2, 12);

  for (const entry of state.cars.values()) {
    const c = entry.id === state.selfId && !state.selfFinished ? entry.car : interpolated(entry);
    const f = Math.max(0, Math.min(1, (c.x - track.startX) / (track.finishX - track.startX)));
    const px = x0 + f * barW;
    ctx.beginPath();
    ctx.arc(px, y0 + 4, entry.id === state.selfId ? 5 : 4, 0, TAU);
    ctx.fillStyle = entry.color;
    ctx.fill();
    if (entry.id === state.selfId) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.min(255, Math.round(r * amount));
  g = Math.min(255, Math.round(g * amount));
  b = Math.min(255, Math.round(b * amount));
  return `rgb(${r},${g},${b})`;
}

/* ---------------------------------------------------------------- frame */

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - state.lastFrame) / 1000;
  state.lastFrame = now;
  dt = Math.min(dt, 0.05);

  update(dt, now);

  if (state.phase === 'menu' || state.phase === 'lobby') {
    renderMenuBackdrop(now);
  } else {
    render();
  }
}

// Animated background behind the menu / lobby panels.
function renderMenuBackdrop(now) {
  const w = innerWidth;
  const h = innerHeight;
  if (!state.track) {
    state.track = createTrack(424242, 900);
    state.cam.x = 60;
    state.cam.y = state.track.heightAt(60) - 2;
    state.cam.scale = Math.min(34, Math.max(16, w / 40));
    state.cam.init = true;
  }
  state.cam.x += 0.12;
  const groundY = state.track.heightAt(state.cam.x);
  state.cam.y += (groundY - 2 - state.cam.y) * 0.05;
  render();
}

requestAnimationFrame(frame);

// Small hook so tools/browser-test.js can check what is drawn where.
window.__hc = {
  state,
  w2s,
  headOffset: {
    x: CAR_SPRITE.head.y * CAR_SPRITE.scale,
    y: CAR_SPRITE.ground - CAR_SPRITE.head.z * CAR_SPRITE.scale,
  },
};
