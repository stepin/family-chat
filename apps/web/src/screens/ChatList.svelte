<script lang="ts">
  import type { ChatListItem, Member } from '@family-chat/core';
  import Icon from '../components/Icon.svelte';
  import StatusLine from '../components/StatusLine.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatListTime } from '../lib/format.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { enableNotifications, notifyEnv, notifyState } from '../lib/push.ts';
  import { t } from '../lib/strings.ts';

  // Chat list (docs/PLAN.md 8.3): status line, chats with name and time,
  // last message and counter; marks for drafts and failed sends.
  const account = $derived(app.account!);
  const chats = $derived(app.chats.filter((c) => c.accountId === account.id));
  const failedByChat = $derived.by(() => {
    const m = new Set<string>();
    for (const o of app.outbox) if (o.status === 'failed') m.add(`${o.accountId}/${o.chatId}`);
    return m;
  });
  const others = $derived(app.members.filter((m) => !m.isMe && !m.removed));
  const removed = $derived(account.status === 'removed' || app.connection[account.id]?.kind === 'removed');
  const openChatId = $derived(nav.top.name === 'chat' ? nav.top.chatId : null);

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  let notifyEnvNow = $state(notifyEnv());
  const pushState = $derived(notifyState(notifyEnvNow, app.platform, account));
  const offerNotify = $derived(
    app.flagsLoaded && !app.flags.notifyDismissed && !removed && pushState === 'off' && chats.some((c) => c.lastMessage),
  );
  const phraseReminder = $derived(
    app.flagsLoaded && !app.flags.phraseConfirmed && !removed && (account.admin || app.flags.phraseOffered),
  );

  async function turnOnNotifications(): Promise<void> {
    try {
      await enableNotifications(app.core, account);
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

  function preview(c: ChatListItem): string {
    const last = c.lastMessage;
    if (!last) return t.list.emptyChat;
    const body = last.kind === 'update-required' ? t.list.updateRequired : last.body.replace(/\s+/g, ' ');
    return last.outgoing ? `${t.list.youPrefix} ${body}` : body;
  }

  function name(c: ChatListItem): string {
    return c.peerName ?? t.common.unknownName;
  }

  /** Arrow keys move between chats (docs/PLAN.md 8.7). */
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
  <header class="screen-header">
    <h1 id="list-title" class="family">{account.familyName}</h1>
    {#if !removed}
      <button class="icon-btn" type="button" aria-label={t.list.newChat} onclick={() => nav.push({ name: 'new-chat' })}>
        <Icon name="plus" />
      </button>
    {/if}
    <button class="icon-btn" type="button" aria-label={t.list.openSettings} onclick={() => nav.push({ name: 'settings' })}>
      <Icon name="settings" />
    </button>
  </header>
  <StatusLine {account} />

  <div class="body">
    {#if removed}
      <div class="banner error" role="alert">
        <strong>{t.status.removed(account.familyName)}</strong>
        <p>{t.status.removedText}</p>
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
    {:else if chats.length > 0}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul class="chats" aria-label={t.list.title} onkeydown={onListKey}>
        {#each chats as c (c.chatId)}
          {@const failed = failedByChat.has(`${c.accountId}/${c.chatId}`)}
          <li>
            <button
              class="chat"
              type="button"
              aria-current={openChatId === c.chatId ? 'true' : undefined}
              onclick={() => nav.openChat(c.accountId, c.chatId)}
            >
              <span class="avatar" aria-hidden="true">{name(c).slice(0, 1).toUpperCase()}</span>
              <span class="lines">
                <span class="line1">
                  <span class="name">{name(c)}{#if c.peerRemoved}<span class="muted small"> · {t.list.removedPeer}</span>{/if}</span>
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
    {:else if app.membersLoaded}
      <div class="empty">
        {#if others.length > 0}
          <h2>{t.list.emptyMemberTitle}</h2>
          <ul class="people">
            {#each others as m (m.userId)}
              <li>
                <button class="person" type="button" onclick={() => startChat(m)}>
                  <span class="avatar" aria-hidden="true">{(m.name ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span class="name">{m.name ?? t.common.unknownName}</span>
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
  </div>

  {#if app.updateReady}
    <div class="update" role="status">
      <span>{t.list.updateAvailable}</span>
      <button class="btn small" type="button" onclick={() => app.applyUpdate()}>{t.list.updateAction}</button>
    </div>
  {/if}
</section>

<style>
  .family {
    padding-left: var(--sp-2);
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

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
    font-size: var(--text-m);
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
