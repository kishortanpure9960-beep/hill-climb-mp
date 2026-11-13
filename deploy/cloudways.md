# Deploying the game server (Cloudways / any Ubuntu VPS)

Vercel can only serve the static client — it cannot hold WebSocket connections,
so the game server needs a host that keeps a Node process alive. These steps run
it under PM2 behind Nginx with TLS, so the Vercel client can reach it as
`wss://…`.

The repo is public, so the box only needs `git`.

## 1. Point a DNS record at the server

Cloudways gives you a public IP. Add an `A` record such as
`game.example.com → <server-ip>` and wait for it to resolve
(`nslookup game.example.com`).

## 2. Install Node, git and PM2

```bash
ssh master_<user>@<server-ip>          # credentials are in the Cloudways panel
node -v                                # needs 18+; install via nvm if missing
sudo npm install -g pm2
```

## 3. Clone and install

```bash
git clone https://github.com/kishortanpure9960-beep/hill-climb-mp.git
cd hill-climb-mp
npm ci --omit=dev
```

## 4. Start it and make it survive reboots

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                            # run the command it prints, once
pm2 logs hill-climb-mp                 # should print the LAN/local URLs
```

The server reads `PORT` (default `3000`), binds `0.0.0.0`, serves the static
client *and* the `/ws` endpoint from the same port.

## 5. Reverse proxy + TLS

Copy `deploy/nginx.conf` to `/etc/nginx/sites-available/hill-climb-mp`, replace
the domain, enable it, then issue a certificate:

```bash
sudo ln -s /etc/nginx/sites-available/hill-climb-mp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d game.example.com
```

The `Upgrade`/`Connection` headers in that file are what let the WebSocket
handshake through — without them the page loads but nobody can join a room.

If the box runs Apache instead of Nginx, the equivalent is:

```apache
ProxyPreserveHost On
ProxyPass        / http://127.0.0.1:3000/ upgrade=websocket
ProxyPassReverse / http://127.0.0.1:3000/
```

## 6. Verify from your laptop

```bash
# the page should load
curl -sI https://game.example.com | head -1

# the socket should upgrade (expect HTTP/1.1 101)
curl -i -N --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://game.example.com/"
```

Then run the repo's own network test against the deployed server:

```bash
URL=https://game.example.com npm run test:net
```

## 7. Point the Vercel client at it

The client reads `window.HC_SERVER` from `public/config.js`, which
`tools/build-static.js` generates from the `GAME_SERVER` env var at build time.

```bash
vercel env add GAME_SERVER production     # wss://game.example.com
vercel --prod
```

## Updating the deployment

```bash
cd hill-climb-mp && git pull && npm ci --omit=dev && pm2 restart hill-climb-mp
```

Rooms are held in memory, so a restart drops any race in progress.
