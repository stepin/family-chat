# @family-chat/core

Клиентское ядро без интерфейса и без DOM (этапы M2, M3 и M4): клиент API сервера `fcd`, локальная база (IndexedDB через Dexie), вход и идентичность, синхронизация длинным запросом, очередь отправки, участники, группы с эпохами, чат с самим собой, вложения, аватары, отметка «проверен», отзыв идентичности, архив `.fcarchive`, администрирование, push и фасад для интерфейса. Работает в странице, воркере и service worker (нужны `fetch`, IndexedDB, WebCrypto и таймеры; для файлов по возможности OPFS).

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
- `kind`: `msg`, `update-required` («обновите приложение»), `service` (служебная строка группы, см. `service`), `deleted` (M4: удалено у всех, тихая строка «Сообщение удалено» без текста и файлов).
- `attachments`: `AttachmentView[]` (пустой список, если вложений нет).
- `upload`: `{done, total}` в байтах, пока сообщение с вложениями ждёт загрузки частей («Загружается N%»); `null` у остальных.
- `location` (M3): `{lat, lon, accuracy}` или `null`; `fwd: true` у пересланного (M4).
- M4: `edited` («изменено»), `reactions` (`ReactionView[]`: `emoji`, `count`, `mine`, `users`), `replyTo` (`ReplyPreview`: `author`, `available`, `body`, `media`, `fileName`, `gseq`; `available: false`, если исходного сообщения нет на устройстве или оно удалено), `devId` и `seq` исходного события.
- `error: 'storage_full'` у сообщения `on-device`: на диске сервера не хватает места (507); загрузка и отправка повторяются сами, текст и файлы остаются в очереди.
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
- Файл один раз копируется в хранилище приложения (OPFS, где он есть с потоками записи, иначе IndexedDB; выбор при запуске, опция `fileStore: 'auto' | 'opfs' | 'idb'`), затем шифруется по частям на лету и загружается частями по 4 МиБ. В OPFS каждая часть лежит отдельным файлом (`<ключ>.parts/<n>`, с M3): запись одной части не переписывает остальные. Файлы M2 (один файл на вложение) читаются и удаляются как раньше. После перезапуска загрузка продолжается: ядро спрашивает сервер, какие части уже есть, и досылает недостающие. Сообщение уходит после загрузки всех частей. В памяти не больше одной части.
- Нехватка места на устройстве: `CoreError` `no-space` до отправки (копия не создаётся, сообщение не ставится в очередь); у скачивания статус `failed` с `error: 'no-space'`, повтор после освобождения места. Ответ сервера 507 (`storage_full`) считается временным: загрузка ждёт и повторяется, `AttachmentView.error` и `MessageView.error` равны `storage_full`.
- Отмена в любой момент (в этой или другой вкладке) не даёт загрузке «ожить»: смена статуса передачи идёт как сравнение-и-запись в одной транзакции; часть, успевшая уйти на сервер после отмены, удаляется.
- Прогресс: `MessageView.upload` и `core.transfers`. Отмена сообщения `core.cancel(acc, msgId)` отменяет и загрузки (части удаляются с сервера); `core.cancelTransfer(acc, blobId)` отменяет одну загрузку (сообщение станет `failed`). `core.retry` перезапускает упавшие загрузки.

Получение:

- `AttachmentView.status`: `not-downloaded`, `downloading` (с `progress` 0..1), `ready`, `failed`, `gone` (удалено с сервера отправителем или по сроку), у своих: `uploading`, `cancelled`.
- Картинки и голосовые до 10 МБ скачиваются сами (настройка `SETTING_AUTO_DOWNLOAD`, по умолчанию включено), остальное по `core.downloadAttachment(acc, blobId)`. `core.cancelTransfer` возвращает в «не скачано».
- Голосовые (M3): `AttachmentView.durationMs`, `peaks` (64 значения 0-255) и `heard` (прослушано на этом устройстве; у своих всегда `true`). `core.markHeard(acc, blobId)` снимает отметку «не прослушано» (локально, на сервер не уходит).
- Скачивание продолжается после перезапуска с первой недостающей части.
- Содержимое: `core.attachmentBlob(acc, blobId)` даёт `Blob` из хранилища (OPFS-файл или Blob из IndexedDB, без чтения целиком в память ядром); `core.attachmentUrl(acc, blobId)` даёт `blob:`-адрес, отзывать его `URL.revokeObjectURL` должен интерфейс.

