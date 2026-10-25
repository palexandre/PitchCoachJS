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
 * Toca unas notas por el altavoz y comprueba si el micrófono las reconoce.
 * Antes espera a que el micrófono «despierte» (muchos móviles dan silencio el primer
 * medio segundo) y sube las notas a una zona que el altavoz de un móvil sí reproduce.
 * @param {object} o
 * @param {AudioContext} o.audioContext
 * @param {MediaStream} o.stream micrófono ya abierto (no se cierra)
 * @param {number[]} [o.midis] notas a tocar (se suben de octava si son graves)
 * @param {number} [o.volume=0.3]
 * @param {number} [o.noteLength=0.28] segundos por nota
 * @param {AbortSignal} [o.signal] para cortarla si el usuario sale
 * @returns {Promise<{leaking: boolean, ratio: number, aborted?: boolean}>}
 */
export async function checkFeedback({ audioContext: ctx, stream, midis = [72, 76, 79, 84], volume = 0.3, noteLength = 0.28, signal }) {
  if (ctx.state === 'suspended') await ctx.resume();
  const det = new PitchDetector({ audioContext: ctx, minVolume: 0.003 });
  await det.start({ input: stream, loop: false });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) esperar a que llegue sonido del micrófono (hasta 1,2 s)
  const t0 = performance.now();
  while (performance.now() - t0 < 1200 && !signal?.aborted) {
    det.read();
    if (det.volume > 0.0005 && performance.now() - t0 > 250) break;
    await wait(30);
  }
  await wait(150);
  if (signal?.aborted) {
    det.stop();
    return { leaking: false, ratio: 0, aborted: true };
  }

  // 2) notas en la zona de 520–1050 Hz, que cualquier altavoz reproduce
  const toneMidis = (midis.length ? midis : [72, 76, 79, 84]).slice(0, 4).map((m) => {
    let x = m;
    while (x < 72) x += 12;
    while (x > 88) x -= 12;
    return x;
  });
  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(ctx.destination);
  const start = ctx.currentTime + 0.05;
  const tones = toneMidis.map((midi, i) => ({ midi, start: start + i * noteLength, end: start + (i + 1) * noteLength }));
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
  signal?.addEventListener('abort', () => out.disconnect(), { once: true });

  // 3) en qué parte de cada nota el micrófono oye esa misma nota (cualquier octava);
  //    se deja margen por el retraso del altavoz al micrófono
  let frames = 0;
  let hits = 0;
  const end = tones[tones.length - 1].end + 0.35;
  while (ctx.currentTime < end && !signal?.aborted) {
    const now = ctx.currentTime;
    const p = det.read();
    const tone = tones.find((t) => now >= t.start + 0.08 && now < t.end + 0.25);
    if (tone) {
      frames++;
      if (p && tones.some((t) => now >= t.start && now < t.end + 0.3 && Math.abs(((p.midi - t.midi) % 12 + 18) % 12 - 6) < 0.5)) hits++;
    }
    await wait(15);
  }
  det.stop();
  out.disconnect();
  if (signal?.aborted) return { leaking: false, ratio: 0, aborted: true };
  const ratio = frames ? hits / frames : 0;
  return { leaking: ratio >= 0.25, ratio };
}

/**
 * Durante la partida: una voz humana nunca mantiene el tono tan fijo como la guía
 * sintetizada, ni empieza cada nota exactamente a la vez que ella. Si varias notas
 * seguidas son así, el micrófono está oyendo la guía.
 */
export class FeedbackGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSpread=5] cents de variación por debajo de los que el tono es «demasiado fijo»
   * @param {number} [opts.maxOnsetJitter=0.035] s: el eco llega siempre con el mismo retraso; una voz no
   * @param {number} [opts.notes=4] notas seguidas así para dar la alarma
   */
  constructor({ maxSpread = 5, maxOnsetJitter = 0.035, notes = 4 } = {}) {
    Object.assign(this, { maxSpread, maxOnsetJitter, needed: notes });
    this.reset();
  }

  reset() {
    this.cur = null;
    this.recent = []; // retrasos de las últimas notas «demasiado fijas»
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
      this.recent = [];
      return false;
    }
    const mean = c.cents.reduce((s, v) => s + v, 0) / c.cents.length;
    const spread = Math.sqrt(c.cents.reduce((s, v) => s + (v - mean) ** 2, 0) / c.cents.length);
    const onset = c.first - note.start;
    if (spread >= this.maxSpread || onset > 0.5) {
      this.recent = [];
      return false;
    }
    this.recent.push(onset);
    if (this.recent.length > this.needed) this.recent.shift();
    if (this.recent.length < this.needed) return false;
    const m = this.recent.reduce((s, v) => s + v, 0) / this.recent.length;
    const jitter = Math.sqrt(this.recent.reduce((s, v) => s + (v - m) ** 2, 0) / this.recent.length);
    return jitter < this.maxOnsetJitter;
  }
}
