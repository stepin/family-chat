import { describe, expect, it } from 'vitest';
import {
  CANCEL_SLIDE_PX,
  LOCK_SLIDE_PX,
  MAX_VOICE_MS,
  MIN_VOICE_MS,
  TAP_MS,
  barsFromPeaks,
  canPlayVoice,
  durationWords,
  formatDuration,
  nextSpeed,
  peaksFromLevels,
  pickRecorderType,
  recorderStep,
  seekTo,
  speedLabel,
  timeLeft,
  voiceFileName,
  voiceMime,
  type RecorderEvent,
  type RecorderState,
} from './voice.ts';

function run(events: RecorderEvent[], from: RecorderState = { kind: 'idle' }) {
  let state = from;
  const effects: (string | null)[] = [];
  for (const e of events) {
    const step = recorderStep(state, e);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
}

describe('voice: formats', () => {
  it('prefers AAC in MP4, falls back to Opus in WebM, then Ogg', () => {
    expect(pickRecorderType(() => true)).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickRecorderType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickRecorderType((t) => t === 'audio/webm')).toBe('audio/webm');
    expect(pickRecorderType((t) => t.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
    expect(pickRecorderType(() => false)).toBeNull();
    expect(
      pickRecorderType(() => {
        throw new Error('unknown');
      }),
    ).toBeNull();
  });

  it('maps recorder types to the protocol voice types and names files', () => {
    expect(voiceMime('audio/mp4;codecs=opus')).toBe('audio/mp4');
    expect(voiceMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(voiceMime('audio/ogg')).toBe('audio/ogg');
    expect(voiceMime('')).toBe('audio/mp4');
    expect(voiceFileName('audio/mp4', new Date(2026, 10, 14, 18, 5).getTime())).toBe('Голосовое 2026-11-14 18-05.m4a');
    expect(voiceFileName('audio/webm', 0)).toMatch(/\.webm$/);
  });

  it('can play: canPlayType says anything but ""', () => {
    expect(canPlayVoice('audio/mp4', () => 'maybe')).toBe(true);
    expect(canPlayVoice('audio/webm', () => '')).toBe(false);
    expect(
      canPlayVoice('audio/ogg', () => {
        throw new Error('x');
      }),
    ).toBe(false);
  });
});

describe('voice: waveform', () => {
  it('64 peaks 0-255, loudest at 255, each the maximum of its stretch', () => {
    const levels = Array.from({ length: 640 }, (_, i) => (i % 10 === 0 ? 0.5 : 0.1));
    const peaks = peaksFromLevels(levels);
    expect(peaks).toHaveLength(64);
    expect(peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true);
    expect(peaks.every((p) => p === 255)).toBe(true);
    const ramp = peaksFromLevels(Array.from({ length: 64 }, (_, i) => i / 63));
    expect(ramp[0]).toBe(0);
    expect(ramp[63]).toBe(255);
    expect(ramp[32]).toBe(Math.round((32 / 63) * 255));
  });

  it('short recordings, silence and junk', () => {
    expect(peaksFromLevels([])).toEqual(new Array(64).fill(0));
    // Fewer samples than peaks: stretched, still 64.
    expect(peaksFromLevels([0.2, 0.4])).toHaveLength(64);
    // Quiet recordings stay quiet (not blown up to full height).
    expect(Math.max(...peaksFromLevels(new Array(100).fill(0.02)))).toBe(51);
    expect(peaksFromLevels([Number.NaN, 2, -1], 4)).toEqual([0, 0, 255, 0]);
    expect(peaksFromLevels([1], 8)).toHaveLength(8);
  });

  it('bars for drawing', () => {
    expect(barsFromPeaks(null, 3)).toEqual([0, 0, 0]);
    expect(barsFromPeaks([0, 255], 4)).toEqual([0, 0, 1, 1]);
  });
});

describe('voice: durations and speed', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_900)).toBe('0:07');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(MAX_VOICE_MS)).toBe('10:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('says durations in words for screen readers', () => {
    expect(durationWords(0)).toBe('0 секунд');
    expect(durationWords(1_000)).toBe('1 секунда');
    expect(durationWords(3_000)).toBe('3 секунды');
    expect(durationWords(65_000)).toBe('1 минута 5 секунд');
    expect(durationWords(120_000)).toBe('2 минуты');
    expect(durationWords(660_000)).toBe('11 минут');
  });

  it('cycles 1x, 1.5x, 2x', () => {
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(3)).toBe(1);
    expect(speedLabel(1.5)).toBe('1,5x');
    expect(speedLabel(2)).toBe('2x');
  });

  it('seeks within the recording', () => {
    expect(seekTo(0.5, 10_000)).toBe(5_000);
    expect(seekTo(-1, 10_000)).toBe(0);
    expect(seekTo(2, 10_000)).toBe(10_000);
  });
});

