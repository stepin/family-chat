# @family-chat/core

Клиентское ядро без интерфейса и без DOM (этап M2): клиент API сервера `fcd`, локальная база (IndexedDB через Dexie), вход и идентичность, синхронизация длинным запросом, очередь отправки, участники, группы с эпохами, чат с самим собой, вложения, аватары, отметка «проверен», отзыв идентичности, архив `.fcarchive`, администрирование, push и фасад для интерфейса. Работает в странице, воркере и service worker (нужны `fetch`, IndexedDB, WebCrypto и таймеры; для файлов по возможности OPFS).

Контракт с сервером: `docs/API.md`; криптография: `docs/PROTOCOL.md` и пакет `@family-chat/protocol`.

## Быстрый старт

```ts
import { createCore } from '@family-chat/core';

const core = createCore();          // одна на приложение
await core.start();                 // открыть базу, запустить синхронизацию всех серверов

// Вход
const info = await core.serverInfo(location.origin);                    // adminCodeActive, familyName, пределы
const check = await core.checkInvite(location.origin, code);            // до вступления: кто и куда приглашает
const acc = await core.join({ serverUrl: location.origin, code: { invite: code }, name: 'Мама' });
// acc.firstChatId: личный чат с пригласившим (уже открыт локально)
// { adminCode } для первого администратора; core.restore({ serverUrl, phrase }) на новом устройстве
const phrase = await core.recoveryPhrase(acc.userId);                   // показать один раз

// Список чатов: «Избранное» первым, затем группы и личные чаты по времени
core.chatList.subscribe((list) => { /* ChatSummary[] */ });

// Чат
const view = core.chat(acc.id, chatId);        // view.messages, view.loadOlder(), view.markRead()
await core.send(acc.id, chatId, 'Привет');     // только текст
await core.sendMessage(acc.id, chatId, { text: 'Фото', attachments: [{ data: file, name: file.name, mime: file.type }] });
```

Каждое хранилище имеет `subscribe(fn)` (вызывает `fn` сразу и при каждом изменении, возвращает функцию отписки) и `get()`; это обычные Svelte-совместимые хранилища (`$core.chatList` в компоненте). Изменения из других вкладок и воркеров приходят через живые запросы Dexie.

## Хранилища (живое состояние)

| Хранилище | Что в нём |
|---|---|
| `core.accounts` | `AccountView[]`: учётные записи без секретов. Новое в M2: `selfChatId`, `revoked`, `oldestTime`, `historyTrimmed` |
| `core.connection` | состояние связи по `accountId` (см. ниже) |
| `core.chatList` | `ChatSummary[]`: все чаты. `kind`: `self` (закреплён первым, `pinned: true`), `group`, `dm`. `title`: название группы или имя собеседника (`null` у «Избранного»: интерфейс пишет «Избранное»). `member: false` у группы, где я больше не участник |
| `core.chats` | `ChatListItem[]`: прежний список M1, только личные чаты с другими людьми. Оставлен для совместимости; `apps/web` с M2 берёт `chatList` |
| `core.chat(acc, chat).messages` | `MessageView[]`: сообщения чата, новые в конце, затем очередь отправки |
| `core.group(acc, chat)` | `GroupView \| null`: название, владелец, участники, членство, расхождение с сервером |
| `core.members(acc)` | `Member[]`: участники семьи. Новое: `revoked`, `verified`, `avatar` |
| `core.avatar(acc, userId)` | `AvatarView \| null`: аватар как `Blob` (сам скачивается и кэшируется) |
| `core.transfers` | `TransferView[]`: загрузки и скачивания в очереди, в работе и с ошибкой |
| `core.outbox`, `core.drafts`, `core.diagnostics` | как в M1 |

`core.accountList()` читает учётные записи один раз (живое хранилище отдаёт первое значение асинхронно).

### Состояние связи

`core.connection[accountId]`: `connecting`, `connected` (с `since`), `offline` (с `since`), `login-invalid` (кнопка «Войти заново» вызывает `core.relogin(accountId)`), `removed` (с `reason: 'removed'` или `'revoked'`), `stopped`.

### Сообщения

`MessageView`:

