<script lang="ts">
  import type { ChatSummary, Member } from '@family-chat/core';
  import Avatar from '../components/Avatar.svelte';
  import FamilySwitcher from '../components/FamilySwitcher.svelte';
  import Icon from '../components/Icon.svelte';
  import StatusLine from '../components/StatusLine.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { pageServerUrl } from '../lib/invite.ts';
  import { formatListTime } from '../lib/format.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { enableNotifications, notifyEnv, notifyState, pushAccountOf } from '../lib/push.ts';
  import { archiveReminder, type Reminder } from '../lib/storage.ts';
  import { t } from '../lib/strings.ts';

  // Chat list: status line, "Избранное" pinned first,
  // then groups and direct chats by time; avatars, member counts, marks for
  // drafts, failed sends and failed uploads.
  const account = $derived(app.account!);
  const chats = $derived(app.chatList.filter((c) => c.accountId === account.id));
  const otherChats = $derived(chats.filter((c) => c.kind !== 'self'));
  const failedByChat = $derived.by(() => {
    const m = new Set<string>();
    for (const o of app.outbox) if (o.status === 'failed') m.add(`${o.accountId}/${o.chatId}`);
    for (const x of app.transfers) if (x.direction === 'up' && x.status === 'failed') m.add(`${x.accountId}/${x.chatId}`);
    return m;
  });
  const others = $derived(app.members.filter((m) => !m.isMe && !m.removed && !m.revoked));
  const memberById = $derived(new Map(app.members.map((m) => [m.userId, m])));
  const me = $derived(app.members.find((m) => m.isMe));
  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const removed = $derived(account.status === 'removed' || app.connection[account.id]?.kind === 'removed');
  const openChatId = $derived(nav.top.name === 'chat' ? nav.top.chatId : null);
  const groupSizes = $state<Record<string, number>>({});

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  // Member counts of groups (from the verified signed state); re-subscribed only when the set of groups changes.
  const groupIds = $derived(
    chats
      .filter((c) => c.kind === 'group')
      .map((c) => c.chatId)
      .join(' '),
  );
  $effect(() => {
    const accountId = account.id;
    const unsubs = groupIds
      .split(' ')
      .filter((id) => id.length > 0)
      .map((chatId) =>
        app.core.group(accountId, chatId).subscribe((g) => {
          if (g) groupSizes[chatId] = g.members.length;
        }),
      );
    return () => unsubs.forEach((u) => u());
  });

  let notifyEnvNow = $state(notifyEnv());
  const pushState = $derived(notifyState(notifyEnvNow, app.platform, account, pushAccountOf(app.accounts, pageServerUrl(location))));
  const offerNotify = $derived(
    app.flagsLoaded && !app.flags.notifyDismissed && !removed && pushState === 'off' && otherChats.some((c) => c.lastMessage),
  );
  const phraseReminder = $derived(
    app.flagsLoaded && !app.flags.phraseConfirmed && !removed && (account.admin || app.flags.phraseOffered),
  );

  // The archive reminder: once every 30 days, loudly when storage is not persistent.
  let reminder = $state<Reminder>('none');
  async function checkReminder(): Promise<void> {
    let firstSeen = await app.getValue<number>('firstSeen');
    if (typeof firstSeen !== 'number') {
      firstSeen = Date.now();
      await app.setValue('firstSeen', firstSeen);
    }
    const lastExport = (await app.getValue<number>('lastExport')) ?? null;
    const snoozedAt = (await app.getValue<number>('archiveSnoozed')) ?? null;
    reminder = archiveReminder({ now: Date.now(), persisted: app.persisted, lastExport, snoozedAt, firstSeen });
  }
  $effect(() => {
    void app.persisted;
    void checkReminder();
  });

  async function snoozeReminder(): Promise<void> {
    reminder = 'none';
    await app.setValue('archiveSnoozed', Date.now());
  }

  async function turnOnNotifications(): Promise<void> {
    try {
      await enableNotifications(app.core, account, app.accounts);
    } catch (e) {
      app.notify(t.notify.failed);
      app.log('warn', 'push', 'enabling notifications failed', e);
    }
    notifyEnvNow = notifyEnv();
  }

  async function startChat(m: Member): Promise<void> {
    try {
      const chatId = await app.core.openChat(account.id, m.userId);
      nav.openChat(account.id, chatId, true);
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'chat', 'opening a chat failed', e);
    }
  }

  function title(c: ChatSummary): string {
    if (c.kind === 'self') return t.list.selfChat;
    if (c.kind === 'dm' && c.peerId) return names.get(c.peerId) ?? c.title ?? t.common.unknownName;
    return c.title ?? (c.kind === 'group' ? t.group.title(null) : t.common.unknownName);
  }

  function preview(c: ChatSummary): string {
    const last = c.lastMessage;
    if (!last) return c.kind === 'self' ? t.list.selfChatEmpty : t.list.emptyChat;
    if (last.kind === 'update-required') return t.list.updateRequired;
    if (last.kind === 'deleted') return t.list.deleted;
    if (last.kind === 'service') return t.list.groupChanged;
    const media =
      last.media === 'sticker'
        ? `${t.list.sticker} ${last.body}`.trim()
        : last.media === 'voice' ? t.list.voice : last.media === 'location' ? t.list.location : last.media === 'image' ? t.list.photo : last.media === 'file' ? t.list.file : null;
    const body = (last.media === 'sticker' ? media : last.body.replace(/\s+/g, ' ').trim()) || media || t.list.attachment(1);
    if (last.outgoing && c.kind !== 'self') return `${t.list.youPrefix} ${body}`;
    if (c.kind === 'group' && last.senderId) {
      const who = names.get(last.senderId);
      if (who) return `${who}: ${body}`;
    }
    return body;
  }

  function marks(c: ChatSummary): string[] {
    const out: string[] = [];
    if (c.kind === 'group') {
      const n = groupSizes[c.chatId];
      if (n !== undefined) out.push(t.list.members(n));
      if (!c.member) out.push(t.list.notMember);
    }
    if (c.kind === 'dm') {
      const peer = c.peerId ? memberById.get(c.peerId) : undefined;
      if (c.peerRevoked) out.push(t.list.revokedPeer(peer?.gender ?? 'm'));
      else if (c.peerRemoved) out.push(t.list.removedPeer(peer?.gender ?? 'm'));
      else if (peer?.keyChanged) out.push(t.list.keyChanged);
    }
    return out;
  }

  /** Arrow keys move between chats. */
  function onListKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = e.currentTarget as HTMLElement;
    const items = [...list.querySelectorAll<HTMLButtonElement>('button.chat')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }
