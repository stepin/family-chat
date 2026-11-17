# A Telegram sticker set as a .zip

The script [`../tools/telegram-stickers-zip.py`](../tools/telegram-stickers-zip.py) downloads a Telegram sticker set
into a `.zip` that Family Chat takes as a new pack (“Settings”, “Sticker packs”, “Add pack”). Use it when the family
server has no bot token, so the `https://t.me/addstickers/…` link does not work in the app, or when you want to edit
the set before publishing it: drop some stickers, change emoji.

Русский: [../STICKERS-ZIP.md](../STICKERS-ZIP.md).

## What you need

- Python 3.8 or newer. No other libraries.
- A Telegram bot token. Telegram gives sticker sets out only through the Bot API, so a bot is required. Create one
  with @BotFather: send `/newbot`, choose a name and get a token like `123456:ABC…`. The bot needs no permissions
  and nobody has to message it. The bot whose token the `fcd` server already uses will do.

The token is a secret, like a password: do not publish it or commit it. If it leaks, revoke it in @BotFather
(`/revoke`).

## Running it

```sh
export TELEGRAM_BOT_TOKEN='123456:ABC...'
python3 docs/tools/telegram-stickers-zip.py https://t.me/addstickers/Mewrio
```

This writes `Mewrio.zip` to the current folder. Without `TELEGRAM_BOT_TOKEN` the script asks for the token, with the
input hidden. `FCD_TELEGRAM_BOT_TOKEN`, the variable the server reads, works too.

Instead of the link you can give the set name (`Mewrio`) or a `tg://addstickers?set=Mewrio` link.
Quote a link with `?` in it, or zsh takes it for a file name pattern.

| Option | What it does |
| --- | --- |
| `-o`, `--output <file>` | where to write the archive (default: `<set name>.zip` in the current folder) |
| `-f`, `--force` | overwrite the archive if it exists |

Then in the app: “Settings”, “Sticker packs”, “Add pack”, “Choose files”, pick the archive, check the preview and the
name, “Publish for the family”. Everybody in the family will see the pack. Stickers are stored on the server without
encryption.

## What is in the archive

- The set's `.webp` (regular) and `.tgs` (animated) files, in the set's order.
- Names like `<emoji>_<number>.<ext>`, for example `🤨_01.webp`. The app takes a sticker's emoji from the first
  character of the file name, so Telegram's emoji are kept. A file whose name does not start with an emoji gets 🙂.
- Video stickers (`.webm`) are left out: the app does not support them yet. A set of video stickers only cannot be
  downloaded, the script says so. Telegram custom emoji sets are not downloaded either.

## Making an archive yourself

Any archive of your own files works if it passes the checks the app runs on the device before the preview:

- only `.webp` (static or animated) and `.tgs` inside; other files are skipped, an archive inside the archive rejects
  the whole thing; `__MACOSX/`, `.DS_Store`, `Thumbs.db` and `desktop.ini` are ignored;
- 1 to 200 stickers, `.webp` up to 512 KB, `.tgs` up to 128 KB, sides 1 to 1024 pixels, 50 MB in all;
- stickers follow the order of files in the archive, identical files count once;
- a plain zip, deflate or stored; no password, no ZIP64, no split volumes;
- a `.tgs` longer than 10 seconds, faster than 120 frames per second or with more than 1 MB of unpacked JSON is
  refused.

From a folder of stickers (macOS and Linux):

```sh
cd stickers && zip -X ../pack.zip *.webp *.tgs
```

## Errors

| Message | What to do |
| --- | --- |
| `getStickerSet: Unauthorized (check the bot token)` | the token is wrong or revoked: get a new one from @BotFather |
| `getStickerSet: Bad Request: STICKERSET_INVALID` | no set with that name: check the link |
| `... is a set of custom emoji, not stickers` | an emoji set; the app takes stickers only |
| `no stickers the app can import` | the set has video stickers only |
| `<file> exists (use --force to overwrite)` | pick another name with `-o` or add `--force` |
| `getFile: <network reason>` | Telegram is unreachable: check the network and run it again |
