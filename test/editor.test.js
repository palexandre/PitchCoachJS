import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLyrics, joinLyrics, segmentsToNotes, NoteRecorder, draftToJSON, draftToMidi, songToDraft, loadSong } from '../src/index.js';

test('splitLyrics: syllables, words, lines, sinalefa and melisma', () => {
  assert.deepEqual(splitLyrics('Mar-ti-ni-llo,\n¿dón-de_es-tás? ~'), ['Mar-', 'ti-', 'ni-', 'llo,', '/¿dón-', 'de es-', 'tás?', '~']);
  assert.deepEqual(splitLyrics('  '), []);
});

test('joinLyrics is the reverse of splitLyrics on a finalized song', async () => {
  const text = 'Es-tre-lli-ta,\n¿dón-de_es-tás?';
  const syl = splitLyrics(text);
  const song = await loadSong({ bpm: 60, notes: syl.map((s) => ['C4', 1, s]) });
  assert.equal(joinLyrics(song.notes), text);
  assert.equal(song.lines.length, 2);
  assert.equal(song.lines[1].text.trim(), '¿dónde estás?');
});

test('segmentsToNotes quantizes and keeps one note at a time', () => {
  const notes = segmentsToNotes([
    { start: 0.02, end: 0.48, midi: 60 },
    { start: 0.45, end: 1.1, midi: 62.2 }, // overlaps the previous one
    { start: 1.5, end: 1.52, midi: 64 },   // very short → one grid step
  ], { bpm: 60, grid: 0.25 });
  assert.deepEqual(notes, [
    { beat: 0, length: 0.5, midi: 60 },
    { beat: 0.5, length: 0.5, midi: 62 },
    { beat: 1.5, length: 0.25, midi: 64 },
  ]);
});

test('NoteRecorder: keys and voice', () => {
  const keys = new NoteRecorder({ bpm: 120, startTime: 10, startBeat: 4 });
  keys.noteOn(60, 10);
  keys.noteOn(64, 10.5); // legato: closes the first one
  keys.noteOff(64, 11);
  assert.deepEqual(keys.finish(12), [{ beat: 4, length: 1, midi: 60 }, { beat: 5, length: 1, midi: 64 }]);

  const voice = new NoteRecorder({ bpm: 60, startTime: 0 });
  for (let t = 0; t < 2; t += 0.01) {
    const midi = t < 1 ? 67 + Math.sin(t * 40) * 0.2 : t < 1.9 ? 69.1 : null; // vibrato, then a step, then silence
    voice.pitch(midi, t);
  }
  const notes = voice.finish(2);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.midi), [67, 69]);
  assert.equal(notes[0].beat, 0);
  assert.equal(notes[1].beat, 1);
});

test('drafts export to JSON and MIDI and load back with lyrics', async () => {
  const syl = splitLyrics('Can-ta con-mi-go');
  const draft = { title: 'Prueba', bpm: 90, notes: [60, 62, 64, 65, 67].map((midi, i) => ({ beat: i, length: 1, midi, lyric: syl[i] })) };
  const fromJson = await loadSong(draftToJSON(draft));
  const fromMidi = await loadSong(draftToMidi(draft));
  for (const s of [fromJson, fromMidi]) {
    assert.equal(s.title, 'Prueba');
    assert.deepEqual(s.notes.map((n) => n.midi), [60, 62, 64, 65, 67]);
    assert.equal(s.lines[0].text.trim(), 'Canta conmigo');
    assert.ok(Math.abs(s.notes[1].start - 60 / 90) < 1e-3);
  }
  assert.equal(fromMidi.meta.tempo, 90);
  const back = songToDraft(fromMidi);
  assert.equal(back.bpm, 90);
  assert.deepEqual(back.notes.map((n) => [n.beat, n.midi]), draft.notes.map((n) => [n.beat, n.midi]));
});

test('NoteRecorder.instrument: piano through the mic splits repeated notes on each attack', () => {
  const rec = new NoteRecorder({ bpm: 60, startTime: 0 });
  // Do Do Sol (struck at 0, 1 and 2 s), each decaying like a piano, then silence
  const strikes = [[0, 60], [1, 60], [2, 67]];
  for (let t = 0; t < 3.6; t += 1 / 60) {
    const [start, midi] = [...strikes].reverse().find(([s]) => t >= s);
    const age = t - start;
    const volume = 0.2 * Math.exp(-age * 1.5) + 0.001;
    const pitch = age < 0.02 ? null : midi + 0.1; // attack noise has no pitch
    rec.instrument(volume > 0.01 ? pitch : null, volume, t);
  }
  const notes = rec.finish(3.6);
  assert.deepEqual(notes.map((n) => [n.beat, n.midi]), [[0, 60], [1, 60], [2, 67]]);
  assert.ok(notes[2].length >= 1);
});
