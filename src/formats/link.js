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

/**
 * Cifra un código (AES-GCM, clave aleatoria de 128 bits) para que un acortador de enlaces solo
 * guarde texto ilegible: `data` va en el enlace largo y `key` solo en el «#» del enlace corto.
 * @returns {Promise<{data: string, key: string}>} ambos en base64url
 */
export async function sealCode(code) {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fromBase64url(code)));
  const out = new Uint8Array(iv.length + enc.length);
  out.set(iv);
  out.set(enc, iv.length);
  return { data: toBase64url(out), key: toBase64url(raw) };
}

/** Descifra lo que hizo sealCode; falla si la clave no es la buena o el texto está dañado. */
export async function openCode(data, keyText) {
  const all = fromBase64url(data);
  const key = await crypto.subtle.importKey('raw', fromBase64url(keyText), 'AES-GCM', false, ['decrypt']);
  try {
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12));
    return toBase64url(new Uint8Array(dec));
  } catch {
    throw new Error('El enlace está incompleto o la clave no corresponde');
  }
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
