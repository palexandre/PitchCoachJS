import { finalizeSong } from './song.js';
import { midiToSong } from './formats/midi.js';
import { ultrastarToSong } from './formats/ultrastar.js';
import { jsonToSong } from './formats/json.js';
import { decodeText } from './formats/text.js';

/**
 * Loads a song from any supported source and format.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} source
 *   File/Blob, raw bytes, a URL, UltraStar/JSON text, or an already parsed JSON object.
 * @param {{format?: 'midi'|'ultrastar'|'json', melody?: string, title?: string}} [opts]
 *   melody: for MIDI, the "track:channel" to sing (see song.meta.candidates).
 */
export async function loadSong(source, opts = {}) {
  let name = opts.name ?? '';
  let bytes = null;
  let text = null;

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    name ||= source.name ?? '';
    bytes = new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else if (typeof source === 'string' && isUrl(source)) {
    name ||= decodeURIComponent(source.split(/[?#]/)[0].split('/').pop());
    const res = await fetch(source);
    if (!res.ok) throw new Error(`No se pudo descargar ${source} (${res.status})`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else if (typeof source === 'string') {
    text = source;
  } else if (source && typeof source === 'object') {
    return finalizeSong(jsonToSong(source));
  } else {
    throw new Error('Fuente de canción no soportada');
  }

  const format = opts.format ?? detectFormat(bytes, text, name);
  let raw;
  if (format === 'midi') raw = midiToSong(bytes, opts);
  else {
    text ??= decodeText(bytes);
    raw = format === 'json' ? jsonToSong(text) : ultrastarToSong(text);
  }
  if (!raw.title && name) raw.title = name.replace(/\.[^.]+$/, '');
  if (opts.title) raw.title = opts.title;
  return finalizeSong(raw);
}

function isUrl(s) {
  return !/[\n{]/.test(s) && (/^(https?:|blob:|data:|\.{0,2}\/)/.test(s) || /\.(mid|midi|kar|txt|json)(\?|#|$)/i.test(s));
}

function detectFormat(bytes, text, name) {
  if (bytes && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64) return 'midi'; // "MThd"
  if (/\.(mid|midi|kar)$/i.test(name)) return 'midi';
  const head = (text ?? decodeText(bytes.subarray(0, 512))).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{')) return 'json';
  return 'ultrastar';
}
