/**
 * Canción dentro de un enlace: la melodía y la letra se empaquetan en binario, se comprimen
 * (deflate, que ya trae el navegador) y se escriben en base64url, para el «#» de una URL.
 * Lo que va tras el «#» no llega al servidor: la canción solo viaja en el propio enlace.
 *
 *   const code = await songToCode(song);            // 'AQ…'  (~900 caracteres para 375 notas)
 *   const json = await codeToJSON(code);            // texto JSON que entiende loadSong
 *
 * Formato v1: [1] título, autor (UTF-8 con longitud) · nº de notas · por nota: hueco desde la
 * anterior y duración en centésimas (varint), altura MIDI (0 = silencio no se usa), marcas
 * (1 = nota dorada) · letra: las sílabas en el mismo orden, separadas por \x1f.
 */

const VERSION = 1;
const SEP = '\x1f';

export async function songToCode(song) {
  const enc = new TextEncoder();
  const out = [];
  const varint = (n) => {
    n = Math.max(0, Math.round(n));
    while (n > 127) {
      out.push((n & 127) | 128);
      n >>>= 7;
    }
    out.push(n);
  };
  const str = (s) => {
    const b = enc.encode(s || '');
    varint(b.length);
    out.push(...b);
  };
  out.push(VERSION);
  str(song.title);
  str(song.artist);
  varint(song.notes.length);
  let t = 0;
  for (const n of song.notes) {
    const start = Math.round(n.start * 100);
    const end = Math.round(n.end * 100);
    varint(start - t);
    varint(Math.max(1, end - start));
    out.push(n.midi & 127, n.golden ? 1 : 0);
    t = start + Math.max(1, end - start);
  }
  // sílaba original: «/» = empieza frase, «-» = sigue la palabra, «~» = alarga la anterior
  const syl = song.notes.map((n) => {
    if (n.piece === '' && n.lyric === '~') return (n.lineBreak ? '/' : '') + '~';
    const p = n.piece ?? `${n.lyric} `;
    return (n.lineBreak ? '/' : '') + (/\s$/.test(p) || p === '' ? p.trim() : `${p}-`);
  });
  out.push(...enc.encode(syl.join(SEP)));
  return toBase64url(await deflate(new Uint8Array(out)));
}

/** Devuelve el texto JSON (forma explícita, tiempos en segundos) para loadSong. */
export async function codeToJSON(code) {
  const b = await inflate(fromBase64url(code));
  let p = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (p >= b.length) throw new Error('Enlace incompleto');
      const c = b[p++];
      n += (c & 127) * 2 ** shift;
      if (c < 128) return n;
      shift += 7;
    }
  };
  const dec = new TextDecoder();
  const str = () => {
    const len = varint();
    const s = dec.decode(b.subarray(p, p + len));
    p += len;
    return s;
  };
  if (b[p++] !== VERSION) throw new Error('Este enlace es de una versión más nueva de la app');
  const title = str();
  const artist = str();
  const count = varint();
  const notes = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const start = t + varint();
    const dur = varint();
    const midi = b[p++];
    const flags = b[p++];
    notes.push({ time: start / 100, duration: dur / 100, pitch: midi, golden: !!(flags & 1) });
    t = start + dur;
  }
  const syl = dec.decode(b.subarray(p)).split(SEP);
  notes.forEach((n, i) => (n.lyric = syl[i] ?? ''));
  return JSON.stringify({ title, artist, notes });
}

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch {
    throw new Error('El enlace está dañado o incompleto');
  }
}

function toBase64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(code) {
  const s = atob(code.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