describe('voice: recorder state machine', () => {
  it('hold to record, release to send', () => {
    const r = run([
      { type: 'press', at: 0, via: 'touch' },
      { type: 'ready', at: 100 },
      { type: 'move', dx: -10, dy: 5 },
      { type: 'release', at: 3_000 },
    ]);
    expect(r.effects).toEqual(['open-mic', null, null, 'send']);
    expect(r.state).toEqual({ kind: 'idle' });
  });

  it('slide left cancels, also while the microphone is starting', () => {
    expect(run([{ type: 'press', at: 0, via: 'touch' }, { type: 'ready', at: 10 }, { type: 'move', dx: -CANCEL_SLIDE_PX, dy: 0 }]).effects.at(-1)).toBe(
      'discard',
    );
    expect(run([{ type: 'press', at: 0, via: 'touch' }, { type: 'move', dx: -CANCEL_SLIDE_PX - 1, dy: 0 }]).effects.at(-1)).toBe('discard');
    // A partial slide is shown, not acted on.
    const partial = run([{ type: 'press', at: 0, via: 'touch' }, { type: 'ready', at: 10 }, { type: 'move', dx: -30, dy: 0 }]);
    expect(partial.state).toMatchObject({ kind: 'recording', mode: 'hold', slide: -30 });
  });

  it('slide up locks: releasing then keeps recording until send or cancel', () => {
    const r = run([
      { type: 'press', at: 0, via: 'touch' },
      { type: 'ready', at: 10 },
      { type: 'move', dx: 0, dy: -LOCK_SLIDE_PX },
      { type: 'release', at: 2_000 },
      { type: 'move', dx: -500, dy: 0 },
    ]);
    expect(r.state).toMatchObject({ kind: 'recording', mode: 'locked' });
    expect(r.effects.slice(3)).toEqual([null, null]);
    expect(recorderStep(r.state, { type: 'send', at: 5_000 }).effect).toBe('send');
    expect(recorderStep(r.state, { type: 'cancel' }).effect).toBe('discard');
    expect(recorderStep({ kind: 'recording', mode: 'hold', startedAt: 0, slide: 0 }, { type: 'lock' }).state).toMatchObject({ mode: 'locked' });
  });

  it('a tap (and a click, Enter, a screen reader) records without holding', () => {
    const tap = run([
      { type: 'press', at: 0, via: 'touch' },
      { type: 'ready', at: 50 },
      { type: 'release', at: 50 + TAP_MS - 1 },
    ]);
    expect(tap.state).toMatchObject({ kind: 'recording', mode: 'locked' });
    const click = run([{ type: 'press', at: 0, via: 'click' }, { type: 'ready', at: 50 }]);
    expect(click.state).toMatchObject({ kind: 'recording', mode: 'locked' });
    // Released while the permission prompt was open: locked, nothing sent by surprise.
    const prompt = run([{ type: 'press', at: 0, via: 'touch' }, { type: 'release', at: 4_000 }, { type: 'ready', at: 5_000 }]);
    expect(prompt.state).toMatchObject({ kind: 'recording', mode: 'locked', startedAt: 5_000 });
    expect(prompt.effects).toEqual(['open-mic', null, null]);
  });

  it('too short holds are dropped, not sent', () => {
    const r = run([
      { type: 'press', at: 0, via: 'touch' },
      { type: 'ready', at: 0 },
      { type: 'release', at: MIN_VOICE_MS - 1 },
    ]);
    // Under TAP_MS it is a tap (locked); between TAP_MS and MIN_VOICE_MS it is too short.
    expect(MIN_VOICE_MS).toBeGreaterThan(TAP_MS);
    expect(r.effects.at(-1)).toBe('too-short');
    expect(recorderStep({ kind: 'recording', mode: 'locked', startedAt: 0, slide: 0 }, { type: 'send', at: 100 }).effect).toBe('too-short');
  });

  it('stops and sends at 10 minutes', () => {
    const s: RecorderState = { kind: 'recording', mode: 'locked', startedAt: 1_000, slide: 0 };
    expect(recorderStep(s, { type: 'tick', at: 1_000 + MAX_VOICE_MS - 1 }).effect).toBeNull();
    expect(recorderStep(s, { type: 'tick', at: 1_000 + MAX_VOICE_MS })).toEqual({ state: { kind: 'idle' }, effect: 'send' });
    expect(timeLeft(s, 1_000 + MAX_VOICE_MS - 30_000)).toBe(30_000);
    expect(timeLeft({ kind: 'idle' }, 0)).toBeNull();
  });

  it('refused microphone, no recorder, failures; pressing again retries', () => {
    const denied = run([{ type: 'press', at: 0, via: 'click' }, { type: 'denied' }]);
    expect(denied.state).toEqual({ kind: 'denied' });
    expect(recorderStep(denied.state, { type: 'dismiss' }).state).toEqual({ kind: 'idle' });
    expect(recorderStep(denied.state, { type: 'press', at: 1, via: 'click' }).effect).toBe('open-mic');
    expect(run([{ type: 'press', at: 0, via: 'click' }, { type: 'unsupported' }]).state).toEqual({ kind: 'unsupported' });
    const failed = recorderStep({ kind: 'recording', mode: 'locked', startedAt: 0, slide: 0 }, { type: 'failed' });
    expect(failed).toEqual({ state: { kind: 'failed' }, effect: 'discard' });
    // Events that do not apply change nothing.
    expect(recorderStep({ kind: 'idle' }, { type: 'release', at: 0 })).toEqual({ state: { kind: 'idle' }, effect: null });
    expect(recorderStep({ kind: 'idle' }, { type: 'dismiss' })).toEqual({ state: { kind: 'idle' }, effect: null });
  });
});
