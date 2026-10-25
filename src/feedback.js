/**
 * Detecta si el micrófono capta lo que suena por el altavoz (sin auriculares,
 * la app se oiría a sí misma y puntuaría la melodía guía como si cantara el usuario).
 *
 *   const { leaking } = await checkFeedback({ audioContext, stream, midis: [62, 64, 67] });
 *
 *   const guard = new FeedbackGuard();        // durante la partida
 *   game.on('frame', (f) => guard.frame(f));
 *   game.on('note', (e) => guard.note(e) && pausarYAvisar());
 */
import { PitchDetector } from './pitch-detector.js';
import { midiToFreq } from './notes.js';

/**
 * Toca unas notas cortas por el altavoz y comprueba si el micrófono las reconoce.
 * @param {object} o
 * @param {AudioContext} o.audioContext
 * @param {MediaStream} o.stream micrófono ya abierto (no se cierra)
 * @param {number[]} [o.midis] notas a tocar (mejor las de la canción, al volumen de la guía)
 * @param {number} [o.volume=0.3]
 * @param {number} [o.noteLength=0.2] segundos por nota
 * @returns {Promise<{leaking: boolean, ratio: number}>}
 */
export async function checkFeedback({ audioContext: ctx, stream, midis = [60, 64, 67, 72], volume = 0.3, noteLength = 0.2 }) {
  if (ctx.state === 'suspended') await ctx.resume();
  const det = new PitchDetector({ audioContext: ctx, minVolume: 0.004 });
  await det.start({ input: stream, loop: false });

  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.08;
  const tones = midis.slice(0, 4).map((midi, i) => ({ midi, start: t0 + i * noteLength, end: t0 + (i + 1) * noteLength }));
  for (const t of tones) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToFreq(t.midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t.start);
    g.gain.linearRampToValueAtTime(1, t.start + 0.01);
    g.gain.setValueAtTime(1, t.end - 0.02);
    g.gain.linearRampToValueAtTime(0, t.end);
    o.connect(g).connect(out);
    o.start(t.start);
    o.stop(t.end + 0.02);
  }

  // se cuenta en qué parte del tiempo de cada nota el micrófono oye esa misma nota
  let frames = 0;
  let hits = 0;
  const end = tones[tones.length - 1].end + 0.12;
  await new Promise((resolve) => {
    const tick = () => {
      const now = ctx.currentTime;
      const p = det.read();
      const tone = tones.find((t) => now >= t.start + 0.06 && now < t.end + 0.05);
      if (tone) {
        frames++;
        if (p) {
          const diff = p.midi - tone.midi;
          if (Math.abs(diff - 12 * Math.round(diff / 12)) < 0.5) hits++;
        }
      }
      if (now >= end) resolve();
      else setTimeout(tick, 15);
    };
    tick();
  });
  det.stop();
  out.disconnect();
  const ratio = frames ? hits / frames : 0;
  return { leaking: ratio >= 0.3, ratio };
}

/**
 * Durante la partida: una voz humana nunca mantiene el tono tan fijo como la guía
 * sintetizada, ni empieza cada nota exactamente a la vez que ella. Si varias notas
 * seguidas son así, el micrófono está oyendo la guía.
 */
export class FeedbackGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSpread=3] cents de variación por debajo de los que el tono es «demasiado fijo»
   * @param {number} [opts.maxOnset=0.09] segundos de retraso máximo al empezar la nota
   * @param {number} [opts.notes=3] notas seguidas así para dar la alarma
   */
  constructor({ maxSpread = 3, maxOnset = 0.09, notes = 3 } = {}) {
    Object.assign(this, { maxSpread, maxOnset, needed: notes });
    this.reset();
  }

  reset() {
    this.cur = null;
    this.streak = 0;
  }

  /** @param {{time: number, pitch: {note?: object, hit?: boolean, cents?: number}}} f evento 'frame' del juego */
  frame({ time, pitch }) {
    const n = pitch?.note;
    if (!n) return;
    if (this.cur?.note !== n) this.cur = { note: n, cents: [], first: null };
    if (pitch.hit && pitch.cents != null) {
      this.cur.first ??= time;
      this.cur.cents.push(pitch.cents);
    }
  }

  /**
   * @param {{note: object}} e evento 'note' del juego
   * @returns {boolean} true si el micrófono parece estar oyendo la guía
   */
  note({ note }) {
    const c = this.cur?.note === note ? this.cur : null;
    this.cur = null;
    if (!c || c.cents.length < 8) {
      this.streak = 0;
      return false;
    }
    const mean = c.cents.reduce((s, v) => s + v, 0) / c.cents.length;
    const spread = Math.sqrt(c.cents.reduce((s, v) => s + (v - mean) ** 2, 0) / c.cents.length);
    const onset = c.first - note.start;
    this.streak = spread < this.maxSpread && onset < this.maxOnset ? this.streak + 1 : 0;
    return this.streak >= this.needed;
  }
}
