<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatAccuracy, formatCoords, mapsLink, type Place } from '../lib/location.ts';
  import { t } from '../lib/strings.ts';

  // A place in a message: the main action "Открыть в
  // картах", coordinates and accuracy second. No map picture: tiles from a
  // third party would tell it where the family is.
  let { place }: { place: Place } = $props();

  const coords = $derived(formatCoords(place));
  const accuracy = $derived(formatAccuracy(place.accuracy));
  const link = $derived(mapsLink(place, app.platform.os));
</script>

<div class="place" role="group" aria-label={t.location.cardLabel(coords, accuracy)} data-testid="location-card">
  <span class="pin" aria-hidden="true"><Icon name="pin" size={28} /></span>
  <span class="text">
    <span class="title">{t.location.card}</span>
    <span class="small tabular coords" data-testid="location-coords">{coords}</span>
    <span class="small muted">{t.location.accuracy(accuracy)}</span>
  </span>
  <a
    class="btn small open"
    href={link.href}
    target={link.newTab ? '_blank' : undefined}
    rel="noopener noreferrer nofollow"
    data-testid="location-open">{t.location.open}</a
  >
</div>

<style>
  .place {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--sp-2) var(--sp-3);
    align-items: center;
    min-width: min(16rem, 100%);
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--bg);
    color: var(--text);
  }

  .pin {
    display: inline-flex;
    color: var(--accent);
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .title {
    font-weight: 600;
  }

  .coords {
    overflow-wrap: anywhere;
  }

  .open {
    grid-column: 1 / -1;
    justify-content: center;
    text-decoration: none;
  }
</style>
