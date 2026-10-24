/**
 * Canvas renderer: scrolling note bars with lyrics, playhead, the singer's pitch,
 * star particles, floating messages, HUD, progress bar and final results.
 */
import { midiToName } from './notes.js';
import { themedContext, invertColor } from './colors.js';

export const DEFAULT_THEME = {
  background: ['#2b0d6e', '#3a128c'],
  grid: 'rgba(255,255,255,0.06)',
  gridLabel: 'rgba(255,255,255,0.28)',
  upcoming: 'rgba(255,255,255,0.38)',
  past: '#f4edd9',
  missed: 'rgba(244,237,217,0.55)',
  hit: '#43e08c',
  golden: '#ffcf4a',
  lyric: 'rgba(255,255,255,0.55)',
  lyricPast: '#f4edd9',
  playhead: '#1fd1b5',
  pitch: '#1fd1b5',
  text: '#ffffff',
  font: '"Nunito", "Segoe UI", system-ui, sans-serif',
};

export const DEFAULT_LABELS = {
  perfect: '¡Perfecto!',
  great: '¡Genial!',
  good: 'Bien',
  miss: '',
  streak: (level) => (level >= 5 ? `¡En llamas! x${level}` : `¡Racha x${level}!`),
  combo: (n) => `Combo ${n}`,
  score: 'Puntos',
  paused: 'Pausa',
  results: '¡Canción completada!',
  accuracy: 'Afinación',
  maxCombo: 'Combo máx.',
};

