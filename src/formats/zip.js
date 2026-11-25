/**
 * Lector de ZIP mínimo, sin dependencias: para importar un paquete de canciones de una vez.
 * Admite entradas sin comprimir y comprimidas con deflate (lo que crean Windows, macOS,
 * Android y cualquier compresor); descomprime con DecompressionStream del navegador.
 *
 *   const files = await readZip(bytes);   // [{ name, bytes }]
 */

/** true si los bytes empiezan como un ZIP («PK\3\4»). */
export function isZip(bytes) {
  const b = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset ?? 0, 4);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{name: string, bytes: Uint8Array}[]>} solo ficheros (no carpetas), en el orden del ZIP
 */
export async function readZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // fin del directorio central: firma 0x06054b50, buscando desde el final (puede llevar comentario)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('No es un archivo ZIP válido');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP dañado');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const raw = u8.subarray(p + 46, p + 46 + nameLen);
    // bit 11: nombre en UTF-8; si no, casi siempre CP437 (para nombres ASCII da igual)
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(raw);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`«${name}» está cifrado: el ZIP no puede llevar contraseña`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) out.push({ name, bytes: data.slice() });
    else if (method === 8) out.push({ name, bytes: await inflateRaw(data) });
    else throw new Error(`«${name}» usa una compresión no admitida`);
  }
  return out;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede abrir ZIP comprimidos');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
