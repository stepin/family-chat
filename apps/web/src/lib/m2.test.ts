import { describe, expect, it } from 'vitest';
import type { AttachmentView } from '@family-chat/core';
import { attachmentUi, daysLeft, isDisplayableImage, thumbDataUrl } from './attachment-state.ts';
import { encodeOrder, fitWithin, renameForType, safeFileName, safeMime, shouldReencode, THUMB_STEPS } from './media.ts';
import { displayNames, fingerprintLines, initial, joinNames, shortFingerprint } from './names.ts';
import { serviceText } from './service.ts';
import { archiveFileName, archiveReminder } from './storage.ts';

const DAY = 86_400_000;

describe('image preparation parameters', () => {
  it('fits the long side into 2048 px without upscaling', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536, scaled: true });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048, scaled: true });
    expect(fitWithin(1200, 800, 2048)).toEqual({ width: 1200, height: 800, scaled: false });
    expect(fitWithin(2048, 2048, 2048).scaled).toBe(false);
    expect(fitWithin(10000, 10, 2048)).toEqual({ width: 2048, height: 2, scaled: true });
    expect(fitWithin(10, 100000, 96).width).toBe(1);
  });

  it('tries WebP first, then JPEG', () => {
    expect(encodeOrder()).toEqual(['image/webp', 'image/jpeg']);
  });

  it('thumbnail steps shrink and stay small', () => {
    for (let i = 1; i < THUMB_STEPS.length; i++) {
      expect(THUMB_STEPS[i]!.side).toBeLessThan(THUMB_STEPS[i - 1]!.side);
    }
    expect(THUMB_STEPS[0]!.side).toBeLessThanOrEqual(128);
  });

  it('re-encodes still images only', () => {
    expect(shouldReencode('image/jpeg')).toBe(true);
    expect(shouldReencode('image/heic')).toBe(true);
    expect(shouldReencode('image/gif')).toBe(false);
    expect(shouldReencode('image/svg+xml')).toBe(false);
    expect(shouldReencode('application/pdf')).toBe(false);
  });

  it('renames to the new type', () => {
    expect(renameForType('IMG_0001.HEIC', 'image/webp')).toBe('IMG_0001.webp');
    expect(renameForType('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(renameForType('.hidden', 'image/jpeg')).toBe('.hidden.jpg');
  });

  it('makes file names the protocol accepts', () => {
    expect(safeFileName('  отчёт.pdf ')).toBe('отчёт.pdf');
    expect(safeFileName('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(safeFileName('evil‮txt.exe')).toBe('evil_txt.exe');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('', 'image.png')).toBe('image.png');
    const long = `${'я'.repeat(300)}.pdf`;
    const s = safeFileName(long);
    expect(Array.from(s).length).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(255);
    expect(s.endsWith('.pdf')).toBe(true);
  });

  it('normalises MIME types', () => {
    expect(safeMime('Image/JPEG')).toBe('image/jpeg');
    expect(safeMime('text/plain; charset=utf-8')).toBe('text/plain');
    expect(safeMime('')).toBe('application/octet-stream');
    expect(safeMime('weird')).toBe('application/octet-stream');
  });
});

function att(over: Partial<AttachmentView>): AttachmentView {
  return {
    blobId: 'b',
    name: 'a.jpg',
    mime: 'image/jpeg',
    kind: 'image',
    size: 1000,
    width: 100,
    height: 100,
    thumb: null,
    durationMs: null,
    peaks: null,
    status: 'not-downloaded',
    progress: 0,
    error: null,
    ...over,
  };
}

describe('attachment state mapping', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const ctx = { sentAt: now - 10 * DAY, retentionDays: 90, now };

  it('counts the days left on the server', () => {
    expect(daysLeft(now, 90, now)).toBe(90);
    expect(daysLeft(now - 89.5 * DAY, 90, now)).toBe(1);
    expect(daysLeft(now - 100 * DAY, 90, now)).toBe(0);
    // The device clock behind the server.
    expect(daysLeft(now + 60_000, 90, now)).toBe(90);
  });

  it('maps every status', () => {
    expect(attachmentUi(att({}), ctx)).toMatchObject({ label: 'Не скачано. Доступно ещё 80 дней', action: 'download' });
    expect(attachmentUi(att({}), { ...ctx, sentAt: now - 88 * DAY })).toMatchObject({ label: 'Не скачано. Доступно ещё 2 дня' });
    expect(attachmentUi(att({}), { ...ctx, sentAt: now - 89 * DAY })).toMatchObject({ label: 'Не скачано. Доступно ещё 1 день' });
    expect(attachmentUi(att({ status: 'downloading', progress: 0.426 }), ctx)).toMatchObject({
      label: 'Скачивается 43%',
      action: 'cancel-download',
      percent: 43,
    });
    expect(attachmentUi(att({ status: 'failed' }), ctx)).toMatchObject({ label: 'Не удалось скачать', action: 'retry-download', tone: 'error' });
    expect(attachmentUi(att({ status: 'gone' }), ctx)).toMatchObject({ label: 'Удалено с сервера', action: null });
    expect(attachmentUi(att({ status: 'ready', progress: 1 }), ctx)).toMatchObject({ label: null, action: 'save' });
    expect(attachmentUi(att({ status: 'uploading', progress: 0.5 }), ctx)).toMatchObject({ label: 'Загружается 50%', percent: 50 });
    expect(attachmentUi(att({}), { ...ctx, sentAt: null })).toMatchObject({ label: 'Не скачано' });
  });

  it('shows inline only safe image types within the pixel limit', () => {
    expect(isDisplayableImage(att({}))).toBe(true);
    expect(isDisplayableImage(att({ mime: 'image/avif' }))).toBe(true);
    expect(isDisplayableImage(att({ mime: 'image/svg+xml' }))).toBe(false);
    expect(isDisplayableImage(att({ kind: 'file', mime: 'image/png' }))).toBe(false);
    expect(isDisplayableImage(att({ mime: 'text/html' }))).toBe(false);
    expect(isDisplayableImage(att({ width: 10000, height: 5000 }))).toBe(false);
    expect(isDisplayableImage(att({ width: null }))).toBe(false);
  });

  it('builds a data URL from a base64url thumbnail', () => {
    expect(thumbDataUrl('_9j_4A')).toBe('data:image/jpeg;base64,/9j/4A==');
    expect(thumbDataUrl('bad!chars')).toBeNull();
    expect(thumbDataUrl(null)).toBeNull();
  });
});

describe('service-line wording', () => {
  const names: Record<string, string> = { me: 'Я', mama: 'Мама', petya: 'Петя', vasya: 'Вася' };
  const n = { me: 'me', nameOf: (id: string) => names[id] ?? 'Без имени' };

  it('words every entry', () => {
    expect(serviceText({ type: 'created', by: 'mama', name: 'Семья', members: [] }, n)).toBe('Мама создал(а) группу «Семья»');
    expect(serviceText({ type: 'created', by: 'me', name: 'Семья', members: [] }, n)).toBe('Вы создали группу «Семья»');
    expect(serviceText({ type: 'joined', by: 'mama' }, n)).toBe('Мама добавил(а) вас в группу');
    expect(serviceText({ type: 'renamed', by: 'me', name: 'Дача' }, n)).toBe('Вы переименовали группу в «Дача»');
    expect(serviceText({ type: 'added', by: 'mama', userIds: ['petya', 'vasya'] }, n)).toBe('Мама добавил(а) Петя и Вася');
    expect(serviceText({ type: 'added', by: 'mama', userIds: ['me'] }, n)).toBe('Мама добавил(а) вас');
    expect(serviceText({ type: 'left', userId: 'petya' }, n)).toBe('Петя вышел(а) из группы');
    expect(serviceText({ type: 'removed', by: 'mama', userIds: ['vasya'] }, n)).toBe('Мама удалил(а) из группы Вася');
    expect(serviceText({ type: 'owner', by: 'mama', userId: 'me' }, n)).toBe('Мама передал(а) владение группой. Новый владелец: вы');
    expect(serviceText({ type: 'owner', by: 'me', userId: 'petya' }, n)).toBe('Вы передали владение группой. Новый владелец: Петя');
    expect(serviceText({ type: 'you-removed' }, n)).toBe('Вас удалили из группы. Вы больше не участник');
    expect(serviceText({ type: 'you-left' }, n)).toBe('Вы вышли из группы');
    expect(serviceText({ type: 'left', userId: 'ghost' }, n)).toBe('Без имени вышел(а) из группы');
  });

  it('joins names', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['А'])).toBe('А');
    expect(joinNames(['А', 'Б', 'В'])).toBe('А, Б и В');
  });
});

