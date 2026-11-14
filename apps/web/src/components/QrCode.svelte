<script lang="ts">
  import { encode } from 'uqr';

  // QR code drawn as one SVG path (no inline styles, no HTML injection).
  let { text, label }: { text: string; label: string } = $props();

  const qr = $derived(encode(text, { ecc: 'M', border: 2 }));
  const path = $derived.by(() => {
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return d;
  });
</script>

<svg class="qr" viewBox="0 0 {qr.size} {qr.size}" role="img" aria-label={label} shape-rendering="crispEdges">
  <rect width={qr.size} height={qr.size} fill="#ffffff" />
  <path d={path} fill="#000000" />
</svg>

<style>
  .qr {
    display: block;
    width: min(16rem, 100%);
    height: auto;
    aspect-ratio: 1;
    border-radius: var(--r-m);
  }
</style>
