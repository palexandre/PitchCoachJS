import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoice, fitKey, stablePitches, percentile, loadSong } from '../src/index.js';

test('classifyVoice reconoce voces típicas', () => {
  assert.equal(classifyVoice({ low: 41, high: 61, speak: 42 }).id, 'bajo');
  assert.equal(classifyVoice({ low: 44, high: 65, speak: 45 }).id, 'baritono');
  assert.equal(classifyVoice({ low: 48, high: 70, speak: 48 }).id, 'tenor');
  assert.equal(classifyVoice({ low: 57, high: 78 }).id, 'mezzosoprano');
  assert.equal(classifyVoice({ low: 60, high: 82, speak: 57 }).id, 'soprano');
});

test('fitKey centra la canción y deja margen arriba', async () => {
  const song = await loadSong({ bpm: 60, notes: [['C5', 1, 'a'], ['D5', 4, 'b'], ['E5', 1, 'c'], ['G5', 1, 'd']] });
  const range = { low: 45, high: 64 };
  const { shift, fits } = fitKey(song, range);
  assert.ok(79 + shift <= 62, 'la nota más aguda queda 2 semitonos por debajo del máximo');
  assert.ok(fits);
  // una canción muy amplia no cabe: prima no pasarse por arriba
  const wide = await loadSong({ bpm: 60, notes: [['C3', 1, 'a'], ['C5', 1, 'b']] });
  const r = fitKey(wide, range);
  assert.equal(72 + r.shift, 62);
  assert.equal(r.fits, false);
});

test('stablePitches ignora saltos sueltos', () => {
  const frames = [...Array(20).fill(50), 62, ...Array(20).fill(50.2), null, null, ...Array(20).fill(45)];
  const s = stablePitches(frames);
  assert.ok(s.every((m) => m < 51));
  assert.equal(percentile(s, 0), 45);
});
