// Voice messages: the pure part. Which format to
// record, the 64 waveform peaks, durations as text, playback speeds, and the
// recorder's state machine (press and hold with slide to cancel and slide up
// to lock; a tap or a click starts a locked recording, which is the required
// alternative to holding and the way keyboards and screen readers use it).

import { t } from './strings.ts';

/** Longest recording; at this point the recording stops and is sent. */
export const MAX_VOICE_MS = 10 * 60 * 1000;
/** A warning this long before the limit. */
export const VOICE_WARN_MS = 30_000;
/** Shorter holds are dropped ("Слишком коротко"). */
export const MIN_VOICE_MS = 700;
/** A press released faster than this is a tap: the recording goes on, locked. */
export const TAP_MS = 300;
/** Slide this far to the left (px) to cancel, this far up to lock. */
export const CANCEL_SLIDE_PX = 80;
export const LOCK_SLIDE_PX = 60;
export const PEAK_COUNT = 64;

/** Recorder formats in order of preference: AAC in MP4 first (plays everywhere), then Opus. */
export const RECORDER_TYPES: readonly string[] = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

/** The first format this browser can record, or null (no MediaRecorder support for audio). */
export function pickRecorderType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of RECORDER_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // Some browsers throw for unknown types.
    }
  }
  return null;
}

export type VoiceMime = 'audio/mp4' | 'audio/webm' | 'audio/ogg';

/** The protocol's voice type of a recorder type ("audio/webm;codecs=opus" → "audio/webm"). */
export function voiceMime(recorderType: string): VoiceMime {
  const base = recorderType.split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/webm' || base === 'audio/ogg') return base;
  return 'audio/mp4';
}

const EXT: Record<VoiceMime, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

