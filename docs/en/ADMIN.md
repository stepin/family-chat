# Installing the server

This page is for the administrator: the person who runs the `fcd` server for their family. You need to be able to
open a terminal and run a few commands. What the other family members do is in the [family guide](FAMILY.md).

The app itself is in Russian for now; server messages in the terminal are in Russian too. The examples below
quote them as they appear.

## What you need

- **A computer that runs around the clock**: a mini PC, NAS, Raspberry Pi, home server or VPS. The server is one
  program, `fcd`, and one data folder; there is no database. It needs little memory.
- **HTTPS with a real certificate.** Without HTTPS the browser does not let the app encrypt, show notifications or
  install on the phone's home screen. Usually a reverse proxy provides HTTPS (section [HTTPS](#https)).
- **Access from the internet** if relatives will write from outside the home: a port forward on the router, a VPS
  or a tunnel.
- **Disk space.** Text takes little; photos and files over the retention period (90 days by default) decide.

## Download

Ready-made files are published on the releases page: https://code.example.org/family-chat/releases. Next to them
is `SHA256SUMS` with checksums. Pick the file for your device:

| Device | File |
|---|---|
| Linux on Intel or AMD (mini PC, NAS, VPS) | `fcd-<version>-x86_64-unknown-linux-musl.tar.gz` |
| Linux on ARM64 (Raspberry Pi 3, 4, 5 with a 64-bit system, ARM NAS) | `fcd-<version>-aarch64-unknown-linux-musl.tar.gz` |
| Linux on ARMv7 with a 32-bit system (Raspberry Pi 2 and newer) | `fcd-<version>-armv7-unknown-linux-musleabihf.tar.gz` |
| Mac with Apple Silicon (M1 and newer) | `fcd-<version>-aarch64-apple-darwin.tar.gz` |
| Mac with Intel | `fcd-<version>-x86_64-apple-darwin.tar.gz` |
| Windows (64-bit) | `fcd-<version>-x86_64-pc-windows-msvc.zip` |
| Docker or Podman | image `registry.example.org/family-chat/fcd` (section [Docker](#docker)) |

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
INFO fcd 0.1.0, папка данных /var/lib/family-chat
INFO слушаю 0.0.0.0:8787 (HTTP)
INFO откройте http://192.168.1.10:8787/ (приложение)
INFO откройте http://192.168.1.10:8787/server/ (проверка сервера)
INFO первый запуск: папка данных создана
INFO код администратора: 7K3D-XXXX-XXXX-XXXX
INFO дальше: откройте приложение, нажмите «Настроить для своей семьи» и введите этот код
```

The **administrator code** (`код администратора`) is shown once; keep it. Then:

1. Set up HTTPS (next section) and open the server address in a phone or computer browser. Without HTTPS the app
   works only on the same computer at `http://localhost:8787/`.
2. Press «Настроить для своей семьи» (set up for your family), enter the server address and the code.
3. Enter your name, write down the 24 recovery words (the app checks three of them) and create the first
   invitation. Whoever joins with the code becomes the administrator.

To stop: Ctrl+C or SIGTERM. The server waits for open requests for at most 10 seconds. A second instance on the
same folder refuses to start and says so.

### Lost code

Stop the server and issue a new code; the old one stops working:

```sh
fcd reset-admin-code --data /var/lib/family-chat
```

The code works once: whoever joins with it becomes an administrator and the code stops working. A new code from
`reset-admin-code` is one-time as well; it helps when every administrator has lost access. Relatives join with
invitations.

### A second administrator

An administrator issues invitations, disconnects members and sees disk usage. To make another member an
administrator, run with the server stopped:

```sh
fcd admin list --data /var/lib/family-chat
fcd admin add <userId> --data /var/lib/family-chat
```

`fcd admin list` shows each member's `userId`, name and role.

## Settings

Settings come from flags or from `config.toml` in the data folder. The file is written on first start; flags win
over the file. Restart the server after editing it.

| Flag | In `config.toml` | Default | Meaning |
|---|---|---|---|
| `--port` | `port` | `8787` | port |
| `--listen` | `listen` | `0.0.0.0` | address; `127.0.0.1` when the proxy is on the same computer |
| `--family-name` | `family_name` | `Семья` | family name everyone sees |
| `--retention-days` | `retention_days` | `90` | how many days the server keeps messages and files (7 to 90) |
| `--max-file-mb` | `max_file_mb` | `200` | size limit of one file, MB |
| `--push` | `push` | `true` | notifications; `false`: the server never contacts outside addresses |
| `--trust-forwarded-for` | `trust_forwarded_for` | `false` | take the client address from `X-Forwarded-For` (only behind a proxy) |
| | `push_subject` | `mailto:fcd-admin@example.org` | contact for the Apple, Google and Mozilla push services |
| | `min_free_mb` | `100` | below this much free space the server refuses new data |
| `--tls-cert`, `--tls-key` | | | HTTPS with your own certificate files |
| `--m0` | | | check endpoints of the `/server/` page |

The full list with explanations: `fcd --help`. Detailed log: environment variable `RUST_LOG=debug`.

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
  with `--trust-forwarded-for true`. Without a proxy leave it off: anyone can forge the header.

If the proxy runs on the same computer, start the server with `--listen 127.0.0.1` so that nobody can bypass the
proxy.

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
[server check page](#the-server-check-page-server).

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
  registry.example.org/family-chat/fcd:latest
docker logs fcd 2>&1 | grep 'код администратора'
```

Server flags go after the image name, for example `... fcd:latest --trust-forwarded-for true`. If you change the
port with a flag rather than in `config.toml`, the health check does not know it: change the port in `config.toml`
or set your own check `fcd healthcheck --data /data --port <port>`.

A named volume (`fcd-data`) is easier than a folder: Docker gives it the right owner. If you want a folder on disk,
make user 65534 its owner: `sudo chown 65534:65534 /srv/family-chat`.

Docker Compose, the [compose.yaml](../../compose.yaml) file in the repository root:

```yaml
services:
  fcd:
    image: registry.example.org/family-chat/fcd:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - fcd-data:/data
    stop_grace_period: 20s

volumes:
  fcd-data:
```

Server commands in a container (with the server stopped):

```sh
docker stop fcd
docker run --rm -v fcd-data:/data registry.example.org/family-chat/fcd:latest reset-admin-code
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
Image=registry.example.org/family-chat/fcd:latest
ContainerName=fcd
PublishPort=127.0.0.1:8787:8787
Volume=fcd-data:/data
AutoUpdate=registry
HealthCmd=["/fcd", "healthcheck", "--data", "/data"]
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
ExecStart=/usr/local/bin/fcd --data /var/lib/family-chat --listen 127.0.0.1
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

`--listen 127.0.0.1` fits when the proxy is on the same computer; otherwise drop the flag. Commands with the
service stopped: `sudo systemctl stop fcd`, then `sudo -u fcd fcd reset-admin-code --data /var/lib/family-chat`,
then `sudo systemctl start fcd`.

## Windows and macOS

On Windows, unpack the archive and run `fcd.exe --data C:\FamilyChat` in a terminal; Ctrl+C stops it. There is no
Windows service included; Task Scheduler can start it automatically. On macOS the server runs as on Linux. On
Windows the data folder is protected by the permissions of your account; the server does not set the `0600` and
`0700` permissions it uses on Linux and macOS.

## Updating

The data folder format has a version number. A new server upgrades an older folder by itself; an older server does
not start on a newer folder. So make a backup before updating (next section): it is the only way back.

- **Binary:** stop the server, replace `fcd`, start.
- **Docker:** `docker pull registry.example.org/family-chat/fcd:latest`, then remove and recreate the container
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
- Used and free space are shown to the administrator in the app: «Настройки», «Семья и сервер» (Settings, Family
  and server).

## Members

- **Invitations** are issued by an administrator under «Настройки», «Семья и сервер», «Приглашения». Each works for
  one person for 7 days and only once. A revoked invitation stops working at once.
- **Disconnecting a member** happens there too. Their devices stop receiving and sending at once; history already
  received stays with everyone. Owners of groups they were in get a service message.
- Wrong codes and signatures are limited: at most 10 failures per minute from one address.

## The server check page `/server/`

`https://<your server>/server/` opens the check page. It helps during the first setup and when something does not
work:

- "the server answers": family name, version, retention, the clock difference between device and server;
- "check the long request": whether a 25-second wait gets through your proxy or tunnel. If it breaks earlier,
  raise the proxy's timeout;
- "enable notifications" and "send a test": whether notifications reach this phone.

The long request and the test notification work only when the server runs with `--m0`, and they need the
administrator code. Restart the server without `--m0` afterwards. There is also a device check page, `/device/`:
what this phone's browser can do.

## Is the server alive

`fcd healthcheck` asks the server on the same computer and exits with code 0 if it answers and 1 if not. The port
comes from `--port` or from `config.toml` in `--data`; it also works with `--tls-cert`:

```sh
fcd healthcheck --data /var/lib/family-chat
```

## What has been tested

The server, app and browser end-to-end tests pass in CI (Linux) and on macOS during preparation. The release
workflow builds archives for every system in the table above. Not every build has run on real hardware yet: what
exactly was checked for each is recorded in [CHANGELOG.md](../../CHANGELOG.md). If you run the server on a router,
NAS or single-board computer, please tell us how it went.
