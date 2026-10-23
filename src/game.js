/**
 * Entona: the karaoke practice game. Glues together the song, the synth,
 * the pitch detector, the scorer and the renderer.
 *
 *   const game = new Entona(canvas, { difficulty: 'normal' });
 *   game.load(await loadSong('cancion.mid'));
 *   await game.start();            // asks for the microphone
 *   game.on('end', (result) => console.log(result.grade, result.score));
 */
import { Emitter } from './emitter.js';
import { PitchDetector } from './pitch-detector.js';
import { Scorer, DIFFICULTIES } from './scorer.js';
import { Synth } from './synth.js';
import { Renderer } from './renderer.js';

const DEFAULTS = {
  difficulty: 'normal',   // 'facil' | 'normal' | 'dificil'
  tolerance: null,        // cents; overrides difficulty
  octaveTolerant: true,   // the right note in another octave counts
  transpose: 0,           // semitones
  speed: 1,               // 0.5 .. 1.5, practice slower
  latency: 0.06,          // seconds the microphone lags behind the song
  guideVolume: 0.35,      // guide melody, 0 to mute
  accompanimentVolume: 0.18,
  leadIn: 3,              // seconds of countdown before the first note
  streakStep: 2,          // seconds in tune per streak level
};

export class Entona extends Emitter {
  /**
   * @param {HTMLCanvasElement|null} canvas null to run without graphics
   * @param {object} [opts] see DEFAULTS, plus renderer options (pixelsPerSecond, theme, labels, notation…)
   *   and `audioContext` to share one with your app.
   */
  constructor(canvas, opts = {}) {
    super();
    this.options = { ...DEFAULTS, ...opts };
    this.renderer = canvas ? new Renderer(canvas, opts) : null;
    this.audioContext = opts.audioContext ?? null;
    this.song = null;
    this.scorer = null;
    this.synth = null;
    this.detector = null;
    this.state = 'idle';
    this.result = null;
    this.loopRange = null;
    this.pitch = null;
    this._time = 0;
    this._raf = 0;
    this._lastFrame = 0;
    if (canvas) canvas.addEventListener('pointerdown', (e) => this._onPointer(e));
    this._drawIdle();
  }

  /** Loads a finalized song (from loadSong). */
  load(song) {
    this.stop();
    this.song = song;
    this.result = null;
    this._time = Math.min(0, (song.notes[0]?.start ?? 0) - this.options.leadIn);
    this.scorer = new Scorer(song, this._scorerOptions());
    this.scorer.on('note', (e) => {
      this.renderer?.onNote(e);
      this.emit('note', e);
    });
    this.scorer.on('streak', (e) => {
      this.renderer?.onStreak(e);
      this.emit('streak', e);
    });
    this.scorer.on('score', (e) => this.emit('score', e));
    this.renderer?.setSong(song, this.options.transpose);
    this.synth?.setSong(song);
    this.emit('load', song);
    this._drawIdle();
  }

  _scorerOptions() {
    const o = this.options;
    return {
      tolerance: o.tolerance ?? DIFFICULTIES[o.difficulty]?.tolerance ?? 55,
      octaveTolerant: o.octaveTolerant,
      transpose: o.transpose,
      streakStep: o.streakStep,
    };
  }

  /**
   * Starts (or restarts) the song.
   * @param {object} [opts]
   * @param {'mic'|'demo'|MediaStream|AudioNode} [opts.input='mic']
   *   'demo' sings itself: the guide melody is fed to the detector (handy to try the game).
   * @param {number} [opts.from] song time to start at
   */
  async start({ input = 'mic', from } = {}) {
    if (!this.song) throw new Error('Carga una canción antes de empezar');
    this.audioContext ??= new AudioContext();
    const ctx = this.audioContext;
    if (ctx.state === 'suspended') await ctx.resume();

    if (!this.synth) {
      this.synth = new Synth(ctx);
      this._applyVolumes();
    }
    this.synth.setSong(this.song);

    const demo = input === 'demo';
    if (!this.detector || this._input !== input) {
      this.detector?.stop();
      this.detector = new PitchDetector({ audioContext: ctx });
      await this.detector.start({ input: demo ? this.synth.guide : input === 'mic' ? undefined : input, loop: false });
      this._input = input;
    }
    this._demo = demo;
    this._applyVolumes();

    this.result = null;
    this.renderer?.clearEffects();
    const first = this.song.notes[0]?.start ?? 0;
    const t = from ?? Math.min(0, first - this.options.leadIn);
    this.scorer.reset(t <= first ? -Infinity : t);
    this.state = 'playing';
    this._seekClock(t);
    this.emit('start', { time: t });
    this._loop();
  }

