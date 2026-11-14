<script lang="ts">
  import { onMount } from 'svelte';
  import { MAX_ATTACHMENTS } from '@family-chat/core';
  import Icon from './Icon.svelte';
  import { DISPLAY_IMAGE_TYPES } from '../lib/attachment-state.ts';
  import { formatBytes } from '../lib/format.ts';
  import { safeMime, shouldReencode } from '../lib/media.ts';
  import { t } from '../lib/strings.ts';

  // Preview before sending (docs/PLAN.md screen 10, 8.6): the picked files,
  // a caption, and "Отправить оригинал" for photos. Files over the family's
  // limit are refused here, before anything is uploaded, with the limit named.
  let {
    files = $bindable(),
    caption = $bindable(''),
    maxBytes,
    limitText,
    busy = false,
    onsend,
    oncancel,
  }: {
    files: File[];
    caption?: string;
    /** The server's file limit (bytes); null while unknown. */
    maxBytes: number | null;
    /** The limit as people know it ("200 МБ"). */
    limitText: string;
    busy?: boolean;
    onsend: (original: boolean) => void;
    oncancel: () => void;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let original = $state(false);
  const uid = $props.id();

  interface Item {
    readonly file: File;
    readonly url: string | null;
    readonly image: boolean;
  }

  let items = $state.raw<Item[]>([]);
  $effect(() => {
    const next = files.map((file) => {
      const mime = safeMime(file.type);
      // Own picked pictures are previewed only in the shown types, as <img> with a blob: URL.
      const showable = DISPLAY_IMAGE_TYPES.includes(mime);
      return { file, image: mime.startsWith('image/'), url: showable ? URL.createObjectURL(file) : null };
    });
    items = next;
    return () => next.forEach((i) => i.url && URL.revokeObjectURL(i.url));
  });

  const hasPhotos = $derived(items.some((i) => i.image && shouldReencode(safeMime(i.file.type))));
  /** Files the server will refuse (photos that get downscaled are small enough). */
  const tooLarge = $derived(
    maxBytes === null
      ? []
      : items.filter((i) => (original || !i.image || !shouldReencode(safeMime(i.file.type))) && i.file.size > maxBytes),
  );
  const tooMany = $derived(items.length > MAX_ATTACHMENTS);
  const canSend = $derived(items.length > 0 && tooLarge.length === 0 && !tooMany && !busy);

  onMount(() => {
    dialog?.showModal();
  });

  function remove(i: number): void {
    files = files.filter((_, k) => k !== i);
    if (files.length === 0) oncancel();
  }

  function onCancelEvent(e: Event): void {
    e.preventDefault();
    if (!busy) oncancel();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (canSend) onsend(original);
  }
</script>

<dialog bind:this={dialog} class="preview" aria-labelledby="{uid}-title" oncancel={onCancelEvent}>
  <form class="stack" onsubmit={submit}>
    <h2 id="{uid}-title">{t.attach.previewTitle}</h2>
    <ul class="items">
      {#each items as item, i (item.url ?? `${item.file.name}/${i}`)}
        <li class="item" data-testid="preview-item">
          {#if item.url}
            <img src={item.url} alt={item.file.name} />
          {:else}
            <span class="file-icon" aria-hidden="true"><Icon name={item.image ? 'image' : 'file'} size={28} /></span>
          {/if}
          <span class="info">
            <span class="name">{item.file.name}</span>
            <span class="muted small tabular">{formatBytes(item.file.size)}</span>
          </span>
          <button class="icon-btn" type="button" aria-label={t.attach.remove(item.file.name)} disabled={busy} onclick={() => remove(i)}>
            <Icon name="close" />
          </button>
        </li>
      {/each}
    </ul>

    {#each tooLarge as item (item.file.name + item.file.size)}
      <p class="error-text" role="alert">{t.attach.tooLarge(item.file.name, limitText)}</p>
    {/each}
    {#if tooMany}<p class="error-text" role="alert">{t.attach.tooMany(MAX_ATTACHMENTS)}</p>{/if}

    <div class="field">
      <label for="{uid}-caption">{t.attach.caption}</label>
      <textarea id="{uid}-caption" class="input" rows="2" maxlength="4000" bind:value={caption} disabled={busy}></textarea>
    </div>

    {#if hasPhotos}
      <label class="switch">
        <input type="checkbox" role="switch" bind:checked={original} disabled={busy} aria-describedby="{uid}-orig-hint" />
        <span>
          <span class="label">{t.attach.original}</span>
          <span id="{uid}-orig-hint" class="muted small">{t.attach.originalHint}</span>
        </span>
      </label>
    {/if}

    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={oncancel}>{t.common.cancel}</button>
      <button class="btn" type="submit" disabled={!canSend}>{busy ? t.attach.preparing : t.attach.send}</button>
    </div>
  </form>
</dialog>

<style>
  .preview {
    width: min(30rem, calc(100vw - 2rem));
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    max-height: 40vh;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .item img,
  .file-icon {
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    border-radius: var(--r-m);
    object-fit: cover;
    background: var(--surface-2);
  }

  .file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
  }

  .info {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .switch {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    min-height: var(--touch);
    cursor: pointer;
  }

  .switch input {
    width: 22px;
    height: 22px;
    margin-top: 2px;
    accent-color: var(--accent);
  }

  .switch .label {
    display: block;
    font-weight: 600;
  }

  .end {
    justify-content: flex-end;
  }
</style>
