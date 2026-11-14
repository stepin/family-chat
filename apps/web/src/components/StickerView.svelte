<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { webpInfo, type StickerType } from '@family-chat/core';
  import { app } from '../lib/app.svelte.ts';
  import { loadLottie, reducedMotion, type LottieAnimation } from '../lib/lottie.ts';
  import { t } from '../lib/strings.ts';

  // One sticker (M5): a WebP image (static or animated) or a `.tgs` Lottie
  // animation. The file comes from the core already checked against its hash
  // and, for `.tgs`, unpacked and sanitised (no expressions, no external
  // addresses); it is drawn with the light lottie-web build. SVG and HTML are
  // never rendered from a file. With `prefers-reduced-motion` (and in the
  // picker, `still`) animated stickers stay on their first frame; in a chat a
  // tap plays them once. A missing pack or a bad file shows a quiet
  // placeholder with the sticker's emoji.
  let {
    accountId,
    pack,
    file,
    type,
    emoji,
    w = 512,
    h = 512,
    size = 160,
    still = false,
  }: {
    accountId: string;
    pack: string;
    file: string;
    type: StickerType;
    emoji: string;
    w?: number;
    h?: number;
    /** Longest side on screen, CSS pixels. */
    size?: number;
    /** Picker thumbnails: never animate. */
    still?: boolean;
  } = $props();

  let phase = $state<'loading' | 'ready' | 'missing'>('loading');
  let url = $state<string | null>(null);
  /** First frame of an animated WebP (reduced motion or still). */
  let frame: HTMLCanvasElement | undefined = $state();
  let box: HTMLElement | undefined = $state();
  let animated = $state(false);
  let playing = $state(false);
  let anim: LottieAnimation | null = null;
  const reduced = reducedMotion();

  // svelte-ignore state_referenced_locally
  const scale = Math.min(size / Math.max(w, 1), size / Math.max(h, 1));
  // svelte-ignore state_referenced_locally
  const width = Math.max(1, Math.round(w * scale));
  // svelte-ignore state_referenced_locally
  const height = Math.max(1, Math.round(h * scale));
  /** Animated but held: a tap plays it (chat only). */
  const tapToPlay = $derived(animated && reduced && !still && phase === 'ready');

  async function showWebp(): Promise<void> {
    const blob = await app.core.stickerFile(accountId, pack, file);
    const head = webpInfo(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    animated = !!head?.animated;
    url = URL.createObjectURL(blob);
    if (animated && (reduced || still) && typeof createImageBitmap === 'function') {
      // The first frame only, drawn into a canvas (an <img> would animate).
      const bmp = await createImageBitmap(blob);
      phase = 'ready';
      await tick();
      if (frame) {
        frame.width = bmp.width;
        frame.height = bmp.height;
        frame.getContext('2d')?.drawImage(bmp, 0, 0);
      }
      bmp.close();
      return;
    }
    phase = 'ready';
  }

  async function showTgs(): Promise<void> {
    const [{ data }, lottie] = await Promise.all([app.core.stickerAnimation(accountId, pack, file), loadLottie()]);
    animated = true;
    phase = 'ready';
    await tick();
    if (!box) return;
    const hold = reduced || still;
    anim = lottie.loadAnimation({
      container: box,
      renderer: 'svg',
      loop: !hold,
      autoplay: false,
      animationData: data,
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true },
    });
    anim.addEventListener('complete', () => {
      // Played once on tap: back to the first frame.
      anim?.goToAndStop(0, true);
      playing = false;
    });
    if (hold) anim.goToAndStop(0, true);
    else {
      anim.play();
      playing = true;
    }
  }

  function toggle(): void {
    if (!tapToPlay) return;
    if (type === 'tgs' && anim) {
      if (playing) {
        anim.goToAndStop(0, true);
        playing = false;
      } else {
        anim.goToAndPlay(0, true);
        playing = true;
      }
    } else if (type === 'webp') {
      playing = !playing;
    }
  }

  onMount(() => {
    let cancelled = false;
    (type === 'tgs' ? showTgs() : showWebp()).catch((e: unknown) => {
      if (cancelled) return;
      phase = 'missing';
      app.log('info', 'stickers', 'sticker not shown', e);
    });
    // Animations off screen do not need to run.
    let io: IntersectionObserver | undefined;
    if (!still && !reduced && 'IntersectionObserver' in window && box) {
      io = new IntersectionObserver((entries) => {
        if (!anim) return;
        if (entries.some((e) => e.isIntersecting)) anim.play();
        else anim.pause();
      });
      io.observe(box);
    }
    return () => {
      cancelled = true;
      io?.disconnect();
      anim?.destroy();
      anim = null;
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

{#snippet picture()}
  {#if phase === 'missing'}
    <span class="missing" title={t.stickers.unavailableHint} data-testid="sticker-missing">
      <span class="emoji" aria-hidden="true">{emoji}</span>
      <span class="visually-hidden">{t.stickers.unavailable}</span>
    </span>
  {:else if type === 'tgs'}
    <span class="lottie" bind:this={box} data-testid="sticker-lottie" data-playing={playing ? 'true' : 'false'}></span>
  {:else if phase === 'ready' && animated && (reduced || still) && !playing}
    <canvas bind:this={frame} class="img" data-testid="sticker-frame" aria-hidden="true"></canvas>
  {:else if phase === 'ready' && url}
    <img class="img" src={url} alt="" draggable="false" data-testid="sticker-img" />
  {:else}
    <span class="loading" aria-hidden="true">{emoji}</span>
  {/if}
{/snippet}

{#if tapToPlay}
  <button
    class="sticker tap"
    type="button"
    style:width="{width}px"
    style:height="{height}px"
    aria-label={`${t.stickers.sticker(emoji)}. ${playing ? t.stickers.pause : t.stickers.play}`}
    aria-pressed={playing}
    onclick={toggle}
    data-testid="sticker"
    data-type={type}
    data-animated="true"
  >
    {@render picture()}
  </button>
{:else}
  <span
    class="sticker"
    role="img"
    aria-label={phase === 'missing' ? `${t.stickers.unavailable}: ${emoji}` : t.stickers.sticker(emoji)}
    style:width="{width}px"
    style:height="{height}px"
    data-testid="sticker"
    data-type={type}
    data-animated={animated ? 'true' : 'false'}
    data-state={phase}
  >
    {@render picture()}
  </span>
{/if}

<style>
  .sticker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    flex: 0 0 auto;
  }

  .tap {
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: var(--r-m);
  }

  .img,
  .lottie {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
  }

  .missing,
  .loading {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border-radius: var(--r-l, 16px);
    background: var(--surface-2);
    color: var(--muted);
  }

  .loading {
    background: transparent;
  }

  .emoji,
  .loading {
    font-size: 2.5rem;
    line-height: 1;
  }
</style>
