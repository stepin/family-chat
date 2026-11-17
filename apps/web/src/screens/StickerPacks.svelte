<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isStickerError,
    isTelegramImportError,
    MAX_PACK_NAME_CHARS,
    parseTelegramSetLink,
    type StickerImport,
    type StickerPackView,
    type TelegramProgress,
  } from '@family-chat/core';
  import LocalSticker from '../components/LocalSticker.svelte';
  import Page from '../components/Page.svelte';
  import StickerView from '../components/StickerView.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // The sticker pack manager: the family's
  // packs, importing a new one (a Telegram set by its link, through the family
  // server; a .zip of .webp and .tgs, or the files themselves), a still
  // preview, publishing for the family, deleting one's own pack for everyone.
  // Everything is checked on this device first.
  const ADMIN_TELEGRAM_DOC = 'https://github.com/stepin/family-chat/blob/main/docs/ADMIN.md#telegram';
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

  // Import by a Telegram link.
  let link = $state('');
  const parsedLink = $derived(parseTelegramSetLink(link));
  /** Off when the server has no bot token (an older server says nothing: off too). */
  const telegramOn = $derived(app.hello?.telegramStickers === true);
  let tgCtl: AbortController | null = null;
  let tgProgress = $state.raw<TelegramProgress | null>(null);
  let tgStatus = $state<string | null>(null);
  let tgError = $state<string | null>(null);
  /** The live announcement: at most every 2 s, so a screen reader is not flooded. */
  let announced = $state('');
  let lastAnnounce = 0;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const importing = $derived(tgProgress !== null);
  let replaceDialog: HTMLDialogElement | undefined = $state();
  let afterReplace: (() => void) | null = null;

  function announce(text: string, now = false): void {
    clearTimeout(announceTimer);
    const wait = now ? 0 : Math.max(0, lastAnnounce + 2000 - Date.now());
    announceTimer = setTimeout(() => {
      announced = text;
      lastAnnounce = Date.now();
    }, wait);
  }

  function progressText(p: TelegramProgress): string {
    if (p.phase === 'opening') return t.stickers.tgOpening;
    if (p.phase === 'waiting') return t.stickers.tgWaiting(p.seconds);
    return t.stickers.tgLoaded(p.done, p.total);
  }

  /** Runs `go` now, or after "Replace the current draft?" when a draft is shown. */
  function withReplace(go: () => void): void {
    if (!draft) return go();
    afterReplace = go;
    replaceDialog?.showModal();
  }

  function onLinkSubmit(e: SubmitEvent): void {
    e.preventDefault();
    if (!parsedLink || importing || reading || !telegramOn) return;
    withReplace(() => void loadTelegram());
  }

  async function loadTelegram(retry?: StickerImport): Promise<void> {
    tgCtl?.abort();
    const ctl = new AbortController();
    tgCtl = ctl;
    tgError = null;
    tgStatus = null;
    error = null;
    if (!retry) draft = null;
    tgProgress = { phase: 'opening' };
    announce(t.stickers.tgOpening, true);
    try {
      const result = await app.core.importTelegramStickers(accountId, link, {
        signal: ctl.signal,
        ...(retry ? { retry } : {}),
        onProgress: (p) => {
          if (tgCtl !== ctl) return;
          tgProgress = p;
          announce(progressText(p), p.phase === 'waiting');
        },
      });
      if (tgCtl !== ctl) return;
      draft = result;
      if (!name.trim() && result.telegram) name = result.telegram.title.trim().slice(0, MAX_PACK_NAME_CHARS);
      announce(summary(result), true);
    } catch (err) {
      if (tgCtl !== ctl) return;
      if (err instanceof DOMException && err.name === 'AbortError') {
        tgStatus = t.stickers.tgCancelled;
        announce(t.stickers.tgCancelled, true);
      } else if (isTelegramImportError(err)) {
        tgError = t.stickers.tgError(err.code, err.reason, err.retryAfter, account.admin);
        app.log('warn', 'stickers', `telegram import failed: ${err.code}${err.reason ? ` (${err.reason})` : ''}`);
      } else if (isStickerError(err)) {
        tgError = t.stickers.failed(t.stickers.reason(err.code));
      } else {
        tgError = errorText(err);
        app.log('warn', 'stickers', 'telegram import failed', err);
      }
    } finally {
      if (tgCtl === ctl) {
        tgCtl = null;
        tgProgress = null;
      }
    }
  }

  function cancelTelegram(): void {
    tgCtl?.abort();
  }

  function summary(d: StickerImport): string {
    const tg = d.telegram;
    return tg ? t.stickers.tgSummary(d.stickers.length, tg.video, tg.failed.length) : t.stickers.preview(d.stickers.length);
  }

  onMount(() => () => {
    tgCtl?.abort();
    clearTimeout(announceTimer);
  });

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
    withReplace(() => input?.click());
  }

  async function onPicked(e: Event): Promise<void> {
    const el = e.currentTarget as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    if (files.length === 0) return;
    reading = true;
    error = null;
    tgError = null;
    tgStatus = null;
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
    <div class="source" role="group" aria-labelledby="src-telegram">
      <h3 id="src-telegram">{t.stickers.sourceTelegram}</h3>
      {#if !telegramOn}
        <p class="muted small" id="tg-off" data-testid="telegram-off">
          {t.stickers.tgOff}
          {#if account.admin}<a href={ADMIN_TELEGRAM_DOC} target="_blank" rel="noopener noreferrer">{t.stickers.tgHowTo}</a>{/if}
        </p>
      {/if}
      <form class="link-form" onsubmit={onLinkSubmit} novalidate>
        <label for="tg-link">{t.stickers.linkLabel}</label>
        <div class="link-row">
          <input
            id="tg-link"
            class="input"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://t.me/addstickers/…"
            disabled={!telegramOn || importing || account.status !== 'active'}
            aria-describedby={`tg-link-hint${!telegramOn ? ' tg-off' : ''}${tgError ? ' tg-error' : ''}`}
            aria-invalid={tgError ? 'true' : undefined}
            bind:value={link}
            data-testid="telegram-link"
          />
          <button class="btn" type="submit" disabled={!telegramOn || !parsedLink || importing || reading || account.status !== 'active'} data-testid="telegram-load">
            {t.stickers.load}
          </button>
        </div>
        <span id="tg-link-hint" class="hint">{t.stickers.linkHint}</span>
      </form>
      {#if tgProgress}
        <div class="progress-row">
          <p class="small" data-testid="telegram-status">{progressText(tgProgress)}</p>
          {#if tgProgress.phase !== 'opening'}
            <div
              class="progress"
              role="progressbar"
              aria-label={t.stickers.tgProgress}
              aria-valuemin="0"
              aria-valuemax={tgProgress.total || 1}
              aria-valuenow={tgProgress.done}
            >
              <span style:width={`${tgProgress.total ? Math.round((tgProgress.done / tgProgress.total) * 100) : 0}%`}></span>
            </div>
          {/if}
          <button class="btn secondary small" type="button" onclick={cancelTelegram} data-testid="telegram-cancel">{t.stickers.cancelLoad}</button>
        </div>
      {:else if tgStatus}
        <p class="small" data-testid="telegram-status">{tgStatus}</p>
      {/if}
      {#if tgError}<p class="error-text" id="tg-error" role="alert" data-testid="telegram-error">{tgError}</p>{/if}
      <p class="visually-hidden" aria-live="polite">{announced}</p>
    </div>

    <div class="source" role="group" aria-labelledby="src-files">
      <h3 id="src-files">{t.stickers.sourceFiles}</h3>
      <p class="muted small">{t.stickers.importLead}</p>
      <button class="btn secondary" type="button" disabled={reading || importing || account.status !== 'active'} onclick={choose} data-testid="sticker-import">
        {reading ? t.stickers.reading : t.stickers.choose}
      </button>
    </div>
    {#if draft}
      <form class="stack" onsubmit={publish} novalidate>
        {#if draft.telegram}
          <p class="small" role="status" data-testid="telegram-summary">{summary(draft)}</p>
          {#if draft.telegram.failed.length > 0}
            <button class="btn secondary small retry" type="button" disabled={importing} onclick={() => draft && void loadTelegram(draft)} data-testid="telegram-retry">
              {t.stickers.tgRetry}
            </button>
          {/if}
        {:else}
          <p class="small" role="status">
            {t.stickers.preview(draft.stickers.length)}{#if draft.skipped.length > 0}. {t.stickers.skipped(draft.skipped.length)}{/if}
          </p>
        {/if}
        {#if draft.skipped.length > 0 && !draft.telegram}
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
          <button class="btn" type="submit" disabled={busy || importing || !name.trim()} data-testid="sticker-publish">
            {busy ? t.stickers.publishing : draft.telegram ? t.stickers.publishN(draft.stickers.length) : t.stickers.publish}
          </button>
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

<dialog bind:this={replaceDialog} aria-labelledby="pack-replace-title" onclose={() => (afterReplace = null)}>
  <div class="stack">
    <h2 id="pack-replace-title">{t.stickers.replaceTitle}</h2>
    <p>{t.stickers.replaceText}</p>
    <div class="row end">
      <button class="btn secondary" type="button" onclick={() => replaceDialog?.close()}>{t.common.cancel}</button>
      <button
        class="btn"
        type="button"
        data-testid="sticker-replace-confirm"
        onclick={() => {
          const go = afterReplace;
          draft = null;
          replaceDialog?.close();
          go?.();
        }}>{t.stickers.replace}</button
      >
    </div>
  </div>
</dialog>

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
  .source > .btn {
    align-self: flex-start;
  }

  .source {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .source h3 {
    margin: 0;
    font-size: 1rem;
  }

  .link-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .link-row {
    display: flex;
    gap: var(--sp-2);
  }

  .link-row .input {
    flex: 1;
    min-width: 0;
  }

  /* Narrow screens: the field above the button. */
  @media (max-width: 479px) {
    .link-row {
      flex-direction: column;
    }

    .link-row .btn {
      align-self: flex-start;
    }
  }

  .progress-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }

  .progress-row p {
    margin: 0;
  }

  .progress {
    flex: 1;
    min-width: 8rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .retry {
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
