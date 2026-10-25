/**
 * Real-time monophonic pitch detection (YIN) from the microphone or any AudioNode.
 * Usable on its own, e.g. for "sing this note" flashcards:
 *
 *   const det = new PitchDetector();
 *   det.on('pitch', (p) => console.log(p?.name, p?.cents));
 *   await det.start();          // asks for the microphone
 */
import { Emitter } from './emitter.js';
import { freqToMidi, midiToName } from './notes.js';

/**
 * YIN fundamental frequency estimator (de Cheveigné & Kawahara, 2002).
 * @param {Float32Array} buf time-domain samples
 * @returns {{freq: number, clarity: number} | null}
 */
export function yin(buf, sampleRate, { threshold = 0.12, minFreq = 65, maxFreq = 1100 } = {}) {
  const w = Math.floor(buf.length / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(w - 1, Math.ceil(sampleRate / minFreq));
  const d = new Float32Array(tauMax + 2);

  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // cumulative mean normalized difference
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau];
    d[tau] = running ? (d[tau] * tau) / running : 1;
  }

  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;

  // parabolic interpolation for sub-sample precision
  const a = d[tau - 1];
  const b = d[tau];
  const c = d[tau + 1];
  const denom = a + c - 2 * b;
  const shift = denom ? (a - c) / (2 * denom) : 0;
  return { freq: sampleRate / (tau + shift), clarity: 1 - b };
}

/**
 * Opens the microphone for singing: no automatic gain or noise suppression.
 * @param {{echoCancellation?: boolean}} [opts]
 * @returns {Promise<MediaStream>}
 */
export function openMicrophone({ echoCancellation = false } = {}) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation, noiseSuppression: false, autoGainControl: false },
  });
}

export class PitchDetector extends Emitter {
  /**
   * @param {object} [opts]
   * @param {AudioContext} [opts.audioContext]
   * @param {number} [opts.minFreq=65]  Hz, lowest pitch (C2)
   * @param {number} [opts.maxFreq=1100] Hz, highest pitch (C#6)
   * @param {number} [opts.threshold=0.12] YIN threshold; lower is stricter
   * @param {number} [opts.minVolume=0.01] RMS gate, below it nothing is detected
   * @param {number} [opts.bufferSize=2048]
   * @param {'english'|'solfege'} [opts.notation='solfege'] for the `name` field
   */
  constructor(opts = {}) {
    super();
    this.options = { minFreq: 65, maxFreq: 1100, threshold: 0.12, minVolume: 0.01, bufferSize: 2048, notation: 'solfege', ...opts };
    this.audioContext = opts.audioContext ?? null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this._buf = null;
    this._history = [];
    this._raf = 0;
    this.last = null;
    this.volume = 0; // RMS of the last frame read, even when no pitch was found
  }

  get running() {
    return !!this.analyser;
  }

  /**
   * Starts listening.
   * @param {object} [opts]
   * @param {MediaStream|AudioNode} [opts.input] defaults to the microphone
   * @param {boolean} [opts.loop=true] emit 'pitch' every animation frame; set false and call read() yourself
   * @param {boolean} [opts.echoCancellation=false] when opening the microphone: remove what the speaker plays
   *   (useful without headphones; noise suppression stays off because it mutes sustained sung notes)
   */
  async start({ input, loop = true, echoCancellation = false } = {}) {
    if (this.running) this.stop();
    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    const ctx = this.audioContext;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this.options.bufferSize;
    this._buf = new Float32Array(this.analyser.fftSize);

    if (input instanceof AudioNode) {
      this.source = input;
    } else {
      this._ownStream = !input; // a stream passed in belongs to the caller, who stops it
      this.stream = input ?? (await openMicrophone({ echoCancellation }));
      this.source = ctx.createMediaStreamSource(this.stream);
    }
    this.source.connect(this.analyser);

    if (loop) {
      const tick = () => {
        this.emit('pitch', this.read());
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    this.emit('start');
  }

  stop() {
    cancelAnimationFrame(this._raf);
    try {
      this.source?.disconnect(this.analyser);
    } catch { /* already disconnected */ }
    if (this._ownStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.analyser = this.stream = this.source = null;
    this._history = [];
    this.emit('stop');
  }

  /**
   * Analyses the latest audio.
   * @returns {null | {freq, midi, note, name, cents, clarity, volume}}
   *   midi is fractional (60.3 = 30 cents above C4); note is the nearest integer note.
   */
  read() {
    if (!this.analyser) return null;
    const buf = this._buf;
    this.analyser.getFloatTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    this.volume = rms;

    const res = rms >= this.options.minVolume ? yin(buf, this.audioContext.sampleRate, this.options) : null;
    if (!res || res.freq < this.options.minFreq || res.freq > this.options.maxFreq) {
      this._history = [];
      this.last = null;
      return null;
    }

    // median of the last 3 estimates removes single-frame octave glitches
    const h = this._history;
    h.push(freqToMidi(res.freq));
    if (h.length > 3) h.shift();
    const midi = h.length === 3 ? [...h].sort((a, b) => a - b)[1] : h[h.length - 1];
    const note = Math.round(midi);
    this.last = {
      freq: 440 * 2 ** ((midi - 69) / 12),
      midi,
      note,
      name: midiToName(note, { notation: this.options.notation }),
      cents: Math.round((midi - note) * 100),
      clarity: res.clarity,
      volume: rms,
    };
    return this.last;
  }
}
