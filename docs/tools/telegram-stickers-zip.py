#!/usr/bin/env python3
"""Downloads a Telegram sticker set into a .zip that Family Chat imports.

Usage (docs/STICKERS-ZIP.md):

    TELEGRAM_BOT_TOKEN=123456:ABC... python3 telegram-stickers-zip.py https://t.me/addstickers/<name> [-o out.zip]

The archive holds the set's `.webp` and `.tgs` files in the set's order,
named `<emoji>_<NN>.<ext>`: the app takes a sticker's emoji from the first
character of its file name. Video stickers (`.webm`) are left out, the app
does not support them. Limits are the app's: 200 stickers, `.webp` up to
512 KB, `.tgs` up to 128 KB, 50 MB in all.

The bot token comes from TELEGRAM_BOT_TOKEN (or FCD_TELEGRAM_BOT_TOKEN, as
the server takes it), else it is asked for. It is never printed. Only the
Python standard library is used (3.8 or newer).
"""

import argparse
import getpass
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API = 'https://api.telegram.org'
MAX_STICKERS = 200
MAX_WEBP = 512 * 1024
MAX_TGS = 128 * 1024
MAX_TOTAL = 50 * 1024 * 1024
NAME = re.compile(r'^[A-Za-z0-9_]{1,64}$')


class Fail(Exception):
    pass


def set_name(arg):
    """The set name from a link (t.me/addstickers/<name>, tg://addstickers?set=<name>) or the name itself."""
    arg = arg.strip()
    m = re.match(r'^(?:https?://)?(?:www\.)?(?:t|telegram)\.me/addstickers/([^/?#]+)', arg, re.I)
    if m:
        arg = m.group(1)
    else:
        m = re.match(r'^tg://addstickers\?(.*)$', arg, re.I)
        if m:
            arg = urllib.parse.parse_qs(m.group(1)).get('set', [''])[0]
    if not NAME.match(arg):
        raise Fail(f'not a sticker set link or name: {arg!r}')
    return arg


def fetch(url, what, tries=4):
    """GET with a few retries; errors never show the URL (it holds the token)."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code < 500 and e.code != 429:
                return body  # Bot API errors are JSON with "description"
            err = f'HTTP {e.code}'
        except (urllib.error.URLError, OSError) as e:
            err = getattr(e, 'reason', e)
        if attempt + 1 < tries:
            time.sleep(1 + attempt * 2)
    raise Fail(f'{what}: {err}')


def call(token, method, **params):
    data = fetch(f'{API}/bot{token}/{method}?{urllib.parse.urlencode(params)}', method)
    try:
        j = json.loads(data)
    except ValueError:
        raise Fail(f'{method}: not a Bot API answer')
    if not j.get('ok'):
        d = j.get('description') or 'error'
        if j.get('error_code') == 401:
            d += ' (check the bot token)'
        raise Fail(f'{method}: {d}')
    return j['result']


def valid(ext, data):
    if ext == 'webp':
        return len(data) <= MAX_WEBP and data[:4] == b'RIFF' and data[8:12] == b'WEBP'
    return len(data) <= MAX_TGS and data[:2] == b'\x1f\x8b'


def main():
    p = argparse.ArgumentParser(description='Download a Telegram sticker set as a .zip for Family Chat.')
    p.add_argument('set', help='link https://t.me/addstickers/<name> or the set name')
    p.add_argument('-o', '--output', help='archive to write (default: <name>.zip here)')
    p.add_argument('-f', '--force', action='store_true', help='overwrite the archive if it exists')
    a = p.parse_args()

    name = set_name(a.set)
    out = a.output or f'{name}.zip'
    if os.path.exists(out) and not a.force:
        raise Fail(f'{out} exists (use --force to overwrite)')

    token = (os.environ.get('TELEGRAM_BOT_TOKEN') or os.environ.get('FCD_TELEGRAM_BOT_TOKEN') or '').strip()
    if not token:
        if not sys.stdin.isatty():
            raise Fail('set TELEGRAM_BOT_TOKEN')
        token = getpass.getpass('Telegram bot token (input hidden): ').strip()
    if not re.match(r'^\d+:[A-Za-z0-9_-]+$', token):
        raise Fail('the bot token looks wrong (expected 123456:ABC...)')

    s = call(token, 'getStickerSet', name=name)
    if s.get('sticker_type') == 'custom_emoji':
        raise Fail(f'"{s.get("title")}" is a set of custom emoji, not stickers')
    stickers = s.get('stickers') or []
    print(f'{s.get("title")}: {len(stickers)} stickers')

    video = skipped = 0
    count = total = 0
    fd, tmp = tempfile.mkstemp(suffix='.zip', dir=os.path.dirname(os.path.abspath(out)))
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
            for i, st in enumerate(stickers, 1):
                if st.get('is_video'):
                    video += 1
                    continue
                if count >= MAX_STICKERS:
                    print(f'  stopped at {MAX_STICKERS} stickers (the app\'s limit)')
                    break
                ext = 'tgs' if st.get('is_animated') else 'webp'
                f = call(token, 'getFile', file_id=st['file_id'])
                path = f.get('file_path')
                data = fetch(f'{API}/file/bot{token}/{path}', f'sticker {i}') if path else b''
                if not valid(ext, data):
                    skipped += 1
                    print(f'  sticker {i}: skipped (not a .{ext} within the size limit)')
                    continue
                if total + len(data) > MAX_TOTAL:
                    print('  stopped at 50 MB (the app\'s limit)')
                    break
                emoji = (st.get('emoji') or '').strip()
                z.writestr(f'{emoji}_{i:02d}.{ext}', data)
                count += 1
                total += len(data)
                print(f'  {i}/{len(stickers)} {emoji}', flush=True)
        if count == 0:
            raise Fail('no stickers the app can import (video stickers are not supported)')
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    note = []
    if video:
        note.append(f'{video} video left out')
    if skipped:
        note.append(f'{skipped} skipped')
    print(f'{out}: {count} stickers, {total // 1024} KB' + (f' ({", ".join(note)})' if note else ''))


if __name__ == '__main__':
    try:
        main()
    except Fail as e:
        print(f'error: {e}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
