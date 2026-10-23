/**
 * UltraStar / Vocaluxe / Performous .txt karaoke format.
 *
 *   #TITLE:Mi canción
 *   #BPM:200          (one beat lasts 60 / (BPM * 4) seconds)
 *   #GAP:1500         (ms before beat 0)
 *   : 0 4 5 Hel       (type start length pitch syllable; pitch 0 = C4)
 *   * 4 4 7 lo        (golden note)
 *   F 8 2 0 ~         (freestyle: shown, not scored)
 *   - 12              (line break)
 *   E
 */
export function ultrastarToSong(text) {
  const headers = {};
  const notes = [];
  let pendingBreak = false;
  let beatOffset = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '');
    if (line.startsWith('#')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(1, i).trim().toUpperCase()] = line.slice(i + 1).trim();
      continue;
    }
    if (line.startsWith('E')) break;
    if (line.startsWith('-')) {
      pendingBreak = true;
      const parts = line.slice(1).trim().split(/\s+/).map(Number);
      if (/^yes$/i.test(headers.RELATIVE ?? '')) beatOffset += parts[1] ?? parts[0] ?? 0;
      continue;
    }
    const m = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/.exec(line);
    if (!m) continue;
    notes.push({
      type: m[1],
      beat: Number(m[2]) + beatOffset,
      length: Number(m[3]),
      pitch: Number(m[4]),
      text: m[5],
      lineBreak: pendingBreak,
    });
    pendingBreak = false;
  }

  const bpm = parseFloat((headers.BPM ?? '').replace(',', '.'));
  if (!bpm) throw new Error('UltraStar: falta #BPM');
  const gap = parseFloat((headers.GAP ?? '0').replace(',', '.')) / 1000;
  const beatSec = 60 / (bpm * 4);

  return {
    title: headers.TITLE ?? '',
    artist: headers.ARTIST ?? '',
    notes: notes.map((n) => ({
      start: gap + n.beat * beatSec,
      end: gap + (n.beat + Math.max(n.length, 1)) * beatSec,
      midi: 60 + n.pitch,
      syllable: n.text,
      lineBreak: n.lineBreak,
      golden: n.type === '*' || n.type === 'G',
      freestyle: n.type === 'F' || n.type === 'R',
    })),
    meta: { format: 'ultrastar', bpm, gap },
  };
}
