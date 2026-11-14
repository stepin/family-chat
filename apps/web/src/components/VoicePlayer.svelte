<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { AttachmentView } from '@family-chat/core';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { attachmentUi } from '../lib/attachment-state.ts';
  import { claimPlayback, releasePlayback } from '../lib/playback.ts';
  import { saveBlob } from '../lib/storage.ts';
  import { t } from '../lib/strings.ts';
  import { barsFromPeaks, canPlayVoice, durationWords, formatDuration, nextSpeed, seekTo, speedLabel } from '../lib/voice.ts';

  // A voice message (docs/PLAN.md 8.6): play and pause, the waveform as a
  // seek slider (pointer, arrows, Home and End), the time, speed 1x / 1.5x /
  // 2x, and the "не прослушано" mark on others' messages until played here.
  // A format this browser cannot play shows that plainly, with a download.
  let {
    accountId,
    attachment,
    outgoing,
    sentAt,
    now,
  }: { accountId: string; attachment: AttachmentView; outgoing: boolean; sentAt: number | null; now: number } = $props();

  const BARS = 48;
  let audio: HTMLAudioElement | undefined = $state();
  let url = $state<string | null>(null);
  let playing = $state(false);
  let position = $state(0);
  let speed = $state(1);
  let cannotPlay = $state(false);
  let busy = $state(false);
  let track: HTMLDivElement | undefined = $state();

  const bars = $derived(barsFromPeaks(attachment.peaks, BARS));
  const mediaDuration = $state({ ms: 0 });
  const duration = $derived(attachment.durationMs ?? mediaDuration.ms);
  const progress = $derived(duration > 0 ? Math.min(1, position / duration) : 0);
  const ready = $derived(attachment.status === 'ready');
  const unheard = $derived(!outgoing && !attachment.heard);
  const ui = $derived(attachmentUi(attachment, { sentAt, retentionDays: app.account?.retentionDays ?? 90, now }));
  const shownTime = $derived(playing || position > 0 ? formatDuration(position) : formatDuration(duration));

  // Only these primitives drive the file URL: the attachment object is new on every
  // database change (marking it heard, for one), which must not restart playback.
  // (Props passed as expressions are getters over the parent's message object.)
  const blobId = $derived(attachment.blobId);
  const mime = $derived(attachment.mime);
  const acc = $derived(accountId);

  // The file once it is in app storage.
  $effect(() => {
    if (!ready) return;
    if (typeof document !== 'undefined' && !canPlayVoice(mime, (m) => document.createElement('audio').canPlayType(m))) {
      cannotPlay = true;
      return;
    }
    let current: string | null = null;
    let cancelled = false;
    void app.core
      .attachmentUrl(acc, blobId)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else url = current = u;
      })
      .catch((e: unknown) => app.log('warn', 'voice', 'voice message not readable', e));
    return () => {
      cancelled = true;
      if (current) URL.revokeObjectURL(current);
      url = null;
    };
  });

  async function toggle(): Promise<void> {
    if (!audio || !url) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    claimPlayback(audio);
    audio.playbackRate = speed;
    try {
      if (duration > 0 && position >= duration - 50) setPosition(0);
      await audio.play();
      if (unheard) void app.core.markHeard(accountId, attachment.blobId).catch(() => undefined);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'NotSupportedError') cannotPlay = true;
      else app.log('warn', 'voice', 'playback did not start', e);
    }
  }

  function setPosition(ms: number): void {
    const clamped = Math.max(0, Math.min(duration || ms, ms));
    position = clamped;
    if (audio) audio.currentTime = clamped / 1000;
  }

  function cycleSpeed(): void {
    speed = nextSpeed(speed);
    if (audio) audio.playbackRate = speed;
  }

  function onTrackPointer(e: PointerEvent): void {
    if (!track || !url || cannotPlay) return;
    if (e.type === 'pointerdown') track.setPointerCapture(e.pointerId);
    else if (!track.hasPointerCapture(e.pointerId)) return;
    const r = track.getBoundingClientRect();
    setPosition(seekTo((e.clientX - r.left) / r.width, duration));
  }

  function onTrackKey(e: KeyboardEvent): void {
    if (!url || cannotPlay) return;
    const step = 5000;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setPosition(position + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setPosition(position - step);
    else if (e.key === 'Home') setPosition(0);
    else if (e.key === 'End') setPosition(duration);
    else return;
    e.preventDefault();
  }

  async function act(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (ready) saveBlob(await app.core.attachmentBlob(accountId, attachment.blobId), attachment.name);
      else if (ui.action === 'cancel-download') await app.core.cancelTransfer(accountId, attachment.blobId);
      else await app.core.downloadAttachment(accountId, attachment.blobId);
    } catch (e) {
      app.notify(t.errors.generic);
      app.log('warn', 'voice', 'voice action failed', e);
    } finally {
      busy = false;
    }
  }

  onDestroy(() => {
    if (audio) {
      audio.pause();
      releasePlayback(audio);
    }
  });
