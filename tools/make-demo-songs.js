// Generates example/songs/martinillo.mid (traditional song, public domain).
// Usage: node tools/make-demo-songs.js
import { writeFileSync } from 'node:fs';
import { writeMidi } from '../src/formats/midi-writer.js';

const Q = 480; // quarter note
const seq = (items) => {
  let tick = 0;
  return items.map(([midi, beats, lyric]) => {
    const n = { tick, length: Math.round(beats * Q * 0.95), midi, lyric };
    tick += beats * Q;
    return n;
  }).filter((n) => n.midi);
};

const C = 60, D = 62, E = 64, F = 65, G = 67, A = 69, G3 = 55;
const melody = seq([
  [C, 1, '/Mar-'], [D, 1, 'ti-'], [E, 1, 'ni-'], [C, 1, 'llo, '],
  [C, 1, 'Mar-'], [D, 1, 'ti-'], [E, 1, 'ni-'], [C, 1, 'llo, '],
  [E, 1, '/¿dón-'], [F, 1, 'de es-'], [G, 2, 'tás? '],
  [E, 1, '¿dón-'], [F, 1, 'de es-'], [G, 2, 'tás? '],
  [G, 0.5, '/To-'], [A, 0.5, 'ca '], [G, 0.5, 'la '], [F, 0.5, 'cam-'], [E, 1, 'pa-'], [C, 1, 'na, '],
  [G, 0.5, 'to-'], [A, 0.5, 'ca '], [G, 0.5, 'la '], [F, 0.5, 'cam-'], [E, 1, 'pa-'], [C, 1, 'na, '],
  [C, 1, '/din '], [G3, 1, 'don '], [C, 2, 'dan, '],
  [C, 1, 'din '], [G3, 1, 'don '], [C, 2, 'dan.'],
]);

// Simple bass: root on every half note.
const bass = [];
for (let bar = 0; bar < 9; bar++) {
  bass.push({ tick: bar * 4 * Q, length: 2 * Q - 20, midi: 48, velocity: 70 });
  bass.push({ tick: bar * 4 * Q + 2 * Q, length: 2 * Q - 20, midi: 43, velocity: 60 });
}

// The melody starts after one bar of bass.
const shift = (notes, ticks) => notes.map((n) => ({ ...n, tick: n.tick + ticks }));

const bytes = writeMidi({
  bpm: 96,
  title: 'Martinillo',
  tracks: [
    { name: 'Voz', channel: 0, notes: shift(melody, 4 * Q) },
    { name: 'Bajo', channel: 1, notes: bass },
  ],
});
writeFileSync(new URL('../example/songs/martinillo.mid', import.meta.url), bytes);
console.log('example/songs/martinillo.mid', bytes.length, 'bytes');
