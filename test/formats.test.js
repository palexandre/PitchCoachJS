import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSong, parsePitch, midiToName } from '../src/index.js';
import { writeMidi } from '../src/formats/midi-writer.js';

const songsDir = new URL('../example/songs/', import.meta.url);

test('parsePitch understands English and solfège names', () => {
  assert.equal(parsePitch('C4'), 60);
  assert.equal(parsePitch('Do4'), 60);
  assert.equal(parsePitch('Sol#3'), 56);
  assert.equal(parsePitch('Bb2'), 46);
  assert.equal(parsePitch('Mib4'), 63);
  assert.equal(parsePitch('la'), 69);
  assert.equal(midiToName(67, { notation: 'solfege' }), 'Sol4');
});

test('MIDI with lyric events: picks the melody track and joins syllables', async () => {
  const song = await loadSong(readFileSync(new URL('martinillo.mid', songsDir)));
  assert.equal(song.title, 'Martinillo');
  assert.equal(song.meta.melody, '1:0');
  assert.equal(song.notes.length, 32);
  assert.ok(song.accompaniment.length > 0);
  assert.equal(song.notes[0].lyric, 'Mar-');
  assert.equal(song.lines.length, 4);
  assert.equal(song.lines[0].text.trim(), 'Martinillo, Martinillo,');
  assert.equal(song.lines[2].text.trim(), 'Toca la campana, toca la campana,');
  // 96 bpm, melody starts after one bar
  assert.ok(Math.abs(song.notes[0].start - 2.5) < 1e-6);
});

test('MIDI: melody choice can be forced and overlapping notes become monophonic', async () => {
  const bytes = writeMidi({
    bpm: 120,
    tracks: [
      { name: 'Piano', channel: 0, notes: [
        { tick: 0, length: 960, midi: 60 }, { tick: 0, length: 960, midi: 64 }, { tick: 480, length: 480, midi: 67 },
      ] },
      { name: 'Batería', channel: 9, notes: [{ tick: 0, length: 100, midi: 36 }] },
    ],
  });
  const song = await loadSong(bytes);
  assert.deepEqual(song.notes.map((n) => n.midi), [64, 67]);
  assert.equal(song.notes[0].end, 0.5);
  const forced = await loadSong(bytes, { melody: '2:9' });
  assert.equal(forced.notes[0].midi, 36);
});

test('KAR style text events with "/" and leading spaces', async () => {
  // Build a file whose lyrics are Text (FF 01) events like .kar files.
  const bytes = writeMidi({ tracks: [{ name: 'Melody', notes: [
    { tick: 0, length: 400, midi: 60 }, { tick: 480, length: 400, midi: 62 }, { tick: 960, length: 400, midi: 64 }, { tick: 1440, length: 400, midi: 65 },
  ] }] });
  // append a track with text events
  const raw = Buffer.from(bytes);
  const textTrack = buildTextTrack([[0, '@TCanción'], [0, '/Ho'], [480, 'la'], [960, ' mun'], [1440, 'do']]);
  raw.writeUInt16BE(raw.readUInt16BE(10) + 1, 10);
  const song = await loadSong(Buffer.concat([raw, textTrack]));
  assert.equal(song.title, 'Canción');
  assert.deepEqual(song.notes.map((n) => n.lyric), ['Ho', 'la', 'mun', 'do']);
  assert.equal(song.lines[0].text, 'Hola mundo');
});

function buildTextTrack(items) {
  const body = [];
  let last = 0;
  for (const [tick, s] of items) {
    const data = [...Buffer.from(s, 'latin1')];
    body.push(...vlq(tick - last), 0xff, 0x01, data.length, ...data);
    last = tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}

function vlq(n) {
  const b = [n & 0x7f];
  while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80);
  return b;
}

test('UltraStar txt', async () => {
  const song = await loadSong(readFileSync(new URL('estrellita.txt', songsDir), 'utf8'));
  assert.equal(song.title, 'Estrellita');
  assert.equal(song.notes.length, 42);
  assert.equal(song.lines.length, 6);
  assert.equal(song.notes[0].start, 2);
  assert.equal(song.notes[0].midi, 60);
  assert.equal(song.lines[0].text.trim(), 'Estrellita, ¿dónde estás?');
  assert.ok(song.notes.some((n) => n.golden));
});

test('UltraStar relative mode and line breaks', async () => {
  const txt = '#TITLE:R\n#BPM:60\n#RELATIVE:yes\n: 0 2 0 a\n- 4 4\n: 0 2 2 b\nE\n';
  const song = await loadSong(txt);
  assert.deepEqual(song.notes.map((n) => n.start), [0, 1]);
  assert.equal(song.lines.length, 2);
});

test('JSON compact form with rests, joins and solfège pitches', async () => {
  const song = await loadSong({ bpm: 60, notes: [['r', 1], ['Do4', 1, 'Can-'], ['Re4', 2, 'ción'], ['Mi4', 1, 'bo-'], ['Fa4', 1, 'ni-'], ['Sol4', 1, 'ta']] });
  assert.equal(song.notes[0].start, 1);
  assert.equal(song.notes[1].end, 4);
  assert.equal(song.lines[0].text, 'Canción bonita ');
  const scale = await loadSong(readFileSync(new URL('escala.json', songsDir), 'utf8'));
  assert.equal(scale.title, 'Escala de Do');
  assert.equal(scale.lines.length, 3);
});

test('JSON explicit form in seconds', async () => {
  const song = await loadSong(JSON.stringify({ notes: [{ time: 0.5, duration: 0.25, pitch: 'A4', lyric: 'la' }] }));
  assert.equal(song.notes[0].midi, 69);
  assert.equal(song.duration, 0.75);
});
