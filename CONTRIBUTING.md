# Как участвовать

Спасибо, что заглянули. Здесь: как собрать проект, как его проверить, где что лежит и как менять протокол.
Документация для пользователей лежит в `docs/` и собирается в сайт, см. [README.md](README.md).

## Что нужно

- Node.js 22 или новее и pnpm 11 (`corepack enable` включит нужную версию из `package.json`).
- Rust stable (`rustup` или пакет системы) с `rustfmt` и `clippy`.
- Для тестов в браузере: Chromium для Playwright, `pnpm --filter @family-chat/web exec playwright install chromium`.

## Сборка

```sh
pnpm install
pnpm build                                            # protocol, core, web, site
cargo build --locked --manifest-path server/Cargo.toml
```

`fcd` встраивает собранное приложение из `apps/web/dist`, поэтому сначала `pnpm build` (или
`pnpm --filter @family-chat/web build`). Без него `cargo build` остановится с понятной ошибкой.

Для разработки интерфейса удобно запустить сервер с приложением с диска: `fcd --data /tmp/fc --web-dir apps/web/dist`
и пересобирать `apps/web` (`pnpm --filter @family-chat/web build --watch`).

## Проверки

Все команды из корня репозитория; в CI выполняются они же (`.github/workflows/ci.yml`).

```sh
pnpm typecheck
pnpm test
pnpm build
cd server
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
cd ..
FCD_BIN=$PWD/server/target/debug/fcd pnpm test:integration
FCD_BIN=$PWD/server/target/debug/fcd pnpm test:e2e
FCD_BIN=$PWD/server/target/debug/fcd pnpm test:e2e:fcd
pnpm test:e2e:site
```

- `pnpm test`: модульные тесты протокола (и независимая проверка векторов), ядра, приложения и сайта (сборка,
  ссылки, примеры из `deploy/` в документации).
- `pnpm test:e2e`: несколько браузеров-родственников против настоящего `fcd`; любые нарушения CSP и ошибки страницы
  валят тест, ключевые экраны проверяются axe.
- `pnpm test:e2e:site`: страницы сайта в светлой и тёмной теме, на 360 px и на компьютере, axe, клавиатура, нет
  запросов к другим сайтам; пункты меню на одной высоте; приложения на сайте нет (оно открывается только со своего
  сервера).
- Долгие проверки отдельно: `pnpm test:e2e:big` (файл 200 МБ), `pnpm --filter @family-chat/web run test:e2e:perf`
  (поиск по 50 000 сообщений).

## Где что лежит

| Путь | Что |
|---|---|
| `server/src/` | `fcd`: `lib.rs` (флаги, запуск), `app.rs` (маршруты), `api.rs`, `groups.rs`, `blobs.rs`, `packs.rs` (запросы), `check.rs` (проверка сервера), `store.rs` (состояние и единственный писатель), `eventlog.rs` (журнал по дням), `datadir.rs` (папка данных, блокировка), `webpush.rs`, `tls.rs`, `headers.rs` (CSP), `healthcheck.rs` |
| `server/src/client/` | клиентская часть протокола на Rust: ключи, конверты, события, группы, вложения |
| `server/src/mcp/` | MCP: `http.rs` (адрес `/mcp`), `conn.rs` и `manage.rs` (подключения), `view.rs` (расшифрованное представление чатов), `tools/` (инструменты), `files.rs` и `media.rs` (файлы), `coverage.rs` (какая возможность приложения каким инструментом покрыта) |
| `server/tests/` | интеграционные тесты: сервер в процессе или настоящий бинарник на временной папке |
| `packages/protocol/` | идентичность, ключи, шифрование, конверты, группы, архив; без ввода-вывода |
| `packages/core/` | ядро клиента: транспорт, IndexedDB (Dexie), синхронизация, очередь отправки, поиск |
| `apps/web/` | приложение на Svelte 5; `e2e/` и `e2e-fcd/` с Playwright |
| `apps/site/` | сайт: `build.mjs`, `check.mjs`, `src/` (главные страницы, стили), `screenshots/`, `e2e/` |
| `docs/` | документация (источник для сайта), протокол, API, векторы |
| `deploy/`, `compose.yaml`, `Dockerfile` | примеры установки; тест сайта следит, чтобы они совпадали с `docs/ADMIN.md` |
| `scripts/release.sh` | сборка архивов выпуска |

## Изменения протокола и тестовые векторы

Протокол описан в [docs/PROTOCOL.md](docs/PROTOCOL.md), API сервера в [docs/API.md](docs/API.md). Правила:

1. Сначала документ: что меняется в формате, почему, как это совместимо со старыми клиентами и папкой данных.
2. Тестовые векторы лежат в `docs/vectors/` и генерируются детерминированно:
   `pnpm --filter @family-chat/protocol run vectors:generate`. Модульные тесты протокола читают те же файлы,
   а `vectors:verify` проверяет их независимой реализацией на `node:crypto`. Сервер сверяется с ними в
   `server/tests/vectors.rs`.
3. Любое изменение формата идёт с отрицательными векторами: что должно быть отвергнуто.
4. У клиентской части протокола две реализации: `packages/protocol` (TypeScript, приложение) и `server/src/client/`
   (Rust, сервер действует ею за личности, подключённые по MCP). Изменение протокола меняет обе в одном изменении,
   вместе с векторами: `server/tests/client_vectors.rs` сверяет с ними реализацию на Rust байт в байт. Их работу
   друг с другом на настоящем сервере проверяет `packages/core/test/mcp.integration.test.ts`.
5. Изменение папки данных сервера: номер формата (`FORMAT_VERSION` в `server/src/datadir.rs`) растёт, если старый
   сервер не сможет работать с новой папкой; обновление старой папки покрывается тестом (`server/tests/upgrade.rs`).
6. Content-Security-Policy приложения задана в `apps/web/vite.config.ts` и в `server/src/headers.rs`; тест сервера
   следит, чтобы они совпадали.

## Стиль

- Rust: `cargo fmt` (настройки в `server/rustfmt.toml`), `clippy` без предупреждений.
- TypeScript: строгий режим, `svelte-check` без предупреждений.
- Тексты интерфейса только в `apps/web/src/lib/strings.ts`.
- Тексты для людей (интерфейс, документация, сайт): простые и конкретные; без длинного тире, вместо него запятая,
  двоеточие, точка или скобки. Тест сайта это проверяет.
- Новые зависимости только когда без них никак, и никаких, что обращаются к сети сами.
- Новый маршрут API получает строку в `server/src/mcp/coverage.rs`: инструмент MCP или причину, почему его нет. Без
  неё тест сервера не пройдёт.

## Выпуск

Как собрать и опубликовать версию: [docs/RELEASING.md](docs/RELEASING.md).

## Иконка

Источник иконки: `docs/design/icon.png`. Все размеры (`apps/web/public/icon.svg`, `icon-192.png`, `icon-512.png`,
`apple-touch-icon.png`, `favicon-32.png`, `badge-96.png` и `icon-maskable-512.png`, если нужен) делает скрипт
`node apps/web/scripts/make-icons.mjs`. Ему нужен ImageMagick 7 (`brew install imagemagick` или
`apt install imagemagick`); запускается вручную, готовые файлы коммитятся, сборке и CI ImageMagick не нужен.
