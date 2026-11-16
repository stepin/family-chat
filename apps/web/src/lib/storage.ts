// Storage on this device and the archive: the server keeps at most N days, so the archive file is the only copy
// of older history. A reminder once every 30 days, and a prominent warning
// when the browser may clear the storage (not persistent).

const DAY_MS = 86_400_000;
export const REMIND_EVERY_DAYS = 30;
/** Not persistent storage: remind more often. */
export const WARN_EVERY_DAYS = 7;
/** Nothing to remind about on the first day. */
export const FIRST_REMINDER_AFTER_DAYS = 1;

export interface ReminderInput {
  readonly now: number;
  /** `navigator.storage.persisted()`; null when unknown. */
  readonly persisted: boolean | null;
  /** Time of the last saved export, or null. */
  readonly lastExport: number | null;
  /** "Не сейчас" was pressed at this time, or null. */
  readonly snoozedAt: number | null;
  /** When this device first saw the identity. */
  readonly firstSeen: number;
}

export type Reminder = 'none' | 'reminder' | 'warning';

/** Whether the chat list shows the archive reminder, and how loudly. */
export function archiveReminder(i: ReminderInput): Reminder {
  if (i.now - i.firstSeen < FIRST_REMINDER_AFTER_DAYS * DAY_MS) return 'none';
  const warning = i.persisted === false;
  const every = (warning ? WARN_EVERY_DAYS : REMIND_EVERY_DAYS) * DAY_MS;
  const last = Math.max(i.lastExport ?? i.firstSeen, i.snoozedAt ?? 0);
  if (i.lastExport === null && warning) {
    // Never exported and the storage may vanish: warn unless snoozed recently.
    return i.snoozedAt !== null && i.now - i.snoozedAt < every ? 'none' : 'warning';
  }
  if (i.now - last < every) return 'none';
  return warning ? 'warning' : 'reminder';
}

/** Archive file name: "family-chat-Ивановы-2026-11-14.fcarchive". */
export function archiveFileName(familyName: string, now: number): string {
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // eslint-disable-next-line no-control-regex
  const family = familyName.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '').trim().slice(0, 40).replace(/\s+/g, '-');
  return `family-chat-${family ? `${family}-` : ''}${date}.fcarchive`;
}

/**
 * Saves a blob as a file through a temporary link. The content type is
 * forced to `application/octet-stream`, so the browser downloads it and
 * never renders it as a page of the app's origin.
 */
export function saveBlob(blob: Blob, name: string): void {
  const safe = new Blob([blob], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(safe);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The system share sheet with a file, when the browser can share files. */
export function canShareFile(file: File): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

/** Shares a file; false when the person closed the sheet or sharing is not possible. */
export async function shareFile(file: File): Promise<boolean> {
  if (!canShareFile(file)) return false;
  try {
    await navigator.share({ files: [file] });
    return true;
  } catch {
    return false;
  }
}

/** Space used by the app on this device, from the browser's estimate. */
export async function usedSpace(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || typeof e.usage !== 'number') return null;
    return { usage: e.usage, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

export async function isPersisted(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/** Reads a file in slices and reports how much was read; stops with an AbortError when `signal` fires. */
export async function* readWithProgress(file: Blob, onProgress: (done: number) => void, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const SLICE = 1024 * 1024;
  for (let off = 0; off < file.size; off += SLICE) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    const chunk = new Uint8Array(await file.slice(off, off + SLICE).arrayBuffer());
    onProgress(Math.min(file.size, off + chunk.length));
    yield chunk;
  }
}
