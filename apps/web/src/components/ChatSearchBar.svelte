<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Search inside one chat (loaded on first use): messages stored on this
  // device, newest first; "3 из 12", previous (older) and next (newer), Enter
  // goes on to the next older match, Escape closes. The chat jumps to each
  // match, loading older messages from the local database when needed.
  let {
    accountId,
    chatId,
    onjump,
    onclose,
  }: {
    accountId: string;
    chatId: string;
    onjump: (senderId: string, msgId: string, gseq: number) => void;
    onclose: () => void;
  } = $props();

  let text = $state('');
  let hits = $state.raw<{ senderId: string; msgId: string; gseq: number }[]>([]);
  let index = $state(0);
  let busy = $state(false);
  let done = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let input: HTMLInputElement | undefined = $state();
  let seq = 0;

  onMount(() => {
    input?.focus();
    return () => clearTimeout(timer);
  });

  function onInput(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  }

  async function run(): Promise<void> {
    const q = text.trim();
    const mine = ++seq;
    if (!q) {
      hits = [];
      done = false;
      return;
    }
    busy = true;
    try {
      const r = await app.core.searchChat(accountId, chatId, q);
      if (mine !== seq) return;
      hits = r.hits.map((h) => ({ senderId: h.senderId, msgId: h.msgId, gseq: h.gseq }));
      index = 0;
      done = true;
      if (hits[0]) onjump(hits[0].senderId, hits[0].msgId, hits[0].gseq);
    } catch (e) {
      app.log('warn', 'search', 'chat search failed', e);
    } finally {
      if (mine === seq) busy = false;
    }
  }

  function step(delta: number): void {
    if (hits.length === 0) return;
    index = (index + delta + hits.length) % hits.length;
    const h = hits[index]!;
    onjump(h.senderId, h.msgId, h.gseq);
  }

  /** Escape anywhere in the bar (the field or its buttons) closes it. */
  function onBarKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (!done) void run();
      else step(e.shiftKey ? -1 : 1);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="chat-search" role="search" data-testid="chat-search" onkeydown={onBarKey}>
  <label class="visually-hidden" for="chat-search-{chatId}">{t.search.fieldChat}</label>
  <input
    id="chat-search-{chatId}"
    bind:this={input}
    bind:value={text}
    type="search"
    autocomplete="off"
    placeholder={t.search.fieldChat}
    aria-describedby="chat-search-note-{chatId}"
    oninput={onInput}
    onkeydown={onKey}
  />
  <span class="pos tabular" role="status" aria-live="polite" data-testid="chat-search-position">
    {#if busy}{t.search.searching}{:else if done}{hits.length > 0 ? t.search.position(index + 1, hits.length) : t.search.nothing}{/if}
  </span>
  <button class="icon-btn" type="button" aria-label={t.search.prev} disabled={hits.length < 2} onclick={() => step(1)} data-testid="chat-search-prev"><Icon name="up" /></button>
  <button class="icon-btn" type="button" aria-label={t.search.next} disabled={hits.length < 2} onclick={() => step(-1)} data-testid="chat-search-next"><Icon name="down" /></button>
  <button class="icon-btn" type="button" aria-label={t.search.close} onclick={onclose}><Icon name="close" /></button>
  <p id="chat-search-note-{chatId}" class="note small muted">{t.search.localNote}</p>
</div>

<style>
  .chat-search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  input {
    flex: 1 1 10rem;
    min-width: 0;
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--bg);
    font-size: var(--text-m);
  }

  .pos {
    min-width: 4.5rem;
    font-size: var(--text-s);
    color: var(--muted);
    text-align: center;
  }

  .note {
    flex: 1 0 100%;
    margin: 0;
  }
</style>
