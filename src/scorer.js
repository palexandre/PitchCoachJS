/**
 * Turns a stream of detected pitches into points, combos, streaks and a final grade.
 * Independent from audio and rendering, so it can be unit-tested or reused.
 *
 * Events:
 *   'note'   { note, rating: 'perfect'|'great'|'good'|'miss', accuracy, points, combo, multiplier }
 *   'streak' { seconds, level }            every `streakStep` seconds singing in tune without breaks
 *   'score'  { score, combo, multiplier, percent }
 */
import { Emitter } from './emitter.js';

export const DIFFICULTIES = {
  facil: { tolerance: 100 },
  normal: { tolerance: 55 },
  dificil: { tolerance: 30 },
};

const RATINGS = [
  ['perfect', 0.85],
  ['great', 0.6],
  ['good', 0.3],
];

const GRACE = 0.2; // seconds without voice that don't break a streak (consonants, breathing)

export class Scorer extends Emitter {
  /**
   * @param {object} song finalized song
   * @param {object} [opts]
   * @param {number} [opts.tolerance=55] cents of allowed deviation
   * @param {boolean} [opts.octaveTolerant=true] accept the right note in any octave
   * @param {number} [opts.transpose=0] semitones added to every target note
   * @param {number} [opts.streakStep=2] seconds of continuous singing per streak level
   */
  constructor(song, opts = {}) {
    super();
    this.song = song;
    this.options = { tolerance: 55, octaveTolerant: true, transpose: 0, streakStep: 2, ...opts };
    this.reset(0);
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
  }

  /** Forgets every note that ends after `time` (used on start and seek). */
  reset(time = 0) {
    this.states ??= [];
    this.song.notes.forEach((n, i) => {
      if (!this.states[i] || n.end > time) {
        this.states[i] = { hit: 0, elapsed: 0, segments: [], done: false, rating: null, accuracy: 0, points: 0 };
      }
    });
    this.combo = 0;
    this.maxCombo = time > 0 ? (this.maxCombo ?? 0) : 0;
    this.streak = 0;
    this._lastVoiced = -Infinity;
    this._cursor = 0;
    this._lastTime = time;
    this.score = this.states.reduce((sum, s) => sum + s.points, 0);
  }

  get multiplier() {
    const c = this.combo;
    return c >= 30 ? 4 : c >= 15 ? 3 : c >= 5 ? 2 : 1;
  }

  /** Target MIDI note (with transpose). */
  target(note) {
    return note.midi + this.options.transpose;
  }

  /** Maps a sung pitch to the octave closest to `target` when octaveTolerant is on. */
  fold(midi, target) {
    if (midi == null || !this.options.octaveTolerant) return midi;
    const diff = midi - target;
    return target + diff - 12 * Math.round(diff / 12);
  }

  /** Note being sung at `time`, or null. */
  activeNote(time) {
    const notes = this.song.notes;
    while (this._cursor > 0 && notes[this._cursor].start > time) this._cursor--;
    while (this._cursor < notes.length - 1 && notes[this._cursor].end <= time) this._cursor++;
    const n = notes[this._cursor];
    return n && n.start <= time && time < n.end ? n : null;
  }

  /** Closest note to `time`, used to fold the pitch indicator between notes. */
  nearestNote(time) {
    const active = this.activeNote(time);
    if (active) return active;
    const notes = this.song.notes;
    const i = this._cursor;
    const cands = [notes[i - 1], notes[i], notes[i + 1]].filter(Boolean);
    return cands.sort((a, b) => dist(a, time) - dist(b, time))[0] ?? null;
  }

  /**
   * Feeds one analysis frame.
   * @param {number} time song time (already latency compensated)
   * @param {number|null} midi detected (fractional) MIDI pitch, null if silent
   * @returns {{note, hit: boolean, midi: number|null, cents: number|null}}
   */
  update(time, midi) {
    const dt = Math.min(Math.max(time - this._lastTime, 0), 0.1);
    this._lastTime = time;
    this._finishUntil(time);

    const note = this.activeNote(time);
    const ref = note ?? this.nearestNote(time);
    const folded = ref ? this.fold(midi, this.target(ref)) : midi;
    let hit = false;
    let cents = null;

    if (midi != null) this._lastVoiced = time;

    if (note && !note.freestyle) {
      const st = this.states[note.index];
      st.elapsed += dt;
      if (folded != null) {
        cents = Math.round((folded - this.target(note)) * 100);
        hit = Math.abs(cents) <= this.options.tolerance;
      }
      if (hit) {
        st.hit += dt;
        const seg = st.segments[st.segments.length - 1];
        if (seg && time - seg[1] < 0.08) seg[1] = time;
        else st.segments.push([time - dt, time]);
        this._addStreak(dt);
      } else if (time - this._lastVoiced > GRACE || folded != null) {
        this.streak = 0;
      }
    }
    return { note, hit, midi: folded, cents };
  }

  _addStreak(dt) {
    const step = this.options.streakStep;
    const before = Math.floor(this.streak / step);
    this.streak += dt;
    const level = Math.floor(this.streak / step);
    if (level > before) this.emit('streak', { seconds: this.streak, level });
  }

  _finishUntil(time) {
    const notes = this.song.notes;
    for (let i = 0; i < notes.length && notes[i].start < time; i++) {
      if (notes[i].end <= time && !this.states[i].done) this._finish(notes[i]);
    }
  }

  _finish(note) {
    const st = this.states[note.index];
    st.done = true;
    if (note.freestyle) return;
    const dur = note.end - note.start;
    // a short onset is forgiven: 80% of the note in tune counts as 100%
    st.accuracy = Math.min(1, st.hit / (dur * 0.8));
    st.rating = (RATINGS.find(([, min]) => st.accuracy >= min) ?? ['miss'])[0];
    this.combo = st.rating === 'miss' ? 0 : this.combo + 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const weight = Math.max(0.5, Math.min(3, dur / this._avgDuration()));
    st.points = Math.round(st.accuracy * 100 * weight * (note.golden ? 2 : 1)) * this.multiplier;
    this.score += st.points;
    this.emit('note', { note, rating: st.rating, accuracy: st.accuracy, points: st.points, combo: this.combo, multiplier: this.multiplier });
    this.emit('score', { score: this.score, combo: this.combo, multiplier: this.multiplier, percent: this.percent() });
  }

  _avgDuration() {
    if (!this._avg) {
      const ns = this.song.notes;
      this._avg = ns.reduce((s, n) => s + n.end - n.start, 0) / Math.max(1, ns.length);
    }
    return this._avg;
  }

  /** Weighted accuracy (0..1) over the notes already finished. */
  percent(all = false) {
    let num = 0;
    let den = 0;
    this.song.notes.forEach((n, i) => {
      const st = this.states[i];
      if (n.freestyle || (!all && !st.done)) return;
      const d = n.end - n.start;
      num += st.accuracy * d;
      den += d;
    });
    return den ? num / den : 0;
  }

  /** Final result, counting unsung notes as misses. */
  result() {
    const percent = this.percent(true);
    const counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.states.forEach((s, i) => {
      if (!this.song.notes[i].freestyle) counts[s.rating ?? 'miss']++;
    });
    const grade = percent >= 0.9 ? 'S' : percent >= 0.8 ? 'A' : percent >= 0.65 ? 'B' : percent >= 0.5 ? 'C' : 'D';
    return {
      score: this.score,
      percent,
      grade,
      stars: Math.round(percent * 5 * 2) / 2, // 0..5 in half stars
      maxCombo: this.maxCombo,
      counts,
    };
  }
}

function dist(n, t) {
  return t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
}
