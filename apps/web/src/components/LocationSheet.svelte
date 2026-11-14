<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatAccuracy, formatCoords, geoProblem, isLowAccuracy, placeFromCoords, type GeoProblem, type Place } from '../lib/location.ts';
  import { t } from '../lib/strings.ts';

  // Sending the current place (docs/PLAN.md screen 13): the position is
  // taken once with getCurrentPosition, its accuracy is shown before sending,
  // and worse than 500 m is pointed out. A refused permission is explained
  // with the way to allow it. No map is loaded.
  let { onsend, oncancel }: { onsend: (place: Place) => Promise<boolean>; oncancel: () => void } = $props();

  const uid = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();
  // Raw: the place goes into IndexedDB as is (a deep $state proxy cannot be cloned).
  let place = $state.raw<Place | null>(null);
  let problem = $state<GeoProblem | null>(null);
  let locating = $state(false);
  let sending = $state(false);
  let request = 0;

  function locate(): void {
    problem = null;
    if (!window.isSecureContext) {
      problem = 'insecure';
      return;
    }
    if (!navigator.geolocation) {
      problem = 'unsupported';
      return;
    }
    const mine = ++request;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (mine !== request) return;
        locating = false;
        place = placeFromCoords(pos.coords);
      },
      (err) => {
        if (mine !== request) return;
        locating = false;
        problem = geoProblem(err.code);
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  onMount(() => {
    dialog?.showModal();
    locate();
  });

  function onCancelEvent(e: Event): void {
    e.preventDefault();
    if (!sending) oncancel();
  }

  async function send(): Promise<void> {
    if (!place || sending) return;
    sending = true;
    try {
      if (await onsend(place)) oncancel();
    } finally {
      sending = false;
    }
  }

  const problemText = $derived.by(() => {
    switch (problem) {
      case 'denied':
        return t.location.deniedText(app.platform.os);
      case 'timeout':
        return t.location.timeout;
      case 'unsupported':
        return t.location.unsupported;
      case 'insecure':
        return t.location.insecure;
      case 'unavailable':
        return t.location.unavailable;
      default:
        return '';
    }
  });
</script>

<dialog bind:this={dialog} class="sheet" aria-labelledby="{uid}-title" oncancel={onCancelEvent} data-testid="location-sheet">
  <div class="stack">
    <h2 id="{uid}-title">{t.location.title}</h2>
    {#if locating}
      <p role="status" class="muted">{t.location.locating}</p>
    {/if}
    {#if problem}
      <div class="notice warn" role="alert" data-testid="location-problem" data-problem={problem}>
        {#if problem === 'denied'}<p><strong>{t.location.denied}</strong></p>{/if}
        <p>{problemText}</p>
      </div>
    {/if}
    {#if place && !locating}
      <div class="where" data-testid="location-preview">
        <span class="pin" aria-hidden="true"><Icon name="pin" size={28} /></span>
        <span class="text">
          <span class="tabular">{formatCoords(place)}</span>
          <span class="small" data-testid="location-accuracy">{t.location.accuracy(formatAccuracy(place.accuracy))}</span>
        </span>
      </div>
      {#if isLowAccuracy(place.accuracy)}
        <p class="notice warn" role="status" data-testid="location-low">{t.location.low(formatAccuracy(place.accuracy))}</p>
      {/if}
    {/if}
    <p class="small muted">{t.location.privacy}</p>
    <div class="row actions">
      <button class="btn" type="button" disabled={!place || locating || sending} onclick={send}>{t.location.send}</button>
      {#if problem !== 'unsupported' && problem !== 'insecure'}
        <button class="btn secondary" type="button" disabled={locating || sending} onclick={locate}>{t.location.refresh}</button>
      {/if}
      <button class="btn secondary" type="button" disabled={sending} onclick={oncancel}>{t.common.cancel}</button>
    </div>
  </div>
</dialog>

<style>
  .sheet {
    width: min(28rem, calc(100vw - 2rem));
    padding: var(--sp-5);
    border: 0;
    border-radius: var(--r-l);
    background: var(--surface);
    color: var(--text);
  }

  .sheet::backdrop {
    background: var(--scrim);
  }

  .where {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .pin {
    display: inline-flex;
    color: var(--accent);
  }

  .text {
    display: flex;
    flex-direction: column;
  }

  .actions {
    flex-wrap: wrap;
  }
</style>
