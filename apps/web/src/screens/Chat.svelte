<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { MessageView } from '@family-chat/core';
  import Composer from '../components/Composer.svelte';
  import Icon from '../components/Icon.svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import { app, follow } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { groupByDay } from '../lib/group.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // A direct chat: messages grouped by day, own messages on the right, send
  // statuses with retry and cancel, older messages on scrolling up, the
  // composer at the bottom (docs/PLAN.md 8, screen 9).
  let { accountId, chatId, focus = false }: { accountId: string; chatId: string; focus?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  const view = app.core.chat(accountId, chatId);
  let messages = $state.raw<MessageView[]>([]);
  let loaded = $state(false);
  let older = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  let feedEl: HTMLDivElement | undefined = $state();
  let sentinel: HTMLDivElement | undefined = $state();
  let now = $state(Date.now());
  let announce = $state('');
  let offerPhrase = $state(false);
  /** Keys present when the chat opened; later ones animate in. */
  let initialKeys = $state.raw(new Set<string>());
  let stickToBottom = true;

  const account = $derived(app.accounts.find((a) => a.id === accountId) ?? null);
  const item = $derived(app.chats.find((c) => c.accountId === accountId && c.chatId === chatId) ?? null);
  const peer = $derived(item ? app.members.find((m) => m.userId === item.peerId) : undefined);
  const peerName = $derived(peer?.name ?? item?.peerName ?? t.common.unknownName);
  const removed = $derived(account?.status === 'removed' || app.connection[accountId]?.kind === 'removed');
  const peerRemoved = $derived(peer?.removed ?? item?.peerRemoved ?? false);
  const feed = $derived(groupByDay(messages, now));

  // The chat list's counter may update after the messages: clear it whenever it rises while the chat is open.
  $effect(() => {
    if ((item?.unread ?? 0) > 0 && loaded) markReadIfVisible();
  });

  function nearBottom(): boolean {
    if (!feedEl) return true;
    return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
  }

  function scrollToBottom(): void {
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }

  function markReadIfVisible(): void {
    if (document.visibilityState === 'visible' && (item?.unread ?? 0) > 0) void view.markRead();
  }

  async function onMessages(list: MessageView[]): Promise<void> {
    const wasLoaded = loaded;
    const stick = nearBottom() || stickToBottom;
    if (wasLoaded) {
      const prev = new Set(messages.map((m) => m.key));
      const incoming = list.filter((m) => !prev.has(m.key) && !m.outgoing && m.kind === 'msg');
      // Only new messages are announced (not older ones loaded on scrolling).
      const newest = incoming.at(-1);
      if (newest && newest.key === list.at(-1)?.key) {
        announce = `${t.chat.incoming(peerName)}: ${newest.body.slice(0, 200)}`;
      }
    } else {
      initialKeys = new Set(list.map((m) => m.key));
    }
    messages = list;
    loaded = true;
    await tick();
    if (!wasLoaded || stick) scrollToBottom();
    stickToBottom = false;
    markReadIfVisible();
    if (!wasLoaded) checkTop();
  }

  /** The observer does not fire again while the top stays visible: short chats are checked here. */
  function checkTop(): void {
    if (feedEl && feedEl.scrollTop < 200) void loadOlder();
  }

  async function loadOlder(): Promise<void> {
    if (older === 'loading' || older === 'done' || !feedEl) return;
    older = 'loading';
    const fromBottom = feedEl.scrollHeight - feedEl.scrollTop;
    try {
      const more = await view.loadOlder();
      await tick();
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight - fromBottom;
      older = more ? 'idle' : 'done';
      if (more) checkTop();
    } catch (e) {
      older = 'error';
      app.log('warn', 'chat', 'loading older messages failed', e);
    }
  }

  onMount(() => {
    const unsub = follow(view.messages, (list) => void onMessages(list));
    const timer = setInterval(() => (now = Date.now()), 60_000);
    const onVisible = () => markReadIfVisible();
    document.addEventListener('visibilitychange', onVisible);
    let io: IntersectionObserver | undefined;
    if (sentinel && feedEl && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => {
          if (loaded && entries.some((e) => e.isIntersecting)) void loadOlder();
        },
        { root: feedEl, rootMargin: '200px 0px 0px 0px' },
      );
      io.observe(sentinel);
    }
    return () => {
      unsub();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      io?.disconnect();
    };
  });

  async function send(text: string): Promise<boolean> {
    try {
      stickToBottom = true;
      await app.core.send(accountId, chatId, text);
      // Invited relatives are offered the recovery phrase after the first sent message.
      if (account && !account.admin && app.flagsLoaded && !app.flags.phraseOffered && !app.flags.phraseConfirmed) {
        offerPhrase = true;
      }
      return true;
    } catch (e) {
      app.notify(errorText(e));
      app.log('warn', 'chat', 'queueing a message failed', e);
      return false;
    }
  }

  function retry(m: MessageView): void {
    void app.core.retry(accountId, m.msgId).catch((e: unknown) => app.log('warn', 'chat', 'retry failed', e));
  }

  function cancel(m: MessageView): void {
    void app.core.cancel(accountId, m.msgId).catch((e: unknown) => app.log('warn', 'chat', 'cancel failed', e));
  }

  async function phraseNow(): Promise<void> {
    offerPhrase = false;
    await app.setFlag('phraseOffered');
    nav.push({ name: 'phrase' });
  }

  async function phraseLater(): Promise<void> {
    offerPhrase = false;
    await app.setFlag('phraseOffered');
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !app.wide) nav.back();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="screen chat" aria-labelledby="chat-title-{chatId}" onkeydown={onKeydown}>
  <header class="screen-header">
    {#if !app.wide}
      <button class="icon-btn" type="button" aria-label={t.chat.back} onclick={() => nav.back()}>
        <Icon name="back" />
      </button>
    {/if}
    <span class="avatar" aria-hidden="true">{peerName.slice(0, 1).toUpperCase()}</span>
    <h1 id="chat-title-{chatId}">{peerName}</h1>
  </header>

  <div class="feed" bind:this={feedEl} data-testid="feed">
    <div class="top" bind:this={sentinel}>
      {#if loaded && messages.length > 0}
        {#if older === 'loading'}
          <p class="muted small" role="status">{t.chat.loadingOlder}</p>
        {:else if older === 'done'}
          {#if account?.retentionGap}
            <p class="notice small" data-testid="retention-gap">{t.chat.gap(account.retentionGap.firstTime)}</p>
          {:else}
            <p class="muted small">{t.chat.beginning}</p>
          {/if}
        {:else}
          {#if older === 'error'}<p class="error-text small">{t.chat.olderFailed}</p>{/if}
          <button class="btn secondary small" type="button" onclick={loadOlder}>{t.chat.loadOlder}</button>
        {/if}
      {/if}
    </div>

    {#if loaded && messages.length === 0}
      <p class="empty muted">{t.chat.empty}</p>
    {/if}

    <ol class="messages" aria-label={peerName}>
      {#each feed as entry (entry.key)}
        {#if entry.kind === 'day'}
          <li class="day"><span>{entry.label}</span></li>
        {:else}
          <li>
            <span class="visually-hidden">{entry.message.outgoing ? t.chat.outgoing : t.chat.incoming(peerName)}:</span>
            <MessageBubble
              message={entry.message}
              continued={entry.continued}
              fresh={!initialKeys.has(entry.key)}
              onretry={retry}
              oncancel={cancel}
            />
          </li>
        {/if}
      {/each}
    </ol>
  </div>

  <div class="visually-hidden" aria-live="polite" aria-atomic="true">{announce}</div>

  {#if offerPhrase}
    <section class="offer" aria-labelledby="offer-title-{chatId}">
      <h2 id="offer-title-{chatId}">{t.phrase.offerTitle}</h2>
      <p>{t.phrase.offerText}</p>
      <div class="row">
        <button class="btn small" type="button" onclick={phraseNow}>{t.phrase.offerShow}</button>
        <button class="btn secondary small" type="button" onclick={phraseLater}>{t.common.later}</button>
      </div>
    </section>
  {/if}

  {#if removed}
    <p class="blocked" role="status">{t.chat.removedComposer}</p>
  {:else if peerRemoved}
    <p class="blocked" role="status">{t.chat.peerRemovedComposer}</p>
  {:else}
    <Composer {accountId} {chatId} autofocus={focus} onsend={send} />
  {/if}
</section>

<style>
  .chat {
    background: var(--bg);
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    margin-left: var(--sp-1);
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
  }

  .feed {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: var(--sp-3);
  }

  .top {
    display: flex;
    justify-content: center;
    padding: var(--sp-3) var(--sp-4) 0;
    text-align: center;
  }

  .empty {
    padding: var(--sp-8) var(--sp-4);
    text-align: center;
  }

  .messages {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .day {
    display: flex;
    justify-content: center;
    margin: var(--sp-4) 0 var(--sp-2);
  }

  .day span {
    padding: 2px var(--sp-3);
    border-radius: var(--r-l);
    background: var(--surface-2);
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .offer {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0 var(--sp-3) var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--warn-soft);
  }

  .offer h2 {
    font-size: var(--text-m);
  }

  .blocked {
    padding: var(--sp-4);
    padding-bottom: max(var(--sp-4), env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    text-align: center;
  }
</style>
