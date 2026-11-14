# Family Chat

Семейный чат, где сервером служит папка WebDAV на домашнем роутере, а клиент это PWA. Сообщения шифруются на
клиенте. План: [`docs/PLAN.md`](docs/PLAN.md), отложенное: [`TODOS.md`](TODOS.md).

План сменился: сервером становится собственная программа `fcd` на Rust ([`docs/PLAN-v2.md`](docs/PLAN-v2.md)).
Этап M0v2 (сервер, HTTPS, уведомления): [`docs/M0v2.md`](docs/M0v2.md), код сервера в `server/`.

Прежний этап M0: зонд совместимости сервера и проверка устройства. Как провести M0 на своём роутере:
[`docs/M0.md`](docs/M0.md). Рецепты прокси с CORS: [`docs/recipes`](docs/recipes/README.md).

## Структура

```
server              сервер fcd на Rust (M0v2: /v1/hello, проверки, Web Push, встроенный клиент)
packages/protocol   форматы и криптография (с M1)
packages/core       интерфейс Storage и его реализация для WebDAV
apps/web            клиент (PWA); сейчас /server/, /device/ и /probe/
apps/site           статичный сайт (заглушка до M6)
tools/dav-dev       WebDAV-серверы и прокси в Docker для тестов
docs/recipes        Caddy и nginx: CORS перед WebDAV роутера
```

## Разработка

Нужны Node 22+, pnpm 11, Docker.

```bash
pnpm install
pnpm typecheck
pnpm test               # юнит-тесты
pnpm build
pnpm dav:up             # WebDAV-серверы в Docker
pnpm test:integration   # Storage против серверов
pnpm test:e2e           # зонд в браузерах против серверов
cargo test --manifest-path server/Cargo.toml   # сервер (после pnpm build)
pnpm test:e2e:fcd       # страница /server/ против настоящего fcd
```

Лицензия: MIT.
