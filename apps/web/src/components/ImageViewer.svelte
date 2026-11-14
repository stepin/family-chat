<script lang="ts" module>
  export interface ViewerImage {
    readonly blobId: string;
    readonly name: string;
    readonly mime: string;
    readonly status: string;
    readonly thumb: string | null;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { thumbDataUrl } from '../lib/attachment-state.ts';
  import { canShareFile, saveBlob, shareFile } from '../lib/storage.ts';
  import { t } from '../lib/strings.ts';

  // Image viewer (docs/PLAN.md screen 11, 8.6): zoom (buttons, double tap,
  // wheel, pinch), swipe or arrows between the chat's images, save and share,
  // closing by swiping down, Escape or the close button. Pictures are shown
  // only through <img> with blob: URLs.
  let {
    accountId,
    images,
    index = $bindable(0),
    onclose,
  }: { accountId: string; images: readonly ViewerImage[]; index?: number; onclose: () => void } = $props();

  const current = $derived(images[Math.min(Math.max(0, index), images.length - 1)]);
  let url = $state<string | null>(null);
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let dragY = $state(0);
  let closeBtn: HTMLButtonElement | undefined = $state();
  let root: HTMLDivElement | undefined = $state();
  let opener: HTMLElement | null = null;
  const uid = $props.id();
  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  onMount(() => {
    opener = document.activeElement as HTMLElement | null;
    closeBtn?.focus();
    return () => opener?.focus();
  });

  // Load the current picture (download it first if needed).
  $effect(() => {
    const img = current;
    if (!img) return;
    const status = img.status;
    let created: string | null = null;
    let cancelled = false;
    url = null;
    if (status === 'ready') {
      void app.core
        .attachmentUrl(accountId, img.blobId)
        .then((u) => {
          if (cancelled) URL.revokeObjectURL(u);
          else url = created = u;
        })
        .catch((e: unknown) => app.log('warn', 'viewer', 'image not readable', e));
    } else if (status === 'not-downloaded' || status === 'failed') {
      void app.core.downloadAttachment(accountId, img.blobId).catch((e: unknown) => app.log('warn', 'viewer', 'download failed', e));
    }
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  });

  function resetZoom(): void {
    scale = 1;
    tx = 0;
    ty = 0;
  }

  function go(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= images.length) return;
    index = next;
    resetZoom();
  }

  function zoom(factor: number): void {
    scale = Math.min(5, Math.max(1, scale * factor));
    if (scale === 1) resetZoom();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    } else if (e.key === 'ArrowLeft') {
      e.stopPropagation();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.stopPropagation();
      go(1);
    } else if (e.key === '+' || e.key === '=') zoom(1.5);
    else if (e.key === '-') zoom(1 / 1.5);
    else if (e.key === 'Tab' && root) {
      // Keep the focus inside the viewer.
      const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  // ---- touch and mouse gestures ----
  const pointers = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; tx: number; ty: number; dist: number; scale: number } | null = null;
  let lastTap = 0;

  function distance(): number {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  function onDown(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { x: e.clientX, y: e.clientY, tx, ty, dist: distance(), scale };
  }

  function onMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const d = distance();
      if (start.dist > 0) scale = Math.min(5, Math.max(1, (start.scale * d) / start.dist));
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (scale > 1) {
      tx = start.tx + dx;
      ty = start.ty + dy;
    } else if (dy > 0 && Math.abs(dy) > Math.abs(dx)) {
      dragY = dy;
    }
  }

  function onUp(e: PointerEvent): void {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.delete(e.pointerId);
    if (pointers.size > 0) {
      const rest = [...pointers.values()][0]!;
      start = { x: rest.x, y: rest.y, tx, ty, dist: 0, scale };
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const s = start;
    start = null;
    if (scale === 1) resetZoom();
    if (s.scale === 1 && scale === 1) {
      if (dy > 120 && Math.abs(dy) > Math.abs(dx)) {
        dragY = 0;
        onclose();
        return;
      }
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }
    dragY = 0;
    // Double tap or double click toggles the zoom.
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = e.timeStamp;
      if (now - lastTap < 300) {
        if (scale > 1) resetZoom();
        else scale = 2.5;
        lastTap = 0;
      } else lastTap = now;
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  async function blobFor(img: ViewerImage): Promise<Blob> {
    return app.core.attachmentBlob(accountId, img.blobId);
  }

  async function save(): Promise<void> {
    if (!current) return;
    try {
      saveBlob(await blobFor(current), current.name);
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'viewer', 'save failed', e);
    }
  }

  async function share(): Promise<void> {
    if (!current) return;
    try {
      const file = new File([await blobFor(current)], current.name, { type: current.mime });
      if (canShareFile(file)) await shareFile(file);
      else saveBlob(file, current.name);
    } catch (e) {
      app.log('warn', 'viewer', 'share failed', e);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="viewer"
  role="dialog"
  aria-modal="true"
  aria-labelledby="{uid}-title"
  tabindex="-1"
  onkeydown={onKey}
  data-testid="image-viewer"
>
  <header class="bar">
    <button bind:this={closeBtn} class="icon-btn" type="button" aria-label={t.viewer.close} onclick={onclose}><Icon name="close" /></button>
    <h2 id="{uid}-title" class="title">
      <span class="visually-hidden">{t.viewer.title}: </span>{current?.name ?? ''}
      {#if images.length > 1}<span class="pos tabular">{t.viewer.position(index + 1, images.length)}</span>{/if}
    </h2>
    <button class="icon-btn" type="button" aria-label={t.viewer.zoomOut} disabled={scale <= 1} onclick={() => zoom(1 / 1.5)}><Icon name="zoom-out" /></button>
    <button class="icon-btn" type="button" aria-label={t.viewer.zoomIn} disabled={scale >= 5} onclick={() => zoom(1.5)}><Icon name="zoom-in" /></button>
    <button class="icon-btn" type="button" aria-label={t.viewer.save} disabled={!url} onclick={save}><Icon name="download" /></button>
    {#if canShare}
      <button class="icon-btn" type="button" aria-label={t.viewer.share} disabled={!url} onclick={share}><Icon name="share" /></button>
    {/if}
  </header>

  <div
    class="stage"
    role="presentation"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    onwheel={onWheel}
  >
    {#if url}
      <img
        class="picture"
        src={url}
        alt={current?.name ?? ''}
        draggable="false"
        style:transform="translate({tx}px, {ty + dragY}px) scale({scale})"
        style:opacity={dragY > 0 ? Math.max(0.3, 1 - dragY / 400) : 1}
        data-testid="viewer-image"
      />
    {:else if current && thumbDataUrl(current.thumb)}
      <img class="picture blur" src={thumbDataUrl(current.thumb)} alt="" draggable="false" />
      <p class="loading" role="status">{current.status === 'gone' ? t.viewer.notAvailable : t.viewer.loading}</p>
    {:else}
      <p class="loading" role="status">{current?.status === 'gone' ? t.viewer.notAvailable : t.viewer.loading}</p>
    {/if}

    {#if index > 0}
      <button class="nav prev icon-btn" type="button" aria-label={t.viewer.prev} onclick={() => go(-1)}><Icon name="back" /></button>
    {/if}
    {#if index < images.length - 1}
      <button class="nav next icon-btn" type="button" aria-label={t.viewer.next} onclick={() => go(1)}><Icon name="forward" /></button>
    {/if}
  </div>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: #0d0f0e;
    color: #f1f1ee;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    padding-top: max(var(--sp-1), env(safe-area-inset-top));
  }

  .bar .icon-btn,
  .nav {
    color: #f1f1ee;
  }

  .bar .icon-btn:hover,
  .nav:hover {
    background: rgb(255 255 255 / 0.12);
  }

  .bar .icon-btn:disabled {
    opacity: 0.4;
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--text-s);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pos {
    margin-left: var(--sp-2);
    font-weight: 400;
    color: #c9ccc8;
  }

  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    touch-action: none;
    user-select: none;
  }

  .picture {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transform-origin: center;
  }

  .blur {
    filter: blur(8px);
    width: 60%;
  }

  .loading {
    position: absolute;
    bottom: var(--sp-6);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-m);
    background: rgb(0 0 0 / 0.6);
  }

  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgb(0 0 0 / 0.4);
  }

  .prev {
    left: var(--sp-2);
  }

  .next {
    right: var(--sp-2);
  }
</style>