- `status`: `on-device` (в очереди), `on-server` (сервер принял, есть `gseq` и время сервера), `failed` (`core.retry` или `core.cancel`). Набор значений тот же, что в M1.
- `kind`: `msg`, `update-required` («обновите приложение»), `service` (служебная строка группы, см. `service`).
- `attachments`: `AttachmentView[]` (пустой список, если вложений нет).
- `upload`: `{done, total}` в байтах, пока сообщение с вложениями ждёт загрузки частей («Загружается N%»); `null` у остальных.
- `location`, `fwd`: передаются как есть (запись места и пересылка появятся позже).
- `service` (у `kind: 'service'`, `senderId` пустой):

| `service.type` | Поля | Строка в ленте |
|---|---|---|
| `created` | `by`, `name`, `members` | «Мама создала группу «Семья»» |
| `joined` | `by` | «Вас добавили в группу» (первое состояние, увиденное этим устройством, не версия 1) |
| `renamed` | `by`, `name` | «Группа переименована в …» |
| `added` | `by`, `userIds` | «… добавил(а) …» |
| `left` | `userId` | «… вышел(а) из группы» |
| `removed` | `by`, `userIds` | «… удалил(а) …» (исключённые из семьи и отозвавшие идентичность тоже) |
| `owner` | `by`, `userId` | «Владение передано …» |
| `you-removed` | | «Вы больше не участник» |
| `you-left` | | «Вы вышли из группы» |

Служебные строки выводятся из проверенных подписанных состояний; `left`, `you-left` и `you-removed` берутся из служебных записей сервера (выход меняет только список доставки, подписанного состояния о нём нет).

## Группы

```ts
const chatId = await core.createGroup(acc.id, 'Семья', [papaId, katyaId]);
await core.renameGroup(acc.id, chatId, 'Родители');
await core.addGroupMembers(acc.id, chatId, [dimaId]);                       // с прежней перепиской текущей эпохи
await core.addGroupMembers(acc.id, chatId, [dimaId], { history: false });   // «Добавить без прежней переписки»: новая эпоха
await core.removeGroupMembers(acc.id, chatId, [dimaId]);                    // новая эпоха
await core.transferGroupOwnership(acc.id, chatId, papaId);
await core.leaveGroup(acc.id, chatId);                                      // владелец: { transferTo: userId }
await core.refreshGroups(acc.id);                                           // перечитать с сервера сейчас
core.group(acc.id, chatId).subscribe((g) => { /* GroupView */ });
```

Менять группу может только владелец (`CoreError` `not-owner`). Отправка в группу идёт тем же `send`/`sendMessage`.

`GroupView`:

- `name`, `owner`, `isOwner`, `version`, `epoch`, `members` (`GroupMemberView`: имя, `isOwner`, `removed`, `revoked`, `avatar`, `keyMismatch`): всё из проверенного подписанного состояния, это источник истины.
- `member`, `left` (`{reason: 'left' | 'removed', at}`): я больше не участник; лента остаётся читаемой, поле ввода надо отключить. `canSend`: можно отправлять прямо сейчас.
- `mismatch`: список доставки сервера расходится с подписанным составом (`missingOnServer`: вышли или удаляются владельцем; `extraOnServer`: сервер доставляет шифртекст тому, у кого нет ключа). Показывается только когда обе стороны на одной версии.
- `needKey`: ждём запечатанный ключ; `broken`: состояние не прошло проверку (код ошибки протокола), группа дальше не продвигается.
- `pendingChange`: изменение записано на этом устройстве, но сервер его ещё не подтвердил (отправится само при связи).
- `frozen`: владелец исключён из семьи или отозвал идентичность; состав больше не изменить, участники создают новую группу.

Что делает ядро само:

- Перед любой сменой новый секрет эпохи и подписанное состояние сохраняются локально, затем идёт один запрос. Повтор после сбоя или потерянного ответа узнаётся сравнением сохранённого блоба состояния с серверным (409 `chat_exists` / `stale_version`); проигравшее гонку версий изменение перестраивается на новом состоянии.
- Служебные записи сервера (`group_created`, `group_state`, `member_left`, `member_removed`, `member_revoked`) ведут к чтению новых состояний и ключей; при запуске ядро сверяет `GET /v1/chats` и `GET /v1/keys` с базой, потому что запись могла не дойти.
- Клиент владельца сам удаляет из подписанного состояния вышедших, исключённых из семьи и отозвавших идентичность (новая эпоха), один раз даже при двух устройствах владельца.
- Отправка в группу при 409 `epoch_mismatch` получает новый ключ, шифрует заново с тем же `msgId` и повторяет: без потерь и без дублей.
- Событие, ключ или состояние для которого ещё не пришли, ждёт и расшифровывается после обновления группы.

