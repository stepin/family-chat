# Установка сервера

Эта страница для администратора: того, кто запускает сервер `fcd` для своей семьи. Нужно уметь открыть терминал и
выполнить несколько команд. Что делать остальным членам семьи, написано в [памятке для семьи](FAMILY.md).

## Что понадобится

- **Компьютер, который работает круглосуточно**: мини-ПК, NAS, Raspberry Pi, домашний сервер или VPS. Сервер это
  одна программа `fcd` и одна папка с данными, базы данных нет. Памяти ему нужно немного.
- **HTTPS с настоящим сертификатом.** Браузер без HTTPS не даст приложению шифровать, присылать уведомления и
  устанавливаться на экран телефона. Чаще всего HTTPS даёт обратный прокси (раздел [HTTPS](#https)).
- **Доступ из интернета**, если родственники будут писать не только из дома: проброс порта на роутере, VPS или туннель.
- **Место на диске.** Текст занимает мало; место определяют фото и файлы за срок хранения (по умолчанию 90 дней).

## Скачать

Готовые файлы публикуются на странице выпусков: https://code.example.org/family-chat/releases. Рядом лежит файл
`SHA256SUMS` с контрольными суммами. Выберите файл под своё устройство:

| Устройство | Файл |
|---|---|
| Linux на Intel или AMD (мини-ПК, NAS, VPS) | `fcd-<версия>-x86_64-unknown-linux-musl.tar.gz` |
| Linux на ARM64 (Raspberry Pi 3, 4, 5 с 64-битной системой, ARM-NAS) | `fcd-<версия>-aarch64-unknown-linux-musl.tar.gz` |
| Linux на ARMv7 с 32-битной системой (Raspberry Pi 2 и новее) | `fcd-<версия>-armv7-unknown-linux-musleabihf.tar.gz` |
| Mac с Apple Silicon (M1 и новее) | `fcd-<версия>-aarch64-apple-darwin.tar.gz` |
| Mac с Intel | `fcd-<версия>-x86_64-apple-darwin.tar.gz` |
| Windows (64 бита) | `fcd-<версия>-x86_64-pc-windows-msvc.zip` |
| Docker или Podman | образ `registry.example.org/family-chat/fcd` (раздел [Docker](#docker)) |

Какой у вас процессор в Linux, показывает команда `uname -m`: `x86_64`, `aarch64` или `armv7l`. Сборки для Linux
статические: им не нужны библиотеки системы, подходит любой дистрибутив.

Проверка и распаковка (Linux и macOS):

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar xzf fcd-<версия>-x86_64-unknown-linux-musl.tar.gz
sudo install fcd-<версия>-x86_64-unknown-linux-musl/fcd /usr/local/bin/fcd
fcd --version
```

На macOS вместо `sha256sum` есть `shasum -a 256 --check --ignore-missing SHA256SUMS`. Файлы не подписаны
сертификатом Apple; если macOS не даёт запустить скачанный `fcd`, снимите отметку о загрузке:
`xattr -d com.apple.quarantine fcd`.

### Сборка из исходного кода

Пока выпусков нет, сервер собирается из исходников. Нужны Node.js 22 или новее, pnpm 11 и Rust (stable).

```sh
pnpm install
pnpm build
cargo build --release --locked --manifest-path server/Cargo.toml
# готовый файл: server/target/release/fcd
```

Веб-приложение встраивается в `fcd`, поэтому `pnpm build` идёт первым. Архивы для других систем собирает
`scripts/release.sh` (подробности в [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Первый запуск

```sh
fcd --data /var/lib/family-chat
```

`--data` это папка данных. При первом запуске сервер создаёт её и пишет в журнал (в терминал) примерно такое:

```
INFO fcd 0.1.0, папка данных /var/lib/family-chat
INFO слушаю 0.0.0.0:8787 (HTTP)
INFO откройте http://192.168.1.10:8787/ (приложение)
INFO откройте http://192.168.1.10:8787/server/ (проверка сервера)
INFO первый запуск: папка данных создана
INFO код администратора: 7K3D-XXXX-XXXX-XXXX
INFO дальше: откройте приложение, нажмите «Настроить для своей семьи» и введите этот код
```

**Код администратора** показывается один раз, сохраните его. Дальше:

1. Настройте HTTPS (следующий раздел) и откройте адрес сервера в браузере телефона или компьютера. Без HTTPS
   приложение работает только на том же компьютере по адресу `http://localhost:8787/`.
2. Нажмите «Настроить для своей семьи», введите адрес сервера и код.
3. Назовите себя, запишите 24 слова для восстановления (приложение проверит три из них) и создайте первое
   приглашение. Тот, кто вошёл по коду, становится администратором.

Остановка: Ctrl+C или сигнал SIGTERM. Сервер дожидается открытых запросов не дольше 10 секунд. Второй экземпляр
на той же папке не запустится и скажет об этом.

### Если код потерян

Остановите сервер и выпустите новый код, старый перестанет действовать:

```sh
fcd reset-admin-code --data /var/lib/family-chat
```

Код одноразовый: кто вошёл по нему, становится администратором, и код перестаёт действовать. Новый код из
`reset-admin-code` тоже одноразовый; он пригодится, если все администраторы потеряли доступ. Родственники входят по
приглашениям.

### Второй администратор

Администратор выпускает приглашения, отключает участников и видит место на диске. Сделать администратором ещё одного
участника можно командой при остановленном сервере:

```sh
fcd admin list --data /var/lib/family-chat
fcd admin add <userId> --data /var/lib/family-chat
```

`fcd admin list` показывает `userId`, имя и роль каждого участника.

## Настройки

Каждую настройку можно задать тремя способами: флагом, переменной окружения или строкой в `config.toml` в папке
данных. Порядок: **флаг, затем переменная окружения, затем `config.toml`, затем значение по умолчанию**. Переменная
ведёт себя так же, как её флаг: оба важнее файла, а при первом запуске действующие значения (из флагов, переменных и
значений по умолчанию) записываются в новый `config.toml`; позже изменённые флаги и переменные туда не пишутся.
Пустая переменная считается незаданной. Логические значения: `true`, `false`, `1` или `0`; неверное значение
останавливает сервер с ошибкой, в которой названа переменная. После любых изменений перезапустите сервер.

| Флаг | Переменная окружения | В `config.toml` | По умолчанию | Что это |
|---|---|---|---|---|
| `--data` | `FCD_DATA` | | | папка данных (нужна для запуска; в образе Docker `/data`) |
| `--port` | `FCD_PORT` | `port` | `8787` | порт |
| `--listen` | `FCD_LISTEN` | `listen` | `0.0.0.0` | адрес; `127.0.0.1`, если прокси на том же компьютере |
| `--family-name` | `FCD_FAMILY_NAME` | `family_name` | `Семья` (по-английски `Family`) | имя семьи, его видят все |
| `--retention-days` | `FCD_RETENTION_DAYS` | `retention_days` | `90` | сколько дней сервер хранит сообщения и файлы (от 7 до 90) |
| `--max-file-mb` | `FCD_MAX_FILE_MB` | `max_file_mb` | `200` | предел размера одного файла, МБ |
| `--push` | `FCD_PUSH` | `push` | `true` | уведомления; `false`: сервер не обращается ни к каким внешним адресам |
| `--trust-forwarded-for` | `FCD_TRUST_FORWARDED_FOR` | `trust_forwarded_for` | `false` | брать адрес клиента из `X-Forwarded-For` (только за прокси) |
| `--lang` | `FCD_LANG` | `lang` | см. ниже | язык сообщений сервера: `ru` или `en` |
| `--tls-cert`, `--tls-key` | `FCD_TLS_CERT`, `FCD_TLS_KEY` | | | HTTPS со своими файлами сертификата (нужны оба) |
| `--web-dir` | `FCD_WEB_DIR` | | | отдавать приложение из папки (для разработки) |
| `--m0` | `FCD_M0` | | `false` | проверочные точки страницы `/server/` |
| | | `push_subject` | `mailto:fcd-admin@example.org` | контакт для push-сервисов Apple, Google и Mozilla |
| | | `min_free_mb` | `100` | когда свободного места меньше, сервер не принимает новое |

Команды `healthcheck`, `reset-admin-code` и `admin` читают те же переменные, где они имеют смысл (`FCD_DATA`,
`FCD_PORT`, `FCD_LISTEN`, `FCD_LANG`). Другие имена `FCD_*` не мешают (`FCD_GIT_COMMIT` и `FCD_BIN` нужны сборке и
тестам).

**Язык.** Всё, что печатает сервер (строки при запуске, журнал, `fcd --help`, ошибки, `reset-admin-code`, `admin`,
`healthcheck`), бывает по-русски и по-английски: `--lang`, иначе `FCD_LANG`, иначе `lang` в `config.toml`, иначе
язык системы (`LC_ALL`, `LC_MESSAGES`, `LANG`), иначе русский. Несколько редких ошибок командной строки приходят из
библиотеки `clap` и остаются английскими.

Полный список с пояснениями: `fcd --help`. Подробный журнал: переменная окружения `RUST_LOG=debug`.

## HTTPS

Сервер слушает обычный HTTP. HTTPS даёт одно из двух: обратный прокси перед сервером (основной путь) или свои файлы
сертификата. Получать сертификат Let's Encrypt сам сервер не умеет.

### Обратный прокси

Прокси принимает HTTPS на вашем домене и пересылает запросы на `http://127.0.0.1:8787`. Что прокси должен
пропускать:

- **Долгие запросы.** Приложение ждёт новые сообщения в одном запросе до 30 секунд. Время ожидания ответа у прокси
  должно быть больше (например, 90 секунд), иначе связь будет постоянно рваться.
- **Тела до 5 МБ.** Файлы загружаются частями по 4 МиБ, каждая часть отдельным запросом.
- **Заголовок `X-Forwarded-For`**, чтобы ограничение частоты неверных кодов считало попытки по настоящим адресам.
  Тогда запускайте сервер с `--trust-forwarded-for true`. Без прокси этот флаг не включайте: заголовок может
  подделать кто угодно.

Если прокси работает на том же компьютере, запускайте сервер с `--listen 127.0.0.1`, чтобы мимо прокси к нему
нельзя было обратиться.

**Caddy** сам получает и продлевает сертификат Let's Encrypt, если домен указывает на ваш адрес и порты 80 и 443
проброшены на компьютер с Caddy. По умолчанию он не ограничивает ни время ответа, ни размер тела, поэтому хватает
трёх строк:

```
chat.example.org {
	reverse_proxy 127.0.0.1:8787
}
```

**nginx** (сертификат, например, от certbot):

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

Эти файлы лежат в репозитории: [deploy/caddy/Caddyfile](../deploy/caddy/Caddyfile),
[deploy/nginx/family-chat.conf](../deploy/nginx/family-chat.conf). Мы проверяли их чтением, но не запускали
против настоящего сервера.

**Другие варианты.** Обратный прокси в NAS (Synology, QNAP и другие) с сертификатом: назначение
`http://<адрес компьютера с fcd>:8787`. Cloudflare Tunnel: не нужен проброс портов, но HTTPS завершается у
Cloudflare, и Cloudflare видит запросы (переписка при этом остаётся зашифрованной). KeenDNS на роутерах Keenetic с
доменом на устройство в домашней сети: мы этот путь не проверяли. С любым вариантом проверьте долгий запрос на
странице [проверки сервера](#страница-проверки-server).

### Свои файлы сертификата

Если сертификат у вас уже есть (например, его выпускает роутер или скрипт ACME):

```sh
fcd --data /var/lib/family-chat --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

- Сертификат: цепочка в PEM, сначала сертификат сервера. Ключ: PEM (PKCS#8, PKCS#1 или SEC1).
- С этими флагами порт отвечает только по HTTPS (TLS 1.2 и 1.3).
- Сертификат читается при запуске: после продления файлов перезапустите сервер.
- Порт 443 в Linux доступен только привилегированным программам. Проще оставить порт 8787 и пробросить на роутере
  внешний порт 443 на внутренний 8787.

## Docker

Образ содержит только `fcd` (пустой образ `scratch`), работает от пользователя 65534 и хранит данные в томе
`/data`. Проверка здоровья встроена: `fcd healthcheck`.

```sh
docker run -d --name fcd --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v fcd-data:/data \
  registry.example.org/family-chat/fcd:latest
docker logs fcd 2>&1 | grep 'код администратора'
```

Настройки передаются переменными окружения, например `-e FCD_TRUST_FORWARDED_FOR=true` (флаги после имени образа
тоже работают: `... fcd:latest --trust-forwarded-for true`). Образ задаёт `FCD_DATA=/data`. Встроенная проверка
здоровья `fcd healthcheck` читает те же переменные, поэтому порт, изменённый через `-e FCD_PORT=...`, она тоже
знает; порт, изменённый флагом, нет, так что лучше переменная.

Именованный том (`fcd-data`) удобнее папки: Docker сам даёт ему нужного владельца. Если хотите папку на диске,
сделайте её владельцем пользователя 65534: `sudo chown 65534:65534 /srv/family-chat`.

Docker Compose, файл [compose.yaml](../compose.yaml) в корне репозитория:

```yaml
services:
  fcd:
    image: registry.example.org/family-chat/fcd:latest
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

Команды сервера в контейнере (при остановленном сервере):

```sh
docker stop fcd
docker run --rm -v fcd-data:/data registry.example.org/family-chat/fcd:latest reset-admin-code
docker start fcd
```

Образ собирается для `linux/amd64`, `linux/arm64` и `linux/arm/v7`.

## Podman Quadlet

Podman запускает контейнер как службу systemd по файлу `.container`. Для своего пользователя положите файл в
`~/.config/containers/systemd/fcd.container`, для всей системы в `/etc/containers/systemd/fcd.container`
([deploy/podman/fcd.container](../deploy/podman/fcd.container)):

```ini
[Unit]
Description=Family Chat server (fcd)

[Container]
Image=registry.example.org/family-chat/fcd:latest
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

`AutoUpdate=registry` вместе с таймером `podman-auto-update` раз в сутки проверяет, нет ли нового образа, и
перезапускает контейнер. `HealthCmd` записан массивом: в образе нет оболочки. Чтобы служба своего пользователя
работала без входа в систему, включите `loginctl enable-linger <пользователь>`. Этот файл мы не запускали: Podman
на машине подготовки не было.

## systemd без контейнера

Отдельный пользователь, папка данных и служба
([deploy/systemd/fcd.service](../deploy/systemd/fcd.service)):

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

`FCD_LISTEN=127.0.0.1` подходит, если прокси на этом же компьютере; иначе уберите эту строку. Другие настройки
кладите в `/etc/family-chat/fcd.env`, по одной `FCD_...=значение` в строке. Команды при остановленной службе:
`sudo systemctl stop fcd`, затем `sudo -u fcd fcd reset-admin-code --data /var/lib/family-chat`, затем
`sudo systemctl start fcd`.

## Windows и macOS

На Windows распакуйте архив и запустите в терминале `fcd.exe --data C:\FamilyChat`, остановка: Ctrl+C. Службы
Windows в комплекте нет; для автозапуска подойдёт Планировщик заданий. На macOS
сервер запускается так же, как в Linux. На Windows папка данных защищена правами вашей учётной записи, отдельных
прав `0600` и `0700`, как в Linux и macOS, сервер не ставит.

## Обновление

Формат папки данных имеет номер версии. Новый сервер сам обновляет папку старой версии; старый сервер на папке
новой версии не запустится. Поэтому перед обновлением сделайте резервную копию (следующий раздел): откатиться можно
только к ней.

- **Файл:** остановите сервер, замените `fcd`, запустите.
- **Docker:** `docker pull registry.example.org/family-chat/fcd:latest`, затем удалите и создайте контейнер заново
  с тем же томом (`docker compose pull && docker compose up -d`).
- **Podman Quadlet:** обновляется сам (`AutoUpdate=registry`) или командой `podman auto-update`.

Приложение встроено в сервер, поэтому после обновления сервера у всех появится предложение обновить приложение.

## Резервная копия и восстановление

Всё, что хранит сервер, лежит в папке данных. Копия делается при **остановленном** сервере:

```sh
sudo systemctl stop fcd
sudo tar czf family-chat-$(date +%F).tar.gz -C /var/lib family-chat
sudo systemctl start fcd
```

Для Docker с томом `fcd-data`:

```sh
docker stop fcd
docker run --rm -v fcd-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/fcd-data.tar.gz -C /data .
docker start fcd
```

Восстановление: остановите сервер, замените папку данных содержимым копии (с тем же владельцем), запустите. На
другом компьютере так же: копия переносит сервер целиком, вместе с адресами устройств и ключами уведомлений.

Что в копии: шифр сообщений и файлов, открытые ключи и профили участников (имена и фото профилей не шифруются),
кто в каком чате, ключ уведомлений `vapid.json`. Прочитать переписку по копии нельзя, но храните её так же бережно,
как саму папку. Если удалить `vapid.json`, сервер создаст новые ключи, и уведомления на всех устройствах перестанут
приходить, пока каждый не включит их заново.

Копия сервера не заменяет архив на устройствах: сервер хранит не больше срока хранения, а более ранняя переписка
есть только на телефонах и в файлах архива ([памятка для семьи](FAMILY.md#архив-переписки)).

## Срок хранения и место на диске

- Сервер хранит сообщения, служебные записи и файлы не дольше `retention_days` дней (от 7 до 90). Раз в час и при
  запуске он удаляет целые дни, которые старше срока. Часы сервера, убежавшие вперёд, не стирают всё: отсчёт идёт
  от меньшего из «сейчас» и «самое новое событие плюс 7 дней».
- Не удаляются: участники, профили, аватары, записи чатов, состояние групп, ключи групп и наборы стикеров. Они
  маленькие, и без них восстановленное устройство не прочтёт переписку.
- Место определяют файлы. Пример: семья присылает 50 фото в день по 300 КБ, это около 1,3 ГБ за 90 дней.
- Когда свободного места меньше `min_free_mb` (по умолчанию 100 МБ), сервер отвечает «нет места» на новые сообщения,
  файлы и вступления; приложение покажет «На сервере семьи кончается место». Освободите место или уменьшите срок
  хранения.
- Занятое и свободное место видно администратору в приложении: «Настройки», «Семья и сервер».

## Участники

- **Приглашение** выпускает администратор: «Настройки», «Семья и сервер», «Приглашения». Каждое действует для одного
  человека 7 дней и работает один раз. Отозванное приглашение перестаёт действовать сразу.
- **Отключить участника** можно там же. Его устройства сразу перестают получать и отправлять сообщения; уже
  полученная переписка остаётся у всех. Владельцы групп, где он был, получают об этом служебное сообщение.
- Неверные коды и подписи ограничены: не больше 10 ошибок в минуту с одного адреса.

## Страница проверки `/server/`

По адресу `https://<ваш сервер>/server/` открывается страница проверки. Она пригодится при первой настройке и когда
что-то не работает:

- «Сервер отвечает»: имя семьи, версия, срок хранения, расхождение часов устройства и сервера.
- «Проверить длинный запрос»: проходит ли ожидание 25 секунд через ваш прокси или туннель. Если запрос рвётся раньше,
  увеличьте время ожидания у прокси.
- «Включить уведомления» и «Прислать пробное»: доходят ли уведомления на этот телефон.

Длинный запрос и пробное уведомление работают, только если сервер запущен с флагом `--m0`, и требуют код
администратора. После проверки перезапустите сервер без `--m0`. Есть и страница проверки устройства `/device/`:
что умеет браузер этого телефона.

## Как убедиться, что сервер жив

`fcd healthcheck` спрашивает сервер на этом же компьютере и завершается с кодом 0, если он отвечает, и 1, если нет.
Порт берётся из флага `--port` или из `config.toml` в `--data`, работает и с `--tls-cert`:

```sh
fcd healthcheck --data /var/lib/family-chat
```

## Что проверено

Тесты сервера, приложения и сквозные тесты в браузере проходят в CI (Linux) и при подготовке на macOS. Архивы для
всех систем из таблицы выше собирает workflow выпуска. Запускались на настоящем оборудовании пока не все сборки:
что именно проверено для каждой, записано в [CHANGELOG.md](../CHANGELOG.md). Если вы запустили сервер на роутере, NAS или
одноплатном компьютере, расскажите, что получилось.
