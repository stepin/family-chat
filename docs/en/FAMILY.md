# Family guide

Family Chat is a family chat on a server that someone in your family (the administrator) runs. Messages are
encrypted on the phone, so even the server does not know what you write. The app opens in the browser and installs
on the phone's home screen like a normal app. No phone number and no app store are needed.

The app is in Russian for now. Button names below are given in Russian with a translation.

## Joining by invitation

The administrator sends a link or shows a QR code. An invitation works for one person for 7 days and only once: if
somebody already opened the link and joined, ask for a new one.

1. Open the link in **Safari** (iPhone) or **Chrome** (Android). If it opened inside a messenger, the app cannot be
   installed there: press "⋯" or "⋮" and choose "Open in browser".
2. Install the app on the home screen (steps below).
3. Enter your name as relatives will see it, for example "Mum" or "Grandpa Kolya".
4. Write down the 24 recovery words (section below).

Then the chat with the person who invited you opens.

## iPhone: Add to Home Screen

On iPhone the chat lives in the app on the home screen, not in a Safari tab. Only such an app may show
notifications (iOS 16.4 or newer is required). So the order is:

1. On the invitation page press «Скопировать приглашение» (copy invitation).
2. Press Share at the bottom of Safari (a square with an arrow up).
3. Choose "Add to Home Screen". If you do not see it, scroll the list down. Press "Add".
4. Open Family Chat from the home screen and press «Вставить приглашение» (paste invitation).

The home screen app has its own storage: what you did in the Safari tab does not carry over.

## Android

Chrome offers "Install app". If there is no button: menu "⋮", then "Install app" or "Add to Home screen". You can
also continue in the browser without installing, but the installed app is handier and delivers notifications more
reliably.

## On a computer

Open the invitation link in Chrome, Edge, Firefox or Safari. The app works in a tab; Chrome and Edge can install it
as a separate window.

## The 24 recovery words

When you join, the app shows 24 words. They replace a password: with them you get back into the family on a new
phone.

- Write them on paper and keep them at home. The app asks for three of the words to check what you wrote.
- Never show or send them to anyone. Whoever has these words can write in your name.
- The words are English: that makes them easy to write down without mistakes.
- You can see them again under «Настройки», «Слова для восстановления» (Settings, Recovery words).

Without these words, after losing your phone you start from scratch and relatives see you as a new person.

## Notifications

The app offers «Включить уведомления» (enable notifications); the same is under «Настройки», «Уведомления». On
iPhone they work only in the app on the home screen. A notification shows who the message is from or which group
it is in, but not its text: the app takes the name from the phone's own storage, it does not travel through the
server or the push services.

If notifications do not arrive, see the [FAQ](FAQ.md#notifications-do-not-arrive).

## A second device or a new phone

You can sign in on another phone, tablet or computer with the same 24 words:

1. Open the family server address (or an invitation link) and press «Восстановить по фразе» (restore with the
   phrase).
2. Paste the invitation link or the server address, then enter the 24 words.

The server sends the history of the retention period (usually 90 days). Older history moves with an archive file
from the old device (below). With the same words you are the same person for your relatives: your key fingerprint
does not change.

## What happens after 90 days

The server keeps messages and files for at most the retention period (usually 90 days; the administrator may choose
less) and then deletes them. Your devices keep everything: all history a device received lives on it.

So a new phone without an archive has only the last 90 days. If a chat says that messages before some date were
already deleted from the server, only an archive from another device brings them back.

## Message archive

The archive is one encrypted file with all history of this device, optionally with photos and files.

- **Save:** «Настройки», «Хранилище и архив», «Создать архив» (Settings, Storage and archive, Create archive),
  then save or share the file. Keep it where you will not lose it: on a computer, a USB stick, your own cloud.
- **Move to a new device:** first sign in with the recovery words, then press «Выбрать файл архива» (choose archive
  file) on the same screen. Messages already known are skipped, there are no duplicates.
- Only the same identity, that is the same 24 words, can open the archive.

The app reminds you to save an archive every 30 days, and more often when the browser has not promised to keep the
app's data: this happens when the phone is low on space or the app is not installed on the home screen.

## Several families

One app can be in several families, each with its own server: «Настройки», «Семьи на этом устройстве», «Добавить
семью» (Settings, Families on this device, Add family). You can join with the same identity (one set of words for
all families) or a separate one (own words per family). Families never mix, and data of one family never goes to
another family's server.

Notifications on one device come from one family only: that is how browsers work. Other families receive messages
while the app is open.

## If the phone is lost or someone saw the words

Until you act, the lost phone stays connected to the family. Revoke your key:

- from another device: «Настройки», «Безопасность», «Отозвать идентичность» (Settings, Security, Revoke identity);
- without a device: on the sign-in screen press «Восстановить по фразе», then «Потеряли телефон? Отозвать ключ по
  словам» (lost your phone? revoke the key with the words).

After revoking, all your devices in this family are disconnected for good, these words no longer sign in, and you
can come back only with a new invitation, as a new person. History on the devices stays readable. You can also ask
the administrator to disconnect you from the family.

## Checking keys

Each person has a key fingerprint: 30 digits in six groups of five, in «Контакт» (contact) and «Мой профиль» (my
profile). Compare them with a relative in person or by phone and mark them as checked. If a relative's key changed
(for example, they started over on a new phone), the app warns you: call them and compare the fingerprint before
writing anything private.

If a relative started over without the words, the family sees two identities of them. You can link them in their
contact: «Это тот же человек, что и…» (this is the same person as…). The link is visible only on your device; old
and new history show as one conversation.

## Good to know

- **Search** looks only through messages on this device; the query goes nowhere.
- **A place** is sent as coordinates, the app loads no map. "Open in maps" hands the coordinates to the map service
  you open.
- **Photos** are made smaller before sending. «Отправить оригинал» (send original) sends the file as is, including
  the location and time of shooting inside it.
- **Stickers** are stored on the family server without encryption: everybody in the family and whoever runs the
  server can see them. Do not make stickers from private photos.
- **A new group member** sees the group history still on the server. The group owner can add someone "without the
  earlier history".
- If the administrator disconnected you from the family, history on the device stays readable, but you cannot
  write to this family.

How the protection works and what it does not promise: [Security](SECURITY-MODEL.md).
