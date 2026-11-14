# Family Chat

Семейный чат со сквозным шифрованием. Сервер `fcd` (Rust) запускается дома, хранит только шифртекст не дольше 90
дней и сам отдаёт веб-клиент (PWA) со своего адреса. План: [`docs/PLAN-v2.md`](docs/PLAN-v2.md) (поверх
[`docs/PLAN.md`](docs/PLAN.md)), отложенное: [`TODOS.md`](TODOS.md).

Этап M1: администратор настраивает семью и приглашает родственников ссылкой, родственники переписываются в личных
чатах с телефонов. Документы: API сервера [`docs/API.md`](docs/API.md), криптография
[`docs/PROTOCOL.md`](docs/PROTOCOL.md), проверка сервера и HTTPS [`docs/M0v2.md`](docs/M0v2.md).

## Запуск

```bash
fcd --data /path/to/family-chat-data
```

При первом запуске сервер печатает адрес и код администратора. Откройте адрес по HTTPS (обратный прокси, см.
`docs/M0v2.md`), нажмите «Настроить для своей семьи» и введите код. Образ Docker собирается из корня: `Dockerfile`.

## Структура

```
server              сервер fcd на Rust: API, хранение, очистка, Web Push, встроенный клиент
packages/protocol   идентичность, шифрование, форматы событий
packages/core       ядро клиента без DOM: API, локальная база, синхронизация, очередь отправки
apps/web            веб-клиент (Svelte 5, PWA); страницы проверки /device/ и /server/
apps/site           статичный сайт (заглушка до M6)
```

## Разработка

Нужны Node 22+, pnpm 11, Rust (stable).

```bash
pnpm install
pnpm typecheck
pnpm test                 # модульные тесты всех пакетов
pnpm build
pnpm test:integration     # ядро против настоящего fcd
pnpm test:e2e             # клиент в Chromium против настоящего fcd (Playwright)
pnpm test:e2e:fcd         # страница /server/ против fcd --m0
cd server && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

`pnpm test:e2e` сам собирает клиент и `fcd`; готовый бинарник можно передать через `FCD_BIN=/путь/к/fcd`.

Лицензия: MIT.
