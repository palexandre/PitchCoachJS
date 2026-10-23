/**
 * Lyrics helpers: write lyrics as normal text and get one syllable per note.
 *
 *   splitLyrics('Mar-ti-ni-llo, Mar-ti-ni-llo,\n¿dón-de_es-tás?')
 *   → ['Mar-', 'ti-', 'ni-', 'llo,', 'Mar-', 'ti-', 'ni-', 'llo,', '/¿dón-', 'de es-', 'tás?']
 *
 * - spaces separate words, "-" separates syllables of a word
 * - "_" keeps several words on one note (sinalefa): "de_es"
 * - a new line starts a new lyric line
 * - a lone "~" holds the previous syllable on one more note (melisma)
 */
export function splitLyrics(text) {
  const out = [];
  String(text ?? '').split(/\r?\n/).forEach((line) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    words.forEach((word, wi) => {
      const syllables = word.split('-').filter((s) => s !== '');
      syllables.forEach((s, si) => {
        let t = s.replace(/_/g, ' ');
        if (si < syllables.length - 1) t += '-';
        if (wi === 0 && si === 0 && out.length) t = `/${t}`;
        out.push(t);
      });
    });
  });
  return out;
}

/**
 * The reverse of splitLyrics, for editing a song's lyrics as text.
 * @param {{lyric: string, lineBreak?: boolean}[]} notes finalized song notes
 */
export function joinLyrics(notes) {
  let text = '';
  notes.forEach((n, i) => {
    const lyric = (n.lyric || '~').replace(/\s+/g, '_');
    if (i > 0) {
      const prev = notes[i - 1].lyric || '~';
      text += n.lineBreak ? '\n' : /-$/.test(prev) ? '' : ' ';
    }
    text += lyric;
  });
  return text;
}

/** Number of syllables (notes) the text needs. */
export function countSyllables(text) {
  return splitLyrics(text).length;
}
