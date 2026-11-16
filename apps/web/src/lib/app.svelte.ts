// Application state shared by all screens: the core (one per page, on the
// main thread), the boot phase, the pending invitation, the update
// banner and short notices.

import {
  createCore,
  DbVersionError,
  type SharedContent,
  type AccountView,
  type ChatSummary,
  type ConnectionState,
  type Hello,
  type TransferView,
  type FamilyChatCore,
  type Gender,
  type Member,
  type OutboxItem,
  type Readable,
  type Unsubscribe,
} from '@family-chat/core';
import { showUnread } from './badge.ts';
import { describe } from './errors.ts';
import type { ParsedInvite } from './invite.ts';
import { currentPlatform, type PlatformInfo } from './platform.ts';
import { LANG_SETTING_KEY, readLangPref, resolveLang, systemLanguages, writeLangPref, type Lang, type LangPref } from './locale.ts';
import { activeLang, loadStrings } from './strings.ts';

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

/** Setting: the family shown on this device (several servers). */
const CURRENT_ACCOUNT = 'ui.currentAccount';

/** Shared content waiting for its chat (Web Share Target). */
export interface PendingShare {
  readonly accountId: string;
  readonly chatId: string;
  readonly content: SharedContent;
}

class AppState {
  phase: BootPhase = $state('loading');
  /** Accounts on this device (families on several servers). */
  accounts: AccountView[] = $state.raw([]);
  /** The family shown now; falls back to the first account. */
  currentId: string | null = $state(null);
  /** Total unread over all families (the icon badge and the title). */
  unreadTotal = $state(0);
  /** Shared content (Web Share Target) on its way into a chat. */
  pendingShare: PendingShare | null = $state.raw(null);
  /** Shared content waiting for the person to choose a chat (the chooser is open). */
  choosingShare: SharedContent | null = $state.raw(null);
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
  /** All chats: "Избранное" first, then groups and direct chats by time. */
  chatList: ChatSummary[] = $state.raw([]);
  chatsLoaded = $state(false);
  /** Uploads and downloads in the queue, active or failed. */
  transfers: TransferView[] = $state.raw([]);
  /** `/v1/hello` of the shown account's server (limits), once fetched. */
  hello: Hello | null = $state.raw(null);
  /** `navigator.storage.persisted()`; null while unknown. */
  persisted: boolean | null = $state(null);
  outbox: OutboxItem[] = $state.raw([]);
  connection: Record<string, ConnectionState> = $state.raw({});
  /** Family members of the shown account. */
  members: Member[] = $state.raw([]);
  membersLoaded = $state(false);
  /** Per-identity interface flags stored in the core's settings table. */
  flags: Flags = $state({ ...NO_FLAGS });
  /** Interface language and the person's choice; the screens are keyed by `lang`. */
  lang: Lang = $state(activeLang());
  langPref: LangPref = $state(readLangPref());
  flagsLoaded = $state(false);
  #membersOf: string | null = null;
  #membersUnsub: Unsubscribe | undefined;
  #core: FamilyChatCore | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;

  get core(): FamilyChatCore {
    if (!this.#core) throw new Error('core not started');
    return this.#core;
  }

  /** The family shown now (one of several servers). */
  get account(): AccountView | null {
    return this.accounts.find((a) => a.id === this.currentId) ?? this.accounts[0] ?? null;
  }

  /** Gender of a member of the shown family from the profile; male when unknown. */
  genderOf(userId: string | null | undefined): Gender {
    return (userId ? this.members.find((m) => m.userId === userId)?.gender : undefined) ?? 'm';
  }

  /** My own gender in the shown family (for "Я записала", "Напишите первой"). */
  get myGender(): Gender {
    return this.members.find((m) => m.isMe)?.gender ?? 'm';
  }

  /** The family name where it is needed to tell families apart: only with several families on this device. */
  familyLabel(name: string): string | null {
    return this.accounts.length > 1 ? name : null;
  }

  /** Unread messages per family (for the switcher). */
  get unreadByAccount(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.chatList) out[c.accountId] = (out[c.accountId] ?? 0) + c.unread;
    return out;
  }

