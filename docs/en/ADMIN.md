# Installing the server

This page is for the administrator: the person who runs the `fcd` server for their family. You need to be able to
open a terminal and run a few commands. What the other family members do is in the [family guide](FAMILY.md).

The app speaks English and Russian. Server messages in the terminal are in English or Russian too (see
“Language” under Settings below); the examples below show the Russian output.

## What you need

- **A computer that runs around the clock**: a mini PC, NAS, Raspberry Pi, home server or VPS. The server is one
  program, `fcd`, and one data folder; there is no database. It needs little memory.
- **HTTPS with a real certificate.** Without HTTPS the browser does not let the app encrypt, show notifications or
  install on the phone's home screen. Usually a reverse proxy provides HTTPS (section [HTTPS](#https)).
- **Access from the internet** if relatives will write from outside the home: a port forward on the router, a VPS
  or a tunnel.
- **Disk space.** Text takes little; photos and files over the retention period (90 days by default) decide.

## Download

Ready-made files are published on the releases page: https://github.com/stepin/family-chat/releases. Next to them
is `SHA256SUMS` with checksums. Pick the file for your device:

| Device | File |
|---|---|
| Linux on Intel or AMD (mini PC, NAS, VPS) | `fcd-<version>-x86_64-unknown-linux-musl.tar.gz` |
| Linux on ARM64 (Raspberry Pi 3, 4, 5 with a 64-bit system, ARM NAS) | `fcd-<version>-aarch64-unknown-linux-musl.tar.gz` |
| Linux on ARMv7 with a 32-bit system (Raspberry Pi 2 and newer) | `fcd-<version>-armv7-unknown-linux-musleabihf.tar.gz` |
| Mac with Apple Silicon (M1 and newer) | `fcd-<version>-aarch64-apple-darwin.tar.gz` |
| Mac with Intel | `fcd-<version>-x86_64-apple-darwin.tar.gz` |
| Windows (64-bit) | `fcd-<version>-x86_64-pc-windows-msvc.zip` |
| Docker or Podman | image `ghcr.io/stepin/fcd` (section [Docker](#docker)) |

On Linux, `uname -m` shows the processor: `x86_64`, `aarch64` or `armv7l`. The Linux builds are static: they need
no system libraries and work on any distribution.

Check and unpack (Linux and macOS):

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar xzf fcd-<version>-x86_64-unknown-linux-musl.tar.gz
sudo install fcd-<version>-x86_64-unknown-linux-musl/fcd /usr/local/bin/fcd
fcd --version
```

On macOS use `shasum -a 256 --check --ignore-missing SHA256SUMS`. The files are not signed with an Apple
certificate; if macOS refuses to run the downloaded `fcd`, remove the download mark:
`xattr -d com.apple.quarantine fcd`.

### Building from source

Until there are releases, the server is built from source. You need Node.js 22 or newer, pnpm 11 and Rust (stable).

```sh
pnpm install
pnpm build
cargo build --release --locked --manifest-path server/Cargo.toml
# the result: server/target/release/fcd
```

The web app is built into `fcd`, so `pnpm build` comes first. Archives for other systems are made by
`scripts/release.sh` (details in [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## First start

```sh
fcd --data /var/lib/family-chat
```

`--data` is the data folder. On first start the server creates it and writes to its log (the terminal) roughly:

```
INFO fcd 1.0.1, папка данных /var/lib/family-chat
INFO слушаю 0.0.0.0:8787 (HTTP)
INFO откройте http://192.168.1.10:8787/ (приложение)
INFO откройте http://192.168.1.10:8787/server/ (проверка сервера)
INFO первый запуск: папка данных создана
INFO код администратора сервера: 7K3D-XXXX-XXXX-XXXX
INFO дальше: откройте приложение, нажмите “Set up for my family” и введите этот код
```

(With `--lang en` the same lines are in English.) The **server admin code** (`код администратора сервера`) is shown
once; keep it like a password. It is reusable and does one thing only: it creates families on this server. Nobody
joins a family with it. Then:

1. Set up HTTPS (next section) and open the server address in a phone or computer browser. Without HTTPS the app
   works only on the same computer at `http://localhost:8787/`. The app sends the server code only over HTTPS (or
   to this same computer).
2. Press “Set up for my family”, enter the server address and the code.
3. Enter your name, write down the 24 recovery words (the app checks three of them) and create the first
   invitation. On a fresh server this sets up the root family (at the server's own address) and you become its
   administrator. The same code later creates other families on this server ([Several families on one
   server](#several-families-on-one-server)).

To stop: Ctrl+C or SIGTERM. The server waits for open requests for at most 10 seconds. A second instance on the
same folder refuses to start and says so.

### Two kinds of codes

- **The server admin code** is one per server and reusable. It only creates families (in the app: “Set up for my
  family”). A new code (the old one stops working), with the server stopped:

  ```sh
  fcd reset-admin-code --data /var/lib/family-chat
  ```

  A server that ran version 0.1.0 has no server code: run this command once.
- **A family's join code** belongs to one family and works once: whoever joins with it becomes an administrator of
  that family, and the code stops working. It is a setup code (creating a family gives one; it lasts 1 hour) or a
  recovery code, when every administrator of the family has lost access:

  ```sh
  fcd families list --data /var/lib/family-chat          # family ids
  fcd reset-admin-code --data /var/lib/family-chat --family root     # the root family
  fcd reset-admin-code --data /var/lib/family-chat --family <id>     # another family
  ```

  The recovery code is entered in the app as the admin code when joining the family; a member who joins with it
  becomes an administrator.

Relatives join with invitations. The first screen always shows “Set up for my family”, with a line under it saying
that a code from the server owner is needed. Checking the server does not need a reset: the administrator checks
it in the app (section [Server check](#server-check)).

### A second administrator

An administrator issues invitations, disconnects members and sees disk usage. To make another member an
administrator, run with the server stopped:

```sh
fcd admin list --data /var/lib/family-chat
fcd admin add <userId> --data /var/lib/family-chat
```

`fcd admin list` shows each member's `userId`, name and role. Without `--family` the commands work on the root
family, with `--family <id>` on another family of this server. Commands with `--family` also need the server
stopped: that stops every family of the server.

## Settings

Every setting can be given in three ways: a command-line flag, an environment variable, or a key in
`config.toml` in the data folder. Order of precedence: **flag, then environment variable, then `config.toml`, then
the default**. An environment variable behaves exactly like its flag: both win over the file, and on the first start
the effective values (from flags, variables and defaults) are written into the new `config.toml`; later changes of a
flag or a variable are not written there. An empty variable counts as not set. Booleans take `true`, `false`, `1` or
`0`; a wrong value stops the server with an error that names the variable. Restart the server after changing
anything.

| Flag | Environment variable | In `config.toml` | Default | Meaning |
|---|---|---|---|---|
| `--data` | `FCD_DATA` | | | data folder (needed to start; in the Docker image `/data`) |
| `--port` | `FCD_PORT` | `port` | `8787` | port |
| `--listen` | `FCD_LISTEN` | `listen` | `0.0.0.0` | address; `127.0.0.1` when the proxy is on the same computer |
| `--family-name` | `FCD_FAMILY_NAME` | `family_name` | `Семья` (`Family` in English) | name of the root family, everyone in it sees it |
| `--retention-days` | `FCD_RETENTION_DAYS` | `retention_days` | `90` | how many days the server keeps messages and files (7 to 90) |
| `--max-file-mb` | `FCD_MAX_FILE_MB` | `max_file_mb` | `200` | size limit of one file, MB |
| `--push` | `FCD_PUSH` | `push` | `true` | notifications; `false`: the server never contacts push services (without a Telegram token, no outside address at all) |
| `--trust-forwarded-for` | `FCD_TRUST_FORWARDED_FOR` | `trust_forwarded_for` | `false` | take the client address from `X-Forwarded-For` (only behind a proxy) |
| `--lang` | `FCD_LANG` | `lang` | see below | language of the server's messages: `ru` or `en` |
| `--tls-cert`, `--tls-key` | `FCD_TLS_CERT`, `FCD_TLS_KEY` | | | HTTPS with your own certificate files (both are needed) |
| `--web-dir` | `FCD_WEB_DIR` | | | serve the app from a folder (development) |
| `--push-subject` | `FCD_PUSH_SUBJECT` | `push_subject` | `mailto:fcd-admin@example.org` | contact for the Apple, Google and Mozilla push services: `mailto:` or `https://` |
| `--min-free-mb` | `FCD_MIN_FREE_MB` | `min_free_mb` | `100` | below this much free space, MB, the server refuses new data; `0`: no check |
| `--telegram-bot-token` | `FCD_TELEGRAM_BOT_TOKEN` | `telegram_bot_token` | | Telegram bot token for sticker sets by link ([Telegram](#telegram)); empty: off |
| `--telegram-bot-token-file` | `FCD_TELEGRAM_BOT_TOKEN_FILE` | `telegram_bot_token_file` | | a file with the token (Docker and Podman secrets) |
| `--telegram-api-url` | `FCD_TELEGRAM_API_URL` | `telegram_api_url` | `https://api.telegram.org` | Bot API address (own telegram-bot-api) |
| `--telegram-api-allow-http` | `FCD_TELEGRAM_API_ALLOW_HTTP` | `telegram_api_allow_http` | `false` | allow `http://` in the Bot API address beyond this computer |

**Contact for push services.** Some push services reject the default `mailto:fcd-admin@example.org`. Set your own:
`--push-subject mailto:you@example.com` (or `FCD_PUSH_SUBJECT`, or `push_subject` in `config.toml`). A wrong value
stops the server with an error that names the source and the value.

**`--offer-setup` is gone in 1.0.0.** Remove the `offer_setup` line from `config.toml` (version 0.1.0 wrote it)
before starting 1.0.0; otherwise the server and `fcd reset-admin-code` stop with an error that names this line.

The commands `healthcheck`, `reset-admin-code`, `families` and `admin` read the same variables where they apply (`FCD_DATA`,
`FCD_PORT`, `FCD_LISTEN`, `FCD_LANG`). Other `FCD_*` names are ignored (`FCD_GIT_COMMIT` and `FCD_BIN` belong to the
build and the tests).

**Language.** Everything the server prints (the start-up lines, the log, `fcd --help`, errors, `reset-admin-code`,
`admin`, `healthcheck`) is in Russian or English: `--lang`, else `FCD_LANG`, else `lang` in `config.toml`, else the
system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`), else Russian. The examples in this guide show the Russian output. A
few lines come from the `clap` library and stay in English in the Russian help: some rare command-line errors.

The full list with explanations: `fcd --help`. Detailed log: environment variable `RUST_LOG=debug`.

## Several families on one server

One `fcd` holds several families. The root family answers at the server's own address (`https://chat.example.org`),
every other one at its own address `https://chat.example.org/f/<id>` (`<id>` is 16 lowercase letters and digits).
To the app each such family is a server of its own: its own serverId, members, invitations
`https://chat.example.org/f/<id>/#invite=…`, administrators and codes.

**Create a family.** In the app: “Set up for my family” (or “Add a family”, “I am an administrator: a new
family”), the server address, the server admin code, the family name (names differ on one server, ignoring case).
The app joins the new family at once with its setup code, you become its administrator, and the “Done” screen shows
the family address and an invitation for relatives. The app has no list of families of a server.

**List of families:** `fcd families list --data …` shows the id, name and state of each family (set up, not set up,
broken). The command only reads and works while the server runs.

**Shared and separate.** Shared by the whole server: port and address, HTTPS, notifications (on/off and
`push_subject`), the notification key `vapid.json`, retention, file limit, `min_free_mb`, the Telegram token, the
log language, the limit on wrong codes. Separate per family: serverId, name, join code, administrators, members and
all data.

**Data folder.** The root family lives in the folder itself, as before. Other families live in `families/<id>/`
with the same layout but without their own `fcd.lock`, `config.toml` and `vapid.json`. The server is never started
on a family folder by itself (`fcd --data …/families/<id>` refuses and suggests `--family`).

**The proxy** must pass the paths `/f/…`; the Caddy and nginx examples below proxy the whole `/`, which is enough.

**A broken family.** If a family's `server.json` or folder cannot be read, the server starts anyway: the log names
the family and the reason, and its address answers “the family is temporarily unavailable” (503). Restore
`families/<id>` from a backup, or move the folder out of `families/` and restart the server. `fcd healthcheck` still
exits 0 then (otherwise the container with every family would restart) and prints broken families as warnings;
with `--strict` they give exit code 1.

**A family created by mistake:** stop the server, move the folder `families/<id>` away (for example into your
backups), start the server. Removing a family from the app is not available yet.

**Cost.** Each family takes its own writer thread and memory for the indexes of its data. Measured on macOS (debug
build, 17.11.2026): a server with one family uses about 11 MB of memory, with the root and 20 empty families about
14 MB, and starts with 20 families in under 0.1 seconds.

**The alternative:** a second `fcd` with its own data folder at its own address (a subdomain or a port) still
works. It is fully separate but needs a second address and certificate.

## Telegram

Telegram sticker sets are added in the app by their link `https://t.me/addstickers/<name>`. Telegram serves sets
only through the Bot API with a bot token. The server keeps the token; family members never see it. Video stickers
(`.webm`) are skipped for now.

1. In Telegram open @BotFather, send `/newbot`, choose a name and get a token like `123456:ABC…`.
2. Give the token to the server in one of these ways and restart the server:
   - the variable `FCD_TELEGRAM_BOT_TOKEN` (best in a container);
   - a file with the token: `--telegram-bot-token-file /run/secrets/telegram_bot_token` (Docker and Podman secrets);
   - the line `telegram_bot_token = "…"` in `config.toml`;
   - the flag `--telegram-bot-token` (its value shows in the process list, so prefer the others).

   Docker:

   ```sh
   docker run -d --name fcd --restart unless-stopped \
     -p 127.0.0.1:8787:8787 -v fcd-data:/data \
     -e FCD_TELEGRAM_BOT_TOKEN=123456:ABC... \
     ghcr.io/stepin/fcd:latest
   ```

   compose (`environment:` of the `fcd` service): `FCD_TELEGRAM_BOT_TOKEN: "123456:ABC..."`. Podman Quadlet (in
   `[Container]`): `Environment=FCD_TELEGRAM_BOT_TOKEN=123456:ABC...` or `Secret=telegram_bot_token,type=env,target=FCD_TELEGRAM_BOT_TOKEN`.
   systemd: the line `FCD_TELEGRAM_BOT_TOKEN=123456:ABC...` in the service's environment file.
3. At start the server writes one line: “Loading stickers from Telegram: on (bot @name)”, “Telegram rejected the
   token” or “Telegram is unreachable”. The administrator sees the same in the app: Settings, Family and server;
   the `/server/` page shows only “on” or “off”.

The token is a secret, like a password. A new token: edit and restart; an empty value turns loading by link off.
The server never writes the token into a new `config.toml` and never logs it (request addresses show `bot***`
instead). If you put the token into `config.toml`, it is in your backups too.

With a token the server contacts `api.telegram.org`: Telegram sees the server's address and the names of the sets
members load. Your own Bot API server: `--telegram-api-url https://…` (`http://` only for this computer or with
`--telegram-api-allow-http true`, for example inside a compose network). The `--local` mode of telegram-bot-api is
not supported.

Limits (for the whole server, all families together): at most 20 requests to Telegram per second and 2 set loads
at once; a wait in the queue of at most 15 seconds, then the answer “Telegram asks to wait” (503
`telegram_busy`). After a Telegram 429 the whole server waits the time it names. Per device: at most 3 files at
once and 300 requests per 10 minutes. Each request has one 40-second deadline, a single call to Telegram 15
seconds. A set's list is kept in memory for 10 minutes (at most 256 sets). Files: `.webp` up to 512 KB, `.tgs` up
to 128 KB.

## HTTPS

The server speaks plain HTTP. HTTPS comes from one of two things: a reverse proxy in front of it (the main way) or
your own certificate files. The server cannot obtain a Let's Encrypt certificate by itself.

### Reverse proxy

The proxy accepts HTTPS on your domain and forwards requests to `http://127.0.0.1:8787`. What the proxy must let
through:

- **Long requests.** The app waits for new messages in one request for up to 30 seconds. The proxy's response
  timeout must be longer (for example 90 seconds), or the connection keeps dropping.
- **Bodies up to 5 MB.** Files are uploaded in 4 MiB parts, one request per part.
- **The `X-Forwarded-For` header**, so that the limit on wrong codes counts real addresses. Then start the server
  with `--trust-forwarded-for true`. Without a proxy leave it off: anyone can forge the header. Behind a proxy
  without it, every request comes from the proxy's address, and wrong sign-in attempts and server checks of the
  whole family share one counter (10 a minute); so turn it on behind your own proxy.

If the proxy runs on the same computer, start the server with `--listen 127.0.0.1` so that nobody can bypass the
proxy. The proxy must also pass the paths `/f/…` (other families of this server): the examples below proxy the
whole `/`.

**Caddy** obtains and renews a Let's Encrypt certificate by itself if the domain points to your address and ports 80
and 443 are forwarded to the Caddy computer. By default it limits neither response time nor body size, so three
lines are enough:

```
chat.example.org {
	reverse_proxy 127.0.0.1:8787
}
```

**nginx** (certificate from certbot, for example):

```nginx
server {
    listen 443 ssl;
    server_name chat.example.org;

    ssl_certificate     /etc/letsencrypt/live/chat.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.org/privkey.pem;

    # One request carries at most one 4 MiB part of a file.
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # New messages are awaited in one request for up to 30 seconds.
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

The files are in the repository: [deploy/caddy/Caddyfile](../../deploy/caddy/Caddyfile),
[deploy/nginx/family-chat.conf](../../deploy/nginx/family-chat.conf). We checked them by reading, but did not run
them against a real server.

**Other options.** The reverse proxy of a NAS (Synology, QNAP and others) with a certificate: target
`http://<computer with fcd>:8787`. Cloudflare Tunnel: no port forwarding needed, but HTTPS ends at Cloudflare and
Cloudflare sees the requests (the messages stay encrypted). KeenDNS on Keenetic routers with a domain for a device
in the home network: we have not tried this. Whatever you choose, test the long request on the
[server check page](#server-check).

### Your own certificate files

If you already have a certificate (issued by the router or an ACME script, for example):

```sh
fcd --data /var/lib/family-chat --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

- Certificate: the chain in PEM, the server certificate first. Key: PEM (PKCS#8, PKCS#1 or SEC1).
- With these flags the port answers HTTPS only (TLS 1.2 and 1.3).
- The certificate is read at start: restart the server after renewing the files.
- On Linux, port 443 needs privileges. It is simpler to keep port 8787 and forward external port 443 to internal
  port 8787 on the router.

## Docker

The image contains only `fcd` (an empty `scratch` image), runs as user 65534 and keeps data in the `/data` volume.
A health check is built in: `fcd healthcheck`.

```sh
docker run -d --name fcd --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v fcd-data:/data \
  ghcr.io/stepin/fcd:latest
docker logs fcd 2>&1 | grep -E 'код администратора сервера|server admin code'
```

`latest` is the latest release. To pin a version, use its tag, for example `ghcr.io/stepin/fcd:1.0.1` (the same
versions as on the [releases page](https://github.com/stepin/family-chat/releases), without the `v`).

Settings are passed as environment variables, for example `-e FCD_TRUST_FORWARDED_FOR=true` (flags after the image
name work too: `... fcd:latest --trust-forwarded-for true`). The image sets `FCD_DATA=/data`. The built-in health
check `fcd healthcheck` reads the same variables, so a port changed with `-e FCD_PORT=...` is checked as well; a port
changed with a flag is not, so prefer the variable.

A named volume (`fcd-data`) is easier than a folder: Docker gives it the right owner. If you want a folder on disk,
make user 65534 its owner: `sudo chown 65534:65534 /srv/family-chat`.

Docker Compose, the [compose.yaml](../../compose.yaml) file in the repository root:

```yaml
services:
  fcd:
    image: ghcr.io/stepin/fcd:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - fcd-data:/data
    environment:
      # Server settings (fcd --help lists them all); the health check reads them too.
      FCD_LANG: "ru"
      # FCD_TRUST_FORWARDED_FOR: "true"
    stop_grace_period: 20s

volumes:
  fcd-data:
```

Server commands in a container (with the server stopped):

```sh
docker stop fcd
docker run --rm -v fcd-data:/data ghcr.io/stepin/fcd:latest reset-admin-code
docker start fcd
```

The image is built for `linux/amd64`, `linux/arm64` and `linux/arm/v7`.

## Podman Quadlet

Podman runs a container as a systemd service from a `.container` file. For your own user put it in
`~/.config/containers/systemd/fcd.container`, for the whole system in `/etc/containers/systemd/fcd.container`
([deploy/podman/fcd.container](../../deploy/podman/fcd.container)):

```ini
[Unit]
Description=Family Chat server (fcd)

[Container]
Image=ghcr.io/stepin/fcd:latest
ContainerName=fcd
PublishPort=127.0.0.1:8787:8787
Volume=fcd-data:/data
AutoUpdate=registry
# Server settings (fcd --help lists them all); the health check reads them too.
Environment=FCD_LANG=ru
# Environment=FCD_TRUST_FORWARDED_FOR=true
HealthCmd=["/fcd", "healthcheck"]
HealthInterval=30s
HealthTimeout=15s
HealthStartPeriod=10s
HealthRetries=3

[Service]
Restart=always
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user start fcd
journalctl --user -u fcd | grep 'код администратора'
systemctl --user enable --now podman-auto-update.timer
```

`AutoUpdate=registry` together with the `podman-auto-update` timer checks for a new image once a day and restarts
the container. `HealthCmd` is written as an array because the image has no shell. For a user service to run
without a login session, enable `loginctl enable-linger <user>`. We have not run this file: there was no Podman on
the preparation machine.

## systemd without containers

A dedicated user, the data folder and the service
([deploy/systemd/fcd.service](../../deploy/systemd/fcd.service)):

```sh
sudo useradd --system --home-dir /var/lib/family-chat --shell /usr/sbin/nologin fcd
sudo install -d -o fcd -g fcd -m 700 /var/lib/family-chat
sudo install fcd /usr/local/bin/fcd
sudo cp fcd.service /etc/systemd/system/fcd.service
sudo systemctl daemon-reload
sudo systemctl enable --now fcd
sudo journalctl -u fcd | grep 'код администратора'
```

```ini
[Unit]
Description=Family Chat server (fcd)
After=network-online.target
Wants=network-online.target

[Service]
User=fcd
Group=fcd
Environment=FCD_DATA=/var/lib/family-chat
Environment=FCD_LISTEN=127.0.0.1
# More settings, one VARIABLE=value per line (fcd --help lists them all); the file may be absent.
EnvironmentFile=-/etc/family-chat/fcd.env
ExecStart=/usr/local/bin/fcd
Restart=on-failure
TimeoutStopSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/family-chat

[Install]
WantedBy=multi-user.target
```

`FCD_LISTEN=127.0.0.1` fits when the proxy is on the same computer; otherwise drop that line. Further settings go
into `/etc/family-chat/fcd.env`, one `FCD_...=value` per line. Commands with the service stopped:
`sudo systemctl stop fcd`, then `sudo -u fcd fcd reset-admin-code --data /var/lib/family-chat`, then
`sudo systemctl start fcd`.

## Windows and macOS

On Windows, unpack the archive and run `fcd.exe --data C:\FamilyChat` in a terminal; Ctrl+C stops it. There is no
Windows service included; Task Scheduler can start it automatically. On macOS the server runs as on Linux. On
Windows the data folder is protected by the permissions of your account; the server does not set the `0600` and
`0700` permissions it uses on Linux and macOS.

## Updating

The data folder format has a version number. A new server upgrades an older folder by itself; an older server does
not start on a newer folder. So make a backup before updating (next section): it is the only way back.

**From 0.1.0 to 1.0.0:** remove the `offer_setup` line from `config.toml`, start 1.0.0 and run
`fcd reset-admin-code` once (with the server stopped) to get the server admin code for new families. The root
family and its data stay as they were.

- **Binary:** stop the server, replace `fcd`, start.
- **Docker:** `docker pull ghcr.io/stepin/fcd:latest`, then remove and recreate the container
  with the same volume (`docker compose pull && docker compose up -d`).
- **Podman Quadlet:** updates itself (`AutoUpdate=registry`) or with `podman auto-update`.

The app is built into the server, so after a server update everyone is offered an app update.

## Backup and restore

Everything the server keeps is in the data folder. Copy it with the server **stopped**:

```sh
sudo systemctl stop fcd
sudo tar czf family-chat-$(date +%F).tar.gz -C /var/lib family-chat
sudo systemctl start fcd
```

For Docker with the `fcd-data` volume:

```sh
docker stop fcd
docker run --rm -v fcd-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/fcd-data.tar.gz -C /data .
docker start fcd
```

Restore: stop the server, replace the data folder with the backup's contents (same owner), start. The same works
on another computer: the backup moves the whole server, including device logins and notification keys.

A backup of the data folder includes every family of the server (the `families/` folder). If you put the Telegram
token into `config.toml`, it is in the backup too.

What is in the backup: the ciphertext of messages and files, members' public keys and profiles (profile names and
photos are not encrypted), who is in which chat, the notification key `vapid.json`. Nobody can read the messages
from it, but keep it as carefully as the folder itself. If `vapid.json` is deleted, the server creates new keys and
notifications stop on every device until each person enables them again.

A server backup does not replace the archive on devices: the server keeps only the retention period, older history
lives only on phones and in archive files ([family guide](FAMILY.md#message-archive)).

## Retention and disk usage

- The server keeps messages, service records and files for at most `retention_days` days (7 to 90). Every hour and
  at start it deletes whole days older than that. A server clock that jumped forward does not wipe everything: the
  count starts from the smaller of "now" and "the newest event plus 7 days".
- Not deleted: members, profiles, avatars, chat records, group state, group keys and sticker packs. They are small,
  and a restored device needs them to read anything.
- Files decide the space. For example, a family that sends 50 photos a day at 300 KB needs about 1.3 GB for 90 days.
- When free space falls below `min_free_mb` (100 MB by default), the server refuses new messages, files and joins;
  the app says the family server is running out of space. Free some space or shorten the retention.
- Used and free space are shown to the administrator in the app: “Settings”, “Family and server”.

## Members

- **Invitations** are issued by an administrator under “Settings”, “Family and server”, “Invitations”. Each works for
  one person for 7 days and only once. A revoked invitation stops working at once.
- **Disconnecting a member** happens there too. Their devices stop receiving and sending at once; history already
  received stays with everyone. Owners of groups they were in get a service message.
- Wrong codes and signatures are limited: at most 10 failures per minute from one address, shared by every family
  of the server (together with wrong server admin codes).

## Server check

Two checks show whether all is well between a phone and the server: the **long request** (whether a 25-second wait
gets through your proxy or tunnel; if it breaks earlier, raise the proxy's timeout) and the **test notification**
(whether notifications reach this phone). The checks are always on; no flag is needed.

- **Before setup**, while the root family is not set up: the page `https://<your server>/server/` with the server
  admin code (or the family's join code). It also shows that the server answers: family name, version, retention,
  the clock difference, Telegram. Another family is checked on its own page `https://<your server>/f/<id>/server/`.
- **After setup**: in the administrator's app, Settings → Family and server → Server check. The admin code is used
  up by then; the app checks the server with its own sign-in. Ordinary members do not see the section; their
  Diagnostics says the administrator does the check.

After the administrator has joined, the code no longer works on `/server/`, and the page says where the checks are
now. Wrong codes count together with sign-in attempts (10 a minute from one address). If a notification did not
arrive, the server log lines `test push sent` and `delayed test push failed` show what the push service answered.

There is also a device check page, `/device/`: what this phone's browser can do.

## Is the server alive

`fcd healthcheck` asks the server on the same computer and exits with code 0 if it answers and 1 if not. The port
comes from `--port` or from `config.toml` in `--data`; it also works with `--tls-cert`:

```sh
fcd healthcheck --data /var/lib/family-chat
```

Broken families (see [Several families](#several-families-on-one-server)) are printed as warnings and do not change
the exit code; with `--strict` they give exit code 1.

## What has been tested

The server, app and browser end-to-end tests pass in CI (Linux) and on macOS during preparation. The release
workflow builds archives for every system in the table above. Not every build has run on real hardware yet: what
exactly was checked for each is recorded in [CHANGELOG.md](../../CHANGELOG.md). If you run the server on a router,
NAS or single-board computer, please tell us how it went.
