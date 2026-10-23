/**
 * Minimal Standard MIDI File writer (format 1) with lyric events.
 *
 * tracks: [{ name, channel, notes: [{ tick, length, midi, velocity?, lyric? }] }]
 */
export function writeMidi({ division = 480, bpm = 120, title = '', tracks }) {
  const chunks = [header(tracks.length + 1, division)];
  const tempo = Math.round(60e6 / bpm);
  chunks.push(trackChunk([
    { tick: 0, bytes: meta(0x03, text(title)) },
    { tick: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
  ]));
  for (const t of tracks) {
    const ch = t.channel ?? 0;
    const ev = [{ tick: 0, bytes: meta(0x03, text(t.name ?? '')) }];
    for (const n of t.notes) {
      if (n.lyric) ev.push({ tick: n.tick, order: 0, bytes: meta(0x05, text(n.lyric)) });
      ev.push({ tick: n.tick, order: 2, bytes: [0x90 | ch, n.midi, n.velocity ?? 96] });
      ev.push({ tick: n.tick + n.length, order: 1, bytes: [0x80 | ch, n.midi, 0] });
    }
    chunks.push(trackChunk(ev.sort((a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0))));
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const text = (s) => [...new TextEncoder().encode(s)];
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function header(ntracks, division) {
  return Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, ntracks >> 8, ntracks & 255, division >> 8, division & 255]);
}

function trackChunk(events) {
  const body = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  const len = body.length;
  return Uint8Array.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body]);
}
