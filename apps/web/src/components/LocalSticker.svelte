<script lang="ts">
  import { onMount } from 'svelte';
  import type { ImportedSticker } from '@family-chat/core';
  import { app } from '../lib/app.svelte.ts';
  import { loadLottie, type LottieAnimation } from '../lib/lottie.ts';
  import { t } from '../lib/strings.ts';

  // A still preview of an imported, not yet published sticker: the first
  // frame of the WebP drawn into a canvas, or the first frame of the
  // sanitised `.tgs` animation. The bytes were checked by the core already.
  let { sticker, size = 72 }: { sticker: ImportedSticker; size?: number } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let box: HTMLElement | undefined = $state();
  let failed = $state(false);
  let anim: LottieAnimation | null = null;

  onMount(() => {
    void (async () => {
      if (sticker.type === 'webp') {
        const bmp = await createImageBitmap(new Blob([sticker.bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' }));
        if (canvas) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext('2d')?.drawImage(bmp, 0, 0);
        }
        bmp.close();
      } else {
        const [{ data }, lottie] = await Promise.all([app.core.readTgs(sticker.bytes), loadLottie()]);
        if (!box) return;
        anim = lottie.loadAnimation({ container: box, renderer: 'svg', loop: false, autoplay: false, animationData: data });
        anim.goToAndStop(0, true);
      }
    })().catch(() => (failed = true));
    return () => anim?.destroy();
  });
</script>

<span class="local" role="img" aria-label={t.stickers.sticker(sticker.emoji)} style:width="{size}px" style:height="{size}px" data-testid="local-sticker">
  {#if failed}
    <span class="emoji" aria-hidden="true">{sticker.emoji}</span>
  {:else if sticker.type === 'webp'}
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
  {:else}
    <span class="box" bind:this={box}></span>
  {/if}
</span>

<style>
  .local {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  canvas,
  .box {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .emoji {
    font-size: 2rem;
  }
</style>
