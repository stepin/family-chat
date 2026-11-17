// Mapping of core states to what the interface shows: the connection status
// line and send statuses.

import type { ConnectionState, MessageStatus } from '@family-chat/core';
import { t } from './strings.ts';

export type Tone = 'quiet' | 'busy' | 'warn' | 'error';

export interface StatusLine {
  readonly text: string;
  readonly tone: Tone;
  /** "Войти заново" button. */
  readonly relogin: boolean;
  readonly removed: boolean;
}

/**
 * The status line. `queued` is the number of own messages waiting to be
 * sent; while offline it adds the reassurance that they will go out later.
 */
export function statusLine(
  state: ConnectionState | undefined,
  /** Shown only when it tells families apart (several on the device), else null. */
  familyName: string | null,
  queued = 0,
): StatusLine {
  const s = state ?? { kind: 'connecting' as const };
  switch (s.kind) {
    case 'connected':
      return { text: t.status.connected, tone: 'quiet', relogin: false, removed: false };
    case 'connecting':
    case 'stopped':
      return { text: t.status.connecting, tone: 'busy', relogin: false, removed: false };
    case 'offline':
      if (s.unavailable) return { text: t.addFamily.unavailable, tone: 'error', relogin: false, removed: false };
      return {
        text: queued > 0 ? `${t.status.offline(s.since)}. ${t.status.offlineQueued}` : t.status.offline(s.since),
        tone: 'warn',
        relogin: false,
        removed: false,
      };
    case 'login-invalid':
      return { text: t.status.loginInvalid, tone: 'error', relogin: true, removed: false };
    case 'removed':
      return { text: t.status.removed(familyName), tone: 'error', relogin: false, removed: true };
  }
}

export interface SendStatusView {
  readonly label: string;
  readonly hint: string;
  readonly icon: 'clock' | 'check' | 'alert';
  readonly actions: readonly ('retry' | 'cancel')[];
}

/** Statuses of an own message: words for screen readers, an icon, and the actions it allows. */
export function sendStatus(status: MessageStatus): SendStatusView {
  switch (status) {
    case 'on-device':
      return { label: t.chat.statusOnDevice, hint: t.chat.statusOnDeviceHint, icon: 'clock', actions: ['cancel'] };
    case 'on-server':
      return { label: t.chat.statusOnServer, hint: t.chat.statusOnServerHint, icon: 'check', actions: [] };
    case 'failed':
      return { label: t.chat.statusFailed, hint: t.chat.statusFailedHint, icon: 'alert', actions: ['retry', 'cancel'] };
  }
}
