/**
 * Recording helpers: turn played keys or a sung melody into quantized notes.
 *
 *   const rec = new NoteRecorder({ bpm: 90, startTime: t0, startBeat: 0 });
 *   rec.noteOn(60, t); rec.noteOff(60, t2);   // on-screen / MIDI keys
 *   rec.pitch(midi, t);                       // a voice through the microphone
 *   rec.instrument(midi, volume, t);          // a real piano (or guitar…) through the microphone
 *   const notes = rec.finish(tEnd);           // [{ beat, length, midi }]
 */

/** Rounds `beats` to the nearest multiple of `grid`. */
export const quantize = (beats, grid = 0.25) => Math.round(beats / grid) * grid;

/**
 * Converts timed segments ({start, end, midi} in seconds) to monophonic notes in beats.
 * @param {{start:number, end:number, midi:number}[]} segments
 * @param {{bpm:number, startTime?:number, startBeat?:number, grid?:number}} opts
 */
export function segmentsToNotes(segments, { bpm, startTime = 0, startBeat = 0, grid = 0.25 }) {
  const spb = 60 / bpm;
  const toBeat = (t) => startBeat + (t - startTime) / spb;
  const notes = segments
    .map((s) => {
      const beat = Math.max(startBeat, quantize(toBeat(s.start), grid));
      const end = Math.max(beat + grid, quantize(toBeat(s.end), grid));
      return { beat, length: end - beat, midi: Math.round(s.midi) };
    })
    .sort((a, b) => a.beat - b.beat || b.length - a.length);

  const out = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && n.beat === prev.beat) continue; // two notes snapped together: keep the longer
    if (prev && n.beat < prev.beat + prev.length) prev.length = n.beat - prev.beat;
    out.push(n);
  }
  return out.filter((n) => n.length > 0);
}

export class NoteRecorder {
  /**
   * @param {object} opts
   * @param {number} opts.bpm
   * @param {number} opts.startTime clock time (seconds) of `startBeat`
   * @param {number} [opts.startBeat=0]
   * @param {number} [opts.grid=0.25] quantization in beats (0.25 = sixteenth note)
   * @param {number} [opts.minDuration=0.09] seconds; shorter sung blips are ignored
   */
  constructor({ bpm, startTime, startBeat = 0, grid = 0.25, minDuration = 0.09 }) {
    Object.assign(this, { bpm, startTime, startBeat, grid, minDuration });
    this.segments = [];
    this._held = null; // {midi, start}
    this._voice = null; // {start, last, values[], pending: {midi, since} }
    this._inst = { history: [], note: null, lastOnset: -Infinity };
  }

  // ---- keys -----------------------------------------------------------------

  noteOn(midi, time) {
    if (this._held) this._closeHeld(time);
    this._held = { midi, start: time };
  }

  noteOff(midi, time) {
    if (this._held?.midi === midi) this._closeHeld(time);
  }

  _closeHeld(time) {
    this.segments.push({ start: this._held.start, end: time, midi: this._held.midi });
    this._held = null;
  }

  // ---- voice ------------------------------------------------------------------

  /**
   * Feeds a detected pitch (fractional MIDI, or null for silence) at `time`.
   * A new note starts when the pitch moves by about a semitone for a short while.
   */
  pitch(midi, time) {
    const v = this._voice;
    if (midi == null) {
      if (v && time - v.last > 0.08) this._closeVoice();
      return;
    }
    if (!v) {
      this._voice = { start: time, last: time, values: [midi], pending: null };
      return;
    }
    const center = median(v.values);
    if (Math.abs(midi - center) >= 0.7) {
      v.pending ??= { since: time, values: [] };
      v.pending.values.push(midi);
      if (time - v.pending.since >= 0.07) {
        const next = { start: v.pending.since, last: time, values: v.pending.values, pending: null };
        v.last = v.pending.since;
        this._closeVoice();
        this._voice = next;
      }
    } else {
      v.pending = null;
      v.values.push(midi);
      v.last = time;
    }
  }

  _closeVoice() {
    const v = this._voice;
    this._voice = null;
    if (v && v.last - v.start >= this.minDuration) {
      this.segments.push({ start: v.start, end: v.last, midi: median(v.values) });
    }
  }

  // ---- acoustic instrument -----------------------------------------------------

  /**
   * Feeds one microphone frame of an acoustic instrument (piano, guitar, xylophone…).
   * Unlike the voice, a new note starts on every attack (a jump in volume), so
   * repeated notes are kept apart; the pitch is read just after the attack.
   * Play the melody one note at a time: chords can't be transcribed.
   * @param {number|null} midi detected pitch, null if none
   * @param {number} volume RMS of the frame (PitchDetector#volume)
   * @param {number} time
   */
  instrument(midi, volume, time, { minVolume = 0.006 } = {}) {
    const s = this._inst;
    while (s.history.length && time - s.history[0].time > 0.09) s.history.shift();
    const recentMin = s.history.length ? Math.min(...s.history.map((h) => h.volume)) : 0;
    s.history.push({ time, volume });
    const n = s.note;

    const attack = volume > minVolume && volume > recentMin * 1.7 + minVolume * 0.5 && time - s.lastOnset > 0.09;
    if (attack && (!n || volume > n.level * 1.35)) {
      this._closeInst(time);
      s.lastOnset = time;
      s.note = { start: time, peak: volume, level: volume, values: [], pending: null };
      return;
    }
    if (!n) return;
    n.peak = Math.max(n.peak, volume);
    n.level = volume;

    // the note has died away
    if (volume < minVolume || volume < n.peak * 0.1) return this._closeInst(time);

    if (midi == null) return;
    const age = time - n.start;
    if (n.values.length < 3 || age < 0.3) {
      if (age > 0.025) n.values.push(midi); // skip the hammer noise
      return;
    }
    // legato: pitch moved without a clear attack
    if (Math.abs(midi - median(n.values)) >= 0.8) {
      n.pending ??= { since: time, values: [] };
      n.pending.values.push(midi);
      if (time - n.pending.since >= 0.08) {
        const next = { start: n.pending.since, peak: volume, level: volume, values: n.pending.values, pending: null };
        this._closeInst(n.pending.since);
        s.note = next;
      }
    } else {
      n.pending = null;
    }
  }

  _closeInst(time) {
    const n = this._inst.note;
    this._inst.note = null;
    if (n?.values.length && time - n.start >= this.minDuration) {
      this.segments.push({ start: n.start, end: time, midi: median(n.values) });
    }
  }

  /** Notes recorded so far, including the one still sounding, in beats. */
  preview(time) {
    const segs = [...this.segments];
    if (this._held) segs.push({ start: this._held.start, end: time, midi: this._held.midi });
    if (this._voice) segs.push({ start: this._voice.start, end: time, midi: median(this._voice.values) });
    const inst = this._inst.note;
    if (inst?.values.length) segs.push({ start: inst.start, end: time, midi: median(inst.values) });
    return segmentsToNotes(segs, this);
  }

  /** Stops recording and returns the quantized notes. */
  finish(time) {
    if (this._held) this._closeHeld(time);
    if (this._voice) this._closeVoice();
    if (this._inst.note) this._closeInst(time);
    return segmentsToNotes(this.segments, this);
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
