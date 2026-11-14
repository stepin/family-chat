<script lang="ts">
  import { onMount } from 'svelte';
  import { snippet, type ChatSummary, type GlobalSearchResult, type SearchHit } from '@family-chat/core';
  import Avatar from '../components/Avatar.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatListTime } from '../lib/format.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Global search (docs/PLAN.md 7.2, 8.4): messages stored on this device,
  // grouped by chat with a snippet and a date, plus chats and relatives by
  // name. Nothing is sent to the server; the screen says so.
  const account = $derived(app.account!);
  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const PER_CHAT = 5;

  let text = $state('');
  let result = $state.raw<GlobalSearchResult | null>(null);
  let busy = $state(false);
  let field: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let now = $state(Date.now());

  const groups = $derived.by(() => {
    const out = new Map<string, SearchHit[]>();
    for (const h of result?.messages ?? []) {
      const list = out.get(h.chatId) ?? [];
      list.push(h);
      out.set(h.chatId, list);
    }
    return [...out.entries()];
  });
  const empty = $derived(!!result && result.chats.length === 0 && result.contacts.length === 0 && result.messages.length === 0);

  onMount(() => {
    field?.focus();
    return () => clearTimeout(timer);
  });

  function chatOf(chatId: string): ChatSummary | undefined {
    return app.chatList.find((c) => c.accountId === account.id && c.chatId === chatId);
  }

  function chatTitle(c: ChatSummary | undefined): string {
    if (!c) return t.common.unknownName;
    if (c.kind === 'self') return t.list.selfChat;
    if (c.kind === 'dm' && c.peerId) return names.get(c.peerId) ?? c.title ?? t.common.unknownName;
    return c.title ?? t.group.title(null);
  }

  function onInput(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  }

  async function run(): Promise<void> {
    const q = text.trim();
    const mine = ++seq;
    if (!q) {
      result = null;
      busy = false;
      return;
    }
    busy = true;
    try {
      const r = await app.core.search(q, { accountId: account.id, limit: 200 });
      if (mine === seq) {
        result = r;
        now = Date.now();
      }
    } catch (e) {
      app.log('warn', 'search', 'search failed', e);
    } finally {
      if (mine === seq) busy = false;
    }
  }

  function openHit(h: SearchHit): void {
    nav.openChat(h.accountId, h.chatId, false, { senderId: h.senderId, msgId: h.msgId, gseq: h.gseq });
  }

  async function openContact(userId: string): Promise<void> {
    try {
      const chatId = await app.core.openChat(account.id, userId);
      nav.openChat(account.id, chatId, true);
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'search', 'opening a chat failed', e);
    }
  }

  function hitText(h: SearchHit) {
    const body = h.body.trim() ? h.body : h.fileNames.join(', ');
    return snippet(body, result?.words ?? []);
  }

  function parts(s: { text: string; marks: readonly (readonly [number, number])[] }): { text: string; mark: boolean }[] {
    const out: { text: string; mark: boolean }[] = [];
    let at = 0;
    for (const [a, b] of s.marks) {
      if (a > at) out.push({ text: s.text.slice(at, a), mark: false });
      out.push({ text: s.text.slice(a, b), mark: true });
      at = b;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), mark: false });
    return out;
  }
</script>

<Page title={t.search.title} onback={() => nav.back()}>
  <div class="stack" role="search">
    <label class="visually-hidden" for="global-search">{t.search.field}</label>
    <input
      id="global-search"
      bind:this={field}
      bind:value={text}
      class="field"
      type="search"
      autocomplete="off"
      placeholder={t.search.field}
      aria-describedby="global-search-note"
      oninput={onInput}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          clearTimeout(timer);
          void run();
        }
      }}
    />
    <p id="global-search-note" class="muted small">{t.search.hint}</p>
    <p class="visually-hidden" role="status" aria-live="polite">
      {#if busy}{t.search.searching}{:else if empty}{t.search.nothing}{:else if result}{t.search.messages(result.total)}{/if}
    </p>

    {#if busy && !result}
      <p class="muted" aria-hidden="true">{t.search.searching}</p>
    {:else if empty}
      <p class="muted" data-testid="search-nothing">{t.search.nothing}</p>
    {:else if result}
      {#if result.chats.length > 0}
        <section aria-labelledby="sr-chats">
          <h2 id="sr-chats">{t.search.chats}</h2>
          <ul class="list">
            {#each result.chats as c (c.chatId)}
              <li>
                <button class="row" type="button" onclick={() => nav.openChat(c.accountId, c.chatId)}>
                  <Avatar accountId={c.accountId} userId={c.peerId} name={chatTitle(c)} kind={c.kind === 'dm' ? 'person' : c.kind} size={36} />
                  <span class="name">{chatTitle(c)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if result.contacts.length > 0}
        <section aria-labelledby="sr-contacts">
          <h2 id="sr-contacts">{t.search.contacts}</h2>
          <ul class="list">
            {#each result.contacts as p (p.userId)}
              <li>
                <button class="row" type="button" onclick={() => openContact(p.userId)}>
                  <Avatar accountId={p.accountId} userId={p.userId} name={p.name} size={36} />
                  <span class="name">{names.get(p.userId) ?? p.name}</span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if groups.length > 0}
        <section aria-labelledby="sr-messages" data-testid="search-messages">
          <h2 id="sr-messages">{t.search.messages(result.total)}</h2>
          {#each groups as [chatId, hits] (chatId)}
            {@const c = chatOf(chatId)}
            <div class="group">
              <h3>{chatTitle(c)}</h3>
              <ul class="list">
                {#each hits.slice(0, PER_CHAT) as h (h.senderId + h.msgId)}
                  <li>
                    <button class="hit" type="button" onclick={() => openHit(h)} data-testid="search-hit">
                      <span class="hit-line">
                        <span class="who">{h.senderId === account.userId ? t.msg.youName : (names.get(h.senderId) ?? t.common.unknownName)}</span>
                        <time class="muted small tabular" datetime={new Date(h.time).toISOString()}>{formatListTime(h.time, now)}</time>
                      </span>
                      <!-- prettier-ignore -->
                      <span class="snippet">{#each parts(hitText(h)) as p, i (i)}{#if p.mark}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span>
                    </button>
                  </li>
                {/each}
              </ul>
              {#if hits.length > PER_CHAT}<p class="muted small more">{t.search.more(hits.length - PER_CHAT)}</p>{/if}
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  </div>
</Page>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .field {
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--surface);
    font-size: var(--text-m);
  }

  h2 {
    font-size: var(--text-s);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: var(--sp-2) 0 var(--sp-1);
  }

  h3 {
    font-size: var(--text-m);
    margin: var(--sp-3) 0 var(--sp-1);
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--r-m);
    background: var(--surface);
  }

  .row,
  .hit {
    display: flex;
    width: 100%;
    gap: var(--sp-3);
    align-items: center;
    min-height: var(--touch);
    padding: var(--sp-2) var(--sp-3);
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .hit {
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
  }

  .row:hover,
  .hit:hover {
    background: var(--surface-2);
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  .hit-line {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  .who {
    font-weight: 600;
    font-size: var(--text-s);
  }

  .snippet {
    overflow-wrap: anywhere;
  }

  mark {
    background: var(--warn-soft);
    color: inherit;
    font-weight: 700;
    border-radius: 2px;
  }

  .more {
    padding: var(--sp-1) var(--sp-3);
  }
</style>