  /** Shows another family: its chat list, members and settings. */
  async switchAccount(accountId: string): Promise<void> {
    // A family added a moment ago may not be in the live list yet.
    if (!this.accounts.some((a) => a.id === accountId)) this.accounts = await this.core.accountList();
    if (!this.accounts.some((a) => a.id === accountId)) return;
    this.currentId = accountId;
    this.#watchMembers();
    await this.#core?.setSetting(CURRENT_ACCOUNT, accountId).catch(() => undefined);
  }

  /**
   * Removes a family from this device (with its local history). Shows
   * another family afterwards, or the welcome screen when none is left.
   */
  async removeAccount(accountId: string): Promise<void> {
    await this.core.removeAccount(accountId);
    this.accounts = await this.core.accountList();
    if (this.currentId === accountId) this.currentId = this.accounts[0]?.id ?? null;
    this.#watchMembers();
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
    const saved = await core.getSetting<string>(CURRENT_ACCOUNT).catch(() => undefined);
    this.currentId = this.accounts.some((a) => a.id === saved) ? (saved ?? null) : (this.accounts[0]?.id ?? null);
    follow(core.accounts, (list) => {
      this.accounts = list;
      this.#watchMembers();
    });
    follow(core.chatList, (list) => {
      this.chatList = list;
      this.chatsLoaded = true;
    });
    follow(core.transfers, (list) => (this.transfers = list));
    // The badge and the title follow the total; the count is stored for the service worker.
    follow(core.unreadTotal, (n) => {
      this.unreadTotal = n;
      showUnread(n);
      void core.noteBadge(n).catch(() => undefined);
    });
    follow(core.outbox, (list) => (this.outbox = list));
    core.connection.subscribe((c) => (this.connection = c));
    this.#watchMembers();
    window.addEventListener('online', () => core.wake());
    // The service worker reads the language from the database; localStorage is what this page used.
    void core.setSetting(LANG_SETTING_KEY, this.langPref).catch(() => undefined);
    window.addEventListener('languagechange', () => {
      if (this.langPref === 'system') void this.setLanguage('system');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      core.wake();
      // The service worker may have counted pushes meanwhile: back to the real total.
      showUnread(this.unreadTotal);
      void core.noteBadge(this.unreadTotal).catch(() => undefined);
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
    this.hello = null;
    if (!id) return;
    void this.refreshHello();
    void this.refreshPersisted();
    this.#membersUnsub = follow(this.core.members(id), (list) => {
      this.members = list;
      this.membersLoaded = true;
    });
    void this.#loadFlags();
  }

  /** Fetches the server's limits (file size, retention) for the shown account. */
  async refreshHello(): Promise<Hello | null> {
    const account = this.account;
    if (!account) return null;
    try {
      const h = await this.core.serverInfo(account.serverUrl);
      if (this.account?.id === account.id) this.hello = h;
      return h;
    } catch (e) {
      this.log('info', 'hello', 'server info not fetched', e);
      return null;
    }
  }

  async refreshPersisted(): Promise<void> {
    try {
      this.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    } catch {
      this.persisted = null;
    }
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

  /** A per-identity interface value (timestamps of the archive reminder and similar). */
  async getValue<T>(name: string): Promise<T | undefined> {
    const userId = this.account?.userId;
    return userId ? this.core.getSetting<T>(`ui.${name}.${userId}`) : undefined;
  }

  async setValue(name: string, value: unknown): Promise<void> {
    const userId = this.account?.userId;
    if (userId) await this.core.setSetting(`ui.${name}.${userId}`, value);
  }

  /**
   * Switches the interface language at once: loads the catalogue, then the
   * screens render again (App.svelte keys them by `lang`). Kept in
   * localStorage for the next start and in the settings table for the
   * service worker's notifications.
   */
  async setLanguage(pref: LangPref): Promise<void> {
    writeLangPref(pref);
    const lang = resolveLang(pref, systemLanguages());
    await loadStrings(lang);
    this.langPref = pref;
    this.lang = lang;
    await this.#core?.setSetting(LANG_SETTING_KEY, pref).catch(() => undefined);
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