## Чат с самим собой («Избранное»)

Есть у каждой учётной записи: `AccountView.selfChatId`, `core.openChat(acc.id, acc.userId)` возвращает его же. В `chatList` он первый (`kind: 'self'`, `pinned: true`). Сообщения из него приходят на все мои устройства. В `core.chats` (список M1) его нет; `Member.chatId` у себя по-прежнему `null`.

## Вложения

Отправка:

```ts
await core.sendMessage(acc.id, chatId, {
  text: 'Подпись',
  attachments: [
    { data: file, name: file.name, mime: 'application/pdf' },                                     // файл
    { data: resizedJpeg, name: 'IMG_1.jpg', mime: 'image/jpeg', width: 2048, height: 1536, thumb }, // картинка
  ],
});
```

- Картинку готовит интерфейс (уменьшение, удаление EXIF, миниатюра JPEG до 4096 байт: это API браузера): в ядро приходят готовые байты, размеры и миниатюра. Голосовые: `durationMs` и ровно 64 `peaks`. Для своих проверок интерфейс берёт из ядра `IMAGE_TYPES`, `MAX_ATTACHMENTS`, `MAX_THUMB_BYTES` (константы протокола).
- Размер проверяется по `maxBlobBytes` из `/v1/hello` до начала (`CoreError` `too-large`), описатель по правилам протокола (`invalid-input`), не больше 10 вложений.
- Файл один раз копируется в хранилище приложения (OPFS, где он есть с потоками записи, иначе IndexedDB; выбор при запуске, опция `fileStore: 'auto' | 'opfs' | 'idb'`), затем шифруется по частям на лету и загружается частями по 4 МиБ. После перезапуска загрузка продолжается: ядро спрашивает сервер, какие части уже есть, и досылает недостающие. Сообщение уходит после загрузки всех частей. В памяти не больше одной части.
- Прогресс: `MessageView.upload` и `core.transfers`. Отмена сообщения `core.cancel(acc, msgId)` отменяет и загрузки (части удаляются с сервера); `core.cancelTransfer(acc, blobId)` отменяет одну загрузку (сообщение станет `failed`). `core.retry` перезапускает упавшие загрузки.

Получение:

- `AttachmentView.status`: `not-downloaded`, `downloading` (с `progress` 0..1), `ready`, `failed`, `gone` (удалено с сервера отправителем или по сроку), у своих: `uploading`, `cancelled`.
- Картинки и голосовые до 10 МБ скачиваются сами (настройка `SETTING_AUTO_DOWNLOAD`, по умолчанию включено), остальное по `core.downloadAttachment(acc, blobId)`. `core.cancelTransfer` возвращает в «не скачано».
- Содержимое: `core.attachmentBlob(acc, blobId)` даёт `Blob` из хранилища (OPFS-файл или Blob из IndexedDB, без чтения целиком в память ядром); `core.attachmentUrl(acc, blobId)` даёт `blob:`-адрес, отзывать его `URL.revokeObjectURL` должен интерфейс.

## Профиль, аватары, контакты

- `core.updateProfile(acc, name)`: имя (аватар сохраняется).
- `core.setAvatar(acc, imageBlobOrBytes)`: готовый JPEG или WebP до 256 КБ (уменьшение и EXIF на стороне интерфейса). Ядро загружает картинку, сверяет SHA-256 и подписывает профиль с её ссылкой. `core.removeAvatar(acc)`.
- `core.avatar(acc, userId)`: живой `AvatarView` (`blob`, `type`, `sha256`) или `null`; чужие аватары скачиваются с токеном, проверяются по SHA-256 из подписанного профиля и кэшируются. `core.avatarBlob(acc, userId)` то же разово.
- `core.setVerified(acc, userId, true | false)`: локальная отметка «проверен» по отпечатку (`Member.fingerprint`); если ключи участника сменятся, `Member.verified` станет `false`.
- Отзыв: `core.revokeIdentity(acc)` отзывает мою идентичность на сервере этой учётной записи (необратимо: все её устройства отключаются, история остаётся читаемой); `core.revokeIdentityByPhrase(serverUrl, phrase)` то же без устройства, по фразе. Отозванные контакты: `Member.revoked`, `ChatSummary.peerRevoked`, `GroupMemberView.revoked`; отправка им: `CoreError` `peer-revoked`; их события после момента отзыва не принимаются.

