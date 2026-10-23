/**
 * On-screen piano keyboard (touch, mouse with glissando, and computer keys).
 *
 *   const kb = new PianoKeyboard(container, { from: 60, to: 76 });
 *   kb.on('noteon', ({ midi }) => piano.noteOn(midi));
 *   kb.on('noteoff', ({ midi }) => piano.noteOff(midi));
 *
 * Computer keys: A W S E D F T G Y H U J K O L P Ñ/; → Do…Mi of the next octave,
 * Z / X move the octave down / up.
 */
import { Emitter } from './emitter.js';
import { midiToName } from './notes.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
const KEYMAP = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', 'ñ'];
const KEYMAP_ALT = { ';': 16 };

const STYLE = `
.ek { position: relative; display: flex; height: 100%; min-height: 90px; user-select: none; -webkit-user-select: none; touch-action: none; }
.ek-white { position: relative; flex: 1; margin: 0 1px; border-radius: 0 0 8px 8px; background: var(--ek-white, #f6f0df);
  box-shadow: inset 0 -6px 0 rgba(0,0,0,.12); display: flex; align-items: flex-end; justify-content: center; padding-bottom: 10px;
  font: 800 11px/1 var(--ek-font, system-ui, sans-serif); color: var(--ek-label, rgba(30,10,70,.5)); transition: background .06s; }
.ek-white.ek-c { color: var(--ek-label-c, rgba(30,10,70,.85)); }
.ek-black { position: absolute; top: 0; z-index: 1; height: 60%; border-radius: 0 0 6px 6px; background: var(--ek-black, #1d0b45);
  box-shadow: inset 0 -5px 0 rgba(255,255,255,.08), 0 3px 6px rgba(0,0,0,.35); transition: background .06s; }
.ek-key.ek-down { background: var(--ek-active, #1fd1b5) !important; box-shadow: inset 0 -2px 0 rgba(0,0,0,.15); }
.ek-key.ek-hint { background: var(--ek-hint, #ffcf4a) !important; }
`;

let styleInjected = false;

export class PianoKeyboard extends Emitter {
  /**
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {number} [opts.from=60] first MIDI note (snapped down to a white key)
   * @param {number} [opts.to=76] last MIDI note
   * @param {'english'|'solfege'} [opts.notation='solfege']
   * @param {boolean} [opts.labels=true]
   * @param {boolean} [opts.computerKeys=true]
   */
  constructor(container, opts = {}) {
    super();
    this.container = container;
    this.options = { from: 60, to: 76, notation: 'solfege', labels: true, computerKeys: true, ...opts };
    this.keys = new Map();
    this.pointers = new Map(); // pointerId → midi
    this.pressedKeys = new Map(); // computer key → midi
    this.down = new Set();
    if (!styleInjected && typeof document !== 'undefined') {
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.append(s);
      styleInjected = true;
    }
    this.el = document.createElement('div');
    this.el.className = 'ek';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Teclado de piano');
    container.append(this.el);
    this._bind();
    this.render();
  }

  get from() {
    return this.options.from;
  }

  /** Changes the visible range. */
  setRange(from, to) {
    this.releaseAll();
    Object.assign(this.options, { from, to });
    this.render();
  }

  /** Moves the range by whole octaves. */
  shiftOctave(delta) {
    const span = this.options.to - this.options.from;
    const from = Math.max(21, Math.min(108 - span, this.options.from + 12 * delta));
    this.setRange(from, from + span);
  }

  setNotation(notation) {
    this.options.notation = notation;
    this.render();
  }

  render() {
    let { from, to } = this.options;
    while (BLACK.has(from % 12)) from--;
    while (BLACK.has(to % 12)) to++;
    this.options.from = from;
    this.options.to = to;
    this.el.innerHTML = '';
    this.keys.clear();
    const whites = [];
    for (let m = from; m <= to; m++) if (!BLACK.has(m % 12)) whites.push(m);
    const w = 100 / whites.length;
    for (let m = from; m <= to; m++) {
      const key = document.createElement('div');
      key.dataset.midi = m;
      key.setAttribute('role', 'button');
      key.setAttribute('aria-label', midiToName(m, { notation: this.options.notation }));
      if (BLACK.has(m % 12)) {
        const leftWhite = whites.indexOf(m - 1);
        key.className = 'ek-key ek-black';
        key.style.left = `calc(${(leftWhite + 1) * w}% - ${w * 0.3}%)`;
        key.style.width = `${w * 0.6}%`;
      } else {
        key.className = `ek-key ek-white${m % 12 === 0 ? ' ek-c' : ''}`;
        if (this.options.labels) {
          key.textContent = midiToName(m, { notation: this.options.notation, octave: m % 12 === 0 });
        }
      }
      if (this.down.has(m)) key.classList.add('ek-down');
      this.el.append(key);
      this.keys.set(m, key);
    }
  }

  /** Lights a key without playing it (e.g. while the song plays). */
  highlight(midi, on = true, cls = 'ek-hint') {
    this.keys.get(midi)?.classList.toggle(cls, on);
  }

  clearHighlights(cls = 'ek-hint') {
    for (const k of this.keys.values()) k.classList.remove(cls);
  }

  press(midi, source = 'api') {
    if (this.down.has(midi)) return;
    this.down.add(midi);
    this.keys.get(midi)?.classList.add('ek-down');
    this.emit('noteon', { midi, source });
  }

  release(midi, source = 'api') {
    if (!this.down.delete(midi)) return;
    this.keys.get(midi)?.classList.remove('ek-down');
    this.emit('noteoff', { midi, source });
  }

  releaseAll() {
    for (const m of [...this.down]) this.release(m);
    this.pointers.clear();
    this.pressedKeys.clear();
  }

  destroy() {
    this.releaseAll();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.el.remove();
  }

  _keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const key = el?.closest?.('.ek-key');
    return key && this.el.contains(key) ? Number(key.dataset.midi) : null;
  }

  _bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      const midi = this._keyAt(e.clientX, e.clientY);
      if (midi == null) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, midi);
      this.press(midi, 'pointer');
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const midi = this._keyAt(e.clientX, e.clientY);
      const prev = this.pointers.get(e.pointerId);
      if (midi === prev) return;
      if (prev != null && ![...this.pointers.entries()].some(([id, m]) => id !== e.pointerId && m === prev)) this.release(prev, 'pointer');
      this.pointers.set(e.pointerId, midi);
      if (midi != null) this.press(midi, 'pointer');
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const midi = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (midi != null && ![...this.pointers.values()].includes(midi)) this.release(midi, 'pointer');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this._onKeyDown = (e) => {
      if (!this.options.computerKeys || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!this.el.isConnected || !this.el.offsetParent) return; // hidden
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'x') {
        this.shiftOctave(k === 'z' ? -1 : 1);
        return;
      }
      let idx = KEYMAP.indexOf(k);
      if (idx < 0 && k in KEYMAP_ALT) idx = KEYMAP_ALT[k];
      if (idx < 0) return;
      e.preventDefault();
      const base = this.options.from + ((12 - (this.options.from % 12)) % 12);
      const midi = base + idx;
      this.pressedKeys.set(k, midi);
      this.press(midi, 'key');
    };
    this._onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      const midi = this.pressedKeys.get(k);
      if (midi == null) return;
      this.pressedKeys.delete(k);
      this.release(midi, 'key');
    };
    this._onBlur = () => this.releaseAll();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }
}
