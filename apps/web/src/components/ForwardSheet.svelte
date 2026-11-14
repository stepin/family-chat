<script lang="ts">
  import { onMount } from 'svelte';
  import { isCoreError, type MessageView } from '@family-chat/core';
  import Avatar from './Avatar.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { displayNames } from '../lib/names.ts';
  import { t } from '../lib/strings.ts';

  // Forwarding one message to one or several chats (loaded on first use).
  // Every file is encrypted again for each chat by the core, so files must be
  // on this device: if some are not, the sheet says so and downloads them
  // first, with progress.
  let { accountId, chatId, message, onclose }: { accountId: string; chatId: string; message: MessageView; onclose: () => void } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let returnTo: HTMLElement | null = null;
  let filter = $state('');
  let selected = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const chats = $derived(
    app.chatList.filter((c) => c.accountId === accountId && c.member && !c.peerRemoved && !c.peerRevoked),
  );
  function title(c: (typeof chats)[number]): string {
    if (c.kind === 'self') return t.list.selfChat;
    if (c.kind === 'dm' && c.peerId) return names.get(c.peerId) ?? c.title ?? t.common.unknownName;
    return c.title ?? t.group.title(null);
  }
  const shown = $derived(
    chats.filter((c) => !filter.trim() || title(c).toLowerCase().replace(/ё/g, 'е').includes(filter.trim().toLowerCase().replace(/ё/g, 'е'))),
  );
  const missing = $derived((message.attachments ?? []).filter((a) => a.status !== 'ready'));
  const gone = $derived(missing.some((a) => a.status === 'gone'));
  const downloading = $derived(missing.some((a) => a.status === 'downloading'));
  const progress = $derived(
    missing.length === 0 ? 100 : Math.floor((missing.reduce((n, a) => n + a.progress, 0) / missing.length) * 100),
  );

  onMount(() => {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => returnTo?.focus();
  });

  function toggle(id: string): void {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }

  async function download(): Promise<void> {
    error = null;
    for (const a of missing) {
      if (a.status === 'downloading' || a.status === 'gone') continue;
      await app.core.downloadAttachment(accountId, a.blobId).catch((e: unknown) => app.log('warn', 'forward', 'download failed', e));
    }
  }

  async function send(): Promise<void> {
    if (selected.length === 0 || missing.length > 0) return;
    busy = true;
    error = null;
    try {
      await app.core.forwardMessage(accountId, chatId, message.senderId, message.msgId, selected);
      app.notify(t.forward.done(selected.length));
      dialog?.close();
    } catch (e) {
      error = isCoreError(e, 'not-downloaded') ? t.forward.needDownload : isCoreError(e, 'gone') ? t.forward.gone : t.forward.failed;
      app.log('warn', 'forward', 'forwarding failed', e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} class="sheet" onclose={onclose} aria-labelledby="forward-title" data-testid="forward-sheet">
  <div class="stack">
    <h2 id="forward-title">{t.forward.title}</h2>
    {#if missing.length > 0}
      <div class="notice" role="status">
        <p>{gone ? t.forward.gone : t.forward.needDownload}</p>
        {#if !gone}
          {#if downloading}
            <p class="small tabular">{t.forward.downloading(progress)}</p>
            <progress max="100" value={progress} aria-label={t.forward.downloading(progress)}></progress>
          {:else}
            <button class="btn small" type="button" onclick={download} data-testid="forward-download">{t.forward.download(missing.length)}</button>
          {/if}
        {/if}
      </div>
    {/if}
    <p class="muted">{t.forward.lead}</p>
    <label class="visually-hidden" for="forward-filter">{t.forward.filter}</label>
    <input id="forward-filter" class="filter" type="search" autocomplete="off" placeholder={t.forward.filter} bind:value={filter} />
    {#if shown.length === 0}
      <p class="muted">{t.forward.none}</p>
    {:else}
      <fieldset class="list">
        <legend class="visually-hidden">{t.forward.lead}</legend>
        {#each shown as c (c.chatId)}
          {@const peer = c.peerId ? app.members.find((m) => m.userId === c.peerId) : undefined}
          <label class="item">
            <input type="checkbox" checked={selected.includes(c.chatId)} onchange={() => toggle(c.chatId)} />
            <Avatar accountId={c.accountId} userId={c.peerId} name={title(c)} kind={c.kind === 'dm' ? 'person' : c.kind} hasAvatar={!!peer?.avatar} size={32} />
            <span class="name">{title(c)}</span>
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row">
      <button class="btn secondary" type="button" onclick={() => dialog?.close()}>{t.common.cancel}</button>
      <button class="btn" type="button" disabled={busy || selected.length === 0 || missing.length > 0} onclick={send} data-testid="forward-send">
        {busy ? t.forward.sending : t.forward.send(selected.length)}
      </button>
    </div>
  </div>
</dialog>

<style>
  .sheet {
    width: min(28rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 2rem);
    padding: var(--sp-4);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  h2 {
    font-size: var(--text-l);
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
    border-radius: var(--r-m);
    background: var(--warn-soft);
  }

  .notice .btn {
    align-self: flex-start;
  }

  progress {
    width: 100%;
  }

  .filter {
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--bg);
    font-size: var(--text-m);
  }

  .list {
    margin: 0;
    padding: 0;
    border: 0;
    max-height: 40dvh;
    overflow-y: auto;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--r-m);
    cursor: pointer;
  }

  .item:hover {
    background: var(--surface-2);
  }

  .item input {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
</style>