describe('fingerprint formatting and names', () => {
  const fp = '12345 67890 11111 22222 33333 44444';

  it('splits into lines of three groups', () => {
    expect(fingerprintLines(fp)).toEqual(['12345 67890 11111', '22222 33333 44444']);
    expect(shortFingerprint(fp)).toBe('12345');
    expect(shortFingerprint('')).toBe('');
  });

  it('adds the short fingerprint only to equal names', () => {
    const m = displayNames(
      [
        { userId: 'a', name: 'Мама', fingerprint: fp },
        { userId: 'b', name: ' мама ', fingerprint: '99999 00000' },
        { userId: 'c', name: 'Петя', fingerprint: '55555' },
        { userId: 'd', name: null, fingerprint: '77777' },
      ],
      'Без имени',
    );
    expect(m.get('a')).toBe('Мама · 12345');
    expect(m.get('b')).toBe('мама · 99999');
    expect(m.get('c')).toBe('Петя');
    expect(m.get('d')).toBe('Без имени');
  });

  it('takes the first letter', () => {
    expect(initial('мама')).toBe('М');
    expect(initial('  ')).toBe('?');
    expect(initial(null)).toBe('?');
  });
});

describe('archive reminder', () => {
  const now = Date.UTC(2026, 10, 14);
  const base = { now, persisted: true, lastExport: null, snoozedAt: null, firstSeen: now - 40 * DAY };

  it('stays quiet on the first day', () => {
    expect(archiveReminder({ ...base, firstSeen: now - 1000, persisted: false })).toBe('none');
  });

  it('reminds once every 30 days with persistent storage', () => {
    expect(archiveReminder({ ...base, firstSeen: now - 10 * DAY })).toBe('none');
    expect(archiveReminder(base)).toBe('reminder');
    expect(archiveReminder({ ...base, lastExport: now - 29 * DAY })).toBe('none');
    expect(archiveReminder({ ...base, lastExport: now - 31 * DAY })).toBe('reminder');
    expect(archiveReminder({ ...base, lastExport: now - 31 * DAY, snoozedAt: now - DAY })).toBe('none');
  });

  it('warns when storage is not persistent', () => {
    expect(archiveReminder({ ...base, persisted: false, firstSeen: now - 2 * DAY })).toBe('warning');
    expect(archiveReminder({ ...base, persisted: false, snoozedAt: now - DAY })).toBe('none');
    expect(archiveReminder({ ...base, persisted: false, snoozedAt: now - 8 * DAY })).toBe('warning');
    expect(archiveReminder({ ...base, persisted: false, lastExport: now - 3 * DAY })).toBe('none');
    expect(archiveReminder({ ...base, persisted: false, lastExport: now - 8 * DAY })).toBe('warning');
  });

  it('names the archive file', () => {
    expect(archiveFileName('Ивановы', Date.UTC(2026, 10, 14, 12))).toBe('family-chat-Ивановы-2026-11-14.fcarchive');
    expect(archiveFileName('A/B: c', Date.UTC(2026, 0, 2, 12))).toBe('family-chat-AB-c-2026-01-02.fcarchive');
  });
});
