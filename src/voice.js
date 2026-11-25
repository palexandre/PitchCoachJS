/**
 * Voz del cantante: tipo de voz, zona cómoda y tono automático para cada canción.
 *
 *   const range = { low: 45, high: 64, speak: 47 };   // MIDI, de la prueba de voz
 *   classifyVoice(range).name;                         // 'Barítono'
 *   fitKey(song, range).shift;                         // semitonos para esa canción
 */

// Rangos orientativos de voces sin formación (más estrechos que los de un cantante profesional).
// speak: nota media al hablar.
export const VOICE_TYPES = [
  { id: 'bajo', name: 'Bajo', low: 40, high: 62, speak: 41 },
  { id: 'baritono', name: 'Barítono', low: 43, high: 65, speak: 44 },
  { id: 'tenor', name: 'Tenor', low: 47, high: 69, speak: 47 },
  { id: 'contralto', name: 'Contralto', low: 53, high: 74, speak: 52 },
  { id: 'mezzosoprano', name: 'Mezzosoprano', low: 56, high: 77, speak: 55 },
  { id: 'soprano', name: 'Soprano', low: 59, high: 81, speak: 57 },
];

/** Voz grave estándar (La2–Re4), para quien no ha hecho la prueba. */
export const DEFAULT_RANGE = { low: 45, high: 62, speak: 47 };

/** El tipo de voz cuyo rango típico se parece más al medido. */
export function classifyVoice({ low, high, speak }) {
  const cost = (t) => Math.abs(low - t.low) + Math.abs(high - t.high) + (speak == null ? 0 : 1.5 * Math.abs(speak - t.speak));
  return VOICE_TYPES.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}

/** Zona cómoda: el rango sin los extremos, que cuestan (sobre todo arriba). */
export function comfortZone({ low, high }) {
  const span = high - low;
  return { low: low + Math.min(3, span * 0.15), high: high - Math.min(4, span * 0.2) };
}

/** Altura central de una canción: la mediana de sus notas ponderada por duración. */
export function tessitura(song) {
  const notes = song.notes.filter((n) => n.end > n.start).sort((a, b) => a.midi - b.midi);
  const total = notes.reduce((s, n) => s + n.end - n.start, 0);
  let acc = 0;
  for (const n of notes) {
    acc += n.end - n.start;
    if (acc >= total / 2) return n.midi;
  }
  return notes.length ? notes[0].midi : 60;
}

/**
 * Semitonos que hay que mover la canción para cantarla cómodo: su parte central cae en la
 * zona cómoda y la nota más aguda queda al menos `topMargin` semitonos por debajo del máximo.
 * @returns {{ shift: number, fits: boolean }} fits = false si la canción abarca más que la voz
 */
export function fitKey(song, range, { topMargin = 2 } = {}) {
  if (!song?.notes?.length) return { shift: 0, fits: true };
  const lowest = song.lowest ?? Math.min(...song.notes.map((n) => n.midi));
  const highest = song.highest ?? Math.max(...song.notes.map((n) => n.midi));
  const zone = comfortZone(range);
  let shift = Math.round((zone.low + zone.high) / 2 - tessitura(song));
  const maxTop = range.high - topMargin;
  if (highest + shift > maxTop) shift = Math.floor(maxTop - highest);
  else if (lowest + shift < range.low) shift = Math.min(Math.ceil(range.low - lowest), Math.floor(maxTop - highest));
  return { shift, fits: lowest + shift >= range.low && highest + shift <= range.high };
}

/**
 * Notas fiables de una serie de lecturas (MIDI o null, ~60 por segundo): solo las que se
 * mantienen estables unas décimas, para que un chasquido o un salto de octava no cuenten.
 */
export function stablePitches(frames, { window = 9, spread = 0.6 } = {}) {
  const out = [];
  for (let i = 0; i + window <= frames.length; i++) {
    const w = frames.slice(i, i + window);
    if (w.some((m) => m == null)) continue;
    const sorted = [...w].sort((a, b) => a - b);
    if (sorted.at(-1) - sorted[0] <= spread * 2) out.push(sorted[Math.floor(window / 2)]);
  }
  return out;
}

/** Percentil p (0–1) de una lista de números. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}
