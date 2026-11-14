// Application state shared by all screens: the core (one per page, on the
// main thread in M1), the boot phase, the pending invitation, the update
// banner and short notices.

import {
  createCore,
  DbVersionError,
  type AccountView,
  type ChatListItem,
  type ConnectionState,
  type FamilyChatCore,
  type Member,
  type OutboxItem,
  type Readable,
  type Unsubscribe,
} from '@family-chat/core';
import { describe } from './errors.ts';
import type { ParsedInvite } from './invite.ts';
import { currentPlatform, type PlatformInfo } from './platform.ts';

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface Flags {
  /** The recovery phrase was shown and confirmed by three words. */
  phraseConfirmed: boolean;
  /** The phrase was offered after the first sent message (invited relatives). */
  phraseOffered: boolean;
  /** "Включите уведомления" in the chat list was dismissed. */
  notifyDismissed: boolean;
}

const NO_FLAGS: Flags = { phraseConfirmed: false, phraseOffered: false, notifyDismissed: false };

export type BootPhase = 'loading' | 'ready' | 'db-newer' | 'failed' | 'old-browser';

class AppState {
  phase: BootPhase = $state('loading');
  /** Accounts on this device (the UI uses the first one in M1). */
  accounts: AccountView[] = $state.raw([]);
  /** Invitation read from the address (or pasted), kept in memory only. */
  invite: ParsedInvite | null = $state.raw(null);
  /** A new version of the app is waiting (service worker). */
  updateReady = $state(false);
  /** Chrome's deferred install prompt (`beforeinstallprompt`), when offered. */
  installPrompt: InstallPromptEvent | null = $state.raw(null);
  /** Activates the waiting version and reloads. */
  applyUpdate: () => void = () => location.reload();
  /** Short notice at the bottom of the screen. */
  toast: string | null = $state(null);
  /** Window is at least 900 px wide: two columns. */
  wide = $state(false);
  platform: PlatformInfo = $state.raw({ os: 'other', inApp: false, standalone: false, iosSafari: false });
  chats: ChatListItem[] = $state.raw([]);
  chatsLoaded = $state(false);
  outbox: OutboxItem[] = $state.raw([]);
  connection: Record<string, ConnectionState> = $state.raw({});
  /** Family members of the shown account. */
  members: Member[] = $state.raw([]);
  membersLoaded = $state(false);
  /** Per-identity interface flags stored in the core's settings table. */
  flags: Flags = $state({ ...NO_FLAGS });
  flagsLoaded = $state(false);
  #membersOf: string | null = null;
  #membersUnsub: Unsubscribe | undefined;
  #core: FamilyChatCore | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;

  get core(): FamilyChatCore {
    if (!this.#core) throw new Error('core not started');
    return this.#core;
  }

  /** The account shown (several servers are not in the M1 interface). */
  get account(): AccountView | null {
    return this.accounts[0] ?? null;
  }

  async boot(): Promise<void> {
    this.platform = currentPlatform();
    if (!('indexedDB' in window) || !globalThis.crypto?.subtle) {
      this.phase = 'old-browser';
      return;
    }
    const core = createCore();
    try {
      await core.start();
    } catch (e) {
      this.phase = e instanceof DbVersionError ? 'db-newer' : 'failed';
      return;
    }
    this.#core = core;
    // The first value of the live query arrives asynchronously; read once to
    // decide the first screen without a flash of the welcome screen.
    this.accounts = await core.accountList();
    follow(core.accounts, (list) => {
      this.accounts = list;
      this.#watchMembers();
    });
    follow(core.chats, (list) => {
      this.chats = list;
      this.chatsLoaded = true;
    });
    follow(core.outbox, (list) => (this.outbox = list));
    core.connection.subscribe((c) => (this.connection = c));
    this.#watchMembers();
    window.addEventListener('online', () => core.wake());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') core.wake();
    });
    this.phase = 'ready';
  }

  #watchMembers(): void {
    const id = this.account?.id ?? null;
    if (id === this.#membersOf) return;
    this.#membersUnsub?.();
    this.#membersOf = id;
    this.members = [];
    this.membersLoaded = false;
    this.flagsLoaded = false;
    if (!id) return;
    this.#membersUnsub = follow(this.core.members(id), (list) => {
      this.members = list;
      this.membersLoaded = true;
    });
    void this.#loadFlags();
  }

  async #loadFlags(): Promise<void> {
    const userId = this.account?.userId;
    if (!userId) return;
    const next: Flags = { ...NO_FLAGS };
    for (const k of Object.keys(NO_FLAGS) as (keyof Flags)[]) {
      next[k] = (await this.core.getSetting(`ui.${k}.${userId}`)) === true;
    }
    if (this.account?.userId !== userId) return;
    this.flags = next;
    this.flagsLoaded = true;
  }

  async setFlag(name: keyof Flags, value = true): Promise<void> {
    const userId = this.account?.userId;
    this.flags = { ...this.flags, [name]: value };
    if (userId) await this.core.setSetting(`ui.${name}.${userId}`, value);
  }

  notify(text: string): void {
    this.toast = text;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), 4000);
  }

  /** Writes a secret-free line to the diagnostics log. */
  log(level: 'info' | 'warn' | 'error', kind: string, message: string, e?: unknown): void {
    const text = e === undefined ? message : `${message}: ${describe(e)}`;
    void this.#core?.logDiagnostic(level, kind, text, this.account?.id ?? null);
  }
}

export const app = new AppState();

/**
 * Subscribes to a core store and skips the immediate call with the store's
 * initial value: the first call of `set` carries data from the database.
 */
export function follow<T>(store: Readable<T>, set: (value: T) => void): Unsubscribe {
  let initial = true;
  const unsub = store.subscribe((v) => {
    if (!initial) set(v);
  });
  initial = false;
  return unsub;
}
