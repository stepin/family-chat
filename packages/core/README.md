# @family-chat/core

Клиентское ядро этапа M1 без интерфейса и без DOM: клиент API сервера `fcd`, локальная база (IndexedDB через Dexie), вход и идентичность, синхронизация длинным запросом, очередь отправки, список участников, администрирование, push и фасад для интерфейса. Работает в странице, воркере и service worker (нужны `fetch`, IndexedDB, WebCrypto и таймеры).

Контракт с сервером: `docs/API.md`; криптография: `docs/PROTOCOL.md` и пакет `@family-chat/protocol`.

## Как пользоваться из интерфейса

```ts
import { createCore } from '@family-chat/core';

const core = createCore();          // одна на приложение
await core.start();                 // открыть базу, запустить синхронизацию всех серверов

// Вход
const info = await core.serverInfo(location.origin);          // adminCodeActive, familyName
const acc = await core.join({ serverUrl: location.origin, code: { invite }, name: 'Мама' });
// или { adminCode } для первого администратора; core.restore({ serverUrl, phrase }) на новом устройстве
const phrase = await core.recoveryPhrase(acc.userId);         // показать один раз

// Состояние: обычные Svelte-совместимые хранилища ($core.chats в компоненте)
core.accounts; core.connection; core.chats; core.outbox; core.drafts; core.diagnostics;
const members = core.members(acc.id);

// Чат
const chatId = await core.openChat(acc.id, peerUserId);
const view = core.chat(acc.id, chatId);   // view.messages, view.loadOlder(), view.markRead()
await core.send(acc.id, chatId, 'Привет');
```

`core.accountList()` читает учётные записи один раз (живое хранилище отдаёт первое значение асинхронно), `core.logDiagnostic(level, kind, message)` пишет строку интерфейса в журнал диагностики (без секретов).

Каждое хранилище имеет `subscribe(fn)` (вызывает `fn` сразу и при каждом изменении, возвращает функцию отписки) и `get()`. Изменения из других вкладок приходят через живые запросы Dexie.

Состояние связи (`core.connection`, по `accountId`): `connecting`, `connected`, `offline` (с `since`), `login-invalid` (кнопка «Войти заново» вызывает `core.relogin(accountId)`), `removed`, `stopped`.

Статусы сообщения: `on-device` (в очереди), `on-server` (сервер принял, есть `gseq` и время сервера), `failed` (`core.retry` или `core.cancel`).

Service worker на push вызывает `handlePushPayload(event.data.json())` и получает либо `{kind: 'message', senderName, text?}`, либо `{kind: 'generic'}` («Новое сообщение»). Текст есть, только если включена настройка `SETTING_PUSH_SHOW_TEXT`.

## Тесты

```bash
pnpm --filter @family-chat/core test        # модульные (Vitest, fake-indexeddb, поддельный сервер в памяти)
pnpm test:integration                       # из корня: против настоящего fcd
```

`pnpm test:integration` собирает `apps/web/dist` (если его нет) и `fcd` (`cargo build`), затем запускает `test/m1.integration.test.ts`: каждый прогон поднимает `fcd` на временной папке и порту, выбранном системой, с `--push false`. Готовый бинарник можно передать через `FCD_BIN=/путь/к/fcd`, тогда сборка пропускается.

