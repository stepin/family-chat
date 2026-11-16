# Family Chat

Семейный чат со сквозным шифрованием на своём сервере. Сервер `fcd` (один исполняемый файл на Rust, без базы
данных) запускается дома, хранит только шифр и не дольше 90 дней, и сам отдаёт веб-приложение (PWA) для iPhone,
Android и компьютера. Вход по приглашению, без номеров телефонов. История живёт на устройствах.

*In English:* an end-to-end encrypted family chat on your own server. One Rust binary with the web app built in,
no database, messages kept on the server for at most 90 days. The app and the server speak Russian and English. Documentation in
English: [installation](docs/en/ADMIN.md), [family guide](docs/en/FAMILY.md), [security](docs/en/SECURITY-MODEL.md),
[FAQ](docs/en/FAQ.md).

## Статус

Версия 0.1, первая публичная. Сделано всё задуманное для первой версии: личные чаты и группы, файлы до 200 МБ,
голосовые, место, реакции, ответы, правка, удаление, пересылка, поиск, стикеры, уведомления, несколько семей,
архив переписки. Криптография собственная и **не проходила независимый аудит**. На роутерах, NAS и одноплатных
компьютерах сервер пока проверялся мало. Формат папки данных и API могут меняться; сервер сам обновляет папку
старой версии.

## Быстрый старт

Docker (образ `ghcr.io/stepin/fcd`; `latest` это последний выпуск, для закрепления берите тег версии, например
`ghcr.io/stepin/fcd:0.1.0`):

```sh
docker run -d --name fcd --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v fcd-data:/data \
  ghcr.io/stepin/fcd:latest
docker logs fcd 2>&1 | grep -E 'код администратора|admin code'
```

Готовый файл для своей системы со страницы выпусков (https://github.com/stepin/family-chat/releases):

```sh
tar xzf fcd-<версия>-x86_64-unknown-linux-musl.tar.gz
./fcd-<версия>-x86_64-unknown-linux-musl/fcd --data ./family-chat-data
```

При первом запуске сервер печатает адрес и одноразовый код администратора. Приложению нужен HTTPS: поставьте перед
сервером обратный прокси (Caddy, nginx, NAS) или дайте ему свои файлы сертификата. Затем откройте адрес, нажмите
«Настроить для своей семьи» и введите код. Подробно: [установка сервера](docs/ADMIN.md).

Настройки сервера задаются флагами, переменными окружения `FCD_*` (например `FCD_PORT`, `FCD_LANG`) или в
`config.toml` папки данных; порядок: флаг, переменная, файл. Список: `fcd --help` и [установка сервера](docs/ADMIN.md).

## Документация

Источник документации один: Markdown в `docs/`. Тот же текст собирается в сайт проекта (`apps/site`).

| Для кого | Документ |
|---|---|
| Администратор | [Установка сервера](docs/ADMIN.md): загрузка, Docker, Podman, systemd, HTTPS, обновление, резервная копия |
| Семья | [Памятка для семьи](docs/FAMILY.md): приглашение, iPhone и Android, 24 слова, архив, несколько семей |
| Все | [Безопасность](docs/SECURITY-MODEL.md): что видит сервер и от чего шифрование не защищает |
| Все | [Вопросы и решения](docs/FAQ.md) |
| Разработчики | [Протокол](docs/PROTOCOL.md), [API сервера](docs/API.md), [CONTRIBUTING.md](CONTRIBUTING.md) |
| Выпуск | [docs/RELEASING.md](docs/RELEASING.md), [CHANGELOG.md](CHANGELOG.md) |
| Уязвимости | [SECURITY.md](SECURITY.md) |

План проекта: [`docs/PLAN-v2.md`](docs/PLAN-v2.md) поверх [`docs/PLAN.md`](docs/PLAN.md), отложенное:
[`TODOS.md`](TODOS.md).

## Разработка

Нужны Node.js 22 или новее, pnpm 11 и Rust (stable).

```sh
pnpm install
pnpm typecheck
pnpm test                 # модульные тесты всех пакетов и сайта
pnpm build                # протокол, ядро, веб-приложение, сайт
cd server && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cd ..
pnpm test:integration     # ядро против настоящего fcd
pnpm test:e2e             # приложение в Chromium против настоящего fcd (Playwright)
pnpm test:e2e:fcd         # страница /server/ против настоящего fcd
pnpm test:e2e:site        # сайт: доступность, клавиатура, 360 px, меню, без приложения
pnpm site:preview         # собранный сайт на http://127.0.0.1:4180/
```

Тесты с `fcd` сами собирают приложение и сервер; готовый бинарник можно передать через `FCD_BIN=/путь/к/fcd`.
Подробнее о сборке, тестах и изменениях протокола: [CONTRIBUTING.md](CONTRIBUTING.md).

## Устройство репозитория

```
server              сервер fcd на Rust: API, хранение, очистка, Web Push, встроенное приложение
packages/protocol   идентичность, шифрование, форматы событий (TypeScript, без ввода-вывода)
packages/core       ядро клиента без DOM: API, локальная база, синхронизация, очередь отправки
apps/web            веб-приложение (Svelte 5, PWA); страницы проверки /device/ и /server/
apps/site           сайт проекта (https://stepin.github.io/family-chat/): страницы из docs/, снимки экрана
docs                документация, протокол, API, тестовые векторы
deploy              примеры: systemd, Podman Quadlet, Caddy, nginx
scripts             сборка выпуска (release.sh)
Dockerfile          образ сервера (scratch, несколько архитектур); compose.yaml рядом
```

## Лицензия

MIT, текст в [LICENSE](LICENSE).