const STAR_COLORS = ['#ffd54a', '#ffffff', '#43e08c', '#ff8ad8', '#7fe7ff'];

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number|'auto'} [opts.pixelsPerSecond='auto'] horizontal zoom; 'auto' adapts to the width
   * @param {number} [opts.playheadPosition=0.3] fraction of the width
   * @param {'english'|'solfege'} [opts.notation='solfege'] grid labels
   * @param {boolean} [opts.hud=true] score & combo
   * @param {boolean} [opts.lyricsLine=true] karaoke phrase at the bottom
   * @param {boolean} [opts.results=true] draw the final results over the canvas
   * @param {(color: string) => string} [opts.colorMap] translates every drawn color (e.g. to a light theme)
   * @param {boolean} [opts.invertColors=false] draw every color inverted
   * @param {{top?: number, bottom?: number}} [opts.insets] px reserved for your own overlays (toolbars, safe areas)
   * @param {object} [opts.theme] overrides DEFAULT_THEME
   * @param {object} [opts.labels] overrides DEFAULT_LABELS
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = themedContext(canvas.getContext('2d'), () => this.options.colorMap ?? (this.options.invertColors ? invertColor : null));
    this.options = { pixelsPerSecond: 'auto', playheadPosition: 0.3, notation: 'solfege', hud: true, lyricsLine: true, results: true, insets: {}, invertColors: false, colorMap: null, ...opts };
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.labels = { ...DEFAULT_LABELS, ...opts.labels };
    this.particles = [];
    this.popups = [];
    this.trail = [];
    this.song = null;
    this.width = 0;
    this.height = 0;
    this._observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this._observer?.observe(canvas);
    this.resize();
  }

  destroy() {
    this._observer?.disconnect();
  }

  setSong(song, transpose = 0) {
    this.song = song;
    this._chunkCache = null;
    this.transpose = transpose;
    this.clearEffects();
  }

  clearEffects() {
    this.particles = [];
    this.popups = [];
    this.trail = [];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || this.canvas.width);
    this.height = Math.max(1, rect.height || this.canvas.height);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.onResize?.();
  }

  get layout() {
    const insetTop = this.options.insets?.top ?? 0;
    const h = this.height - (this.options.insets?.bottom ?? 0);
    const bottom = this.options.lyricsLine ? 92 : 50;
    return {
      top: insetTop + (this.options.hud ? 58 : 24),
      bottom: h - bottom,
      lyricY: h - 62,
      progressY: h - 20,
      playheadX: Math.round(this.width * this.options.playheadPosition),
    };
  }

  /** Pixels per second of song; 'auto' shows ~5 s on phones and ~7 s on wide screens. */
  get pps() {
    const v = this.options.pixelsPerSecond;
    return v === 'auto' ? Math.max(95, Math.min(180, this.width / 5.5)) : v;
  }

  /** Visible pitch range, at least 1.5 octaves so small songs aren't stretched. */
  range() {
    const t = this.transpose ?? 0;
    let lo = (this.song?.lowest ?? 60) + t - 2;
    let hi = (this.song?.highest ?? 72) + t + 3;
    const min = 18;
    if (hi - lo < min) {
      const pad = (min - (hi - lo)) / 2;
      lo -= pad;
      hi += pad;
    }
    return [lo, hi];
  }

  yFor(midi) {
    const { top, bottom } = this.layout;
    const [lo, hi] = this.range();
    return bottom - ((midi - lo) / (hi - lo)) * (bottom - top);
  }

  xFor(t, time) {
    return this.layout.playheadX + (t - time) * this.pps;
  }

  /** Time under an x coordinate of the progress bar, or null. */
  progressTimeAt(x, y) {
    if (!this.song) return null;
    const { progressY } = this.layout;
    if (Math.abs(y - progressY) > 14) return null;
    const [x0, x1] = this._progressX();
    return Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) * this.song.duration;
  }

  _progressX() {
    return [62, this.width - 22];
  }

  // ---- effects -----------------------------------------------------------

  burst(x, y, count = 14, power = 1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (60 + Math.random() * 220) * power;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 80 * power,
        life: 0,
        ttl: 0.7 + Math.random() * 0.8,
        size: 4 + Math.random() * 7 * power,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 8,
        color: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
      });
    }
  }

  sparkle(x, y) {
    this.particles.push({
      x: x + (Math.random() - 0.5) * 8,
      y: y + (Math.random() - 0.5) * 8,
      vx: -40 - Math.random() * 90,
      vy: (Math.random() - 0.5) * 70,
      life: 0, ttl: 0.5 + Math.random() * 0.4,
      size: 2.5 + Math.random() * 3.5,
      rot: 0, spin: 4,
      color: Math.random() < 0.6 ? this.theme.hit : '#ffffff',
    });
  }

  popup(text, { x, y, color = this.theme.text, size = 22, ttl = 1.1, big = false } = {}) {
    if (!text) return;
    if (!big) this.popups = this.popups.filter((p) => p.big); // one rating at a time
    this.popups.push({ text, x: x ?? this.width / 2, y: y ?? this.height / 2, color, size, ttl, life: 0, big });
  }

  /** Called by the game for scorer events. */
  onNote({ note, rating }) {
    if (rating === 'miss') return;
    const x = this.layout.playheadX;
    const y = this.yFor(note.midi + (this.transpose ?? 0)) - 26;
    const colors = { perfect: this.theme.golden, great: this.theme.hit, good: '#ffffff' };
    this.popup(this.labels[rating], { x, y, color: colors[rating], size: rating === 'perfect' ? 22 : 18 });
    if (rating === 'perfect') this.burst(x, y + 26, 10, 0.8);
  }

  onStreak({ level }) {
    const label = typeof this.labels.streak === 'function' ? this.labels.streak(level) : this.labels.streak;
    this.popup(label, { y: this.height * 0.32, color: this.theme.golden, size: 34 + Math.min(level, 6) * 3, ttl: 1.5, big: true });
    this.burst(this.layout.playheadX, this.height * 0.45, 18 + level * 6, 1 + Math.min(level, 5) * 0.15);
  }

  // ---- drawing -----------------------------------------------------------

  /**
   * @param {object} f frame
   * @param {number} f.time song time
   * @param {number} f.dt seconds since last frame
   * @param {object} f.scorer
   * @param {{midi:number|null, hit:boolean}} f.pitch folded pitch for the indicator
   * @param {'idle'|'playing'|'paused'|'ended'} f.state
   * @param {object} [f.result] final result when ended
   * @param {[number,number]|null} [f.loop]
   */
  draw(f) {
    const { ctx, width: w, height: h, theme } = this;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, theme.background[0]);
    grad.addColorStop(1, theme.background[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    if (!this.song) return;

    this._drawGrid();
    if (f.loop) this._drawLoop(f);
    this._drawNotes(f);
    this._drawTrail(f);
    this._drawPlayhead(f);
    this._updateParticles(f.dt);
    this._drawPopups(f.dt);
    if (this.options.lyricsLine) this._drawLyricsLine(f);
    this._drawProgress(f);
    if (this.options.hud) this._drawHud(f);
    if (f.time < 0 && f.state === 'playing') this._drawCountdown(f.time);
    if (f.state === 'paused') this._drawCenter(this.labels.paused);
    if (f.state === 'ended' && f.result && this.options.results) this._drawResults(f.result);
  }

  _font(size, weight = 800) {
    return `${weight} ${size}px ${this.theme.font}`;
  }

  _drawGrid() {
    const { ctx, theme } = this;
    const [lo, hi] = this.range();
    ctx.font = this._font(10, 700);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (pc !== 0 && pc !== 7) continue; // Do and Sol lines
      const y = this.yFor(m);
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = pc === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
      ctx.fillStyle = theme.gridLabel;
      ctx.fillText(midiToName(m, { notation: this.options.notation }), 6, y - 7);
    }
  }

  _barHeight() {
    const { top, bottom } = this.layout;
    const [lo, hi] = this.range();
    return Math.max(8, Math.min(18, ((bottom - top) / (hi - lo)) * 0.9));
  }

  _drawNotes(f) {
    const { ctx, theme, song } = this;
    const time = f.time;
    const bh = this._barHeight();
    const t0 = time - this.layout.playheadX / this.pps - 0.5;
    const t1 = time + (this.width - this.layout.playheadX) / this.pps + 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = this._font(Math.max(12, Math.min(17, bh + 2)), 700);

    for (const n of song.notes) {
      if (n.end < t0) continue;
      if (n.start > t1) break;
      const st = f.scorer?.states[n.index];
      const x0 = this.xFor(n.start, time);
      const x1 = Math.max(x0 + bh, this.xFor(n.end, time) - 2);
      const y = this.yFor(n.midi + (this.transpose ?? 0)) - bh / 2;
      const px = this.layout.playheadX;

      // upcoming part
      ctx.fillStyle = n.golden ? withAlpha(theme.golden, 0.55) : theme.upcoming;
      roundRect(ctx, x0, y, x1 - x0, bh, bh / 2);
      ctx.fill();

      if (px > x0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 - 1, y - 2, Math.min(px, x1) - x0 + 1, bh + 4);
        ctx.clip();
        ctx.fillStyle = n.golden ? theme.golden : st?.hit ? theme.past : theme.missed;
        roundRect(ctx, x0, y, x1 - x0, bh, bh / 2);
        ctx.fill();
        // green where the singer was in tune
        if (st?.segments.length) {
          ctx.fillStyle = theme.hit;
          ctx.shadowColor = theme.hit;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          roundRect(ctx, x0, y, x1 - x0, bh, bh / 2);
          ctx.clip();
          for (const [a, b] of st.segments) {
            const sx = this.xFor(a, time);
            ctx.fillRect(sx, y, Math.max(2, this.xFor(b, time) - sx), bh);
          }
        }
        ctx.restore();
      }

      if (n.lyric) {
        const active = time >= n.start && time < n.end;
        const ratio = st ? st.hit / Math.max(0.05, st.elapsed) : 0;
        let color = theme.lyric;
        if (st?.done) color = st.rating && st.rating !== 'miss' ? theme.hit : theme.lyricPast;
        else if (active) color = ratio > 0.5 ? theme.hit : theme.lyricPast;
        ctx.fillStyle = color;
        // hasta donde empieza la nota siguiente; si no cabe, se recorta con «…»
        const next = song.notes[n.index + 1];
        const room = Math.max(x1 - x0, (next ? this.xFor(next.start, time) : Infinity) - x0 - 8);
        const text = fitText(ctx, n.lyric, room);
        if (ctx.measureText(text).width <= x1 - x0) {
          ctx.fillText(text, (x0 + x1) / 2, y + bh + 6);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(text, x0, y + bh + 6);
          ctx.textAlign = 'center';
        }
      }
    }
  }

  _drawLoop(f) {
    const { ctx } = this;
    const [a, b] = f.loop;
    const xa = this.xFor(a, f.time);
    const xb = this.xFor(b, f.time);
    ctx.fillStyle = 'rgba(31,209,181,0.08)';
    ctx.fillRect(xa, this.layout.top - 20, xb - xa, this.layout.bottom - this.layout.top + 40);
  }

  _drawTrail(f) {
    const { ctx, theme } = this;
    const px = this.layout.playheadX;
    if (f.state === 'playing' && f.time >= 0) {
      this.trail.push({ t: f.time, midi: f.pitch?.midi ?? null, hit: !!f.pitch?.hit });
    }
    const oldest = f.time - px / this.pps;
    while (this.trail.length && this.trail[0].t < oldest) this.trail.shift();

    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      if (a.midi == null || b.midi == null || Math.abs(a.midi - b.midi) > 2 || b.t - a.t > 0.15) continue;
      ctx.strokeStyle = b.hit ? theme.hit : withAlpha(theme.pitch, 0.7);
      ctx.beginPath();
      ctx.moveTo(this.xFor(a.t, f.time), this.yFor(a.midi));
      ctx.lineTo(this.xFor(b.t, f.time), this.yFor(b.midi));
      ctx.stroke();
    }
  }

  _drawPlayhead(f) {
    const { ctx, theme } = this;
    const { playheadX: x, top, bottom } = this.layout;
    ctx.strokeStyle = theme.playhead;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, top - 30);
    ctx.lineTo(x, bottom + 20);
    ctx.stroke();

    const midi = f.pitch?.midi;
    const hit = f.pitch?.hit;
    const y = midi != null ? Math.max(top - 30, Math.min(bottom + 20, this.yFor(midi))) : bottom + 20;
    ctx.save();
    ctx.fillStyle = hit ? theme.hit : theme.playhead;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = hit ? 22 : midi != null ? 10 : 0;
    ctx.beginPath();
    ctx.arc(x, y, hit ? 11 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (hit && f.state === 'playing') {
      this.sparkle(x, y);
      if (Math.random() < 0.5) this.sparkle(x, y);
    }
  }

  _updateParticles(dt) {
    const { ctx } = this;
    this.particles = this.particles.filter((p) => (p.life += dt) < p.ttl);
    for (const p of this.particles) {
      p.vy += 260 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const k = 1 - p.life / p.ttl;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      starPath(ctx, p.size * (0.6 + 0.4 * k));
      ctx.fill();
      ctx.restore();
    }
  }

  _drawPopups(dt) {
    const { ctx } = this;
    this.popups = this.popups.filter((p) => (p.life += dt) < p.ttl);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.popups) {
      const k = p.life / p.ttl;
      const scale = p.big ? 1 + 0.25 * Math.max(0, 1 - k * 5) : 1;
      ctx.save();
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      ctx.translate(p.x, p.y - k * (p.big ? 20 : 40));
      ctx.scale(scale, scale);
      ctx.font = this._font(p.size, 900);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(30,6,80,0.8)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  /**
   * Parte una frase en trozos que caben en `maxW`, cortando entre palabras.
   * Devuelve [{ notes: Note[], text }]. Se guarda en caché por frase y tamaño.
   */
  _lineChunks(li, maxW, size) {
    const key = `${li}:${Math.round(maxW)}:${size}`;
    this._chunkCache ??= new Map();
    if (this._chunkCache.has(key)) return this._chunkCache.get(key);
    const { ctx, song } = this;
    const pieces = song.lines[li].notes.map((i) => song.notes[i]);
    const chunks = [];
    let cur = [];
    let width = 0;
    let lastBreak = -1; // posición en `cur` justo después de un final de palabra
    for (const n of pieces) {
      const w = ctx.measureText(n.piece).width;
      if (cur.length && width + w > maxW) {
        const cut = lastBreak > 0 ? lastBreak : cur.length;
        chunks.push(cur.slice(0, cut));
        cur = cur.slice(cut);
        width = cur.reduce((s, p) => s + ctx.measureText(p.piece).width, 0);
        lastBreak = -1;
      }
      cur.push(n);
      width += w;
      if (/\s$/.test(n.piece)) lastBreak = cur.length;
    }
    if (cur.length) chunks.push(cur);
    const out = chunks.map((notes) => ({ notes, text: notes.map((n) => n.piece).join('').trim() }));
    if (this._chunkCache.size > 200) this._chunkCache.clear();
    this._chunkCache.set(key, out);
    return out;
  }

  _drawLyricsLine(f) {
    const { ctx, theme, song } = this;
    const time = f.time;
    const li = song.lines.findIndex((l) => time < l.end + 0.25);
    if (li < 0) return;
    const size = Math.max(16, Math.min(26, this.width / 34));
    const maxW = this.width - 32;
    ctx.font = this._font(size, 800);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // la frase entera si cabe; si no, el trozo que se está cantando
    const chunks = this._lineChunks(li, maxW, size);
    let ci = chunks.findIndex((c) => time < c.notes[c.notes.length - 1].end + 0.25);
    if (ci < 0) ci = chunks.length - 1;
    const pieces = chunks[ci].notes;
    const total = pieces.reduce((s, n) => s + ctx.measureText(n.piece).width, 0);
    let x = (this.width - Math.min(total, maxW)) / 2;
    const y = this.layout.lyricY;

    for (const n of pieces) {
      const wPiece = ctx.measureText(n.piece).width;
      const st = f.scorer?.states[n.index];
      if (time >= n.end) {
        ctx.fillStyle = st?.rating && st.rating !== 'miss' ? theme.hit : theme.lyricPast;
        ctx.fillText(n.piece, x, y);
      } else if (time > n.start) {
        // karaoke wipe inside the current syllable
        const k = (time - n.start) / (n.end - n.start);
        ctx.fillStyle = theme.lyric;
        ctx.fillText(n.piece, x, y);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y - size, wPiece * k, size * 2);
        ctx.clip();
        ctx.fillStyle = f.pitch?.hit ? theme.hit : theme.lyricPast;
        ctx.fillText(n.piece, x, y);
        ctx.restore();
      } else {
        ctx.fillStyle = theme.lyric;
        ctx.fillText(n.piece, x, y);
      }
      x += wPiece;
    }

    // debajo, lo que viene: el siguiente trozo o la siguiente frase
    const small = Math.round(size * 0.62);
    ctx.font = this._font(small, 700);
    const nextText = chunks[ci + 1]?.text ?? song.lines[li + 1]?.text.trim();
    if (nextText) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(fitText(ctx, nextText, maxW), this.width / 2, y + size * 0.95);
    }
  }

  _drawProgress(f) {
    const { ctx, theme, song } = this;
    const y = this.layout.progressY;
    const [x0, x1] = this._progressX();
    const k = Math.max(0, Math.min(1, f.time / Math.max(0.001, song.duration)));
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    if (f.loop) {
      ctx.strokeStyle = withAlpha(theme.playhead, 0.6);
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * (f.loop[0] / song.duration), y);
      ctx.lineTo(x0 + (x1 - x0) * (f.loop[1] / song.duration), y);
      ctx.stroke();
    }
    ctx.strokeStyle = theme.past;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + (x1 - x0) * k, y);
    ctx.stroke();
    ctx.fillStyle = theme.past;
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * k, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = this._font(13, 700);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatTime(f.time), 12, y);
  }

  _drawHud(f) {
    const { ctx, theme } = this;
    const s = f.scorer;
    if (!s) return;
    ctx.save();
    ctx.translate(0, this.options.insets?.top ?? 0);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    ctx.font = this._font(13, 700);
    ctx.globalAlpha = 0.7;
    ctx.fillText(this.song.title, 14, 12);
    ctx.globalAlpha = 1;

    ctx.textAlign = 'right';
    ctx.font = this._font(26, 900);
    ctx.fillText(s.score.toLocaleString(), this.width - 16, 8);
    if (s.combo >= 2) {
      ctx.font = this._font(14, 800);
      ctx.fillStyle = s.multiplier > 1 ? theme.golden : theme.hit;
      const mult = s.multiplier > 1 ? `  ×${s.multiplier}` : '';
      ctx.fillText(this.labels.combo(s.combo) + mult, this.width - 16, 38);
    }
    // streak meter
    const step = s.options.streakStep;
    const k = (s.streak % step) / step;
    if (s.streak > 0.2) {
      const x = 14;
      const y = 34;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      roundRect(ctx, x, y, 120, 8, 4);
      ctx.fill();
      ctx.fillStyle = theme.golden;
      roundRect(ctx, x, y, Math.max(8, 120 * k), 8, 4);
      ctx.fill();
      ctx.font = this._font(12, 900);
      ctx.textAlign = 'left';
      ctx.fillText('★'.repeat(Math.min(5, Math.floor(s.streak / step))), x + 128, y - 3);
    }
    ctx.restore();
  }

  _drawCountdown(time) {
    const n = Math.ceil(-time);
    if (n > 3) return;
    const k = n + time; // 1 → 0 inside each second
    this._drawCenter(String(n), 70 + 30 * k, 0.4 + 0.6 * k);
  }

  _drawCenter(text, size = 46, alpha = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = this._font(size, 900);
    ctx.fillStyle = this.theme.text;
    ctx.fillText(text, this.width / 2, this.height * 0.42);
    ctx.restore();
  }

  _drawResults(r) {
    const { ctx, theme, labels } = this;
    const w = this.width;
    const h = this.height;
    ctx.fillStyle = 'rgba(20,4,60,0.78)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = h * 0.4;
    ctx.fillStyle = theme.text;
    ctx.font = this._font(22, 800);
    ctx.fillText(labels.results, w / 2, cy - 90);

    for (let i = 0; i < 5; i++) {
      const x = w / 2 + (i - 2) * 46;
      const fill = Math.max(0, Math.min(1, r.stars - i));
      ctx.save();
      ctx.translate(x, cy - 40);
      starPath(ctx, 19);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      if (fill > 0) {
        ctx.clip();
        ctx.fillStyle = theme.golden;
        ctx.fillRect(-20, -20, 40 * fill, 40);
      }
      ctx.restore();
    }

    ctx.font = this._font(64, 900);
    ctx.fillStyle = r.grade === 'S' ? theme.golden : theme.hit;
    ctx.fillText(r.grade, w / 2, cy + 22);
    ctx.font = this._font(26, 900);
    ctx.fillStyle = theme.text;
    ctx.fillText(`${r.score.toLocaleString()} ${labels.score.toLowerCase()}`, w / 2, cy + 74);
    ctx.font = this._font(14, 700);
    ctx.globalAlpha = 0.8;
    ctx.fillText(`${labels.accuracy}: ${Math.round(r.percent * 100)}%   ·   ${labels.maxCombo}: ${r.maxCombo}`, w / 2, cy + 106);
    ctx.globalAlpha = 1;
  }
}

/** Recorta `text` con «…» para que no pase de `maxW` píxeles con la fuente actual. */
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function starPath(ctx, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
}

function withAlpha(hex, a) {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

export function formatTime(t) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
