/**
 * Tiny Web Audio synth that plays the guide melody (clear triangle wave, easy to
 * follow) and the MIDI accompaniment (piano) with a look-ahead scheduler, so it follows pause, seek, speed and transpose.
 */
import { midiToFreq } from './notes.js';
import { Piano } from './piano.js';
import { legatoGroups } from './song.js';

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
    this.piano = new Piano(ctx, this.backing, { volume: 1.6 });
    this.events = [];
    this.cursor = 0;
    this.voices = new Set();
  }

  setSong(song) {
    this.events = [
      // sílabas seguidas a la misma altura suenan como una sola nota, sin cortes
      ...legatoGroups(song.notes).map((n) => ({ ...n, bus: 'guide' })),
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
    this.piano.stopAll();
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
    if (e.bus === 'backing') {
      this.piano.play(e.midi + transpose, { when, duration: dur, velocity: e.velocity ?? 0.7 });
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(e.midi + transpose);
    const g = ctx.createGain();
    const peak = 0.6;
    const attack = 0.015;
    const release = Math.min(0.08, dur / 3);
    when = Math.max(when, ctx.currentTime);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak * 0.85, Math.max(when + attack, when + dur - release));
    g.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(g).connect(this.guide);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    this.voices.add(osc);
    osc.onended = () => {
      this.voices.delete(osc);
      g.disconnect();
    };
  }
}