## Место (M3)

```ts
await core.sendMessage(acc.id, chatId, { location: { lat: 55.7558, lon: 37.6173, accuracy: 25 } });   // без текста можно
```

Широта, долгота и точность проверяются до постановки в очередь (`invalid-input`). В `ChatSummary.lastMessage.media` для списка чатов: `image`, `voice`, `file`, `location` или `null`.

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

## Ответ, правка, удаление, реакции, пересылка, поиск (M4)

```ts
await core.sendMessage(acc.id, chatId, { text: 'Хорошо', reply: { author, id } });      // ответ с цитатой
await core.editMessage(acc.id, chatId, msgId, 'новый текст');                           // своё сообщение; в очереди меняется на месте
await core.deleteForEveryone(acc.id, chatId, senderId, msgId);                          // своё, или любое в своей группе
await core.deleteForMe(acc.id, chatId, senderId, msgId);                                // только на этом устройстве
await core.react(acc.id, chatId, senderId, msgId, '👍', true);                          // false снимает
const ids = await core.forwardMessage(acc.id, chatId, senderId, msgId, [chatA, chatB]); // CoreError not-downloaded, если файлов нет
const found = await core.search('ёлка дача');                // GlobalSearchResult: messages, total, chats, contacts, words
const inChat = await core.searchChat(acc.id, chatId, 'ёлка'); // все совпадения в чате, новые первыми
await core.chat(acc.id, chatId).reveal(gseq);                 // показать сообщение (догрузить из локальной базы)
```

Правка, удаление и реакция уходят через ту же очередь отправки, что и сообщения, и видны сразу (до ответа сервера). «Удалить у всех»: сначала зашифрованное событие `delete`, затем `DELETE /v1/chats/<id>/events/<gseq>` и `DELETE /v1/blobs/<id>` своих вложений; запись очереди живёт до конца этой уборки.

Правила применения (одинаковый результат при любом порядке прихода; события-правки хранятся в таблице `controls`, сообщение пересчитывается из всех них):

- `delete` действует от автора сообщения или от владельца группы в принятом состоянии эпохи события удаления. Окончательно: сообщение становится строкой `deleted`, его событие и события правок и реакций к нему удаляются с устройства, вложения тоже. Удаление, пришедшее раньше сообщения, оставляет надгробие (`tombstones`), сообщение по приходу сразу становится строкой `deleted`.
- `edit` действует только от автора; побеждает правка с наибольшим `gseq` (порядок сервера). Окна времени нет: планы его не задают. Правки удалённого сообщения не действуют.
- `react`: одно значение на (сообщение, автор, эмодзи), действует наибольший `gseq`; эмодзи идут по `gseq` самой ранней действующей реакции.
- Обнулённая запись сервера (`deleted: true`) и служебная запись `event_deleted` подписи не имеют: они только ставят строку `deleted` там, где о сообщении ничего не известно, и никогда не скрывают прочитанное сообщение. Скрывает только подписанный `delete`.
- «Удалить у меня» пишет надгробие `local`: сообщение пропадает на этом устройстве и больше не появляется при повторной доставке.

Поиск локальный, на сервер ничего не уходит. У каждого сообщения есть поле `words` с multiEntry-индексом Dexie: слова после NFKC, нижнего регистра и замены `ё` на `е`, не короче 2 символов, каждое один раз; в индекс идут текст и имена файлов. Слово запроса ищется по префиксу, короче 3 символов только целым словом; несколько слов: все должны совпасть. Слова пересчитываются при каждой записи сообщения (синхронизация, правка, удаление, импорт архива), поэтому индекс всегда соответствует сообщениям. Схема базы выросла до версии 3: таблицы `controls`, `tombstones` и индекс `*words`; при обновлении старые сообщения индексируются.

