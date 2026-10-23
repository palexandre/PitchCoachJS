/**
 * Entona JSON format, designed to be written by hand.
 *
 * Compact form: notes play one after another, lengths in beats.
 *   {
 *     "title": "Escala", "bpm": 90,
 *     "notes": [
 *       ["Do4", 1, "Do"], ["Re4", 1, "Re"],
 *       ["r", 1],                       // rest
 *       ["Mi4", 2, "/Can-"], ["Fa4", 1, "ción"]   // "/" starts a new line, "-" joins syllables
 *     ]
 *   }
 *
 * Explicit form: times in seconds (or beats if "bpm" is set and "beat" is used).
 *   { "notes": [ { "time": 0.5, "duration": 0.4, "pitch": "C4", "lyric": "Hey" } ] }
 */
import { parsePitch } from '../notes.js';

const isRest = (p) => p === null || p === undefined || /^(r|rest|_|-|silencio)$/i.test(String(p));

export function jsonToSong(data) {
  const obj = typeof data === 'string' ? JSON.parse(data) : data;
  const bpm = Number(obj.bpm) || 0;
  const beatSec = bpm ? 60 / bpm : 1;
  const offset = Number(obj.offset ?? obj.gap ?? 0);
  const notes = [];
  let cursor = 0; // beats (or seconds without bpm)

  for (const item of obj.notes ?? []) {
    if (Array.isArray(item)) {
      const [pitch, length = 1, lyric = ''] = item;
      if (!isRest(pitch)) {
        notes.push({
          start: offset + cursor * beatSec,
          end: offset + (cursor + length) * beatSec,
          midi: parsePitch(pitch),
          syllable: lyric,
        });
      }
      cursor += length;
    } else {
      const start = item.time ?? (item.beat !== undefined ? item.beat * beatSec : cursor * beatSec);
      const dur = item.duration ?? (item.length ?? item.beats ?? 1) * beatSec;
      notes.push({
        start: offset + start,
        end: offset + start + dur,
        midi: parsePitch(item.pitch ?? item.midi),
        syllable: item.lyric ?? item.text ?? '',
        golden: !!item.golden,
      });
      cursor = (start + dur) / beatSec;
    }
  }

  return {
    title: obj.title ?? '',
    artist: obj.artist ?? '',
    notes,
    meta: { format: 'json', bpm },
  };
}
