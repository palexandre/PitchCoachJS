/**
 * Tiny Web Audio synth that plays the guide melody and the MIDI accompaniment
 * with a look-ahead scheduler, so it follows pause, seek, speed and transpose.
 */
import { midiToFreq } from './notes.js';

const LOOKAHEAD = 0.35; // seconds of song scheduled in advance

export class Synth {
  constructor(ctx, destination = ctx.destination) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(destination);
    this.guide = ctx.createGain();
    this.guide.gain.value = 0.35;
    this.guide.connect(this.master);
    this.backing = ctx.createGain();
    this.backing.gain.value = 0.18;
    this.backing.connect(this.master);
    this.events = [];
    this.cursor = 0;
    this.voices = new Set();
  }

  setSong(song) {
    this.events = [
      ...song.notes.map((n) => ({ ...n, bus: 'guide' })),
      ...song.accompaniment.map((n) => ({ ...n, bus: 'backing' })),
    ].sort((a, b) => a.start - b.start);
    this.cursor = 0;
  }

  /** Silences everything and moves the scheduler to `songTime`. */
  reset(songTime) {
    for (const v of this.voices) {
      try {
        v.stop();
      } catch { /* not started */ }
    }
    this.voices.clear();
    this.cursor = this.events.findIndex((e) => e.start >= songTime);
    if (this.cursor < 0) this.cursor = this.events.length;
  }

  /**
   * Schedules upcoming notes.
   * @param {number} songTime current song time
   * @param {(t: number) => number} toCtxTime song time → AudioContext time
   * @param {{speed: number, transpose: number}} opts
   */
  schedule(songTime, toCtxTime, { speed, transpose }) {
    while (this.cursor < this.events.length && this.events[this.cursor].start < songTime + LOOKAHEAD * speed) {
      const e = this.events[this.cursor++];
      if (e.start < songTime - 0.05) continue;
      this._play(e, toCtxTime(e.start), (e.end - e.start) / speed, transpose);
    }
  }

  _play(e, when, dur, transpose) {
    const ctx = this.ctx;
    const guide = e.bus === 'guide';
    const osc = ctx.createOscillator();
    osc.type = guide ? 'triangle' : 'sine';
    osc.frequency.value = midiToFreq(e.midi + transpose);
    const g = ctx.createGain();
    const peak = guide ? 0.6 : 0.25 + 0.35 * (e.velocity ?? 0.7);
    const attack = 0.015;
    const release = Math.min(0.08, dur / 3);
    when = Math.max(when, ctx.currentTime);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak * (guide ? 0.85 : 0.6), Math.max(when + attack, when + dur - release));
    g.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(g).connect(guide ? this.guide : this.backing);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    this.voices.add(osc);
    osc.onended = () => {
      this.voices.delete(osc);
      g.disconnect();
    };
  }
}
