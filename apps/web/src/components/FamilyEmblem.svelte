<script lang="ts">
  import type { Emblem } from '../lib/emblem.ts';

  // The family's emblem: a coloured circle with a white symbol. Decorative:
  // wherever it is shown, the control or the line next to it is named.
  let { emblem, size = 28 }: { emblem: Emblem; size?: number } = $props();

  const PATHS: Record<Emblem['symbol'], string> = {
    circle: 'M12 7a5 5 0 1 1 0 10a5 5 0 1 1 0-10z',
    diamond: 'M12 6l6 6l-6 6l-6-6z',
    triangle: 'M12 6.5l6 10.5H6z',
    star: 'M12 5.5l1.9 4.2l4.6.4l-3.5 3l1.1 4.5L12 15.2l-4.1 2.4l1.1-4.5l-3.5-3l4.6-.4z',
    heart: 'M12 18s-6-3.7-6-8a3.2 3.2 0 0 1 6-1.6A3.2 3.2 0 0 1 18 10c0 4.3-6 8-6 8z',
    leaf: 'M17.5 6.5C11 6.5 6.5 9.5 6.5 14.5c0 1.4.4 2.4.9 3l1-1c2-2 4-3.5 6.5-4.5c-2.3 1.4-4.2 3-5.8 5.2c.6.3 1.3.3 2 .3c5 0 6.4-5 6.4-11z',
    sun: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM11.2 4.5h1.6v2.6h-1.6zM11.2 16.9h1.6v2.6h-1.6zM4.5 11.2h2.6v1.6H4.5zM16.9 11.2h2.6v1.6h-2.6z',
    house: 'M12 6l6.5 5.5h-2V18h-3.2v-4h-2.6v4H7.5v-6.5h-2z',
  };
</script>

<svg class="emblem" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="12" fill={emblem.color} />
  <path d={PATHS[emblem.symbol]} fill="#ffffff" />
</svg>

<style>
  .emblem {
    flex: 0 0 auto;
    display: block;
  }
</style>
