/**
 * Utilidades de color para dibujar en canvas con los colores invertidos
 * (tema «invertido») sin tocar el código que dibuja.
 */

/** Invierte un color CSS: #rgb, #rrggbb, rgb() o rgba(). Otros valores se devuelven tal cual. */
export function invertColor(color) {
  if (typeof color !== 'string') return color;
  const c = color.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    const n = 0xffffff ^ parseInt(h, 16);
    return `#${n.toString(16).padStart(6, '0')}`;
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => 255 - Number(v));
    return m[4] === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${m[4]})`;
  }
  return color;
}

/**
 * Hace que un contexto 2D invierta los colores que se le asignan mientras
 * `enabled()` sea verdadero: fillStyle, strokeStyle, shadowColor y los
 * colores de los degradados.
 * @param {CanvasRenderingContext2D} ctx
 * @param {() => boolean} enabled
 */
export function invertibleContext(ctx, enabled) {
  const proto = Object.getPrototypeOf(ctx);
  for (const prop of ['fillStyle', 'strokeStyle', 'shadowColor']) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(ctx, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, enabled() ? invertColor(v) : v); },
    });
  }
  for (const fn of ['createLinearGradient', 'createRadialGradient']) {
    const orig = ctx[fn].bind(ctx);
    ctx[fn] = (...args) => {
      const grad = orig(...args);
      const add = grad.addColorStop.bind(grad);
      grad.addColorStop = (offset, color) => add(offset, enabled() ? invertColor(color) : color);
      return grad;
    };
  }
  return ctx;
}
