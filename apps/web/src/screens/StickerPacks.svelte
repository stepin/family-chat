<script lang="ts">
  import { onMount } from 'svelte';
  import { isStickerError, MAX_PACK_NAME_CHARS, type StickerImport, type StickerPackView } from '@family-chat/core';
  import LocalSticker from '../components/LocalSticker.svelte';
  import Page from '../components/Page.svelte';
  import StickerView from '../components/StickerView.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // The sticker pack manager: the family's
  // packs, importing a new one (a .zip of .webp and .tgs, or the files
  // themselves), a still preview, publishing for the family, deleting one's
  // own pack for everyone. Everything is checked on this device first.
  const account = $derived(app.account!);
  // svelte-ignore state_referenced_locally
  const accountId = app.account!.id;
  let packs = $state.raw<StickerPackView[]>([]);
  let loaded = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let reading = $state(false);
  let draft = $state.raw<StickerImport | null>(null);
  let name = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;
  let toDelete = $state.raw<StickerPackView | null>(null);
  const names = $derived(displayNames(app.members, t.common.unknownName));

  onMount(() => {
    const unsub = app.core.stickerPacks(accountId).subscribe((list) => (packs = list));
    app.core
      .refreshStickers(accountId)
      .catch((e: unknown) => app.log('info', 'stickers', 'sticker packs not refreshed', e))
      .finally(() => (loaded = true));
    return unsub;
  });

  function choose(): void {
    error = null;
    input?.click();
  }

  async function onPicked(e: Event): Promise<void> {
    const el = e.currentTarget as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    if (files.length === 0) return;
    reading = true;
    error = null;
    try {
      draft = await app.core.importStickers(files.map((f) => ({ name: f.name, data: f })));
      if (!name.trim()) {
        const first = files[0]!.name.replace(/\.(zip|webp|tgs)$/i, '').slice(0, MAX_PACK_NAME_CHARS);
        name = files.length === 1 && /\.zip$/i.test(files[0]!.name) ? first : '';
      }
    } catch (err) {
      draft = null;
      error = isStickerError(err) ? t.stickers.failed(t.stickers.reason(err.code)) : errorText(err);
      app.log('warn', 'stickers', 'sticker import refused', err);
    } finally {
      reading = false;
    }
  }

  async function publish(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!draft || busy || !name.trim()) return;
    busy = true;
    error = null;
    try {
      await app.core.publishStickerPack(accountId, name.trim(), draft);
      draft = null;
      name = '';
      app.notify(t.stickers.published);
    } catch (err) {
      error = isStickerError(err) ? t.stickers.failed(t.stickers.reason(err.code)) : t.stickers.publishFailed;
      app.log('warn', 'stickers', 'publishing a pack failed', err);
    } finally {
      busy = false;
    }
  }

  function askDelete(e: MouseEvent, p: StickerPackView): void {
    opener = e.currentTarget as HTMLElement;
    toDelete = p;
    error = null;
    dialog?.showModal();
  }

  async function confirmDelete(): Promise<void> {
    const p = toDelete;
    if (!p || busy) return;
    busy = true;
    try {
      await app.core.deleteStickerPack(accountId, p.packId);
      dialog?.close();
      app.notify(t.stickers.deleted);
    } catch (err) {
      error = t.stickers.deleteFailed;
      app.log('warn', 'stickers', 'deleting a pack failed', err);
    } finally {
      busy = false;
    }
  }
</script>

