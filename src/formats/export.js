/**
 * Exporters: save songs written in the editor (or any loaded song) as
 * PitchCoach JSON or as a MIDI file with lyric events.
 *
 * A "draft" is the editor's model, with times in beats:
 *   { title, artist, bpm, lyricsText, notes: [{ beat, length, midi, lyric }] }
 */
import { writeMidi } from './midi-writer.js';
import { midiToName } from '../notes.js';

/** Draft → PitchCoach JSON object (loadable with loadSong). */
export function draftToJSON(draft) {
  return {
    title: draft.title || 'Mi canción',
    artist: draft.artist || '',
    bpm: draft.bpm,
    lyricsText: draft.lyricsText ?? undefined,
    notes: draft.notes.map((n) => ({
      beat: round(n.beat),
      length: round(n.length),
      pitch: midiToName(n.midi),
      lyric: n.lyric ?? '',
    })),
  };
}

/** Draft → MIDI bytes (one melody track with lyrics). */
export function draftToMidi(draft, { division = 480 } = {}) {
  return writeMidi({
    division,
    bpm: draft.bpm,
    title: draft.title || 'Mi canción',
    tracks: [{
      name: 'Voz',
      channel: 0,
      notes: draft.notes.map((n) => ({
        tick: Math.round(n.beat * division),
        length: Math.max(1, Math.round(n.length * division) - 8),
        midi: n.midi,
        lyric: midiLyric(n.lyric),
      })),
    }],
  });
}

/**
 * Finalized song (times in seconds) → draft in beats.
 * Useful to open any song in the editor.
 */
export function songToDraft(song, { bpm, grid = 0.25 } = {}) {
  // UltraStar's #BPM is not a musical tempo, so only MIDI and JSON tempos are trusted
  const tempo = bpm || song.meta?.tempo || (song.meta?.format === 'json' && song.meta.bpm) || 100;
  const q = (sec) => Math.round((sec * tempo) / 60 / grid) * grid;
  return {
    title: song.title,
    artist: song.artist,
    bpm: Math.round(tempo),
    notes: song.notes.map((n) => {
      const beat = q(n.start);
      return { beat, length: Math.max(grid, q(n.end) - beat), midi: n.midi, lyric: (n.lineBreak && n.index > 0 ? '/' : '') + n.lyric };
    }),
  };
}

// Lyric event text: our MIDI reader joins "syl-" with the next syllable and
// treats a trailing space as the end of a word.
function midiLyric(lyric = '') {
  if (!lyric) return '';
  return /-$/.test(lyric) ? lyric : `${lyric} `;
}

const round = (x) => Math.round(x * 1000) / 1000;
