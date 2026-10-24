// Song editor for the example app: piano roll, on-screen piano, step entry,
// real-time recording (piano or voice), lyrics and export.
import {
  Piano, PianoKeyboard, NoteRecorder, PitchDetector,
  splitLyrics, midiToName, draftToJSON, themedContext, legatoGroups,
} from '../src/index.js';
import { readJSON, writeJSON } from './store.js';

const LABEL_W = 44;
const RULER_H = 26;
const MIN_MIDI = 36;
const MAX_MIDI = 96;
const BLACK = new Set([1, 3, 6, 8, 10]);
const DURATION_NAMES = { 0.25: 'Semicorchea', 0.5: 'Corchea', 1: 'Negra', 2: 'Blanca', 4: 'Redonda' };

const COLORS = {
  bg: '#22095a',
  rowBlack: 'rgba(0,0,0,0.16)',
  rowC: 'rgba(255,255,255,0.07)',
  beat: 'rgba(255,255,255,0.05)',
  bar: 'rgba(255,255,255,0.16)',
  ruler: '#1b0748',
  rulerText: 'rgba(246,240,223,0.55)',
  label: 'rgba(246,240,223,0.45)',
  note: '#1fd1b5',
  noteText: '#0d0430',
  selected: '#ffcf4a',
  recorded: '#ff8ad8',
  cursor: '#1fd1b5',
  playhead: '#ffffff',
  pitch: '#43e08c',
};

export const EDITOR_DEFAULTS = { duration: 1, write: true, metronome: true, grid: 0.25 };

export const emptyDraft = () => ({ title: '', artist: '', bpm: 90, beatsPerBar: 4, lyricsText: '', notes: [] });

export class SongEditor {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root   the editor screen
   * @param {() => AudioContext} o.audio
   * @param {() => 'solfege'|'english'} o.notation
   * @param {(msg: string, error?: boolean) => void} o.toast
   * @param {(json: object, id: string|null) => Promise<string>} o.onSave returns the saved id
   * @param {(json: object) => void} o.onTry
   * @param {() => void} o.onExit
   * @param {(id: string) => Promise<void>} o.onDelete
   */
  constructor(o) {
    this.o = o;
    this.root = o.root;
    this.$ = (s) => this.root.querySelector(s);
    this.canvas = this.$('#ed-roll');
    this.colorMap = null; // traduce los colores al tema claro
    this.g = themedContext(this.canvas.getContext('2d'), () => this.colorMap);

    const prefs = readJSON('editor-prefs', { ...EDITOR_DEFAULTS });
    this.prefs = prefs;
    this.draft = emptyDraft();
    this.id = null;
    this.sel = null;
    this.cursor = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.mode = 'idle'; // idle | playing | countin | recording
    this.view = { ppb: 56, scroll: -0.25, top: 79, rowH: 16 };
    this.width = 0;
    this.height = 0;
    this.pointers = new Map();
    this.live = null; // live pitch while recording voice

    this.keyboard = new PianoKeyboard(this.$('#ed-keys'), { from: 60, to: 76, notation: o.notation() });
    this.keyboard.on('noteon', ({ midi }) => this._keyDown(midi));
    this.keyboard.on('noteoff', ({ midi }) => this._keyUp(midi));

    new ResizeObserver(() => this._resize()).observe(this.canvas);
    this._bindUI();
    this._bindCanvas();
    this._bindShortcuts();
  }

  // ======================================================================
  // Opening & saving
  // ======================================================================

  /** Opens a draft. `id` is the library id when editing a saved song of yours. */
  open(draft, { id = null } = {}) {
    this.stop();
    this.draft = { ...emptyDraft(), ...structuredClone(draft) };
    this.draft.notes.sort((a, b) => a.beat - b.beat);
    this.id = id;
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.cursor = this.endBeat();
    this.keyboard.setNotation(this.o.notation());
    this._fitView();
    this._syncUI();
    this.draw();
    // the screen may have just become visible: fit again once it has a size
    requestAnimationFrame(() => {
      this._resize();
      this._fitView();
      this.draw();
    });
  }

  /** Restores the autosaved draft, if any. */
  restoreAutosave() {
    const saved = readJSON('editor-autosave', null);
    if (!saved?.draft?.notes?.length) return false;
    this.open(saved.draft, { id: saved.id });
    this.dirty = saved.dirty;
    this._syncUI();
    return true;
  }

  clearAutosave() {
    writeJSON('editor-autosave', null);
  }

  toJSON() {
    const syl = splitLyrics(this.draft.lyricsText);
    return draftToJSON({
      ...this.draft,
      title: this.draft.title.trim() || 'Mi canción',
      notes: this.draft.notes.map((n, i) => ({ ...n, lyric: syl[i] ?? '' })),
    });
  }

  async save() {
    if (!this.draft.notes.length) return this.o.toast('Añade alguna nota antes de guardar', true);
    this.id = await this.o.onSave(this.toJSON(), this.id);
    this.dirty = false;
    this.clearAutosave();
    this._syncUI();
    this.o.toast('Canción guardada en tu biblioteca');
  }

  async exit() {
    this.stop();
    if (this.dirty && this.draft.notes.length) {
      const ok = await this.o.confirm({
        title: '¿Salir sin guardar?',
        text: 'Tu borrador se guarda en este dispositivo y podrás seguir luego desde «Crear canción».',
        ok: 'Salir', cancel: 'Seguir editando',
      });
      if (!ok) return;
    } else {
      this.clearAutosave();
    }
    this.o.onExit();
  }

  // ======================================================================
  // Model
  // ======================================================================

  get notes() {
    return this.draft.notes;
  }

  endBeat() {
    return this.notes.reduce((m, n) => Math.max(m, n.beat + n.length), 0);
  }

