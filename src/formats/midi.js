/**
 * Standard MIDI File reader (.mid / .midi / .kar) with lyric support.
 *
 * Lyrics are taken from Lyric meta events (FF 05) or, for .kar files,
 * from Text events (FF 01) following the KAR conventions ("/" new line,
 * "\" new paragraph, "@" headers).
 */
import { decodeText } from './text.js';

const DRUM_CHANNEL = 9;

/** Low level parse: header + tracks with absolute-tick events. */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const readStr = (n) => String.fromCharCode(...bytes.subarray(pos, (pos += n)));
  const u32 = () => ((pos += 4), view.getUint32(pos - 4));
  const u16 = () => ((pos += 2), view.getUint16(pos - 2));
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = bytes[pos++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };

  if (readStr(4) !== 'MThd') throw new Error('No es un archivo MIDI válido');
  const headerLen = u32();
  const format = u16();
  const trackCount = u16();
  const division = u16();
  pos = 8 + headerLen;
  if (division & 0x8000) throw new Error('MIDI con división SMPTE no soportado');

  const tracks = [];
  for (let t = 0; t < trackCount && pos < bytes.length; t++) {
    const id = readStr(4);
    const len = u32();
    const end = Math.min(pos + len, bytes.length);
    if (id !== 'MTrk') {
      pos = end;
      continue;
    }
    const events = [];
    let tick = 0;
    let running = 0;
    while (pos < end) {
      tick += vlq();
      let status = bytes[pos];
      if (status & 0x80) pos++;
      else status = running; // running status
      if (status === 0xff) {
        const type = bytes[pos++];
        const l = vlq();
        const data = bytes.subarray(pos, pos + l);
        pos += l;
        events.push({ tick, kind: 'meta', type, data });
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += vlq(); // sysex: skip
      } else {
        running = status;
        const cmd = status & 0xf0;
        const channel = status & 0x0f;
        const a = bytes[pos++];
        const b = cmd === 0xc0 || cmd === 0xd0 ? 0 : bytes[pos++];
        if (cmd === 0x90 && b > 0) events.push({ tick, kind: 'on', channel, key: a, velocity: b });
        else if (cmd === 0x80 || cmd === 0x90) events.push({ tick, kind: 'off', channel, key: a });
        else if (cmd === 0xc0) events.push({ tick, kind: 'program', channel, program: a });
      }
    }
    pos = end;
    tracks.push({ events });
  }
  return { format, division, tracks };
}

/** Builds a tick → seconds converter from every tempo event in the file. */
function tempoMap(midi) {
  const tempos = midi.tracks
    .flatMap((t) => t.events)
    .filter((e) => e.kind === 'meta' && e.type === 0x51)
    .map((e) => ({ tick: e.tick, usPerBeat: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }))
    .sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerBeat: 500000 });

  const segments = [];
  let seconds = 0;
  tempos.forEach((t, i) => {
    if (i > 0) {
      const prev = segments[i - 1];
      seconds = prev.seconds + ((t.tick - prev.tick) * prev.usPerBeat) / 1e6 / midi.division;
    }
    segments.push({ ...t, seconds });
  });

  return (tick) => {
    let s = segments[0];
    for (const seg of segments) {
      if (seg.tick > tick) break;
      s = seg;
    }
    return s.seconds + ((tick - s.tick) * s.usPerBeat) / 1e6 / midi.division;
  };
}

/** Pairs note on/off events of a track. */
function collectNotes(track, trackIndex) {
  const open = new Map();
  const notes = [];
  for (const e of track.events) {
    if (e.kind !== 'on' && e.kind !== 'off') continue;
    const k = e.channel * 128 + e.key;
    if (e.kind === 'on') {
      if (!open.has(k)) open.set(k, []);
      open.get(k).push(e);
    } else {
      const on = open.get(k)?.shift();
      if (on) notes.push({ track: trackIndex, channel: e.channel, midi: e.key, velocity: on.velocity, startTick: on.tick, endTick: e.tick });
    }
  }
  return notes.sort((a, b) => a.startTick - b.startTick);
}

function metaText(e) {
  return decodeText(e.data);
}

/** Lyric events of the whole file: [{tick, text}] plus KAR headers. */
function collectLyrics(midi) {
  const lyricEvents = [];
  const textByTrack = midi.tracks.map(() => []);
  const headers = {};
  midi.tracks.forEach((t, ti) => {
    for (const e of t.events) {
      if (e.kind !== 'meta') continue;
      if (e.type === 0x05) lyricEvents.push({ tick: e.tick, text: metaText(e) });
      if (e.type === 0x01) {
        const text = metaText(e);
        if (text.startsWith('@')) {
          const key = text[1];
          if (key === 'T' && !headers.title) headers.title = text.slice(2).trim();
          else if (key === 'T' && !headers.artist) headers.artist = text.slice(2).trim();
        } else {
          textByTrack[ti].push({ tick: e.tick, text });
        }
      }
    }
  });
  if (lyricEvents.length >= 3) return { lyrics: lyricEvents, headers };
  // .kar: words live as text events, usually in a track named "Words"
  let best = textByTrack.reduce((bi, list, i) => (list.length > textByTrack[bi].length ? i : bi), 0);
  const words = midi.tracks.findIndex((t) => trackName(t)?.toLowerCase() === 'words');
  if (words >= 0 && textByTrack[words].length) best = words;
  const lyrics = textByTrack[best].length >= 3 ? textByTrack[best] : lyricEvents;
  return { lyrics: lyrics.sort((a, b) => a.tick - b.tick), headers };
}

