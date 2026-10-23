/**
 * Sample-accurate metronome (Web Audio look-ahead scheduling).
 *
 *   const m = new Metronome(ctx);
 *   m.start({ bpm: 90, onBeat: ({ beat, bar, accent, when }) => … });
 *   m.stop();
 */
export class Metronome {
  constructor(ctx, destination = ctx.destination, { volume = 0.5 } = {}) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = volume;
    this.output.connect(destination);
    this._timer = 0;
    this.running = false;
  }

  set volume(v) {
    this.output.gain.value = v;
  }

  /** A single click, accented ones are higher. */
  click(when = this.ctx.currentTime, accent = false) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g).connect(this.output);
    o.start(when);
    o.stop(when + 0.06);
  }

  /**
   * @param {object} opts
   * @param {number} opts.bpm
   * @param {number} [opts.beatsPerBar=4]
   * @param {number} [opts.when] AudioContext time of beat 0 (default: now)
   * @param {boolean} [opts.audible=true] false keeps the beat callbacks but no sound
   * @param {number} [opts.firstBeat=0] song beat of the first click, so accents fall on bar lines
   * @param {(e: {beat: number, bar: number, accent: boolean, when: number}) => void} [opts.onBeat]
   *   called roughly when each beat sounds
   */
  start({ bpm, beatsPerBar = 4, when, audible = true, firstBeat = 0, onBeat } = {}) {
    this.stop();
    this.running = true;
    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
    this.startTime = when ?? this.ctx.currentTime + 0.05;
    this.audible = audible;
    let beat = 0;
    const spb = 60 / bpm;
    const schedule = () => {
      const horizon = this.ctx.currentTime + 0.15;
      while (this.startTime + beat * spb < horizon) {
        const t = this.startTime + beat * spb;
        const accent = (((beat + firstBeat) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        if (this.audible) this.click(t, accent);
        if (onBeat) {
          const e = { beat: beat + firstBeat, bar: Math.floor((beat + firstBeat) / beatsPerBar), accent, when: t };
          setTimeout(() => this.running && onBeat(e), Math.max(0, (t - this.ctx.currentTime) * 1000));
        }
        beat++;
      }
    };
    schedule();
    this._timer = setInterval(schedule, 25);
  }

  stop() {
    clearInterval(this._timer);
    this.running = false;
  }
}
