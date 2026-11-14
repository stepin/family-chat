<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { EMOJI_BY_CHAR, EMOJI_CATEGORIES, searchEmoji, type Emoji } from '../lib/emoji-data.ts';
  import { t } from '../lib/strings.ts';

  // The built-in emoji picker (its own chunk, loaded on first use): system
  // emoji only, a Russian search, categories as tabs, recently used ones kept
  // on this device. Keyboard: arrows move in the grid, Enter picks, Escape
  // closes, focus goes back to where it was.
  //
  // M5: from the composer it also has a "Стикеры" tab (the sticker panel is
  // its own chunk, loaded when the tab is opened).
  let {
    onpick,
    onclose,
    title = t.emoji.title,
    stickers = null,
    onsticker,
  }: {
    onpick: (emoji: string) => void;
    onclose: () => void;
    title?: string;
    /** Account whose sticker packs are offered (null: emoji only, as for reactions). */
    stickers?: string | null;
    onsticker?: (packId: string, file: string) => void;
  } = $props();

  const MODE_KEY = 'picker.mode';
  const loadStickers = () => import('./StickerPanel.svelte');
  let mode = $state<'emoji' | 'stickers'>('emoji');

  const RECENT_KEY = 'emoji.recent';
  const RECENT_MAX = 24;
  let dialog: HTMLDialogElement | undefined = $state();
  let grid: HTMLElement | undefined = $state();
  let searchEl: HTMLInputElement | undefined = $state();
  let query = $state('');
  let recent = $state<string[]>([]);
  let tab = $state(EMOJI_CATEGORIES[0]!.id);
  let active = $state(0);
  let returnTo: HTMLElement | null = null;

  const recentItems = $derived(recent.map((c) => EMOJI_BY_CHAR.get(c) ?? { char: c, name: c, words: [] }));
  const tabs = $derived([
    ...(recent.length > 0 ? [{ id: 'recent', label: t.emoji.recent, icon: '🕘' }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
  ]);
  const items = $derived<readonly Emoji[]>(
    query.trim() ? searchEmoji(query) : tab === 'recent' ? recentItems : (EMOJI_CATEGORIES.find((c) => c.id === tab)?.items ?? []),
  );
  const gridLabel = $derived(query.trim() ? t.emoji.search : (tabs.find((x) => x.id === tab)?.label ?? ''));

  function setMode(m: 'emoji' | 'stickers'): void {
    mode = m;
    void app.core.setSetting(MODE_KEY, m).catch(() => undefined);
    if (m === 'emoji') void tick().then(() => searchEl?.focus());
  }

  function onModeKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = mode === 'emoji' ? 'stickers' : 'emoji';
    setMode(next);
    void tick().then(() => document.getElementById(`picker-mode-${next}`)?.focus());
  }

  onMount(() => {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    if (stickers) {
      void app.core.getSetting<string>(MODE_KEY).then((m) => {
        if (m === 'stickers') mode = 'stickers';
      });
    }
    void app.core.getSetting<string[]>(RECENT_KEY).then((r) => {
      if (Array.isArray(r)) {
        recent = r.filter((x) => typeof x === 'string').slice(0, RECENT_MAX);
        if (recent.length > 0) tab = 'recent';
      }
    });
    searchEl?.focus();
    return () => returnTo?.focus();
  });

  function close(): void {
    dialog?.close();
  }

  async function pick(e: Emoji): Promise<void> {
    const next = [e.char, ...recent.filter((c) => c !== e.char)].slice(0, RECENT_MAX);
    recent = next;
    void app.core.setSetting(RECENT_KEY, next).catch(() => undefined);
    onpick(e.char);
    close();
  }

  function columns(): number {
    const first = grid?.querySelector<HTMLElement>('[role="option"]');
    if (!grid || !first || first.offsetWidth === 0) return 8;
    return Math.max(1, Math.round(grid.clientWidth / first.offsetWidth));
  }

  async function focusActive(): Promise<void> {
    await tick();
    grid?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.focus();
  }

  function onGridKey(e: KeyboardEvent): void {
    const n = items.length;
    if (n === 0) return;
    const cols = columns();
    let next = active;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, active + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, active - 1);
    else if (e.key === 'ArrowDown') next = Math.min(n - 1, active + cols);
    else if (e.key === 'ArrowUp') {
      if (active < cols) {
        e.preventDefault();
        searchEl?.focus();
        return;
      }
      next = active - cols;
    } else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = items[active];
      if (item) void pick(item);
      return;
    } else return;
    e.preventDefault();
    active = next;
    void focusActive();
  }

  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      active = 0;
      void focusActive();
    } else if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault();
      void pick(items[0]!);
    }
  }

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.findIndex((x) => x.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    selectTab(next.id);
    void tick().then(() => document.getElementById(`emoji-tab-${next.id}`)?.focus());
  }

  function selectTab(id: string): void {
    tab = id;
    query = '';
    active = 0;
    if (grid) grid.scrollTop = 0;
  }

  $effect(() => {
    void query;
    active = 0;
  });