<Page title={t.stickers.title} onback={() => nav.back()}>
  <section class="section" aria-labelledby="packs-new">
    <h2 id="packs-new">{t.stickers.importTitle}</h2>
    <p class="muted small">{t.stickers.importLead}</p>
    {#if !draft}
      <button class="btn" type="button" disabled={reading || account.status !== 'active'} onclick={choose} data-testid="sticker-import">
        {reading ? t.stickers.reading : t.stickers.choose}
      </button>
    {:else}
      <form class="stack" onsubmit={publish} novalidate>
        <p class="small" role="status">
          {t.stickers.preview(draft.stickers.length)}{#if draft.skipped.length > 0}. {t.stickers.skipped(draft.skipped.length)}{/if}
        </p>
        {#if draft.skipped.length > 0}
          <ul class="skipped small muted" data-testid="sticker-skipped">
            {#each draft.skipped.slice(0, 10) as s, i (i)}<li>{s.name}: {t.stickers.reason(s.reason)}</li>{/each}
          </ul>
        {/if}
        <ul class="grid" aria-label={t.stickers.preview(draft.stickers.length)} data-testid="sticker-preview">
          {#each draft.stickers as s (s.file)}
            <li><LocalSticker sticker={s} /></li>
          {/each}
        </ul>
        <div class="field">
          <label for="pack-name">{t.stickers.nameLabel}</label>
          <input id="pack-name" class="input" type="text" maxlength={MAX_PACK_NAME_CHARS} autocomplete="off" aria-describedby="pack-name-hint" bind:value={name} />
          <span id="pack-name-hint" class="hint">{t.stickers.nameHint}</span>
        </div>
        <p class="notice small">{t.stickers.publishHint}</p>
        <div class="row">
          <button class="btn" type="submit" disabled={busy || !name.trim()} data-testid="sticker-publish">{busy ? t.stickers.publishing : t.stickers.publish}</button>
          <button class="btn secondary" type="button" disabled={busy} onclick={() => (draft = null)}>{t.stickers.discard}</button>
        </div>
      </form>
    {/if}
    {#if error && !toDelete}<p class="error-text" role="alert">{error}</p>{/if}
    <input
      bind:this={input}
      class="visually-hidden"
      type="file"
      accept=".zip,.webp,.tgs,application/zip,image/webp"
      multiple
      tabindex="-1"
      aria-hidden="true"
      data-testid="sticker-input"
      onchange={onPicked}
    />
  </section>

  <section class="section" aria-labelledby="packs-list">
    <h2 id="packs-list">{t.stickers.packs}</h2>
    {#if packs.length === 0}
      <p class="muted">{loaded ? t.stickers.empty : t.stickers.loading}</p>
    {:else}
      <ul class="packs">
        {#each packs as p (p.packId)}
          <li class="pack" data-testid="sticker-pack">
            <div class="pack-head">
              <span class="lines">
                <span class="pname">{p.name}</span>
                <span class="sub">{t.stickers.count(p.stickers.length)} · {p.mine ? t.stickers.mine : t.stickers.by(names.get(p.author) ?? t.common.unknownName, app.genderOf(p.author))}</span>
              </span>
              {#if p.mine}
                <button class="btn secondary small" type="button" onclick={(e) => askDelete(e, p)} data-testid="sticker-pack-delete">{t.stickers.delete}</button>
              {/if}
            </div>
            <ul class="strip" aria-label={t.stickers.grid(p.name)}>
              {#each p.stickers.slice(0, 6) as s (s.file)}
                <li><StickerView {accountId} pack={p.packId} file={s.file} type={s.type} emoji={s.emoji} w={s.w} h={s.h} size={56} still /></li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</Page>

<dialog bind:this={dialog} aria-labelledby="pack-delete-title" onclose={() => {
  toDelete = null;
  opener?.focus();
}}>
  <div class="stack">
    <h2 id="pack-delete-title">{t.stickers.deleteTitle}</h2>
    <p>{t.stickers.deleteText}</p>
    {#if error && toDelete}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={() => dialog?.close()}>{t.common.cancel}</button>
      <button class="btn danger" type="button" disabled={busy} onclick={confirmDelete} data-testid="sticker-pack-delete-confirm">{t.stickers.delete}</button>
    </div>
  </div>
</dialog>

<style>
  .section > .btn {
    align-self: flex-start;
  }

  .grid,
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .grid {
    max-height: 40dvh;
    overflow-y: auto;
  }

  .skipped {
    margin: 0;
    padding-left: var(--sp-5);
    overflow-wrap: anywhere;
  }

  .packs {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .pack-head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .lines {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .pname {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .sub {
    font-size: var(--text-s);
    color: var(--muted);
  }

  .end {
    justify-content: flex-end;
  }
</style>
