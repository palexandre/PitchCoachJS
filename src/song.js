/**
 * Song model shared by every format.
 *
 * Song {
 *   title, artist,
 *   notes: Note[]          // the melody to sing (monophonic, sorted)
 *   accompaniment: Note[]  // optional, only played back, never scored
 *   lines: Line[]          // lyric phrases, for the karaoke line
 *   duration, lowest, highest, meta
 * }
 * Note { start, end, midi, lyric, piece, lineBreak, golden, freestyle, index }
 *   - start/end in seconds
 *   - lyric: text shown under the bar ("i-", "sn't")
 *   - piece: text used to build the karaoke line ("i" + "sn't " = "isn't ")
 */

const LINE_GAP = 1.2; // seconds of silence that start a new phrase when the source has no line marks
const LINE_CHARS = 34;

/**
 * Normalizes a raw song: sorts notes, cleans lyrics and builds phrases.
 * `syllable` is the raw lyric of each note; spaces and trailing "-" mark word boundaries.
 */
export function finalizeSong(raw) {
  const notes = (raw.notes ?? [])
    .filter((n) => n.end > n.start && Number.isFinite(n.midi))
    .map((n) => ({ ...n }))
    .sort((a, b) => a.start - b.start || b.midi - a.midi);

  const rawSyllables = notes.map((n) => n.syllable ?? n.lyric ?? '');
  const spaced = rawSyllables.some((s) => /^\s|\s$/.test(s.replace(/[\r\n/\\]/g, '')));

  notes.forEach((n, i) => {
    let s = rawSyllables[i];
    if (/^[\r\n/\\]/.test(s)) n.lineBreak = true;
    s = s.replace(/[\r\n/\\]/g, '');
    const next = rawSyllables[i + 1] ?? '';
    if (/[\r\n]$/.test(rawSyllables[i]) && notes[i + 1]) notes[i + 1].lineBreak = true;

    n.lyric = s.trim();
    if (n.lyric === '~') {
      n.piece = '';
    } else if (spaced) {
      n.piece = s.replace(/-\s*$/, (m) => (/^\s/.test(next) ? m : ''));
    } else {
      n.piece = /-$/.test(n.lyric) ? n.lyric.slice(0, -1) : `${n.lyric} `;
    }
    n.index = i;
    delete n.syllable;
  });

  const lines = buildLines(notes);
  const accompaniment = (raw.accompaniment ?? []).slice().sort((a, b) => a.start - b.start);
  // the game ends with the voice; a long instrumental outro is not practice time
  const lastEnd = notes.length ? notes[notes.length - 1].end : Math.max(0, ...accompaniment.map((n) => n.end));
  const midis = notes.map((n) => n.midi);

  return {
    title: raw.title || 'Sin título',
    artist: raw.artist || '',
    notes,
    accompaniment,
    lines,
    duration: lastEnd,
    lowest: midis.length ? Math.min(...midis) : 60,
    highest: midis.length ? Math.max(...midis) : 72,
    meta: raw.meta ?? {},
  };
}

function buildLines(notes) {
  const hasMarks = notes.some((n, i) => i > 0 && n.lineBreak);
  const lines = [];
  let current = null;
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    let breakHere = !current;
    if (current && hasMarks) breakHere = !!n.lineBreak;
    if (current && !hasMarks) {
      const len = current.text.length;
      const wordStart = !prev || /\s$/.test(prev.piece) || prev.piece === '';
      breakHere = n.start - prev.end >= LINE_GAP || (len >= LINE_CHARS && wordStart);
    }
    if (breakHere) {
      current = { start: n.start, end: n.end, notes: [], text: '' };
      lines.push(current);
    }
    current.notes.push(i);
    current.end = n.end;
    current.text += n.piece;
    n.line = lines.length - 1;
  });
  return lines;
}
