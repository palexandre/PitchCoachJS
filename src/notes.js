/** Pitch helpers: MIDI numbers, frequencies and note names (English or solfège). */

const ENGLISH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

const PITCH_CLASS = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
  do: 0, re: 2, mi: 4, fa: 5, sol: 7, so: 7, la: 9, si: 11, ti: 11,
};

export const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const freqToMidi = (freq) => 69 + 12 * Math.log2(freq / 440);

/**
 * Name of a MIDI note.
 * @param {number} midi
 * @param {{notation?: 'english'|'solfege', octave?: boolean}} [opts]
 */
export function midiToName(midi, { notation = 'english', octave = true } = {}) {
  const n = Math.round(midi);
  const names = notation === 'solfege' ? SOLFEGE : ENGLISH;
  const name = names[((n % 12) + 12) % 12];
  return octave ? `${name}${Math.floor(n / 12) - 1}` : name;
}

/**
 * Parse a pitch: a MIDI number or a name like "C4", "F#3", "Bb2", "Do4", "Sol#3", "Mib4".
 * The octave defaults to 4 (C4 = Do4 = MIDI 60).
 * @returns {number} MIDI note number
 */
export function parsePitch(pitch) {
  if (typeof pitch === 'number') return pitch;
  const m = /^\s*(sol|do|re|mi|fa|so|la|si|ti|[a-g])\s*([#b♯♭s]*)\s*(-?\d+)?\s*$/i.exec(String(pitch));
  if (!m) throw new Error(`Nota no reconocida: "${pitch}"`);
  let pc = PITCH_CLASS[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' || ch === 's' ? 1 : -1;
  const octave = m[3] === undefined ? 4 : Number(m[3]);
  return 12 * (octave + 1) + pc;
}
