/**
 * Tiny Web Audio synth that plays the guide melody and the MIDI accompaniment with an organ
 * sound that holds every note to its end, using a look-ahead scheduler, so it follows pause, seek, speed and transpose.
 */
import { Organ } from './organ.js';
import { legatoGroups } from './song.js';

const LOOKAHEAD = 0.35; // seconds of song scheduled in advance

/**
 * Seconds between a sample being rendered (ctx.currentTime) and it reaching the ears.
 * Small on desktop; on Android it can exceed 0.1 s, and with Bluetooth headphones 0.2–0.3 s,
 * so visuals must lag by this much. Uses the larger of the reported latency and the one
 * measured from getOutputTimestamp() (which on many phones includes the Bluetooth delay),
 * smoothed so the playhead does not jitter.
 */
const measured = new WeakMap(); // ctx → { value, t }
export function outputDelay(ctx) {
  if (!ctx) return 0;
  const reported = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  let m = measured.get(ctx);
  const now = performance.now();
  if (ctx.state === 'running' && ctx.getOutputTimestamp && (!m || now - m.t > 250)) {
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime > 0 && ts.performanceTime > 0) {
      // muestra que suena ahora mismo = la que sonaba en performanceTime + lo transcurrido desde entonces
      const playing = ts.contextTime + (now - ts.performanceTime) / 1000;
      const lag = ctx.currentTime - playing;
      if (lag >= 0 && lag < 0.8) {
        const prev = m?.value ?? lag;
        m = { value: prev + (lag - prev) * 0.2, t: now };
        measured.set(ctx, m);
      }
    }
  }
  return Math.max(reported, m?.value ?? 0);
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