/** "Голосовое 2026-11-14 18-30.m4a" (the name is shown only when the file is saved). */
export function voiceFileName(mime: VoiceMime, time: number): string {
  const d = new Date(time);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.voice.fileName} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}.${EXT[mime]}`;
}

/**
 * The waveform of a recording: `count` peaks 0-255 from loudness samples
 * (0..1, any number of them). Each peak is the loudest sample of its stretch;
 * the loudest peak becomes 255, but quiet recordings are not blown up to look
 * loud (the divisor is at least `floor`).
 */
export function peaksFromLevels(levels: readonly number[], count = PEAK_COUNT, floor = 0.1): number[] {
  const out = new Array<number>(count).fill(0);
  if (levels.length === 0) return out;
  const raw = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    let max = 0;
    for (let k = from; k < to && k < levels.length; k++) {
      const v = levels[k]!;
      if (Number.isFinite(v) && v > max) max = v;
    }
    raw[i] = Math.min(1, max);
  }
  const top = Math.max(floor, ...raw);
  for (let i = 0; i < count; i++) out[i] = Math.max(0, Math.min(255, Math.round((raw[i]! / top) * 255)));
  return out;
}

/** Peaks resampled to `bars` values 0..1 for drawing (a recording shown narrower or wider). */
export function barsFromPeaks(peaks: readonly number[] | null, bars: number): number[] {
  if (!peaks || peaks.length === 0) return new Array<number>(bars).fill(0);
  return Array.from({ length: bars }, (_, i) => {
    const v = peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / bars))] ?? 0;
    return Math.max(0, Math.min(1, v / 255));
  });
}

/** "0:07", "1:05", "10:00", "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** For screen readers: "1 минута 5 секунд", "7 секунд". */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (m > 0) parts.push(t.voice.minutes(m));
  if (s > 0 || m === 0) parts.push(t.voice.seconds(s));
  return parts.join(' ');
}

export const SPEEDS: readonly number[] = [1, 1.5, 2];

/** 1 → 1.5 → 2 → 1. */
export function nextSpeed(speed: number): number {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length]!;
}

/** "1x", "1,5x", "2x". */
export function speedLabel(speed: number): string {
  return `${String(speed).replace('.', ',')}x`;
}

/** Whether this browser says it can play the voice message's type (`HTMLMediaElement.canPlayType`). */
export function canPlayVoice(mime: string, canPlayType: (type: string) => string): boolean {
  try {
    return canPlayType(mime) !== '';
  } catch {
    return false;
  }
}

/** Seek position (ms) for a fraction 0..1 of the waveform. */
export function seekTo(fraction: number, durationMs: number): number {
  return Math.round(Math.max(0, Math.min(1, fraction)) * Math.max(0, durationMs));
}

// ---- recorder state machine ----

export type RecordMode = 'hold' | 'locked';

export type RecorderState =
  | { readonly kind: 'idle' }
  /** Waiting for the microphone (the permission prompt may be open). */
  | { readonly kind: 'starting'; readonly mode: RecordMode; readonly pressedAt: number }
  | { readonly kind: 'recording'; readonly mode: RecordMode; readonly startedAt: number; readonly slide: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' };

export type RecorderEvent =
  /** `touch`: a finger or pen (hold to record); `click`: mouse, keyboard or screen reader (records locked). */
  | { readonly type: 'press'; readonly at: number; readonly via: 'touch' | 'click' }
  | { readonly type: 'release'; readonly at: number }
  /** Finger movement since the press, px (negative: left / up). */
  | { readonly type: 'move'; readonly dx: number; readonly dy: number }
  | { readonly type: 'ready'; readonly at: number }
  | { readonly type: 'denied' }
  | { readonly type: 'unsupported' }
  | { readonly type: 'failed' }
  | { readonly type: 'send'; readonly at: number }
  | { readonly type: 'cancel' }
  | { readonly type: 'lock' }
  | { readonly type: 'tick'; readonly at: number }
  | { readonly type: 'dismiss' };

/**
 * What the component does after a step: open the microphone, send the
 * recording, drop it, or drop it because it was too short.
 */
export type RecorderEffect = 'open-mic' | 'send' | 'discard' | 'too-short' | null;

export interface RecorderStep {
  readonly state: RecorderState;
  readonly effect: RecorderEffect;
}

const IDLE: RecorderState = { kind: 'idle' };
const stay = (state: RecorderState): RecorderStep => ({ state, effect: null });

function finish(startedAt: number, at: number): RecorderStep {
  return { state: IDLE, effect: at - startedAt < MIN_VOICE_MS ? 'too-short' : 'send' };
}

export function recorderStep(s: RecorderState, e: RecorderEvent): RecorderStep {
  switch (s.kind) {
    case 'idle':
    case 'denied':
    case 'unsupported':
    case 'failed':
      if (e.type === 'press') {
        return { state: { kind: 'starting', mode: e.via === 'touch' ? 'hold' : 'locked', pressedAt: e.at }, effect: 'open-mic' };
      }
      if (e.type === 'dismiss' && s.kind !== 'idle') return stay(IDLE);
      return stay(s);

    case 'starting':
      switch (e.type) {
        case 'ready':
          return stay({ kind: 'recording', mode: s.mode, startedAt: e.at, slide: 0 });
        // Released before the microphone was ready (a tap, or the permission prompt took the
        // gesture): keep recording, locked, so nothing is lost and nothing is sent by surprise.
        case 'release':
          return stay({ ...s, mode: 'locked' });
        case 'move':
          if (s.mode === 'hold' && e.dx <= -CANCEL_SLIDE_PX) return { state: IDLE, effect: 'discard' };
          return stay(s);
        case 'cancel':
          return { state: IDLE, effect: 'discard' };
        case 'denied':
          return stay({ kind: 'denied' });
        case 'unsupported':
          return stay({ kind: 'unsupported' });
        case 'failed':
          return stay({ kind: 'failed' });
        default:
          return stay(s);
      }

    case 'recording':
      switch (e.type) {
        case 'move':
          if (s.mode !== 'hold') return stay(s);
          if (e.dx <= -CANCEL_SLIDE_PX) return { state: IDLE, effect: 'discard' };
          if (e.dy <= -LOCK_SLIDE_PX) return stay({ ...s, mode: 'locked', slide: 0 });
          return stay({ ...s, slide: Math.min(0, e.dx) });
        case 'release':
          if (s.mode === 'locked') return stay(s);
          // A quick tap right after the microphone opened: carry on, locked.
          if (e.at - s.startedAt < TAP_MS) return stay({ ...s, mode: 'locked', slide: 0 });
          return finish(s.startedAt, e.at);
        case 'lock':
          return stay({ ...s, mode: 'locked', slide: 0 });
        case 'send':
          return finish(s.startedAt, e.at);
        case 'cancel':
          return { state: IDLE, effect: 'discard' };
        case 'tick':
          return e.at - s.startedAt >= MAX_VOICE_MS ? { state: IDLE, effect: 'send' } : stay(s);
        case 'failed':
          return { state: { kind: 'failed' }, effect: 'discard' };
        default:
          return stay(s);
      }
  }
}

/** Time left before the limit, ms (for the "осталось 30 секунд" warning). */
export function timeLeft(s: RecorderState, now: number): number | null {
  return s.kind === 'recording' ? Math.max(0, MAX_VOICE_MS - (now - s.startedAt)) : null;
}
