/**
 * Lightweight piano-like instrument built from additive partials with a
 * hammer-style attack and pitch-dependent decay. No samples to download.
 *
 *   const piano = new Piano(audioContext);
 *   piano.play(60, { duration: 0.5 });   // Do4
 *   piano.noteOn(64); …; piano.noteOff(64);
 */
import { midiToFreq } from './notes.js';

// [harmonic, amplitude, detune in cents]
const PARTIALS = [
  [1, 1, 0],
  [2, 0.42, 1.5],
  [3, 0.2, -1],
  [4, 0.11, 2],
  [5, 0.05, 0],
];

export class Piano {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} [destination]
   * @param {{volume?: number}} [opts]
   */
  constructor(ctx, destination = ctx.destination, { volume = 0.5 } = {}) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = volume;
    this.output.connect(destination);
    this.voices = new Map(); // midi → voice currently held
    this.all = new Set();
  }

  set volume(v) {
    this.output.gain.value = v;
  }

  /** Starts a note; returns its voice. A note already sounding on that key is released. */
  noteOn(midi, { velocity = 0.8, when } = {}) {
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime);
    this.noteOff(midi, { when: t });
    const voice = this._voice(midi, t, velocity);
    this.voices.set(midi, voice);
    return voice;
  }

  noteOff(midi, { when } = {}) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);
    this._release(v, when ?? this.ctx.currentTime);
  }

  /** Plays a note of fixed duration (seconds), optionally in the future. */
  play(midi, { when, duration = 0.5, velocity = 0.8 } = {}) {
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime);
    const v = this._voice(midi, t, velocity);
    this._release(v, t + duration);
    return v;
  }

  /** Silences everything immediately. */
  stopAll() {
    const t = this.ctx.currentTime;
    for (const v of this.all) this._release(v, t, 0.02);
    this.voices.clear();
  }

  _voice(midi, when, velocity) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    const bright = Math.min(16000, f * (4 + 12 * velocity));
    filter.frequency.setValueAtTime(bright, when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(f * 1.8, 300), when + 1.2);

    // low notes ring longer than high notes
    const decay = Math.max(0.5, Math.min(3.2, 3.4 - (midi - 36) * 0.045));
    const peak = 0.22 * (0.35 + 0.65 * velocity);
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.004);
    amp.gain.setTargetAtTime(peak * 0.35, when + 0.004, 0.09); // quick initial drop (hammer)
    amp.gain.setTargetAtTime(0, when + 0.12, decay / 3);

    const oscs = PARTIALS.filter(([h]) => f * h < 18000).map(([h, a, cents]) => {
      const o = ctx.createOscillator();
      o.type = h === 1 ? 'triangle' : 'sine';
      o.frequency.value = f * h;
      o.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = a / (h === 1 ? 1 : 1 + (midi - 60) / 48); // fewer overtones up high
      o.connect(g).connect(filter);
      o.start(when);
      return o;
    });
    filter.connect(amp).connect(this.output);

    const voice = { oscs, amp, end: when + decay * 2.5 };
    oscs.forEach((o) => o.stop(voice.end));
    oscs[0].onended = () => {
      this.all.delete(voice);
      amp.disconnect();
    };
    this.all.add(voice);
    return voice;
  }

  _release(v, when, time = 0.09) {
    if (when >= v.end) return;
    v.amp.gain.cancelScheduledValues(when);
    v.amp.gain.setTargetAtTime(0, when, time);
    const stop = when + time * 6;
    if (stop < v.end) {
      v.end = stop;
      v.oscs.forEach((o) => {
        try {
          o.stop(stop);
        } catch { /* already stopped */ }
      });
    }
  }
}