  pause() {
    if (this.state !== 'playing') return;
    this._time = this.currentTime;
    this.state = 'paused';
    this.synth?.reset(this._time);
    this.emit('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this._seekClock(this._time);
    this.emit('resume');
  }

  togglePause() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  /** Stops the song and releases the microphone. */
  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.synth?.reset(Infinity);
    this.detector?.stop();
    this.detector = null;
    this._input = null;
    if (this.state !== 'idle') this.emit('stop');
    this.state = 'idle';
  }

  /** Jumps to a song time (seconds). Notes after it are scored again. */
  seek(time) {
    if (!this.song) return;
    const t = Math.max(Math.min(0, (this.song.notes[0]?.start ?? 0) - 1), Math.min(time, this.song.duration));
    this.scorer.reset(t);
    this.renderer?.clearEffects();
    this._time = t;
    if (this.state === 'ended') this.state = 'paused';
    if (this.state === 'playing') this._seekClock(t);
    this.emit('seek', { time: t });
    if (this.state !== 'playing') this._drawFrame(0);
  }

  /** Repeats a section while practicing. Pass null to disable. */
  setLoop(start, end) {
    this.loopRange = start == null ? null : [Math.max(0, start), Math.min(end, this.song?.duration ?? end)];
    if (this.loopRange && (this.currentTime < this.loopRange[0] || this.currentTime > this.loopRange[1])) this.seek(this.loopRange[0]);
  }

  /** Changes options on the fly: difficulty, tolerance, transpose, speed, volumes, latency… */
  set(opts) {
    const speedChanged = 'speed' in opts && opts.speed !== this.options.speed;
    const now = this.currentTime;
    Object.assign(this.options, opts);
    this.scorer?.setOptions(this._scorerOptions());
    if (this.renderer && 'transpose' in opts) this.renderer.transpose = this.options.transpose;
    this._applyVolumes();
    if (this.state === 'playing' && (speedChanged || 'transpose' in opts)) this._seekClock(now);
    if (this.state !== 'playing') this._drawFrame(0);
  }

  /** Current song time in seconds. */
  get currentTime() {
    if (this.state !== 'playing' || !this.audioContext) return this._time;
    return this._clockOffset + (this.audioContext.currentTime - this._clockStart) * this.options.speed;
  }

  destroy() {
    this.stop();
    this.renderer?.destroy();
  }

  // ---- internals ---------------------------------------------------------

  _applyVolumes() {
    if (!this.synth) return;
    const o = this.options;
    this.synth.guide.gain.value = this._demo ? Math.max(o.guideVolume, 0.3) : o.guideVolume;
    this.synth.backing.gain.value = o.accompanimentVolume;
  }

  _seekClock(t) {
    this._clockOffset = t;
    this._clockStart = this.audioContext.currentTime;
    this._time = t;
    this.synth.reset(t);
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    this._lastFrame = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - this._lastFrame) / 1000);
      this._lastFrame = now;
      this._tick(dt);
      if (this.state !== 'idle') this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  _tick(dt) {
    const o = this.options;
    const reading = this.detector?.read() ?? null;
    let t = this.currentTime;

    if (this.state === 'playing') {
      if (this.loopRange && t >= this.loopRange[1]) {
        this.seek(this.loopRange[0]);
        t = this.currentTime;
      }
      this.synth.schedule(t, (st) => this._clockStart + (st - this._clockOffset) / o.speed, o);
      const latency = this._demo ? 0.03 : o.latency;
      const res = this.scorer.update(t - latency * o.speed, reading?.midi ?? null);
      this.pitch = { ...reading, midi: res.midi, hit: res.hit, cents: res.cents, note: res.note };
      this.emit('frame', { time: t, pitch: this.pitch });
      if (t > this.song.duration + 0.6) this._end();
    } else {
      const ref = this.scorer?.nearestNote(t);
      const midi = reading && ref ? this.scorer.fold(reading.midi, this.scorer.target(ref)) : reading?.midi ?? null;
      this.pitch = reading ? { ...reading, midi, hit: false } : null;
    }
    this._drawFrame(dt);
  }

  _end() {
    this._time = this.song.duration;
    this.state = 'ended';
    this.synth.reset(Infinity);
    this.result = this.scorer.result();
    this.renderer?.burst(this.renderer.width / 2, this.renderer.height * 0.35, 20 + this.result.stars * 12, 1.4);
    this.emit('end', this.result);
  }

  _drawFrame(dt) {
    this.renderer?.draw({
      time: this.state === 'playing' ? this.currentTime : this._time,
      dt,
      scorer: this.scorer,
      pitch: this.pitch,
      state: this.state,
      result: this.result,
      loop: this.loopRange,
    });
  }

  _drawIdle() {
    if (this.renderer) requestAnimationFrame(() => this._drawFrame(0));
  }

  _onPointer(e) {
    if (!this.renderer || !this.song) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = this.renderer.progressTimeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (t != null) this.seek(t);
  }
}
