# Installation

Blockfall consists of two processes: the **website** (PHP + Apache, port 80) and the **game server** (PHP command line,
port 8081). Without the latter, only the modes against the computer and on the same screen work.

## 1. With Docker (recommended)

```bash
git clone <this repository> blockfall
cd blockfall
docker compose up -d --build
```

- Game: <http://localhost:8095>
- Game server: `ws://localhost:8096` (set in `BLOCKFALL_WS` in `docker-compose.yml`, as the browser must reach it)

The image is based on `php:8.5-apache-trixie` (Debian 13, PHP 8.5); both services use the same image.

```bash
docker compose logs -f blockfall-ws     # game server log (matches, ranking)
docker compose down                 # stop (the leaderboard is kept)
docker compose down -v              # stop AND delete the leaderboard
```

The leaderboard (`ratings.json`) is in the named volume `blockfall_data`, mounted on `/var/www/html/data`: it is written by
the **game server** and read by the website, which is why both services mount it. To reset it, delete `ratings.json` and restart
`blockfall-ws`.

## 2. Without Docker

Requirements: **PHP 8.5** with `json` and `mbstring`, [Composer](https://getcomposer.org), and a web server (or PHP's built-in
server for testing).

```bash
composer install --no-dev
mkdir -p web/data && chmod 775 web/data
BLOCKFALL_WS=ws://localhost:8081 php -S 0.0.0.0:8080 -t web      # the website
php server/server.php                                        # the game server (second terminal)
```

In production, point the document root at `web/` (and **not** the repository root: `server/` and `src/` must never be served).
`web/data/` must be writable by the user running the game server and readable by the web server, and must not be downloadable
(Apache: the provided `.htaccess`, with `AllowOverride All`; nginx: `location /data/ { deny all; }`).

A systemd unit for the game server:

```ini
[Unit]
Description=Blockfall game server
After=network.target

[Service]
User=www-data
ExecStart=/usr/bin/php /srv/blockfall/server/server.php
Environment=WS_PORT=8081
Restart=always

[Install]
WantedBy=multi-user.target
```

## 3. Configuration

| Variable | Where | Purpose | Default |
| --- | --- | --- | --- |
| `BLOCKFALL_WS` | website | WebSocket URL used by the **browser** | empty = `wss://<host>/ws` on HTTPS, `ws://<host>:8081` otherwise |
| `WS_PORT` | game server | listening port | `8081` |
| `WS_ALLOWED_ORIGINS` | game server | allowed origins, comma-separated | empty = all |
| `BLOCKFALL_DATA_DIR` | both | directory of `ratings.json` | `web/data` (`/var/www/html/data` in the Docker image) |
| `BLOCKFALL_AUTOLOAD` | both | path of Composer's `vendor/autoload.php` if not at the usual place | `/opt/blockfall/vendor/autoload.php` in the image |
| `BLOCKFALL_TARGET` | game server | points to win | `7` |
| `BLOCKFALL_INVITE_TTL` | game server | seconds before an unanswered challenge expires | `20` |
| `BLOCKFALL_REMATCH_TTL` | game server | seconds to ask for a rematch after a match | `30` |

## 4. Behind an HTTPS reverse proxy

A page served over HTTPS can only open a secure WebSocket (`wss://`). Proxy the game server under `/ws`:

```nginx
server {
    listen 443 ssl;
    server_name blockfall.example.com;
    # ... certificates ...

    location / {
        proxy_pass http://127.0.0.1:8095;
        proxy_set_header Host $host;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8096;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

Then in `docker-compose.yml`: `BLOCKFALL_WS: "wss://blockfall.example.com/ws"` on `blockfall`, and
`WS_ALLOWED_ORIGINS: "https://blockfall.example.com"` on `blockfall-ws`. Restart with `docker compose up -d`.

## 5. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Server unreachable" | `blockfall-ws` is not running, port 8081/8091 is blocked, or `BLOCKFALL_WS` points to the wrong URL |
| Online silent behind HTTPS | `BLOCKFALL_WS` is not a `wss://` URL, or the proxy lacks the `Upgrade` headers |
| "Leaderboard unavailable" | `api.php` is not responding, or `web/data/` is not readable |
| Stale page after an update | clear the cache (Ctrl+F5) |
