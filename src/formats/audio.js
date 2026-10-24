/**
 * Exportación a audio: toca la canción con el piano sin sonar (OfflineAudioContext)
 * y la guarda como WAV, que se abre en cualquier reproductor.
 *
 *   const wav = await songToWav(song);            // Uint8Array
 *   new Blob([wav], { type: 'audio/wav' });
 */
import { Piano } from '../piano.js';

/**
 * @param {object} song canción finalizada (loadSong)
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {boolean} [opts.accompaniment=true] incluir el resto de pistas del MIDI
 * @param {number} [opts.transpose=0] semitonos
 * @param {number} [opts.tail=1.5] segundos de cola para que la última nota se apague
 */
export async function songToWav(song, { sampleRate = 44100, accompaniment = true, transpose = 0, tail = 1.5 } = {}) {
  const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('Este navegador no puede generar audio');
  const backing = accompaniment ? song.accompaniment ?? [] : [];
  const end = Math.max(song.duration, ...backing.map((n) => n.end)) + tail;
  const ctx = new Offline(2, Math.ceil(end * sampleRate), sampleRate);

  const melody = new Piano(ctx, ctx.destination, { volume: 0.9 });
  for (const n of song.notes) melody.play(n.midi + transpose, { when: n.start, duration: n.end - n.start, velocity: 0.85 });
  if (backing.length) {
    const piano = new Piano(ctx, ctx.destination, { volume: 0.4 });
    for (const n of backing) piano.play(n.midi + transpose, { when: n.start, duration: n.end - n.start, velocity: n.velocity ?? 0.6 });
  }

  const buffer = await ctx.startRendering();
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return encodeWav(normalize(channels), sampleRate);
}

/** Sube el volumen hasta -1 dB sin saturar. */
function normalize(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (!peak) return channels;
  const k = 0.89 / peak;
  return channels.map((ch) => ch.map((v) => v * k));
}

/**
 * Codifica muestras en WAV PCM de 16 bits.
 * @param {Float32Array[]} channels un array por canal, todos de la misma longitud
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate) {
  const n = channels[0]?.length ?? 0;
  const nch = channels.length;
  const dataLen = n * nch * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
