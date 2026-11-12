// End-to-end network smoke test: two clients join one room, race and get snapshots.
import WebSocket from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
const stats = { snaps: 0, finished: [], errors: [], done: false };

function client(name, room) {
  const ws = new WebSocket(URL);
  const c = { name, ws, id: null, room: null, x: 0, welcome: false };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'welcome') {
      Object.assign(c, { id: msg.you, room: msg.room, welcome: true });
      console.log(`${name} joined room ${msg.room} as #${msg.you}`);
    }
    if (msg.t === 'countdown') console.log(`${name} countdown, seed ${msg.seed}`);
    if (msg.t === 'snap') {
      stats.snaps++;
      for (const row of msg.cars) if (row[0] === c.id) c.x = row[1];
    }
    if (msg.t === 'finished') stats.finished.push(msg);
    if (msg.t === 'results') {
      stats.done = true;
      console.log('RESULTS', JSON.stringify(msg.results));
    }
    if (msg.t === 'error') stats.errors.push(msg.message);
  });
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
};

const a = client('Alice');
if (!(await waitFor(() => a.welcome))) {
  console.error('FAIL: Alice never got a welcome message');
  process.exit(1);
}

const b = client('Bob', a.room);
if (!(await waitFor(() => b.welcome))) {
  console.error('FAIL: Bob could not join room', a.room);
  process.exit(1);
}

await wait(300);
a.ws.send(JSON.stringify({ t: 'start' }));

if (!(await waitFor(() => stats.snaps > 0, 6000))) {
  console.error('FAIL: no snapshots after start');
  process.exit(1);
}

const inputTimer = setInterval(() => {
  for (const c of [a, b]) if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'input', throttle: 1 }));
}, 50);

await wait(9000);
clearInterval(inputTimer);

console.log(`snapshots: ${stats.snaps}`);
console.log(`Alice x=${a.x.toFixed(1)}  Bob x=${b.x.toFixed(1)}`);
console.log(`finish events: ${stats.finished.length}`);
console.log(`errors: ${stats.errors}`);

const ok = stats.snaps > 30 && a.x > 30 && b.x > 30;
console.log(ok ? 'NETWORK OK' : 'NETWORK FAILED');
process.exit(ok ? 0 : 1);
