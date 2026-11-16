<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import type { MicRecorder, VoiceRecording } from '../lib/recorder.ts';
  import { t } from '../lib/strings.ts';
  import {
    CANCEL_SLIDE_PX,
    MAX_VOICE_MS,
    VOICE_WARN_MS,
    durationWords,
    formatDuration,
    recorderStep,
    type RecorderEffect,
    type RecorderEvent,
    type RecorderState,
  } from '../lib/voice.ts';

  // Voice recording. Phones: hold the button and
  // speak, release to send; slide left to cancel, slide up to keep recording
  // without holding. A tap (and on a desktop a click, and Enter or Space)
  // starts a recording that goes on by itself until "Отправить" or
  // "Отменить": the required alternative to holding, and what keyboards and
  // screen readers use. Ten minutes at most; then it stops and is sent.
  let {
    disabled = false,
    onrecorded,
    onactive,
  }: {
    disabled?: boolean;
    /** Sends the recording; false when it could not be queued. */
    onrecorded: (rec: VoiceRecording) => Promise<boolean>;
    /** Recording started or ended (the composer hides its field meanwhile). */
    onactive?: ((active: boolean) => void) | undefined;
  } = $props();

  const uid = $props.id();
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const BARS = 40;

  let rec = $state<RecorderState>({ kind: 'idle' });
  let levels = $state<number[]>(new Array(BARS).fill(0));
  let elapsed = $state(0);
  let announce = $state('');
  let warned = false;
  let mic: MicRecorder | null = null;
  /** Bumped on every new recording: a microphone that opens late for an old one is closed. */
  let session = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let origin: { x: number; y: number } | null = null;
  let button: HTMLButtonElement | undefined = $state();
  let sendBtn: HTMLButtonElement | undefined = $state();
  /** The press began with a finger; the click that follows it is ignored. */
  let touchPress = false;

  const active = $derived(rec.kind === 'starting' || rec.kind === 'recording');
  const locked = $derived((rec.kind === 'starting' || rec.kind === 'recording') && rec.mode === 'locked');
  const slide = $derived(rec.kind === 'recording' ? rec.slide : 0);

  $effect(() => {
    onactive?.(active);
  });

  function dispatch(e: RecorderEvent): void {
    const before = rec;
    const step = recorderStep(rec, e);
    rec = step.state;
    if (step.effect) void run(step.effect);
    if (before.kind !== 'idle' && rec.kind === 'idle' && step.effect !== 'send' && step.effect !== 'open-mic') stopTicker();
    // Entering the locked mode by tap or keyboard: the next useful control is "send".
    const wasReady = before.kind === 'recording' && before.mode === 'locked';
    if (rec.kind === 'recording' && rec.mode === 'locked' && !wasReady) void tick().then(() => sendBtn?.focus());
  }

  async function run(effect: Exclude<RecorderEffect, null>): Promise<void> {
    switch (effect) {
      case 'open-mic':
        await openMic();
        break;
      case 'send':
        await finish();
        break;
      case 'discard':
        mic?.discard();
        mic = null;
        session++;
        announce = t.voice.discarded;
        stopTicker();
        button?.focus();
        break;
      case 'too-short':
        mic?.discard();
        mic = null;
        session++;
        stopTicker();
        app.notify(t.voice.tooShort);
        break;
    }
  }

  async function openMic(): Promise<void> {
    const mine = ++session;
    levels = new Array(BARS).fill(0);
    elapsed = 0;
    warned = false;
    try {
      const { MicRecorder } = await import('../lib/recorder.ts');
      const opened = await MicRecorder.open((level) => {
        levels = [...levels.slice(1), level];
      });
      if (mine !== session || rec.kind !== 'starting') {
        opened.discard();
        return;
      }
      mic = opened;
      startTicker();
      dispatch({ type: 'ready', at: Date.now() });
      announce = t.voice.started;
    } catch (e) {
      if (mine !== session) return;
      const problem = (e as { problem?: string } | null)?.problem;
      if (problem === 'denied') dispatch({ type: 'denied' });
      else if (problem === 'unsupported') dispatch({ type: 'unsupported' });
      else {
        dispatch({ type: 'failed' });
        app.log('warn', 'voice', 'microphone did not start', e);
      }
    }
  }

  async function finish(): Promise<void> {
    const current = mic;
    mic = null;
    stopTicker();
    if (!current) return;
    try {
      const recording = await current.stop();
      const ok = await onrecorded({ ...recording, durationMs: Math.min(recording.durationMs, MAX_VOICE_MS) });
      if (!ok) app.notify(t.voice.failed);
    } catch (e) {
      app.notify(t.voice.failed);
      app.log('warn', 'voice', 'recording could not be finished', e);
    }
    button?.focus();
  }

  function startTicker(): void {
    stopTicker();
    ticker = setInterval(() => {
      if (!mic || rec.kind !== 'recording') return;
      if (mic.failed) {
        app.log('warn', 'voice', 'the recorder stopped with an error');
        dispatch({ type: 'failed' });
        return;
      }
      elapsed = mic.elapsed();
      if (!warned && MAX_VOICE_MS - elapsed <= VOICE_WARN_MS) {
        warned = true;
        announce = t.voice.limitSoon;
      }
      if (elapsed >= MAX_VOICE_MS) {
        announce = t.voice.limitReached;
        if (rec.kind === 'recording') dispatch({ type: 'tick', at: rec.startedAt + MAX_VOICE_MS });
      }
    }, 200);
  }

  function stopTicker(): void {
    clearInterval(ticker);
    ticker = undefined;
  }

  // ---- input ----

  function onPointerDown(e: PointerEvent): void {
    if (disabled || e.pointerType === 'mouse' || e.button !== 0) return;
    touchPress = true;
    e.preventDefault();
    origin = { x: e.clientX, y: e.clientY };
    button?.setPointerCapture(e.pointerId);
    dispatch({ type: 'press', at: Date.now(), via: 'touch' });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!origin) return;
    dispatch({ type: 'move', dx: e.clientX - origin.x, dy: e.clientY - origin.y });
  }

  function onPointerUp(): void {
    if (!origin) return;
    origin = null;
    dispatch({ type: 'release', at: Date.now() });
  }

  function onPointerCancel(): void {
    if (!origin) return;
    origin = null;
    // The system took the gesture (a scroll, a call): a held recording is dropped, a locked one goes on.
    if (!locked) dispatch({ type: 'cancel' });
  }

  /** Mouse, keyboard and screen readers: a click starts a locked recording. */
  function onClick(): void {
    if (touchPress) {
      touchPress = false;
      return;
    }
    if (disabled || active) return;
    dispatch({ type: 'press', at: Date.now(), via: 'click' });
  }

  function onPanelKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: 'cancel' });
    }
  }

  function send(): void {
    dispatch({ type: 'send', at: Date.now() });
  }

  function cancel(): void {
    dispatch({ type: 'cancel' });
  }

  function lock(): void {
    dispatch({ type: 'lock' });
  }

  onDestroy(() => {
    session++;
    mic?.discard();
    mic = null;
    stopTicker();
  });
