/**
 * Small pipe-organ style voice: additive drawbars (8', 4', 2 2/3', 2'…) that hold the note
 * at full level for as long as it lasts, with a short attack and release like a real organ.
 * Same interface as Piano, so either can be used wherever a melody is played.
 */
import { midiToFreq } from './notes.js';

// [harmonic, level]: 8' fundamental dominant, so pitch detection on the guide stays solid
const STOPS = [[1, 1], [2, 0.45], [3, 0.16], [4, 0.2], [6, 0.06], [8, 0.07]];
const ATTACK = 0.035;
const RELEASE = 0.09;

export class Organ {
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

  /** Starts a note that sounds until noteOff. A note already sounding on that key is released. */
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
    this._release(v, Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime));
  }

  /** Plays a note held for exactly `duration` seconds, optionally in the future. */
  play(midi, { when, duration = 0.5, velocity = 0.8 } = {}) {
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime);
    const v = this._voice(midi, t, velocity);
    this._release(v, t + Math.max(duration - RELEASE * 0.5, ATTACK));
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
    const level = 0.2 * (0.5 + 0.5 * velocity);
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(level, when + ATTACK);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(12000, f * 10);
    filter.Q.value = 0.5;
    const oscs = STOPS.filter(([h]) => f * h < 16000).map(([h, a]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * h;
      const g = ctx.createGain();
      g.gain.value = a;
      o.connect(g).connect(filter);
      o.start(when);
      return o;
    });
    filter.connect(amp).connect(this.output);
    const voice = { oscs, amp, level, start: when, end: Infinity };
    oscs[0].onended = () => {
      this.all.delete(voice);
      amp.disconnect();
    };
    this.all.add(voice);
    return voice;
  }

  _release(v, when, time = RELEASE) {
    if (when >= v.end) return;
    const g = v.amp.gain;
    if (when - v.start >= ATTACK) {
      g.cancelScheduledValues(when);
      g.setValueAtTime(v.level, when);
    } else if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(when);
    else g.cancelScheduledValues(when);
    g.setTargetAtTime(0, when, time / 3);
    v.end = when + time * 2;
    v.oscs.forEach((o) => {
      try {
        o.stop(v.end);
      } catch { /* already stopped */ }
    });
  }
}