## Вступление и срок хранения

- `core.checkInvite(serverUrl, code)` → `{status: 'valid' | 'used' | 'expired', familyName, createdBy: {userId, name}, createdAt, expiresAt}` или `{status: 'invalid'}`. `createdBy.name` до вступления непроверенная подсказка.
- `core.join` с приглашением возвращает `firstChatId`: личный чат с пригласившим.
- `AccountView.oldestTime` и `historyTrimmed`: если `historyTrimmed`, вверху чата, история которого дошла до начала (`loadOlder()` вернул `false`), показывается «сообщения до <oldestTime> с сервера уже удалены» и предложение импорта архива. В `retentionGap` тоже есть `oldestTime`.

## Архив

```ts
// Экспорт потоком: заголовок, затем зашифрованные блоки по 1 МиБ
for await (const chunk of core.exportArchive({ includeFiles: true })) await writable.write(chunk);
// или: const stream = await core.exportArchiveStream(); await new Response(stream).blob();

// Импорт (идентичность должна быть на устройстве: сначала восстановление по фразе)
const { added, skipped, files } = await core.importArchive(fileOrStreamOrChunks);   // «Добавлено N, пропущено M»
```

В архиве все учётные записи идентичности без токенов, контакты, чаты, подписанные состояния групп с секретами эпох, служебные записи, проверенные события как есть и, по флажку, файлы вложений. Импорт заново проверяет события тем же путём, что синхронизация, и пропускает известные. Архив другой идентичности: `CoreError` `wrong-identity`; повреждённый или обрезанный: `bad-archive`. Учётная запись, которой на устройстве нет, создаётся без токена и при первом запросе входит подписью с новым `devId`.

## Push

Service worker на push вызывает `handlePushPayload(event.data.json())` и получает либо `{kind: 'message', senderName, chatKind, chatName, text?, attachments}`, либо `{kind: 'generic'}` («Новое сообщение»). Работает и для групп (`chatName`: название группы). Текст есть, только если включена настройка `SETTING_PUSH_SHOW_TEXT`.

## Ошибки

- `CoreError` с `code`: прежние (`no-account`, `no-identity`, `account-exists`, `login-invalid`, `removed`, `unknown-user`, `unknown-chat`, `invalid-input`, `unsupported-server`, `closed`) и новые: `too-large`, `not-member`, `not-owner`, `owner-cannot-leave`, `busy`, `need-key`, `peer-revoked`, `revoked`, `wrong-identity`, `bad-archive`, `gone`. `self-chat` больше не возникает.
- `ApiError` (`code` как в `docs/API.md`, `details.epoch|limit|rev|version`) и `NetworkError` из транспорта; `isTransient(e)` говорит, поможет ли повтор.
- В текстах ошибок и в диагностике нет токенов, ключей, фраз и текста сообщений.

## Совместимость с клиентом M1

Фасад M1 не менялся по сигнатурам: `chats`, `send`, `chat()`, `members()`, `join()` (результат расширен), `MessageStatus` и `ConnectionState` (у `removed` добавлено необязательное поле). Схема базы выросла до версии 2 только добавлением таблиц и полей; база, созданная M1, открывается и обновляется автоматически.

## Тесты

```bash
pnpm --filter @family-chat/core test        # модульные (Vitest, fake-indexeddb, поддельный сервер в памяти, поддельный OPFS)
pnpm test:integration                       # из корня: против настоящего fcd
```

`pnpm test:integration` собирает `apps/web/dist` (если его нет) и `fcd` (`cargo build`), затем запускает `test/*.integration.test.ts`: каждый файл поднимает `fcd` на временной папке и порту, выбранном системой, с `--push false`. Готовый бинарник можно передать через `FCD_BIN=/путь/к/fcd`, тогда сборка пропускается.