## Архив

```ts
// Экспорт потоком: заголовок, затем зашифрованные блоки по 1 МиБ
for await (const chunk of core.exportArchive({ includeFiles: true })) await writable.write(chunk);
// или: const stream = await core.exportArchiveStream(); await new Response(stream).blob();

// Импорт (идентичность должна быть на устройстве: сначала восстановление по фразе)
const { added, skipped, files } = await core.importArchive(fileOrStreamOrChunks);   // «Добавлено N, пропущено M»
```

В архиве все учётные записи идентичности без токенов, контакты, чаты, подписанные состояния групп с секретами эпох, служебные записи, проверенные события как есть (правки и реакции тоже события), надгробия удалённых сообщений (M4: «у всех» и «у меня», с местом в ленте) и, по флажку, файлы вложений. Импорт заново проверяет события тем же путём, что синхронизация, и пропускает известные. Архив другой идентичности: `CoreError` `wrong-identity`; повреждённый или обрезанный: `bad-archive`. Учётная запись, которой на устройстве нет, создаётся без токена и при первом запросе входит подписью с новым `devId`.

## Push

Service worker на push вызывает `handlePushPayload(event.data.json())` и получает либо `{kind: 'message', senderName, chatKind, chatName, text?, attachments}`, либо `{kind: 'generic'}` («Новое сообщение»). Работает и для групп (`chatName`: название группы). Текст есть, только если включена настройка `SETTING_PUSH_SHOW_TEXT`.

## Ошибки

- `CoreError` с `code`: прежние (`no-account`, `no-identity`, `account-exists`, `login-invalid`, `removed`, `unknown-user`, `unknown-chat`, `invalid-input`, `unsupported-server`, `closed`) и новые: `too-large`, `not-member`, `not-owner`, `owner-cannot-leave`, `busy`, `need-key`, `peer-revoked`, `revoked`, `wrong-identity`, `bad-archive`, `gone`. `self-chat` больше не возникает. M3: `no-space` (на устройстве не хватает места). M4: `not-downloaded` (для пересылки файлы должны быть на устройстве; в `message` идентификаторы вложений через запятую), `not-allowed` (чужое сообщение нельзя изменить или удалить у всех).
- `ApiError` (`code` как в `docs/API.md`, `details.epoch|limit|rev|version`) и `NetworkError` из транспорта; `isTransient(e)` говорит, поможет ли повтор.
- В текстах ошибок и в диагностике нет токенов, ключей, фраз и текста сообщений.

## Совместимость с клиентом M1

Фасад M1 не менялся по сигнатурам: `chats`, `send`, `chat()`, `members()`, `join()` (результат расширен), `MessageStatus` и `ConnectionState` (у `removed` добавлено необязательное поле). Схема базы выросла до версии 3 только добавлением таблиц, полей и индексов; база, созданная M1 или M2/M3, открывается и обновляется автоматически.

## Тесты

```bash
pnpm --filter @family-chat/core test        # модульные (Vitest, fake-indexeddb, поддельный сервер в памяти, поддельный OPFS)
pnpm test:integration                       # из корня: против настоящего fcd
FC_PERF=1 pnpm --filter @family-chat/core test m4   # замер поиска на 50 000 сообщений (fake-indexeddb, медленно)
pnpm --filter @family-chat/web run test:e2e:perf    # тот же замер в Chromium
```

`pnpm test:integration` собирает `apps/web/dist` (если его нет) и `fcd` (`cargo build`), затем запускает `test/*.integration.test.ts`: каждый файл поднимает `fcd` на временной папке и порту, выбранном системой, с `--push false`. Готовый бинарник можно передать через `FCD_BIN=/путь/к/fcd`, тогда сборка пропускается.
