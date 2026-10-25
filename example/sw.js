// Service worker: la app funciona sin conexión.
// La lista de archivos y la versión las genera `npm run pwa` (tools/build-pwa.js);
// no edites a mano el bloque entre los marcadores.

// <precache>
const VERSION = '9d7533b03a';
const PRECACHE = [
  './',
  './app.js',
  './editor.js',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './index.html',
  './manifest.webmanifest',
  './songs/escala.json',
  './songs/estrellita.txt',
  './songs/martinillo.mid',
  './store.js',
  './style.css',
  './theme.js',
  '../src/colors.js',
  '../src/emitter.js',
  '../src/feedback.js',
  '../src/formats/audio.js',
  '../src/formats/export.js',
  '../src/formats/json.js',
  '../src/formats/midi-writer.js',
  '../src/formats/midi.js',
  '../src/formats/text.js',
  '../src/formats/ultrastar.js',
  '../src/game.js',
  '../src/index.js',
  '../src/keyboard.js',
  '../src/load.js',
  '../src/lyrics.js',
  '../src/metronome.js',
  '../src/notes.js',
  '../src/piano.js',
  '../src/pitch-detector.js',
  '../src/recorder.js',
  '../src/renderer.js',
  '../src/scorer.js',
  '../src/song.js',
  '../src/synth.js',
];
// </precache>

const CACHE = `pitchcoach-${VERSION}`;
const FONTS = 'pitchcoach-fonts';

self.addEventListener('install', (event) => {
  // cache: 'reload' salta la caché HTTP del navegador (GitHub Pages guarda 10 min):
  // sin esto, una versión nueva podía guardar archivos viejos mezclados con los nuevos.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// La página pide activar la versión nueva cuando el usuario pulsa «Actualizar».
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Tipografía de Google Fonts: se sirve la guardada y se refresca en segundo plano.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navegación: siempre el index.html de esta versión (con o sin ?accion=…).
  if (req.mode === 'navigate') {
    event.respondWith((async () => (await caches.match(new URL('./', self.location).href, { cacheName: CACHE })) ?? fetch(req))());
    return;
  }

  // Resto: primero la caché de esta versión; lo que no esté, de la red.
  event.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit ?? update;
}
