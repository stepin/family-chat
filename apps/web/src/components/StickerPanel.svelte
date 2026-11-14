<script lang="ts">
  import { onMount } from 'svelte';
  import type { PackSticker, StickerPackView } from '@family-chat/core';
  import StickerView from './StickerView.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { t } from '../lib/strings.ts';

  // The sticker tab of the picker (M5, docs/PLAN.md screen 14): the family's
  // packs as tabs, recently used stickers first, a tap sends. Thumbnails stay
  // still (first frame); the message itself animates.
  let { accountId, onpick, onmanage }: { accountId: string; onpick: (packId: string, file: string) => void; onmanage: () => void } = $props();

  const RECENT_MAX = 24;
  // svelte-ignore state_referenced_locally
  const recentKey = `stickers.recent.${accountId}`;
  let packs = $state.raw<StickerPackView[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let recent = $state<string[]>([]);
  let tab = $state<string>('');

  interface Item {
    readonly pack: string;
    readonly sticker: PackSticker;
  }

  const byKey = $derived(new Map(packs.flatMap((p) => p.stickers.map((s): [string, Item] => [`${p.packId}/${s.file}`, { pack: p.packId, sticker: s }]))));
  const recentItems = $derived(recent.map((k) => byKey.get(k)).filter((x): x is Item => !!x));
  const tabs = $derived([
    ...(recentItems.length > 0 ? [{ id: 'recent', label: t.stickers.recent }] : []),
    ...packs.map((p) => ({ id: p.packId, label: p.name })),
  ]);
  const current = $derived(tabs.some((x) => x.id === tab) ? tab : (tabs[0]?.id ?? ''));
  const items = $derived<Item[]>(
    current === 'recent' ? recentItems : (packs.find((p) => p.packId === current)?.stickers.map((s) => ({ pack: current, sticker: s })) ?? []),
  );
  const gridLabel = $derived(t.stickers.grid(tabs.find((x) => x.id === current)?.label ?? ''));

  onMount(() => {
    const unsub = app.core.stickerPacks(accountId).subscribe((list) => (packs = list));
    void app.core.getSetting<string[]>(recentKey).then((r) => {
      if (Array.isArray(r)) recent = r.filter((x) => typeof x === 'string').slice(0, RECENT_MAX);
    });
    app.core
      .refreshStickers(accountId)
      .catch((e: unknown) => {
        failed = true;
        app.log('info', 'stickers', 'sticker packs not refreshed', e);
      })
      .finally(() => (loaded = true));
    return unsub;
  });

  function pick(i: Item): void {
    const key = `${i.pack}/${i.sticker.file}`;
    const next = [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_MAX);
    recent = next;
    // A plain array: a state proxy cannot be stored in IndexedDB.
    void app.core.setSetting(recentKey, next).catch(() => undefined);
    onpick(i.pack, i.sticker.file);
  }
</script>

<div class="stickers" data-testid="sticker-panel">
  {#if packs.length === 0}
    {#if !loaded}
      <p class="muted center" role="status">{t.stickers.loading}</p>
    {:else}
      <div class="empty">
        <p>{failed ? t.errors.generic : t.stickers.empty}</p>
        <p class="muted small">{t.stickers.emptyHint}</p>
        <button class="btn small" type="button" onclick={onmanage}>{t.stickers.addPack}</button>
      </div>
    {/if}
  {:else}
    <div class="tabs" role="tablist" aria-label={t.stickers.packs}>
      {#each tabs as x (x.id)}
        <button class="tab" type="button" role="tab" aria-selected={current === x.id} onclick={() => (tab = x.id)} data-testid="sticker-tab">{x.label}</button>
      {/each}
    </div>
    <ul class="grid" aria-label={gridLabel}>
      {#each items as i (`${i.pack}/${i.sticker.file}`)}
        <li>
          <button class="cell" type="button" aria-label={t.stickers.send(i.sticker.emoji)} onclick={() => pick(i)} data-testid="sticker-cell">
            <StickerView {accountId} pack={i.pack} file={i.sticker.file} type={i.sticker.type} emoji={i.sticker.emoji} w={i.sticker.w} h={i.sticker.h} size={64} still />
          </button>
        </li>
      {/each}
    </ul>
    <button class="link-btn manage" type="button" onclick={onmanage}>{t.stickers.manage}</button>
  {/if}
</div>

<style>
  .stickers {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    flex: 1 1 auto;
    min-height: 0;
  }

  .center {
    padding: var(--sp-4);
    text-align: center;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-3);
  }

  .tabs {
    display: flex;
    gap: var(--sp-1);
    overflow-x: auto;
    flex: 0 0 auto;
  }

  .tab {
    flex: 0 0 auto;
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .tab[aria-selected='true'] {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
    box-shadow: inset 0 -3px 0 var(--accent);
  }

  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
    align-content: start;
    gap: var(--sp-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 76px;
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    cursor: pointer;
  }

  .cell:hover,
  .cell:focus-visible {
    background: var(--surface-2);
  }

  .manage {
    align-self: flex-end;
  }
</style>
