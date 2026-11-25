/**
 * Tiny Web Audio synth that plays the guide melody and the MIDI accompaniment with an organ
 * sound that holds every note to its end, using a look-ahead scheduler, so it follows pause, seek, speed and transpose.
 */
import { Organ } from './organ.js';
import { legatoGroups } from './song.js';

const LOOKAHEAD = 0.35; // seconds of song scheduled in advance

/**
 * Seconds between a sample being rendered (ctx.currentTime) and it reaching the speaker.
 * Small on desktop; on Android it can exceed 0.1 s, so visuals must lag by this much.
 */
export function outputDelay(ctx) {
  return (ctx?.outputLatency || 0) + (ctx?.baseLatency || 0);
}

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
    this.organ = new Organ(ctx, this.guide, { volume: 2.4 });
    this.backingOrgan = new Organ(ctx, this.backing, { volume: 1.6 });
    this.events = [];
    this.cursor = 0;
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
    this.organ.stopAll();
    this.backingOrgan.stopAll();
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
    const organ = e.bus === 'backing' ? this.backingOrgan : this.organ;
    organ.play(e.midi + transpose, { when, duration: dur, velocity: e.velocity ?? 0.8 });
  }
}
