import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildSw, precacheList } from '../tools/build-pwa.js';

const example = new URL('../example/', import.meta.url);

test('sw.js está al día con los archivos de la app (ejecuta `npm run pwa`)', () => {
  const { current, next } = buildSw();
  assert.equal(current, next);
});

test('la caché incluye todo lo que la app necesita sin conexión', () => {
  const urls = precacheList().map((f) => f.url);
  for (const u of ['./index.html', './app.js', './editor.js', './style.css', './manifest.webmanifest', '../src/index.js', '../src/keyboard.js', './songs/martinillo.mid']) {
    assert.ok(urls.includes(u), u);
  }
});

test('el manifiesto es válido y sus iconos existen', () => {
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', example), 'utf8'));
  assert.equal(m.short_name, 'PitchCoach');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, example)), i.src);
});

test('al instalar una versión nueva se descargan los archivos del servidor, no de la caché HTTP', () => {
  const sw = readFileSync(new URL('sw.js', example), 'utf8');
  assert.match(sw, /cache: 'reload'/);
});

test('el tema claro de los estilos coincide con la tabla de theme.js', async () => {
  const css = readFileSync(new URL('style.css', example), 'utf8');
  assert.doesNotMatch(css, /filter:\s*invert/);
  const { LIGHT } = await import('../example/theme.js');
  const block = /html\[data-theme="claro"\] \{([\s\S]*?)\}/.exec(css)[1];
  const vars = [...block.matchAll(/--c-([0-9a-f]{6}): (\d+), (\d+), (\d+);/g)];
  assert.ok(vars.length >= 20);
  for (const [, name, r, g, b] of vars) {
    const hex = [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    assert.equal(hex, LIGHT[name], name);
  }
});
