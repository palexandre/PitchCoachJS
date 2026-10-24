// Tema claro: para cada color del tema oscuro, su equivalente en el claro.
// Lo usan el canvas del juego y del editor; style.css tiene el mismo cuadro
// en `html[data-theme="claro"]` (un test comprueba que coinciden).

export const LIGHT = {
  // fondos y superficies
  '170640': 'f6f3fb', // fondo de la página
  '22095a': 'f1ecf8', // fondo secundario, piano roll
  '2a0f68': 'ffffff', // tarjetas, hojas, menús
  '34157c': 'ffffff', // opción elegida en los selectores
  '3d1394': 'e6dcfb', // brillo del degradado de fondo
  '2b0d6e': 'f4f0fb', // escenario del juego (arriba)
  '3a128c': 'eae2f8', // escenario del juego (abajo)
  '12042f': 'ebe5f4', // zona del teclado del editor
  '1b0748': 'e9e2f5', // regla del editor
  '14043c': 'ffffff', // cristal de los botones flotantes, fondo de resultados
  '1e0650': 'ffffff', // contorno de los textos flotantes del juego
  '08021c': '1d0b45', // velo detrás de las ventanas
  '000000': '2d1b5c', // sombras
  // textos y líneas: lo claro sobre oscuro pasa a oscuro sobre claro
  'ffffff': '1d0b45',
  'f6f0df': '1d0b45',
  'f4edd9': '4b3a80', // barras ya cantadas
  '0d0430': 'ffffff', // texto sobre botones de color
  '1d0b45': '2a1a52', // teclas negras
  '1e0a46': '1e0a46', // nombres en las teclas blancas
  // acentos, algo más intensos para leerse sobre blanco
  '1fd1b5': '0ea58f',
  '3be5ca': '12b89f',
  '43e08c': '1f9d5a',
  'ffcf4a': 'c98a00',
  'ffd54a': 'd9a000',
  'ff9d4a': 'e8741f',
  'ff7a8a': 'd93a52',
  'ff5c7c': 'e0334f',
  'ff6b8b': 'e0334f',
  'ff8ad8': 'cc3d96',
  '7fe7ff': '1597bd',
  '4da3ff': '1a73e8',
  '5b2bd6': '5b2bd6',
  '6f5cff': '6f5cff',
};

const toHex = (r, g, b) => [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');

/** Traduce un color del tema oscuro al claro, conservando la transparencia. */
export function lightColor(color) {
  if (typeof color !== 'string') return color;
  const c = color.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    let h = m[1].toLowerCase();
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return LIGHT[h] ? `#${LIGHT[h]}` : color;
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) {
    const to = LIGHT[toHex(m[1], m[2], m[3])];
    if (!to) return color;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(to.slice(i, i + 2), 16));
    return m[4] === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${m[4]})`;
  }
  return color;
}
