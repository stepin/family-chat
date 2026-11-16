// What an attachment shows: its state in words ("не скачано", "скачивается
// N%", "не удалось", "удалено с сервера", "доступно ещё N дней") and the one
// action it offers.

import type { AttachmentView } from '@family-chat/core';
import { t } from './strings.ts';

const DAY_MS = 86_400_000;

/**
 * Image types shown inline (only through `<img>` with a blob: URL). Anything
 * else is offered as a download, never opened in the app's origin.
 */
export const DISPLAY_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** Largest image decoded for display (docs/PROTOCOL.md 16.3: 40 megapixels). */
export const MAX_DISPLAY_PIXELS = 40_000_000;

/** An image attachment that may be decoded and shown inline. */
export function isDisplayableImage(a: Pick<AttachmentView, 'kind' | 'mime' | 'width' | 'height'>): boolean {
  if (a.kind !== 'image' || !DISPLAY_IMAGE_TYPES.includes(a.mime)) return false;
  if (a.width === null || a.height === null) return false;
  return a.width * a.height <= MAX_DISPLAY_PIXELS;
}

/**
 * Whole days an attachment stays on the server (0 when it is due to be
 * deleted). A clock behind the server never shows more than the retention.
 */
export function daysLeft(sentAt: number, retentionDays: number, now: number): number {
  const left = Math.ceil((sentAt + retentionDays * DAY_MS - Math.max(now, sentAt)) / DAY_MS);
  return Math.min(retentionDays, Math.max(0, left));
}

export type AttachmentAction = 'download' | 'cancel-download' | 'retry-download' | 'save' | null;

export interface AttachmentUi {
  /** Words for the state; null when nothing needs saying (ready, or an own upload shown on the message). */
  readonly label: string | null;
  readonly action: AttachmentAction;
  /** 0..100 while downloading or uploading. */
  readonly percent: number | null;
  readonly tone: 'quiet' | 'error';
}

export interface AttachmentContext {
  /** Server time of the message (null while it is on this device). */
  readonly sentAt: number | null;
  readonly retentionDays: number;
  readonly now: number;
}

/** Maps the core's attachment status to what the attachment shows. */
export function attachmentUi(a: AttachmentView, ctx: AttachmentContext): AttachmentUi {
  const percent = Math.round(Math.min(1, Math.max(0, a.progress)) * 100);
  switch (a.status) {
    case 'ready':
      return { label: null, action: 'save', percent: null, tone: 'quiet' };
    case 'downloading':
      return { label: t.attachState.downloading(percent), action: 'cancel-download', percent, tone: 'quiet' };
    case 'uploading':
      if (a.error === 'storage_full') return { label: t.attachState.serverFull, action: null, percent, tone: 'error' };
      return { label: t.attachState.uploading(percent), action: null, percent, tone: 'quiet' };
    case 'failed':
      if (a.error === 'no-space') return { label: t.attachState.noSpace, action: 'retry-download', percent: null, tone: 'error' };
      return { label: t.attachState.downloadFailed, action: 'retry-download', percent: null, tone: 'error' };
    case 'gone':
      return { label: t.attachState.gone, action: null, percent: null, tone: 'quiet' };
    case 'cancelled':
      return { label: t.attachState.cancelled, action: null, percent: null, tone: 'quiet' };
    case 'not-downloaded': {
      if (ctx.sentAt === null) return { label: t.attachState.notDownloaded, action: 'download', percent: null, tone: 'quiet' };
      const left = daysLeft(ctx.sentAt, ctx.retentionDays, ctx.now);
      if (left === 0) return { label: t.attachState.expiring, action: 'download', percent: null, tone: 'quiet' };
      return {
        label: t.attachState.daysLeft(left),
        action: 'download',
        percent: null,
        tone: 'quiet',
      };
    }
  }
}

/** `data:` URL of an inline JPEG thumbnail (base64url in the descriptor). */
export function thumbDataUrl(thumb: string | null): string | null {
  if (!thumb || !/^[A-Za-z0-9_-]+$/.test(thumb)) return null;
  const b64 = thumb.replace(/-/g, '+').replace(/_/g, '/');
  return `data:image/jpeg;base64,${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
}
