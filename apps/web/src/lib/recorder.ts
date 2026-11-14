// The browser part of voice recording: the microphone, MediaRecorder and a
// loudness meter for the live waveform. The recording stays in memory (ten
// minutes of speech are a few megabytes); the core copies it into app
// storage like any attachment.

import { peaksFromLevels, RECORDER_TYPES, voiceMime, type VoiceMime } from './voice.ts';

export interface VoiceRecording {
  readonly blob: Blob;
  readonly mime: VoiceMime;
  readonly durationMs: number;
  readonly peaks: number[];
}

export type MicProblem = 'denied' | 'unsupported' | 'failed';

export class MicError extends Error {
  override readonly name = 'MicError';
  constructor(readonly problem: MicProblem) {
    super(problem);
  }
}

/** Loudness samples per second for the waveform. */
const LEVEL_HZ = 20;

export class MicRecorder {
  readonly #stream: MediaStream;
  #recorder: MediaRecorder;
  /** Formats still to try if the current one fails to start. */
  readonly #fallbacks: string[];
  readonly #chunks: Blob[] = [];
  readonly #levels: number[] = [];
  #audio: AudioContext | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #startedAt = 0;
  #stopped: Promise<void> = Promise.resolve();
  #done = false;
  #failed = false;

  private constructor(stream: MediaStream, types: string[], onLevel: (level: number) => void) {
    this.#stream = stream;
    this.#fallbacks = types.slice(1);
    this.#recorder = this.#start(types[0]!);
    this.#meter(onLevel);
  }

  /**
   * Starts a MediaRecorder. Some browsers claim a format they cannot encode
   * (Chromium builds without AAC say yes to "audio/mp4;codecs=mp4a.40.2" and
   * then fail with "Encoder initialization failed"): such an error before
   * any data switches to the next format.
   */
  #start(type: string): MediaRecorder {
    const r = new MediaRecorder(this.#stream, { mimeType: type, audioBitsPerSecond: 48_000 });
    r.ondataavailable = (e) => {
      if (r === this.#recorder && e.data.size > 0) this.#chunks.push(e.data);
    };
    r.onerror = () => {
      if (r !== this.#recorder) return;
      const next = this.#fallbacks.shift();
      if (this.#chunks.length === 0 && next && !this.#done) {
        try {
          this.#recorder = this.#start(next);
          return;
        } catch {
          // Fall through: failed.
        }
      }
      this.#failed = true;
    };
    this.#stopped = new Promise((resolve) => r.addEventListener('stop', () => resolve(), { once: true }));
    r.start(1000);
    this.#startedAt ||= performance.now();
    return r;
  }

  /** Asks for the microphone and starts recording. Throws MicError. */
  static async open(onLevel: (level: number) => void): Promise<MicRecorder> {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported');
    const types = RECORDER_TYPES.filter((t) => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    });
    if (types.length === 0) throw new MicError('unsupported');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new MicError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
    }
    try {
      return new MicRecorder(stream, types, onLevel);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      throw new MicError('failed');
    }
  }

  #meter(onLevel: (level: number) => void): void {
    try {
      const audio = new AudioContext();
      this.#audio = audio;
      void audio.resume().catch(() => undefined);
      const source = audio.createMediaStreamSource(this.#stream);
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this.#timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        // RMS of speech is around 0.05-0.3; scaled so that normal speech fills most of the height.
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        this.#levels.push(level);
        onLevel(level);
      }, 1000 / LEVEL_HZ);
    } catch {
      // No meter (no Web Audio): the recording still works, the waveform stays flat.
    }
  }

  /** Milliseconds recorded so far. */
  elapsed(): number {
    return this.#startedAt ? performance.now() - this.#startedAt : 0;
  }

  /** The recorder broke (no format could be encoded, or the device went away). */
  get failed(): boolean {
    return this.#failed;
  }

  #release(): void {
    clearInterval(this.#timer);
    for (const t of this.#stream.getTracks()) t.stop();
    void this.#audio?.close().catch(() => undefined);
  }

  /** Stops and returns the recording. */
  async stop(): Promise<VoiceRecording> {
    if (this.#done) throw new MicError('failed');
    this.#done = true;
    const durationMs = Math.round(this.elapsed());
    const r = this.#recorder;
    if (r.state !== 'inactive') r.stop();
    await this.#stopped;
    this.#release();
    const mime = voiceMime(r.mimeType || 'audio/mp4');
    const blob = new Blob(this.#chunks, { type: mime });
    if (blob.size === 0) throw new MicError('failed');
    return { blob, mime, durationMs, peaks: peaksFromLevels(this.#levels) };
  }

  /** Stops and drops the recording. */
  discard(): void {
    if (this.#done) return;
    this.#done = true;
    try {
      if (this.#recorder.state !== 'inactive') this.#recorder.stop();
    } catch {
      // Already stopped.
    }
    this.#release();
    this.#chunks.length = 0;
  }
}