</script>

<button
  bind:this={button}
  class="mic"
  class:held={active && !locked}
  type="button"
  aria-label={t.voice.record}
  aria-describedby="{uid}-hint"
  {disabled}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
  oncontextmenu={(e) => e.preventDefault()}
  onclick={onClick}
  data-testid="voice-record"
>
  <Icon name="mic" />
</button>
<span id="{uid}-hint" class="visually-hidden">{coarse ? t.voice.recordHint : t.voice.recordHintDesktop}</span>

{#if active}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="panel" role="group" aria-label={t.voice.recording} onkeydown={onPanelKey} data-testid="voice-panel" data-mode={locked ? 'locked' : 'hold'}>
    <span class="dot" class:live={rec.kind === 'recording'} aria-hidden="true"></span>
    <span class="time tabular" role="timer" aria-label={durationWords(elapsed)} data-testid="voice-timer">
      {rec.kind === 'starting' ? t.voice.waiting : formatDuration(elapsed)}
    </span>
    <span class="wave" aria-hidden="true" style:transform="translateX({Math.max(slide, -CANCEL_SLIDE_PX)}px)">
      {#each levels as l, i (i)}
        <span class="bar" style:height="{Math.max(8, Math.round(l * 100))}%"></span>
      {/each}
    </span>
    {#if locked}
      <button class="icon-btn danger" type="button" aria-label={t.voice.cancel} onclick={cancel}><Icon name="trash" /></button>
      <button bind:this={sendBtn} class="send" type="button" aria-label={t.voice.send} onclick={send} disabled={rec.kind !== 'recording'}>
        <Icon name="send" />
      </button>
    {:else}
      <span class="hints small" aria-hidden="true">
        <span>{t.voice.slideCancel}</span>
        <span>{t.voice.slideLock}</span>
      </span>
      <button class="icon-btn" type="button" aria-label={t.voice.lock} onclick={lock}><Icon name="lock" /></button>
    {/if}
  </div>
{/if}

<div class="visually-hidden" aria-live="polite" aria-atomic="true">{announce}</div>

{#if rec.kind === 'denied' || rec.kind === 'unsupported' || rec.kind === 'failed'}
  <div class="problem notice warn" role="alert" data-testid="voice-problem">
    {#if rec.kind === 'denied'}
      <p><strong>{t.voice.deniedTitle}</strong></p>
      <p>{t.voice.deniedText(app.platform.os)}</p>
    {:else if rec.kind === 'unsupported'}
      <p>{t.voice.unsupported}</p>
    {:else}
      <p>{t.voice.failed}</p>
    {/if}
    <button class="btn small" type="button" onclick={() => dispatch({ type: 'dismiss' })}>{t.voice.ok}</button>
  </div>
{/if}

<style>
  .mic,
  .send {
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
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  .mic.held {
    position: relative;
    z-index: 2;
    transform: scale(1.25);
  }

  .send:disabled {
    background: var(--surface-2);
    color: var(--muted);
  }

  .panel {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    padding-left: max(var(--sp-3), env(safe-area-inset-left));
    padding-right: max(var(--sp-3), env(safe-area-inset-right));
    background: var(--surface);
    z-index: 1;
  }

  .panel:has(.hints) {
    /* While held, the finger stays on the mic button under the panel's right end. */
    padding-right: calc(var(--touch) + var(--sp-4));
  }

  .dot {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--muted);
  }

  .dot.live {
    background: var(--error);
    animation: pulse 1s ease-in-out infinite alternate;
  }

  @keyframes pulse {
    to {
      opacity: 0.35;
    }
  }

  .time {
    flex: 0 0 auto;
    min-width: 3.5em;
    font-weight: 600;
  }

  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    overflow: hidden;
  }

  .bar {
    flex: 1 1 0;
    min-width: 2px;
    max-width: 4px;
    border-radius: 2px;
    background: var(--accent);
  }

  .hints {
    display: flex;
    flex-direction: column;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
  }

  .danger {
    color: var(--error);
  }

  .problem {
    position: absolute;
    left: var(--sp-3);
    right: var(--sp-3);
    bottom: calc(100% + var(--sp-2));
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    z-index: 2;
    box-shadow: var(--shadow);
  }

  .problem .btn {
    align-self: flex-start;
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.live {
      animation: none;
    }
    .mic.held {
      transform: none;
    }
  }
</style>
