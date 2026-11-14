<script lang="ts">
  import { onMount } from 'svelte';
  import { naturalSize, prepareAvatar, type Size } from '../lib/media.ts';
  import { t } from '../lib/strings.ts';

  // Square crop of a picked photo for the profile (256 px, WebP or JPEG,
  // at most 256 KB): drag to move, the slider zooms.
  let { file, onsave, oncancel }: { file: File; onsave: (avatar: Blob) => Promise<void>; oncancel: () => void } = $props();

  const FRAME = 240;
  let dialog: HTMLDialogElement | undefined = $state();
  let url = $state<string | null>(null);
  let size = $state<Size | null>(null);
  let zoom = $state(1);
  let ox = $state(0);
  let oy = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const uid = $props.id();

  /** Pixels on screen per source pixel. */
  const k = $derived(size ? Math.max(FRAME / size.width, FRAME / size.height) * zoom : 1);
  const shownW = $derived(size ? size.width * k : FRAME);
  const shownH = $derived(size ? size.height * k : FRAME);

  function clamp(): void {
    ox = Math.min(0, Math.max(FRAME - shownW, ox));
    oy = Math.min(0, Math.max(FRAME - shownH, oy));
  }

  onMount(() => {
    dialog?.showModal();
    // svelte-ignore state_referenced_locally
    const u = URL.createObjectURL(file);
    url = u;
    naturalSize(file)
      .then((s) => {
        size = s;
        const k0 = Math.max(FRAME / s.width, FRAME / s.height);
        ox = (FRAME - s.width * k0) / 2;
        oy = (FRAME - s.height * k0) / 2;
      })
      .catch(() => (error = t.profile.avatarFailed));
    return () => URL.revokeObjectURL(u);
  });

  $effect(() => {
    void zoom;
    clamp();
  });

  let drag: { x: number; y: number; ox: number; oy: number } | null = null;

  function onDown(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox, oy };
  }

  function onMove(e: PointerEvent): void {
    if (!drag) return;
    ox = drag.ox + e.clientX - drag.x;
    oy = drag.oy + e.clientY - drag.y;
    clamp();
  }

  function onUp(): void {
    drag = null;
  }

  function onKey(e: KeyboardEvent): void {
    const step = 10;
    if (e.key === 'ArrowLeft') ox += step;
    else if (e.key === 'ArrowRight') ox -= step;
    else if (e.key === 'ArrowUp') oy += step;
    else if (e.key === 'ArrowDown') oy -= step;
    else return;
    e.preventDefault();
    clamp();
  }

  async function save(): Promise<void> {
    if (!size || busy) return;
    busy = true;
    error = null;
    try {
      const side = Math.round(FRAME / k);
      const avatar = await prepareAvatar(file, {
        sx: Math.max(0, Math.round(-ox / k)),
        sy: Math.max(0, Math.round(-oy / k)),
        side: Math.max(1, Math.min(side, size.width, size.height)),
      });
      await onsave(avatar);
      dialog?.close();
    } catch {
      error = t.profile.avatarFailed;
    } finally {
      busy = false;
    }
  }

  function onCancelEvent(e: Event): void {
    e.preventDefault();
    if (!busy) oncancel();
  }
</script>

<dialog bind:this={dialog} aria-labelledby="{uid}-title" oncancel={onCancelEvent}>
  <div class="stack">
    <h2 id="{uid}-title">{t.profile.cropTitle}</h2>
    <p class="muted small">{t.profile.cropHint}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="frame"
      role="img"
      aria-label={t.profile.cropTitle}
      tabindex="0"
      style:width="{FRAME}px"
      style:height="{FRAME}px"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
      onkeydown={onKey}
    >
      {#if url && size}
        <img
          src={url}
          alt=""
          draggable="false"
          style:width="{shownW}px"
          style:height="{shownH}px"
          style:transform="translate({ox}px, {oy}px)"
        />
      {/if}
      <span class="ring" aria-hidden="true"></span>
    </div>
    <div class="field">
      <label for="{uid}-zoom">{t.profile.zoom}</label>
      <input id="{uid}-zoom" type="range" min="1" max="4" step="0.05" bind:value={zoom} />
    </div>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={oncancel}>{t.common.cancel}</button>
      <button class="btn" type="button" disabled={busy || !size} onclick={save}>{t.common.save}</button>
    </div>
  </div>
</dialog>

<style>
  .frame {
    position: relative;
    align-self: center;
    overflow: hidden;
    border-radius: var(--r-m);
    background: var(--surface-2);
    touch-action: none;
    cursor: grab;
  }

  .frame img {
    position: absolute;
    top: 0;
    left: 0;
    max-width: none;
    user-select: none;
  }

  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 999px rgb(0 0 0 / 0.35);
    pointer-events: none;
  }

  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }

  .end {
    justify-content: flex-end;
  }
</style>
