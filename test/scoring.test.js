import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yin, Scorer, loadSong, freqToMidi } from '../src/index.js';

const sine = (freq, sr = 48000, n = 2048) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr) * 0.5);

test('yin finds the fundamental of pure and rich tones', () => {
  for (const f of [82.4, 196, 261.63, 440, 880]) {
    const r = yin(sine(f), 48000);
    assert.ok(Math.abs(freqToMidi(r.freq) - freqToMidi(f)) < 0.1, `${f} → ${r.freq}`);
  }
  // voice-like: fundamental + strong harmonics
  const buf = Float32Array.from({ length: 2048 }, (_, i) => {
    const t = i / 48000;
    return 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 660 * t);
  });
  assert.ok(Math.abs(yin(buf, 48000).freq - 220) < 2);
  assert.equal(yin(new Float32Array(2048).map(() => Math.random() - 0.5), 48000), null);
});

async function scale() {
  return loadSong({ bpm: 60, notes: [['C4', 1, 'Do'], ['D4', 1, 'Re'], ['E4', 1, 'Mi'], ['F4', 1, 'Fa']] });
}

function sing(scorer, song, pitchAt, until = song.duration + 0.1) {
  for (let t = 0; t <= until; t += 1 / 60) scorer.update(t, pitchAt(t));
}

test('perfect singing gives an S with 5 stars and builds a combo', async () => {
  const song = await scale();
  const s = new Scorer(song);
  const streaks = [];
  s.on('streak', (e) => streaks.push(e.level));
  sing(s, song, (t) => song.notes.find((n) => t >= n.start && t < n.end)?.midi ?? null);
  const r = s.result();
  assert.equal(r.grade, 'S');
  assert.equal(r.stars, 5);
  assert.equal(r.counts.perfect, 4);
  assert.equal(r.maxCombo, 4);
  assert.ok(streaks.length >= 1);
});

test('an octave lower is accepted unless octaveTolerant is off', async () => {
  const song = await scale();
  const low = (t) => (song.notes.find((n) => t >= n.start && t < n.end)?.midi ?? 0) - 12 + 0.2;
  const tolerant = new Scorer(song);
  sing(tolerant, song, low);
  assert.equal(tolerant.result().grade, 'S');
  const strict = new Scorer(song, { octaveTolerant: false });
  sing(strict, song, low);
  assert.equal(strict.result().grade, 'D');
});

test('off-key singing and silence are misses; tolerance follows difficulty', async () => {
  const song = await scale();
  const off = (t) => (song.notes.find((n) => t >= n.start && t < n.end)?.midi ?? 0) + 0.7; // 70 cents sharp
  const normal = new Scorer(song, { tolerance: 55 });
  sing(normal, song, off);
  assert.equal(normal.result().counts.miss, 4);
  const easy = new Scorer(song, { tolerance: 100 });
  sing(easy, song, off);
  assert.equal(easy.result().counts.perfect, 4);
  const silent = new Scorer(song);
  sing(silent, song, () => null);
  assert.equal(silent.result().score, 0);
});

test('reset after a seek re-scores only later notes', async () => {
  const song = await scale();
  const s = new Scorer(song);
  sing(s, song, (t) => song.notes.find((n) => t >= n.start && t < n.end)?.midi ?? null, 2.05);
  const before = s.score;
  assert.ok(before > 0);
  s.reset(1.5);
  assert.equal(s.states[0].done, true);
  assert.equal(s.states[1].done, false);
  assert.ok(s.score < before && s.score > 0);
});

test('transpose shifts the targets', async () => {
  const song = await scale();
  const s = new Scorer(song, { transpose: 3, octaveTolerant: false });
  sing(s, song, (t) => (song.notes.find((n) => t >= n.start && t < n.end)?.midi ?? 0) + 3);
  assert.equal(s.result().grade, 'S');
});

test('legatoGroups liga las sílabas seguidas a la misma altura, sin tocar las demás', async () => {
  const { legatoGroups } = await import('../src/index.js');
  const g = legatoGroups([
    { start: 0, end: 0.5, midi: 60 }, { start: 0.5, end: 1, midi: 60 }, { start: 1.02, end: 1.5, midi: 60 }, // recitado
    { start: 1.5, end: 2, midi: 62 },                                                                         // cambia de nota
    { start: 2.5, end: 3, midi: 62 },                                                                         // tras un silencio
  ]);
  assert.deepEqual(g.map((x) => [x.start, x.end, x.midi, x.count]), [[0, 1.5, 60, 3], [1.5, 2, 62, 1], [2.5, 3, 62, 1]]);
});

let i0 = 0;
test('FeedbackGuard distingue la guía oída por el micrófono de una voz humana', async () => {
  const { FeedbackGuard } = await import('../src/index.js');
  const notes = [0, 1, 2, 3, 4, 5].map((i) => ({ start: i, end: i + 0.9 }));
  const run = (centsAt, onsetOf) => {
    const g = new FeedbackGuard();
    let alarm = false;
    notes.forEach((note, i) => {
      for (let t = note.start + onsetOf(i); t < note.end; t += 1 / 60) g.frame({ time: t, pitch: { note, hit: true, cents: centsAt(t) } });
      alarm ||= g.note({ note });
    });
    return alarm;
  };
  // eco de la guía en un móvil: tono clavado y siempre el mismo retraso (aquí 0,18 s)
  assert.equal(run(() => 1 + Math.sin(i0++) * 0.5, () => 0.18), true);
  // voz con vibrato: oscila
  assert.equal(run((t) => 12 * Math.sin(t * 30), () => 0.15), false);
  // voz muy afinada y casi sin vibrato: entra cada vez con un retraso distinto
  assert.equal(run((t) => 2 * Math.sin(t * 9), (i) => [0.05, 0.16, 0.09, 0.22, 0.04, 0.13][i]), false);
});