</script>

<dialog bind:this={dialog} class="picker" aria-labelledby="emoji-title" onclose={onclose} data-testid="emoji-picker">
  <div class="head">
    <h2 id="emoji-title">{title}</h2>
    <button class="icon-btn" type="button" aria-label={t.emoji.close} onclick={close}><Icon name="close" /></button>
  </div>
  {#if stickers}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="modes" role="tablist" aria-label={t.emoji.modes} tabindex="-1" onkeydown={onModeKey}>
      {#each [{ id: 'emoji', label: t.emoji.emojiTab }, { id: 'stickers', label: t.emoji.stickersTab }] as m (m.id)}
        <button
          id="picker-mode-{m.id}"
          class="mode"
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          aria-controls="picker-panel-{m.id}"
          tabindex={mode === m.id ? 0 : -1}
          data-testid="picker-mode-{m.id}"
          onclick={() => setMode(m.id as 'emoji' | 'stickers')}>{m.label}</button
        >
      {/each}
    </div>
  {/if}
  {#if stickers && mode === 'stickers'}
    <div id="picker-panel-stickers" class="panel" role="tabpanel" aria-labelledby="picker-mode-stickers">
      {#await loadStickers()}
        <p class="muted none" role="status">{t.stickers.loading}</p>
      {:then { default: StickerPanel }}
        <StickerPanel
          accountId={stickers}
          onpick={(packId, file) => {
            onsticker?.(packId, file);
            close();
          }}
          onmanage={() => {
            close();
            nav.push({ name: 'sticker-packs' });
          }}
        />
      {/await}
    </div>
  {:else}
  <div id="picker-panel-emoji" class="panel" role={stickers ? 'tabpanel' : undefined} aria-labelledby={stickers ? 'picker-mode-emoji' : undefined}>
  <label class="visually-hidden" for="emoji-search">{t.emoji.search}</label>
  <input
    id="emoji-search"
    bind:this={searchEl}
    bind:value={query}
    class="search"
    type="search"
    autocomplete="off"
    placeholder={t.emoji.searchHint}
    onkeydown={onSearchKey}
  />
  {#if !query.trim()}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="tabs" role="tablist" aria-label={t.emoji.categories} tabindex="-1" onkeydown={onTabKey}>
      {#each tabs as c (c.id)}
        <button
          id="emoji-tab-{c.id}"
          class="tab"
          type="button"
          role="tab"
          aria-selected={tab === c.id}
          aria-controls="emoji-grid"
          aria-label={c.label}
          title={c.label}
          tabindex={tab === c.id ? 0 : -1}
          onclick={() => selectTab(c.id)}><span aria-hidden="true">{c.icon}</span></button
        >
      {/each}
    </div>
  {/if}
  {#if items.length === 0}
    <p class="muted none" role="status">{query.trim() ? t.emoji.none : ''}</p>
  {:else}
    <div
      id="emoji-grid"
      bind:this={grid}
      class="grid"
      role="listbox"
      aria-label={t.emoji.grid(gridLabel)}
      tabindex="-1"
      onkeydown={onGridKey}
    >
      {#each items as e, i (e.char)}
        <button
          class="emoji"
          type="button"
          role="option"
          aria-selected={i === active}
          aria-label={`${e.char} ${e.name}`}
          title={e.name}
          tabindex={i === active ? 0 : -1}
          onfocus={() => (active = i)}
          onclick={() => pick(e)}>{e.char}</button
        >
      {/each}
    </div>
  {/if}
  </div>
  {/if}
</dialog>

<style>
  .picker {
    width: min(26rem, calc(100vw - 1rem));
    max-width: none;
    height: min(28rem, calc(100dvh - 2rem));
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .picker:not([open]) {
    display: none;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .head h2 {
    font-size: var(--text-m);
    padding-left: var(--sp-1);
  }

  .modes {
    display: flex;
    gap: var(--sp-1);
    flex: 0 0 auto;
  }

  .mode {
    flex: 1 1 0;
    min-height: var(--touch);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .mode[aria-selected='true'] {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
    box-shadow: inset 0 -3px 0 var(--accent);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    flex: 1 1 auto;
    min-height: 0;
  }

  .search {
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--bg);
    font-size: var(--text-m);
  }

  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    flex: 0 0 auto;
  }

  .tab {
    flex: 0 0 auto;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    font-size: 1.35rem;
    cursor: pointer;
  }

  .tab[aria-selected='true'] {
    background: var(--accent-soft);
    box-shadow: inset 0 -3px 0 var(--accent);
  }

  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--touch), 1fr));
    align-content: start;
  }

  .emoji {
    height: var(--touch);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
  }

  .emoji:hover,
  .emoji[aria-selected='true'] {
    background: var(--surface-2);
  }

  .none {
    padding: var(--sp-4);
    text-align: center;
  }
</style>