</script>

<div class="voice" class:unheard data-testid="voice-message" data-mime={attachment.mime} data-status={attachment.status} data-heard={attachment.heard ? 'true' : 'false'}>
  {#if cannotPlay}
    <span class="icon" aria-hidden="true"><Icon name="mic" /></span>
    <span class="body">
      <span class="cannot" data-testid="voice-cannot-play">{t.voice.cannotPlay}</span>
      <span class="small muted tabular">{formatDuration(duration)}</span>
    </span>
    <button class="btn secondary small" type="button" disabled={busy} onclick={act}>{t.voice.download}</button>
  {:else}
    <button
      class="play"
      type="button"
      disabled={!url}
      aria-label={playing ? t.voice.pause : t.voice.play(durationWords(duration))}
      onclick={toggle}
      data-testid="voice-play"
    >
      <Icon name={playing ? 'pause' : 'play'} />
    </button>
    <span class="body">
      <div
        bind:this={track}
        class="track"
        role="slider"
        tabindex={url ? 0 : -1}
        aria-label={t.voice.position}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(position / 1000)}
        aria-valuetext={t.voice.positionText(durationWords(position), durationWords(duration))}
        aria-disabled={!url}
        onpointerdown={onTrackPointer}
        onpointermove={onTrackPointer}
        onkeydown={onTrackKey}
      >
        {#each bars as b, i (i)}
          <span class="bar" class:done={i / bars.length < progress} style:height="{Math.max(12, Math.round(b * 100))}%"></span>
        {/each}
      </div>
      <span class="meta small">
        <span class="tabular" data-testid="voice-time">{shownTime}</span>
        {#if unheard}<span class="dot" aria-hidden="true"></span><span class="visually-hidden" data-testid="voice-unheard">{t.voice.unheard}</span>{/if}
        {#if !ready && ui.label && attachment.status !== 'uploading'}
          <span class:error-text={ui.tone === 'error'}>{ui.label}</span>
        {/if}
      </span>
    </span>
    {#if ready}
      <button class="speed small" type="button" aria-label={t.voice.speed(speedLabel(speed))} onclick={cycleSpeed} data-testid="voice-speed">
        {speedLabel(speed)}
      </button>
    {:else if ui.action && attachment.status !== 'uploading'}
      <button class="icon-btn" type="button" disabled={busy} aria-label={ui.action === 'cancel-download' ? t.attach.cancelDownload : t.voice.download} onclick={act}>
        <Icon name={ui.action === 'cancel-download' ? 'close' : 'download'} />
      </button>
    {/if}
  {/if}
  {#if url && !cannotPlay}
    <audio
      bind:this={audio}
      src={url}
      preload="metadata"
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      onended={() => {
        playing = false;
        position = duration;
      }}
      ontimeupdate={() => {
        if (audio && playing) position = audio.currentTime * 1000;
      }}
      onloadedmetadata={() => {
        if (audio && Number.isFinite(audio.duration)) mediaDuration.ms = audio.duration * 1000;
      }}
      onerror={() => {
        const code = audio?.error?.code;
        // 3: decode, 4: source not supported.
        if (code === 3 || code === 4) cannotPlay = true;
      }}
    ></audio>
  {/if}
</div>

<style>
  .voice {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: min(17rem, 100%);
  }

  .play {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }

  .play:disabled {
    background: var(--surface-2);
    color: var(--muted);
    cursor: default;
  }

  .icon {
    display: inline-flex;
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    gap: 2px;
  }

  .track {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 32px;
    cursor: pointer;
    touch-action: none;
    border-radius: var(--r-s);
  }

  .track:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .bar {
    flex: 1 1 0;
    min-width: 2px;
    border-radius: 2px;
    background: currentColor;
    opacity: 0.4;
  }

  .bar.done {
    opacity: 1;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: inherit;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }

  .speed {
    flex: 0 0 auto;
    min-width: var(--touch);
    min-height: var(--touch);
    padding: 0 var(--sp-2);
    border: 1px solid currentColor;
    border-radius: var(--r-l);
    background: transparent;
    color: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .cannot {
    font-weight: 600;
  }
</style>