  _snapshot() {
    return JSON.stringify({ notes: this.notes, lyricsText: this.draft.lyricsText, bpm: this.draft.bpm, beatsPerBar: this.draft.beatsPerBar });
  }

  _restore(snap) {
    Object.assign(this.draft, JSON.parse(snap));
    this.sel = null;
  }

  /** Every edit goes through here: undo history, autosave and redraw. */
  change(fn, { record = true } = {}) {
    if (record) {
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    fn();
    this.notes.sort((a, b) => a.beat - b.beat || b.midi - a.midi);
    this.dirty = true;
    writeJSON('editor-autosave', { draft: this.draft, id: this.id, dirty: true });
    this._syncUI();
    this.draw();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this.change(() => {}, { record: false });
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this.change(() => {}, { record: false });
  }

  insertNote(midi) {
    const len = this.prefs.duration;
    const at = this.cursor;
    this.change(() => {
      for (const n of this.notes) {
        if (n.beat >= at - 1e-6) n.beat += len;
        else if (n.beat + n.length > at) n.length = at - n.beat;
      }
      this.notes.push({ beat: at, length: len, midi });
      this.cursor = at + len;
    });
    this._reveal(this.cursor);
  }

  insertRest() {
    const len = this.prefs.duration;
    const at = this.cursor;
    this.change(() => {
      for (const n of this.notes) if (n.beat >= at - 1e-6) n.beat += len;
      this.cursor = at + len;
    });
    this._reveal(this.cursor);
  }

  deleteSelected() {
    if (!this.sel) return;
    const n = this.sel;
    this.change(() => {
      this.notes.splice(this.notes.indexOf(n), 1);
      this.sel = null;
    });
  }

  /** Backspace without selection: removes the note just before the cursor. */
  backspace() {
    if (this.sel) return this.deleteSelected();
    const prev = [...this.notes].reverse().find((n) => n.beat < this.cursor - 1e-6);
    if (!prev) return;
    this.change(() => {
      const gap = this.cursor - prev.beat;
      this.notes.splice(this.notes.indexOf(prev), 1);
      for (const n of this.notes) if (n.beat >= this.cursor - 1e-6) n.beat -= gap;
      this.cursor = prev.beat;
    });
  }

  updateSelected(patch, { audition = false } = {}) {
    const n = this.sel;
    if (!n) return;
    this.change(() => {
      if ('midi' in patch) n.midi = clamp(patch.midi, MIN_MIDI, MAX_MIDI);
      if ('beat' in patch) n.beat = Math.max(0, patch.beat);
      if ('length' in patch) n.length = Math.max(this.prefs.grid, patch.length);
    });
    if (audition) this._audition(n.midi);
  }

  // ======================================================================
  // Sound, playback & recording
  // ======================================================================

  _audio() {
    const ctx = this.o.audio();
    if (ctx.state === 'suspended') ctx.resume();
    this.piano ??= new Piano(ctx, ctx.destination, { volume: 0.7 });
    return ctx;
  }

  _audition(midi) {
    this._audio();
    this.piano.play(midi, { duration: 0.35 });
  }

  _keyDown(midi) {
    const ctx = this._audio();
    this.piano.noteOn(midi, { velocity: 0.8 });
    if (this.mode === 'recording' || this.mode === 'countin') {
      this.lastKey = midi;
      if (this.recSource === 'keys' && ctx.currentTime >= this.recStart - (30 / this.draft.bpm)) {
        this.recorder.noteOn(midi, Math.max(ctx.currentTime, this.recStart));
      }
      return;
    }
    if (this.mode === 'playing' || !this.prefs.write) return;
    if (this.sel) this.updateSelected({ midi });
    else this.insertNote(midi);
  }

  _keyUp(midi) {
    if (!this.piano) return;
    this.piano.noteOff(midi);
    if (this.mode === 'recording' && this.recSource === 'keys') this.recorder.noteOff(midi, this.o.audio().currentTime);
  }

  togglePlay() {
    if (this.mode === 'playing') this.stop();
    else if (this.mode === 'idle') this.play();
  }

  play() {
    if (!this.notes.length) return this.o.toast('Todavía no hay notas que escuchar');
    const ctx = this._audio();
    const spb = 60 / this.draft.bpm;
    const from = this.cursor >= this.endBeat() - 1e-6 ? 0 : this.cursor;
    const t0 = ctx.currentTime + 0.08;
    const groups = legatoGroups(this.notes.filter((n) => n.beat >= from - 1e-6).map((n) => ({ start: n.beat, end: n.beat + n.length, midi: n.midi })), 0.01);
    for (const g of groups) {
      this.piano.play(g.midi, { when: t0 + (g.start - from) * spb, duration: (g.end - g.start) * spb * 0.96 });
    }
    this.mode = 'playing';
    this.playFrom = { t0, beat: from };
    this._syncUI();
    this._loop();
  }

  stop() {
    if (this.mode === 'recording' || this.mode === 'countin') return this.stopRecording();
    if (this.mode !== 'playing') return;
    this.piano?.stopAll();
    this.keyboard.clearHighlights();
    this.mode = 'idle';
    this._syncUI();
    this.draw();
  }

  /**
   * @param {'mic-piano'|'voice'|'keys'} source
   *   mic-piano: a real piano heard through the microphone; voice: singing; keys: the on-screen piano
   */
  async startRecording(source) {
    this.stop();
    const ctx = this._audio();
    if (source !== 'keys') {
      try {
        // a piano a little further away is quieter than a voice: lower gate
        this.detector = new PitchDetector({ audioContext: ctx, minVolume: source === 'mic-piano' ? 0.005 : 0.01, minFreq: source === 'mic-piano' ? 40 : 65, maxFreq: 2100 });
        await this.detector.start({ loop: false });
      } catch (err) {
        this.detector = null;
        return this.o.toast(err.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono' : err.message, true);
      }
    }
    const spb = 60 / this.draft.bpm;
    const bpb = this.draft.beatsPerBar;
    const startBeat = Math.max(0, Math.round(this.cursor / this.prefs.grid) * this.prefs.grid);
    this.sel = null;
    this.recSource = source;
    this.recStart = ctx.currentTime + 0.15 + bpb * spb; // after one bar of count-in
    this.recStartBeat = startBeat;
    this.recorder = new NoteRecorder({ bpm: this.draft.bpm, startTime: this.recStart, startBeat, grid: this.prefs.grid });
    this.recPreview = [];
    this.lastKey = null;
    this.mode = 'countin';
    this._syncUI();
    this._loop();
  }

  stopRecording() {
    const ctx = this.o.audio();
    this.detector?.stop();
    this.detector = null;
    this.live = null;
    const recorded = this.mode === 'recording' ? this.recorder.finish(ctx.currentTime) : [];
    this.mode = 'idle';
    this.recPreview = [];
    if (recorded.length) {
      const from = this.recStartBeat;
      const to = recorded.at(-1).beat + recorded.at(-1).length;
      this.change(() => {
        this.draft.notes = this.notes.filter((n) => n.beat + n.length <= from + 1e-6 || n.beat >= to - 1e-6);
        this.notes.push(...recorded);
        this.cursor = to;
        this.view.scroll = Math.max(-0.25, from - 1); // show what was just recorded
      });
      this.view.top = Math.round(this.view.top);
      this.o.toast(`${recorded.length} ${recorded.length === 1 ? 'nota grabada' : 'notas grabadas'}`);
    } else {
      this.view.top = Math.round(this.view.top);
      this._syncUI();
      this.draw();
      this.o.toast('No se ha grabado ninguna nota');
    }
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    const frame = () => {
      if (this.mode === 'idle') return;
      const ctx = this.o.audio();
      const spb = 60 / this.draft.bpm;
      const now = ctx.currentTime;

      if (this.mode === 'playing') {
        const beat = this.playFrom.beat + (now - this.playFrom.t0) / spb;
        this.playhead = Math.max(this.playFrom.beat, beat);
        this.keyboard.clearHighlights();
        for (const n of this.notes) if (beat >= n.beat && beat < n.beat + n.length) this.keyboard.highlight(n.midi, true);
        if (beat > this.endBeat() + 0.25) return this.stop();
      } else {
        if (this.mode === 'countin' && now >= this.recStart) {
          this.mode = 'recording';
          this._syncUI();
        }
        this.playhead = this.recStartBeat + (now - this.recStart) / spb;
        if (this.detector) {
          const p = this.detector.read();
          this.live = p ? p.midi : null;
          this.level = this.detector.volume;
          if (this.mode === 'recording') {
            if (this.recSource === 'voice') this.recorder.pitch(p?.midi ?? null, now);
            else this.recorder.instrument(p?.midi ?? null, this.detector.volume, now);
          }
        }
        if (this.mode === 'recording') this.recPreview = this.recorder.preview(now);
        this._followPitch(this.live ?? this.lastKey ?? this.recPreview.at(-1)?.midi);
      }
      this._follow(this.playhead);
      this.draw();
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  // ======================================================================
  // Piano roll: geometry & drawing
  // ======================================================================

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view.rowH = clamp((this.height - RULER_H) / 22, 12, 20);
    this._fitKeyboard();
    this.draw();
  }

  /** About 56 px per white key: 1.5 octaves on a phone, 3–4 on a laptop. */
  _fitKeyboard() {
    const wanted = clamp(Math.round(this.width / 56), 10, 29);
    let to = this.keyboard.from;
    for (let whites = 0; whites < wanted; to++) if (!BLACK.has(to % 12)) whites++;
    to--;
    if (to !== this.keyboard.options.to) this.keyboard.setRange(this.keyboard.from, Math.min(108, to));
  }

  _fitView() {
    const ms = this.notes.map((n) => n.midi);
    const rows = Math.max(8, Math.floor((this.height - RULER_H) / this.view.rowH) || 20);
    const hi = ms.length ? Math.max(...ms) : 72;
    const lo = ms.length ? Math.min(...ms) : 60;
    this.view.top = Math.min(MAX_MIDI, Math.round((hi + lo) / 2 + rows / 2));
    this.view.ppb = this.width && this.width < 600 ? 44 : 60;
    this.view.scroll = -0.25;
  }

  x(beat) {
    return LABEL_W + (beat - this.view.scroll) * this.view.ppb;
  }

  y(midi) {
    return RULER_H + (this.view.top - midi) * this.view.rowH;
  }

  beatAt(x) {
    return (x - LABEL_W) / this.view.ppb + this.view.scroll;
  }

  midiAt(y) {
    return Math.round(this.view.top - (y - RULER_H) / this.view.rowH - 0.5);
  }

  _reveal(beat) {
    const x = this.x(beat);
    if (x > this.width - 60) this.view.scroll = beat - (this.width - LABEL_W - 120) / this.view.ppb;
    if (x < LABEL_W + 20) this.view.scroll = Math.max(-0.25, beat - 1);
    this.draw();
  }

  /** Keeps the note being sung or played in the middle of the roll while recording. */
  _followPitch(midi) {
    if (midi == null) return;
    const rows = (this.height - RULER_H) / this.view.rowH;
    const pos = (this.view.top - midi) / rows; // 0 = top edge, 1 = bottom edge
    if (pos > 0.3 && pos < 0.7) return;
    const target = clamp(midi + rows / 2, MIN_MIDI + 8, MAX_MIDI);
    this.view.top += (target - this.view.top) * (pos < 0.08 || pos > 0.92 ? 0.35 : 0.12);
  }

  _follow(beat) {
    const x = this.x(beat);
    if (x > this.width * 0.7) this.view.scroll = beat - (this.width * 0.3 - LABEL_W) / this.view.ppb;
  }

  draw() {
    const g = this.g;
    const { width: w, height: h, view } = this;
    if (!w) return;
    const syl = splitLyrics(this.draft.lyricsText);
    const bpb = this.draft.beatsPerBar;

    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, w, h);

    // pitch rows
    const lo = Math.floor(this.midiAt(h)) - 1;
    for (let m = Math.ceil(view.top) + 1; m >= lo; m--) {
      const y = this.y(m) - view.rowH / 2;
      if (BLACK.has(m % 12)) {
        g.fillStyle = COLORS.rowBlack;
        g.fillRect(LABEL_W, y, w, view.rowH);
      }
      if (m % 12 === 0) {
        g.fillStyle = COLORS.rowC;
        g.fillRect(LABEL_W, y + view.rowH - 1, w, 1);
      }
    }

    // the row of the note you are singing or playing, so you never lose it
    const recording = this.mode === 'recording' || this.mode === 'countin';
    const current = recording ? this.live ?? (this.recSource === 'keys' ? this.lastKey : null) : null;
    if (current != null) {
      g.fillStyle = 'rgba(67,224,140,0.14)';
      g.fillRect(LABEL_W, this.y(Math.round(current)) - view.rowH / 2, w, view.rowH);
    }

    // beat & bar lines
    const b0 = Math.floor(view.scroll);
    const b1 = Math.ceil(this.beatAt(w));
    for (let b = Math.max(0, b0); b <= b1; b++) {
      g.fillStyle = b % bpb === 0 ? COLORS.bar : COLORS.beat;
      g.fillRect(Math.round(this.x(b)), RULER_H, 1, h - RULER_H);
    }

    // notes
    const preview = this.mode === 'recording' ? this.recPreview : [];
    const inRecRange = (n) => preview.length && n.beat + n.length > this.recStartBeat && n.beat < this.playhead;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    this.notes.forEach((n, i) => {
      if (inRecRange(n)) return; // being replaced
      this._drawNote(n, n === this.sel ? COLORS.selected : COLORS.note, (syl[i] ?? '').replace(/^\//, ''), syl[i]?.startsWith('/'));
    });
    for (const n of preview) this._drawNote(n, COLORS.recorded, '');

    // cursor & playhead
    const ph = this.mode === 'idle' ? null : this.playhead;
    if (ph == null) {
      g.fillStyle = COLORS.cursor;
      g.fillRect(Math.round(this.x(this.cursor)) - 1, RULER_H, 2, h - RULER_H);
    } else {
      g.fillStyle = this.mode === 'playing' ? COLORS.playhead : '#ff6b8b';
      g.fillRect(Math.round(this.x(ph)) - 1, RULER_H, 2, h - RULER_H);
      if (current != null) {
        const px = this.x(ph);
        const py = this.y(current);
        g.fillStyle = COLORS.pitch;
        g.beginPath();
        g.arc(px, py, 7, 0, Math.PI * 2);
        g.fill();
        // note name next to the dot
        const name = midiToName(Math.round(current), { notation: this.o.notation() });
        g.font = '900 13px Nunito, system-ui, sans-serif';
        const tw = g.measureText(name).width;
        const lx = px + 14 + tw + 12 > w ? px - 14 - tw - 12 : px + 14;
        g.fillStyle = COLORS.pitch;
        roundRect(g, lx, py - 11, tw + 12, 22, 11);
        g.fill();
        g.fillStyle = COLORS.noteText;
        g.textAlign = 'left';
        g.fillText(name, lx + 6, py + 0.5);
      }
    }

    // ruler
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, w, RULER_H);
    g.font = '800 11px Nunito, system-ui, sans-serif';
    g.fillStyle = COLORS.rulerText;
    for (let b = Math.max(0, b0); b <= b1; b++) {
      if (b % bpb) continue;
      g.fillText(String(b / bpb + 1), this.x(b) + 5, RULER_H / 2);
    }
    // cursor flag
    const cx = this.x(ph ?? this.cursor);
    g.fillStyle = ph == null ? COLORS.cursor : this.mode === 'playing' ? COLORS.playhead : '#ff6b8b';
    g.beginPath();
    g.moveTo(cx - 6, RULER_H - 9);
    g.lineTo(cx + 6, RULER_H - 9);
    g.lineTo(cx, RULER_H);
    g.fill();

    // visual metronome (silent): the ruler flashes on every beat, stronger on the first of the bar
    if (this.prefs.metronome && (this.mode === 'playing' || recording)) {
      const beat = Math.floor(this.playhead);
      const frac = this.playhead - beat;
      const accent = (((beat % bpb) + bpb) % bpb) === 0;
      const k = Math.max(0, 1 - frac * 3);
      g.globalAlpha = k * (accent ? 0.35 : 0.18);
      g.fillStyle = accent ? COLORS.selected : '#ffffff';
      g.fillRect(LABEL_W, 0, w, RULER_H);
      g.globalAlpha = k;
      g.beginPath();
      g.arc(w - 16, RULER_H / 2, accent ? 7 : 5, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    if (this.mode === 'recording') {
      if (this.detector) {
        const lv = Math.min(1, Math.sqrt((this.level ?? 0) / 0.25));
        g.fillStyle = 'rgba(255,255,255,0.15)';
        g.fillRect(w - 96, RULER_H / 2 - 3, 64, 6);
        g.fillStyle = lv > 0.9 ? '#ff6b8b' : COLORS.pitch;
        g.fillRect(w - 96, RULER_H / 2 - 3, 64 * lv, 6);
      }
    }

    // pitch labels
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, RULER_H, LABEL_W, h - RULER_H);
    g.font = '700 10px Nunito, system-ui, sans-serif';
    for (let m = Math.ceil(view.top); m >= lo; m--) {
      if (BLACK.has(m % 12)) continue;
      const isC = m % 12 === 0;
      if (!isC && view.rowH < 14 && m % 12 !== 7) continue;
      g.fillStyle = isC ? 'rgba(246,240,223,0.85)' : COLORS.label;
      g.fillText(midiToName(m, { notation: this.o.notation(), octave: isC }), 6, this.y(m));
    }

    // count-in
    if (this.mode === 'countin') {
      const ctx = this.o.audio();
      const left = Math.ceil((this.recStart - ctx.currentTime) / (60 / this.draft.bpm));
      g.fillStyle = 'rgba(23,6,64,0.55)';
      g.fillRect(LABEL_W, RULER_H, w, h);
      const frac = this.playhead - Math.floor(this.playhead);
      g.strokeStyle = `rgba(255,255,255,${Math.max(0, 0.6 - frac * 0.8)})`;
      g.lineWidth = 4;
      g.beginPath();
      g.arc((w + LABEL_W) / 2, (h + RULER_H) / 2, 52 + frac * 26, 0, Math.PI * 2);
      g.stroke();
      g.textAlign = 'center';
      g.font = '900 72px Nunito, system-ui, sans-serif';
      g.fillStyle = '#fff';
      g.fillText(String(Math.max(1, left)), (w + LABEL_W) / 2, (h + RULER_H) / 2);
      g.font = '800 15px Nunito, system-ui, sans-serif';
      g.fillStyle = COLORS.rulerText;
      g.fillText({ voice: 'Prepárate para cantar', 'mic-piano': 'Prepárate para tocar el piano', keys: 'Prepárate para tocar' }[this.recSource], (w + LABEL_W) / 2, (h + RULER_H) / 2 + 56);
    }

    // empty state
    if (!this.notes.length && this.mode === 'idle') {
      g.textAlign = 'center';
      g.fillStyle = 'rgba(246,240,223,0.55)';
      g.font = '800 15px Nunito, system-ui, sans-serif';
      const cxm = (w + LABEL_W) / 2;
      const cym = (h + RULER_H) / 2;
      g.fillText('Toca el piano para escribir la melodía', cxm, cym - 12);
      g.font = '700 13px Nunito, system-ui, sans-serif';
      g.fillStyle = 'rgba(246,240,223,0.38)';
      g.fillText('o pulsa Grabar para tocar o cantar en tiempo real', cxm, cym + 12);
    }
  }

  _drawNote(n, color, lyric, lineStart) {
    const g = this.g;
    const x0 = this.x(n.beat) + 1;
    const x1 = this.x(n.beat + n.length) - 1;
    if (x1 < LABEL_W || x0 > this.width) return;
    const rh = this.view.rowH;
    const y = this.y(n.midi) - rh / 2 + 1;
    g.fillStyle = color;
    roundRect(g, x0, y, Math.max(4, x1 - x0), rh - 2, Math.min(6, (rh - 2) / 2));
    g.fill();
    if (lineStart) {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(x0 - 3, y - 4, 2, rh + 6);
    }
    if (lyric) {
      g.font = `800 ${Math.min(12, rh - 4)}px Nunito, system-ui, sans-serif`;
      const tw = g.measureText(lyric).width;
      if (tw < x1 - x0 - 8) {
        g.fillStyle = COLORS.noteText;
        g.fillText(lyric, x0 + 5, y + (rh - 2) / 2 + 0.5);
      } else {
        g.fillStyle = 'rgba(246,240,223,0.8)';
        g.fillText(lyric, x0 + 2, y + rh + 6);
      }
    }
  }

  _hit(x, y) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const x0 = this.x(n.beat);
      const x1 = this.x(n.beat + n.length);
      const yc = this.y(n.midi);
      if (x >= x0 && x <= x1 + 4 && Math.abs(y - yc) <= this.view.rowH / 2 + 2) {
        const edge = x1 - x < Math.min(14, (x1 - x0) / 3);
        return { note: n, edge };
      }
    }
    return null;
  }

  // ======================================================================
  // Interaction
  // ======================================================================

  _bindCanvas() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      if (this.mode === 'countin' || this.mode === 'recording') return;
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { type: 'pinch', dist: Math.abs(a.x - b.x) || 1, ppb: this.view.ppb, anchor: this.beatAt((a.x + b.x) / 2) };
        return;
      }
      const hit = p.y > RULER_H && p.x > LABEL_W ? this._hit(p.x, p.y) : null;
      if (p.y <= RULER_H && p.x > LABEL_W) {
        this.drag = { type: 'cursor' };
        this._setCursor(p.x);
      } else if (hit) {
        const wasSelected = this.sel === hit.note;
        this.sel = hit.note;
        this.drag = { type: hit.edge ? 'resize' : 'move', start: p, note: hit.note, orig: { ...hit.note }, moved: false, wasSelected };
        this._syncUI();
        this.draw();
      } else {
        this.drag = { type: 'pan', start: p, scroll: this.view.scroll, top: this.view.top, moved: false };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      const d = this.drag;
      if (!d) {
        if (e.pointerType === 'mouse') {
          const hit = this._hit(p.x, p.y);
          c.style.cursor = p.y <= RULER_H ? 'col-resize' : hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair';
        }
        return;
      }
      if (d.type === 'pinch') {
        const [a, b] = [...this.pointers.values()];
        if (!b) return;
        this.view.ppb = clamp((d.ppb * Math.abs(a.x - b.x)) / d.dist, 14, 200);
        this.view.scroll = d.anchor - ((a.x + b.x) / 2 - LABEL_W) / this.view.ppb;
        this.draw();
        return;
      }
      if (d.type === 'cursor') return this._setCursor(p.x);
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 6) return;
      if (!d.moved && d.type !== 'pan') this.undoStack.push(this._snapshot()), (this.redoStack = []);
      d.moved = true;
      const grid = this.prefs.grid;
      if (d.type === 'pan') {
        this.view.scroll = Math.max(-0.25, d.scroll - dx / this.view.ppb);
        this.view.top = clamp(Math.round(d.top + dy / this.view.rowH), MIN_MIDI + 8, MAX_MIDI);
      } else if (d.type === 'move') {
        const beat = Math.max(0, Math.round((d.orig.beat + dx / this.view.ppb) / grid) * grid);
        const midi = clamp(d.orig.midi - Math.round(dy / this.view.rowH), MIN_MIDI, MAX_MIDI);
        if (midi !== d.note.midi) this._audition(midi);
        d.note.beat = beat;
        d.note.midi = midi;
      } else if (d.type === 'resize') {
        d.note.length = Math.max(grid, Math.round((d.orig.length + dx / this.view.ppb) / grid) * grid);
      }
      this.draw();
    });

    const end = (e) => {
      this.pointers.delete(e.pointerId);
      const d = this.drag;
      if (!d) return;
      if (d.type === 'pinch') {
        if (this.pointers.size === 0) this.drag = null;
        return;
      }
      this.drag = null;
      if (d.type === 'move' || d.type === 'resize') {
        if (d.moved) this.change(() => {}, { record: false });
        else if (d.wasSelected) {
          this.sel = null; // second tap deselects
          this._syncUI();
          this.draw();
        } else this._audition(d.note.midi);
      } else if (d.type === 'pan' && !d.moved && e.type === 'pointerup') {
        if (this.sel) {
          this.sel = null;
          this._syncUI();
          this.draw();
        } else {
          const p = d.start;
          const beat = Math.max(0, Math.floor(this.beatAt(p.x) / this.prefs.grid) * this.prefs.grid);
          const midi = clamp(this.midiAt(p.y), MIN_MIDI, MAX_MIDI);
          const note = { beat, length: this.prefs.duration, midi };
          this.change(() => {
            this.notes.push(note);
            this.sel = note;
          });
          this._audition(midi);
        }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const anchor = this.beatAt(e.offsetX);
        this.view.ppb = clamp(this.view.ppb * Math.exp(-e.deltaY / 300), 14, 200);
        this.view.scroll = anchor - (e.offsetX - LABEL_W) / this.view.ppb;
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.view.scroll = Math.max(-0.25, this.view.scroll + (e.deltaX || e.deltaY) / this.view.ppb);
      } else {
        this._wheelAcc = (this._wheelAcc ?? 0) + e.deltaY;
        const rows = Math.trunc(this._wheelAcc / 30);
        if (rows) {
          this._wheelAcc -= rows * 30;
          this.view.top = clamp(this.view.top - rows, MIN_MIDI + 8, MAX_MIDI);
        }
      }
      this.draw();
    }, { passive: false });
  }

  _setCursor(x) {
    this.cursor = Math.max(0, Math.round(this.beatAt(x) / this.prefs.grid) * this.prefs.grid);
    this.sel = null;
    this._syncUI();
    this.draw();
  }

  zoom(factor) {
    const mid = this.beatAt((this.width + LABEL_W) / 2);
    this.view.ppb = clamp(this.view.ppb * factor, 14, 200);
    this.view.scroll = mid - (this.width - LABEL_W) / 2 / this.view.ppb;
    this.draw();
  }

  _bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (!this.root.classList.contains('is-active') || document.querySelector('dialog[open]')) return;
      if (e.target.closest('input, textarea, select')) return;
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 'z') return e.preventDefault(), e.shiftKey ? this.redo() : this.undo();
      if (mod && k.toLowerCase() === 'y') return e.preventDefault(), this.redo();
      if (mod && k.toLowerCase() === 's') return e.preventDefault(), this.save();
      if (mod) return;
      if (k === ' ') return e.preventDefault(), this.mode === 'idle' || this.mode === 'playing' ? this.togglePlay() : this.stop();
      if (k === 'Escape') return this.mode !== 'idle' ? this.stop() : this.sel && ((this.sel = null), this._syncUI(), this.draw());
      if (k === 'Backspace' || k === 'Delete') return e.preventDefault(), this.backspace();
      if (k === 'r' || k === 'R') return this.openRecordDialog();
      if (k === '0') return this.insertRest();
      if ('12345'.includes(k)) return this.setDuration([0.25, 0.5, 1, 2, 4]['12345'.indexOf(k)]);
      const n = this.sel;
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        const d = (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        if (n) this.updateSelected({ midi: n.midi + d }, { audition: true });
        else this.keyboard.shiftOctave(Math.sign(d));
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const d = (k === 'ArrowRight' ? 1 : -1) * this.prefs.grid;
        if (n && e.shiftKey) this.updateSelected({ length: n.length + d });
        else if (n) this.updateSelected({ beat: n.beat + d });
        else {
          this.cursor = Math.max(0, this.cursor + d);
          this._reveal(this.cursor);
          this._syncUI();
        }
      }
    });
  }

  setDuration(v) {
    this.prefs.duration = v;
    writeJSON('editor-prefs', this.prefs);
    if (this.sel) this.updateSelected({ length: v });
    this._syncUI();
  }

  openRecordDialog() {
    if (this.mode !== 'idle') return this.stop();
    this.$('#ed-rec-metro').checked = this.prefs.metronome;
    this.$('#ed-rec-from').textContent = `Desde el compás ${Math.floor(this.cursor / this.draft.beatsPerBar) + 1}`
      + (this.notes.some((n) => n.beat + n.length > this.cursor) ? ' · reemplaza lo que haya después' : '');
    this.o.openDialog(this.$('#ed-record'));
  }

  // ======================================================================
  // UI wiring
  // ======================================================================

  _bindUI() {
    const $ = this.$;
    $('#ed-back').addEventListener('click', () => this.exit());
    $('#ed-save').addEventListener('click', () => this.save());
    $('#ed-title').addEventListener('input', (e) => {
      this.draft.title = e.target.value;
      this.dirty = true;
      writeJSON('editor-autosave', { draft: this.draft, id: this.id, dirty: true });
    });
    $('#ed-play').addEventListener('click', () => (this.mode === 'idle' ? this.play() : this.stop()));
    $('#ed-rec').addEventListener('click', () => this.openRecordDialog());
    $('#ed-undo').addEventListener('click', () => this.undo());
    $('#ed-redo').addEventListener('click', () => this.redo());
    $('#ed-rest').addEventListener('click', () => this.insertRest());
    $('#ed-tempo-chip').addEventListener('click', () => this.openMenu());
    $('#ed-more').addEventListener('click', () => this.openMenu());
    $('#ed-export').addEventListener('click', () => this.exportSong());
    $('#ed-zoom-in').addEventListener('click', () => this.zoom(1.25));
    $('#ed-zoom-out').addEventListener('click', () => this.zoom(0.8));
    $('#ed-oct-down').addEventListener('click', () => this.keyboard.shiftOctave(-1));
    $('#ed-oct-up').addEventListener('click', () => this.keyboard.shiftOctave(1));
    $('#ed-write').addEventListener('click', () => {
      this.prefs.write = !this.prefs.write;
      writeJSON('editor-prefs', this.prefs);
      this.o.toast(this.prefs.write ? 'El piano escribe notas en la partitura' : 'El piano solo suena, no escribe');
      this._syncUI();
    });
    $('#ed-durations').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.setDuration(Number(b.dataset.value));
    });

    // selection bar
    $('#ed-sel-up').addEventListener('click', () => this.updateSelected({ midi: this.sel.midi + 1 }, { audition: true }));
    $('#ed-sel-down').addEventListener('click', () => this.updateSelected({ midi: this.sel.midi - 1 }, { audition: true }));
    $('#ed-sel-left').addEventListener('click', () => this.updateSelected({ beat: this.sel.beat - this.prefs.grid }));
    $('#ed-sel-right').addEventListener('click', () => this.updateSelected({ beat: this.sel.beat + this.prefs.grid }));
    $('#ed-sel-shorter').addEventListener('click', () => this.updateSelected({ length: this.sel.length - this.prefs.grid }));
    $('#ed-sel-longer').addEventListener('click', () => this.updateSelected({ length: this.sel.length + this.prefs.grid }));
    $('#ed-sel-delete').addEventListener('click', () => this.deleteSelected());
    $('#ed-sel-close').addEventListener('click', () => {
      this.sel = null;
      this._syncUI();
      this.draw();
    });

    // lyrics
    $('#ed-lyrics-bar').addEventListener('click', () => {
      $('#ed-lyrics-text').value = this.draft.lyricsText;
      this._lyricsSnap = this._snapshot();
      this._updateLyricsCount();
      this.o.openDialog($('#ed-lyrics'));
      setTimeout(() => $('#ed-lyrics-text').focus(), 300);
    });
    $('#ed-lyrics-text').addEventListener('input', (e) => {
      this.draft.lyricsText = e.target.value;
      this._updateLyricsCount();
      this.dirty = true;
      writeJSON('editor-autosave', { draft: this.draft, id: this.id, dirty: true });
      this._syncUI();
      this.draw();
    });
    $('#ed-lyrics').addEventListener('close', () => {
      if (this._lyricsSnap && this._lyricsSnap !== this._snapshot()) {
        this.undoStack.push(this._lyricsSnap);
        this.redoStack = [];
      }
      this._lyricsSnap = null;
      this._syncUI();
    });

    // record dialog
    $('#ed-record').addEventListener('click', (e) => {
      const src = e.target.closest('[data-source]')?.dataset.source;
      if (!src) return;
      this.prefs.metronome = $('#ed-rec-metro').checked;
      writeJSON('editor-prefs', this.prefs);
      this.o.closeDialog($('#ed-record'));
      this.startRecording(src);
    });

    // menu
    $('#ed-bpm-down').addEventListener('click', () => this._setBpm(this.draft.bpm - 2));
    $('#ed-bpm-up').addEventListener('click', () => this._setBpm(this.draft.bpm + 2));
    $('#ed-bpm-range').addEventListener('input', (e) => this._setBpm(Number(e.target.value), false));
    $('#ed-bpb').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.change(() => (this.draft.beatsPerBar = Number(b.dataset.value)));
      this._syncMenu();
    });
    $('#ed-grid').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.prefs.grid = Number(b.dataset.value);
      writeJSON('editor-prefs', this.prefs);
      this._syncMenu();
    });
    $('#ed-metro').addEventListener('change', (e) => {
      this.prefs.metronome = e.target.checked;
      writeJSON('editor-prefs', this.prefs);
    });
    $('#ed-menu').addEventListener('click', async (e) => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (!a) return;
      if (a === 'try') {
        if (!this.notes.length) return this.o.toast('Añade alguna nota primero', true);
        this.o.closeDialog($('#ed-menu'));
        this.stop();
        this.o.onTry(this.toJSON());
      }
      if (a === 'export') {
        this.o.closeDialog($('#ed-menu'));
        this.exportSong();
      }
      if (a === 'clear') {
        this.o.closeDialog($('#ed-menu'));
        this.change(() => {
          this.draft.notes = [];
          this.sel = null;
          this.cursor = 0;
        });
        this.o.toast('Notas borradas. Puedes deshacerlo.');
      }
      if (a === 'new') {
        const ok = !this.dirty || await this.o.confirm({ title: '¿Empezar una canción nueva?', text: 'Perderás los cambios sin guardar.', ok: 'Empezar de cero', cancel: 'Cancelar' });
        if (!ok) return;
        this.o.closeDialog($('#ed-menu'));
        this.clearAutosave();
        this.open(emptyDraft());
      }
      if (a === 'delete' && this.id) {
        const ok = await this.o.confirm({ title: '¿Eliminar esta canción?', text: 'Se quitará de tu biblioteca. No se puede deshacer.', ok: 'Eliminar', cancel: 'Cancelar', danger: true });
        if (!ok) return;
        await this.o.onDelete(this.id);
        this.o.closeDialog($('#ed-menu'));
        this.dirty = false;
        this.clearAutosave();
        this.o.onExit();
      }
    });
  }

  /** Exports what is in the editor right now, saved or not. */
  exportSong() {
    if (!this.notes.length) return this.o.toast('Añade alguna nota antes de exportar', true);
    this.stop();
    this.o.onExport(this.toJSON());
  }

  openMenu() {
    this._syncMenu();
    this.o.openDialog(this.$('#ed-menu'));
  }

  _setBpm(v, sync = true) {
    const bpm = clamp(Math.round(v), 40, 220);
    if (bpm === this.draft.bpm) return;
    if (!this._bpmTimer) this.undoStack.push(this._snapshot());
    clearTimeout(this._bpmTimer);
    this._bpmTimer = setTimeout(() => (this._bpmTimer = null), 600);
    this.draft.bpm = bpm;
    this.change(() => {}, { record: false });
    if (sync) this._syncMenu();
    else this.$('#ed-bpm').textContent = bpm;
  }

  _syncMenu() {
    const $ = this.$;
    $('#ed-bpm').textContent = this.draft.bpm;
    $('#ed-bpm-range').value = this.draft.bpm;
    $('#ed-metro').checked = this.prefs.metronome;
    for (const b of $('#ed-bpb').querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.value) === this.draft.beatsPerBar));
    for (const b of $('#ed-grid').querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.value) === this.prefs.grid));
    $('#ed-delete').hidden = !this.id;
  }

  _updateLyricsCount() {
    const s = splitLyrics(this.draft.lyricsText).length;
    const n = this.notes.length;
    const el = this.$('#ed-lyrics-count');
    el.textContent = `${s} ${s === 1 ? 'sílaba' : 'sílabas'} · ${n} ${n === 1 ? 'nota' : 'notas'}`;
    el.className = `lyrics-count ${s === n ? 'ok' : s > n ? 'over' : ''}`;
    this.$('#ed-lyrics-diff').textContent = s === n || !n ? '' : s > n ? `Sobran ${s - n} sílabas: no tienen nota` : `Faltan ${n - s} sílabas: esas notas irán sin letra`;
  }

  _syncUI() {
    const $ = this.$;
    if (document.activeElement !== $('#ed-title')) $('#ed-title').value = this.draft.title;
    $('#ed-save').disabled = !this.dirty && !!this.id;
    $('#ed-save').textContent = this.id && !this.dirty ? 'Guardada' : 'Guardar';
    $('#ed-undo').disabled = !this.undoStack.length;
    $('#ed-redo').disabled = !this.redoStack.length;
    $('#ed-tempo').textContent = this.draft.bpm;

    const busy = this.mode === 'countin' || this.mode === 'recording';
    const play = $('#ed-play');
    play.classList.toggle('on', this.mode === 'playing');
    play.setAttribute('aria-label', this.mode === 'playing' ? 'Parar' : 'Escuchar');
    play.querySelector('.label').textContent = this.mode === 'playing' ? 'Parar' : 'Escuchar';
    play.disabled = busy;
    const rec = $('#ed-rec');
    rec.classList.toggle('on', busy);
    rec.querySelector('.label').textContent = busy ? 'Parar' : 'Grabar';
    this.root.classList.toggle('recording', busy);

    for (const b of $('#ed-durations').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(Number(b.dataset.value) === (this.sel ? this.sel.length : this.prefs.duration)));
    }
    $('#ed-write').classList.toggle('on', this.prefs.write);
    $('#ed-write').setAttribute('aria-pressed', String(this.prefs.write));

    const sel = this.sel;
    $('#ed-selbar').hidden = !sel;
    if (sel) {
      const idx = this.notes.indexOf(sel);
      const syl = splitLyrics(this.draft.lyricsText)[idx];
      $('#ed-sel-name').textContent = midiToName(sel.midi, { notation: this.o.notation() });
      $('#ed-sel-info').textContent = `${DURATION_NAMES[sel.length] ?? `${sel.length} pulsos`}${syl ? ` · «${syl.replace(/^\//, '')}»` : ''}`;
    }

    const syl = splitLyrics(this.draft.lyricsText).length;
    const n = this.notes.length;
    $('#ed-lyrics-preview').textContent = this.draft.lyricsText.trim().replace(/\s*\n\s*/g, ' / ') || 'Toca para escribir la letra';
    $('#ed-lyrics-preview').classList.toggle('placeholder', !this.draft.lyricsText.trim());
    const badge = $('#ed-lyrics-badge');
    badge.textContent = n ? `${syl}/${n}` : '';
    badge.className = `badge ${syl === n ? 'ok' : syl > n ? 'over' : ''}`;
  }
}

// ---- helpers ------------------------------------------------------------------

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}
