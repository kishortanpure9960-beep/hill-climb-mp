// Headless-browser smoke test: loads the real UI, creates a room, starts a
// solo race, holds the gas key and checks that the car actually moves.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const BASE_URL = process.env.URL || 'http://localhost:3000';
const profile = path.join(os.tmpdir(), 'opencode', 'hc-chrome-' + Date.now());
const shots = path.join(process.cwd(), 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1280,800',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    BASE_URL,
  ],
  { stdio: 'ignore' }
);

let ws;
let nextId = 1;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }
    }, 15000);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
  return res.result.value;
}

async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(shots, { recursive: true });
  const file = path.join(shots, name);
  await fs.writeFile(file, Buffer.from(res.data, 'base64'));
  console.log('screenshot ->', file);
  return file;
}

try {
  // wait for the devtools endpoint
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const host = new URL(BASE_URL).host;
      target = list.find((t) => t.type === 'page' && t.url.includes(host));
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('Chrome devtools did not come up');

  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  console.log('title:', await evaluate('document.title'));
  await shot('01-menu.png');

  // join
  await evaluate(`
    document.getElementById('nameInput').value = 'BrowserBot';
    document.getElementById('playBtn').click();
    true
  `);
  await sleep(1500);

  const lobby = await evaluate(`({
    lobbyVisible: !document.getElementById('lobby').classList.contains('hidden'),
    code: document.getElementById('roomCode').textContent,
    players: document.querySelectorAll('#playerList li:not(.empty)').length,
    startEnabled: !document.getElementById('startBtn').disabled,
    menuError: document.getElementById('menuError').textContent
  })`);
  console.log('lobby:', lobby);
  await shot('02-lobby.png');

  // start the race
  await evaluate(`document.getElementById('startBtn').click(); true`);
  await sleep(1500);
  await shot('03-countdown.png');
  await sleep(2600);

  // hold gas
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  });

  await sleep(6000);

  const hud = await evaluate(`({
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    timer: document.getElementById('timer').textContent,
    dist: document.getElementById('dist').textContent,
    speed: document.getElementById('speed').textContent,
    rankRows: document.querySelectorAll('#rank .rank-row').length
  })`);
  console.log('hud:', hud);
  await shot('04-race.png');

  // pixel sanity: sky should be blue, ground should be brown
  const pixels = await evaluate(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const px = (x, y) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    return {
      sky: px(c.width * 0.15, c.height * 0.06),
      ground: px(c.width * 0.5, c.height * 0.9),
      car: px(c.width * 0.5, c.height * 0.62)
    };
  })()`);
  const [sr, sg, sb] = pixels.sky;
  const [gr, gg, gb] = pixels.ground;
  const skyOk = sb > sr && sb > 100;
  const groundOk = gr > gb && gr > 40;
  console.log('pixels:', { skyOk, groundOk, sky: pixels.sky, ground: pixels.ground });

  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  });

  const meters = parseFloat((hud.dist || '0').replace(/[^\d.]/g, '')) || 0;
  console.log('console errors:', errors.length ? errors : 'none');

  const ok =
    lobby.lobbyVisible &&
    lobby.players === 1 &&
    hud.hudVisible &&
    meters > 25 &&
    skyOk &&
    groundOk &&
    errors.length === 0;
  console.log(ok ? 'BROWSER OK' : 'BROWSER FAILED');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('BROWSER TEST ERROR:', err.message);
  console.error('console errors:', errors);
  process.exitCode = 1;
} finally {
  try {
    if (ws) ws.close();
  } catch {}
  chrome.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