function trackName(track) {
  const e = track.events.find((ev) => ev.kind === 'meta' && ev.type === 0x03);
  return e ? metaText(e).trim() : null;
}

/** Keeps the highest voice when notes overlap, so the melody is singable. */
function monophonic(notes) {
  const sorted = notes.slice().sort((a, b) => a.startTick - b.startTick || b.midi - a.midi);
  const out = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && n.startTick === prev.startTick) continue;
    if (prev && n.startTick < prev.endTick) prev.endTick = n.startTick;
    out.push({ ...n });
  }
  return out.filter((n) => n.endTick > n.startTick);
}

/**
 * Converts a MIDI file to an Entona raw song.
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{melody?: string, title?: string}} [opts] melody: candidate id "track:channel"
 */
export function midiToSong(input, opts = {}) {
  const midi = parseMidi(input);
  const toSec = tempoMap(midi);
  const { lyrics, headers } = collectLyrics(midi);
  const tolerance = midi.division / 4;

  // Every (track, channel) with notes is a melody candidate.
  const groups = new Map();
  midi.tracks.forEach((t, ti) => {
    for (const n of collectNotes(t, ti)) {
      const id = `${ti}:${n.channel}`;
      if (!groups.has(id)) groups.set(id, { id, track: ti, channel: n.channel, name: trackName(t) || `Pista ${ti + 1}`, notes: [] });
      groups.get(id).notes.push(n);
    }
  });

  const candidates = [...groups.values()].map((g) => {
    const starts = new Set(g.notes.map((n) => n.startTick));
    const lyricMatches = lyrics.filter((l) => g.notes.some((n) => Math.abs(n.startTick - l.tick) <= tolerance)).length;
    return { ...g, noteCount: g.notes.length, lyricMatches, polyphony: g.notes.length / Math.max(1, starts.size) };
  });

  const melodic = candidates.filter((c) => c.channel !== DRUM_CHANNEL);
  let chosen = candidates.find((c) => c.id === opts.melody);
  if (!chosen) {
    chosen = melodic.slice().sort((a, b) =>
      b.lyricMatches - a.lyricMatches ||
      a.polyphony - b.polyphony ||
      b.noteCount - a.noteCount,
    )[0];
  }
  if (!chosen) throw new Error('El MIDI no contiene notas');

  const melody = monophonic(chosen.notes);
  const syllables = melody.map(() => '');
  for (const l of lyrics) {
    // nearest note start; lyrics usually sit on the same tick as their note-on
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < melody.length; i++) {
      const d = Math.abs(melody[i].startTick - l.tick);
      if (d < bestD) [bestD, bestI] = [d, i];
      if (melody[i].startTick > l.tick + tolerance) break;
    }
    if (bestI >= 0) syllables[bestI] += l.text;
  }

  const notes = melody.map((n, i) => ({
    start: toSec(n.startTick),
    end: toSec(n.endTick),
    midi: n.midi,
    syllable: syllables[i],
  }));

  const accompaniment = candidates
    .filter((c) => c !== chosen && c.channel !== DRUM_CHANNEL)
    .flatMap((c) => c.notes)
    .map((n) => ({ start: toSec(n.startTick), end: toSec(n.endTick), midi: n.midi, velocity: n.velocity / 127, channel: n.channel }));

  const seqName = midi.tracks[0] ? trackName(midi.tracks[0]) : null;
  const firstTempo = midi.tracks.flatMap((t) => t.events).filter((e) => e.kind === 'meta' && e.type === 0x51).sort((a, b) => a.tick - b.tick)[0];
  const tempo = firstTempo ? Math.round((60e6 / ((firstTempo.data[0] << 16) | (firstTempo.data[1] << 8) | firstTempo.data[2])) * 100) / 100 : 120;
  return {
    title: opts.title || headers.title || seqName || '',
    artist: headers.artist || '',
    notes,
    accompaniment,
    meta: {
      format: 'midi',
      tempo,
      melody: chosen.id,
      hasLyrics: lyrics.length > 0,
      candidates: candidates.map(({ id, name, channel, noteCount, lyricMatches }) => ({ id, name, channel, noteCount, lyricMatches })),
    },
  };
}