</script>

<section class="screen" aria-labelledby="list-title">
  <!-- No family name at the top. My avatar opens Settings; the switcher appears only with several families. -->
  <header class="screen-header">
    <button class="icon-btn me" type="button" aria-label={t.list.openSettings} onclick={() => nav.push({ name: 'settings' })} data-testid="open-settings">
      <Avatar accountId={account.id} userId={account.userId} name={me?.name ?? null} hasAvatar={!!me?.avatar} size={34} />
    </button>
    <h1 id="list-title" class="list-title">{t.list.title}</h1>
    {#if app.accounts.length > 1}<FamilySwitcher />{/if}
    <button class="icon-btn" type="button" aria-label={t.search.open} onclick={() => nav.push({ name: 'search' })} data-testid="open-search">
      <Icon name="search" />
    </button>
    {#if !removed}
      <button class="icon-btn" type="button" aria-label={t.list.newChat} onclick={() => nav.push({ name: 'new-chat' })}>
        <Icon name="plus" />
      </button>
    {/if}
  </header>
  <StatusLine {account} />

  <div class="body">
    {#if removed}
      <div class="banner error" role="alert">
        {#if account.revoked}
          <strong>{t.status.revoked(app.familyLabel(account.familyName))}</strong>
          <p>{t.status.revokedText}</p>
        {:else}
          <strong>{t.status.removed(app.familyLabel(account.familyName))}</strong>
          <p>{t.status.removedText}</p>
        {/if}
      </div>
    {:else if !account.initialSyncDone}
      <p class="banner muted small" role="status">{t.status.syncing}</p>
    {/if}

    {#if phraseReminder}
      <div class="banner warn">
        <p>{t.phrase.reminder}</p>
        <button class="btn small" type="button" onclick={() => nav.push({ name: 'phrase' })}>{t.phrase.reminderAction}</button>
      </div>
    {/if}

    {#if reminder !== 'none' && !removed}
      <div class="banner" class:warn={reminder === 'warning'} data-testid="archive-reminder">
        <p>
          <strong>{reminder === 'warning' ? t.list.archiveWarnTitle : t.list.archiveTitle}</strong>
          {reminder === 'warning' ? t.list.archiveWarnText : t.list.archiveText(account.retentionDays)}
        </p>
        <div class="row">
          <button class="btn small" type="button" onclick={() => nav.push({ name: 'storage' })}>{t.list.archiveAction}</button>
          <button class="btn secondary small" type="button" onclick={snoozeReminder}>{t.common.notNow}</button>
        </div>
      </div>
    {/if}

    {#if offerNotify}
      <div class="banner">
        <p><strong>{t.list.notifyTitle}</strong> {t.list.notifyText}</p>
        <div class="row">
          <button class="btn small" type="button" onclick={turnOnNotifications}>{t.list.notifyAction}</button>
          <button class="btn secondary small" type="button" onclick={() => app.setFlag('notifyDismissed')}>{t.common.notNow}</button>
        </div>
      </div>
    {/if}

    {#if !app.chatsLoaded}
      <ul class="skeleton" aria-hidden="true">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}<li></li>{/each}
      </ul>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul class="chats" aria-label={t.list.title} onkeydown={onListKey}>
        {#each chats as c (c.chatId)}
          {@const failed = failedByChat.has(`${c.accountId}/${c.chatId}`)}
          {@const peer = c.peerId ? memberById.get(c.peerId) : undefined}
          {@const extra = marks(c)}
          <li>
            <button
              class="chat"
              type="button"
              data-kind={c.kind}
              aria-current={openChatId === c.chatId ? 'true' : undefined}
              onclick={() => nav.openChat(c.accountId, c.chatId)}
            >
              <Avatar
                accountId={c.accountId}
                userId={c.peerId}
                name={title(c)}
                kind={c.kind === 'dm' ? 'person' : c.kind}
                hasAvatar={!!peer?.avatar}
              />
              <span class="lines">
                <span class="line1">
                  <span class="name">{title(c)}{#if extra.length > 0}<span class="muted small extra"> · {extra.join(' · ')}</span>{/if}</span>
                  {#if c.lastTime}<span class="time tabular">{formatListTime(c.lastTime, now)}</span>{/if}
                </span>
                <span class="line2">
                  {#if failed}
                    <span class="mark failed">{t.list.failed}</span>
                  {:else if c.draft}
                    <span class="preview"><span class="mark draft">{t.list.draft}</span> {c.draft}</span>
                  {:else}
                    <span class="preview">{preview(c)}</span>
                  {/if}
                  {#if c.unread > 0}
                    <span class="badge tabular" aria-hidden="true">{c.unread}</span>
                    <span class="visually-hidden">{t.list.unread(c.unread)}</span>
                  {/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if otherChats.length === 0 && app.membersLoaded}
        <div class="empty">
          {#if others.length > 0}
            <h2>{t.list.emptyMemberTitle}</h2>
            <ul class="people">
              {#each others as m (m.userId)}
                <li>
                  <button class="person" type="button" onclick={() => startChat(m)}>
                    <Avatar accountId={account.id} userId={m.userId} name={m.name} hasAvatar={!!m.avatar} />
                    <span class="name">{names.get(m.userId) ?? t.common.unknownName}</span>
                    <Icon name="chevron" size={20} />
                  </button>
                </li>
              {/each}
            </ul>
          {:else if account.admin}
            <h2>{t.list.emptyAdminTitle}</h2>
            <p class="muted">{t.list.emptyAdminText}</p>
            <button class="btn" type="button" onclick={() => nav.push({ name: 'invites' })}>{t.list.emptyAdminAction}</button>
          {:else}
            <p class="muted">{t.list.emptyNobody}</p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  {#if app.updateReady}
    <div class="update" role="status">
      <span>{t.list.updateAvailable}</span>
      <button class="btn small" type="button" onclick={() => app.applyUpdate()}>{t.list.updateAction}</button>
    </div>
  {/if}
</section>

<style>
  .list-title {
    padding-left: var(--sp-1);
  }

  .me {
    overflow: hidden;
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .banner {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-3) var(--sp-3) 0;
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface-2);
  }

  .banner.warn {
    background: var(--warn-soft);
  }

  .banner.error {
    background: var(--error-soft);
  }

  .banner .btn {
    align-self: flex-start;
  }

  .chats,
  .people,
  .skeleton {
    margin: 0;
    padding: var(--sp-2) 0;
    list-style: none;
  }

  .chat,
  .person {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 64px;
    padding: var(--sp-2) var(--sp-4);
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .chat:hover,
  .person:hover {
    background: var(--surface-2);
  }

  .chat[aria-current='true'] {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .chat[aria-current='true'] .time,
  .chat[aria-current='true'] .preview {
    color: var(--on-accent-soft-muted);
  }


  .lines {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    gap: 2px;
  }

  .line1,
  .line2 {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .name {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    font-size: var(--text-m);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .extra {
    font-weight: 400;
  }

  .time {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .preview {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--muted);
    font-size: var(--text-s);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mark {
    font-size: var(--text-s);
    font-weight: 600;
  }

  .mark.failed {
    flex: 1 1 auto;
    color: var(--error);
  }

  .mark.draft {
    color: var(--warn);
  }

  .badge {
    flex: 0 0 auto;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-xs);
    font-weight: 700;
    line-height: 22px;
    text-align: center;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-6) var(--sp-4);
  }

  .empty .btn {
    align-self: flex-start;
  }

  .people {
    margin: 0 calc(-1 * var(--sp-4));
  }

  .skeleton li {
    height: 48px;
    margin: var(--sp-2) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface-2);
  }

  .update {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-4);
    padding-bottom: max(var(--sp-2), env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: var(--surface);
  }
</style>
