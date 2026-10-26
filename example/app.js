import { PitchCoach, loadSong, midiToName, songToDraft, joinLyrics, draftToJSON, draftToMidi, songToWav, openMicrophone, checkFeedback, FeedbackGuard } from '../src/index.js';
import { readJSON, writeJSON, removeJSON, clearAllJSON, listImported, saveImported, deleteImported, clearImported } from './store.js';
import { SongEditor, emptyDraft, EDITOR_DEFAULTS } from './editor.js';
import { lightColor } from './theme.js';

const $ = (sel) => document.querySelector(sel);

const BUILTIN = [
  { id: 'songs/responsorio-breve.json', artist: 'Completas' },
  { id: 'songs/escala.json', artist: 'Calentamiento' },
];

const DEFAULT_SETTINGS = {
  difficulty: 'normal',
  speed: 1,
  octaveTolerant: true,
  guideVolume: 0.35,
  accompanimentVolume: 0.18,
  latency: 0.06,
  notation: 'solfege',
  theme: 'claro',
};
const DIFFICULTY_TEXT = {
  facil: ['Fácil', 'Margen de ±1 semitono'],
  normal: ['Normal', 'Margen de ±½ semitono'],
  dificil: ['Difícil', 'Afinación fina, ±30 cents'],
};
const FORMAT_TEXT = { midi: 'MIDI', ultrastar: 'UltraStar', json: 'JSON' };

const settings = readJSON('settings', DEFAULT_SETTINGS);
// versiones anteriores tenían «original» e «invertido»
settings.theme = settings.theme === 'original' || settings.theme === 'oscuro' ? 'oscuro' : 'claro';
const perSong = readJSON('per-song', {}); // { id: { transpose, melody } }
const best = readJSON('best', {});        // { id: { score, grade, stars } }

/** @type {{id, name, artist, source, imported, song, error}[]} */
let library = [];
let current = null;  // library entry being played or viewed
let mode = 'mic';    // 'mic' | 'demo'

// One AudioContext for the whole app (created on first use, resumed on gestures).
let audioCtx = null;
const audio = () => (audioCtx ??= new AudioContext());

const game = new PitchCoach($('#stage'), { ...settings, hud: false, results: false, leadIn: 3 });
let returnTo = 'home'; // screen to go back to when leaving a game

// =========================================================================
// Library
// =========================================================================

async function initLibrary() {
  const builtins = await Promise.all(BUILTIN.map(async (b) => {
    const entry = { ...b, source: b.id, imported: false };
    await parseEntry(entry);
    return entry;
  }));
  const imported = await listImported();
  const importedEntries = await Promise.all(imported.map(async (r) => {
    const entry = { id: r.id, name: r.name, source: r.bytes, imported: true, own: !!r.own, addedAt: r.addedAt };
    await parseEntry(entry);
    return entry;
  }));
  library = [...importedEntries.filter((e) => e.song), ...builtins];
  renderLibrary();
}

async function parseEntry(entry) {
  try {
    entry.song = await loadSong(entry.source, { name: entry.name, melody: perSong[entry.id]?.melody });
    entry.error = null;
    indexEntry(entry);
  } catch (err) {
    entry.song = null;
    entry.error = err.message;
  }
  return entry;
}

// ---- selector de canciones ---------------------------------------------------

const SORT_DEFAULT_DIR = { title: 'asc', artist: 'asc', duration: 'asc', added: 'desc', played: 'desc', record: 'desc' };
const picker = readJSON('picker', { sort: 'title', dir: 'asc', filter: 'all' });
let query = '';
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Prepara los textos en los que se busca (sin tildes ni mayúsculas). */
function indexEntry(e) {
  const s = e.song;
  e.search = { title: norm(s.title), artist: norm(e.artist || s.artist), lyrics: norm(s.lines.map((l) => l.text).join(' ')) };
}

const lastPlayed = (e) => perSong[e.id]?.lastPlayed ?? 0;

function visibleSongs() {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  let list = library.filter((e) => e.song);
  const f = picker.filter;
  if (f === 'own') list = list.filter((e) => e.own);
  else if (f === 'imported') list = list.filter((e) => e.imported && !e.own);
  else if (f === 'builtin') list = list.filter((e) => !e.imported);
  else if (f === 'record') list = list.filter((e) => best[e.id]);
  else if (f === 'new') list = list.filter((e) => !lastPlayed(e) && !best[e.id]);
  if (terms.length) {
    list = list.filter((e) => terms.every((t) => e.search.title.includes(t) || e.search.artist.includes(t) || e.search.lyrics.includes(t)));
  }
  const key = {
    title: () => 0,
    artist: (a, b) => collator.compare(a.artist || a.song.artist || '￿', b.artist || b.song.artist || '￿'),
    duration: (a, b) => a.song.duration - b.song.duration,
    added: (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0),
    played: (a, b) => lastPlayed(a) - lastPlayed(b),
    record: (a, b) => (best[a.id]?.score ?? -1) - (best[b.id]?.score ?? -1),
  }[picker.sort] ?? (() => 0);
  const dir = picker.dir === 'desc' ? -1 : 1;
  const byTitle = (a, b) => collator.compare(a.song.title, b.song.title);
  return list.sort((a, b) => (picker.sort === 'title' ? dir * byTitle(a, b) : dir * key(a, b) || byTitle(a, b)));
}

/** Resalta los términos buscados en `text` (ignorando tildes y mayúsculas). */
function highlight(text, terms) {
  if (!terms.length) return escapeHTML(text);
  let flat = '';
  const map = [];
  [...text].forEach((ch, i) => {
    for (const c of norm(ch)) {
      flat += c;
      map.push(i);
    }
  });
  const chars = [...text];
  const marked = new Array(chars.length).fill(false);
  for (const t of terms) {
    let at = flat.indexOf(t);
    while (at >= 0) {
      for (let k = at; k < at + t.length; k++) marked[map[k]] = true;
      at = flat.indexOf(t, at + t.length);
    }
  }
  let out = '';
  let open = false;
  chars.forEach((c, i) => {
    if (marked[i] && !open) (out += '<mark>'), (open = true);
    if (!marked[i] && open) (out += '</mark>'), (open = false);
    out += escapeHTML(c);
  });
  return out + (open ? '</mark>' : '');
}

function relativeDate(ms) {
  const days = Math.round((Date.now() - ms) / 864e5);
  if (days < 1) return 'hoy';
  return new Intl.RelativeTimeFormat('es', { numeric: 'auto' }).format(-days, 'day');
}

function renderLibrary() {
  renderHome();
  const el = $('#library');
  if (!el) return;
  const total = library.filter((e) => e.song).length;
  const list = visibleSongs();
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const filtered = terms.length || picker.filter !== 'all';
  $('#songs-count').textContent = filtered ? `${list.length} de ${total}` : plural(total, 'canción', 'canciones');

  el.innerHTML = list.map((entry, i) => {
    const s = entry.song;
    const b = best[entry.id];
    let lyricHit = '';
    if (terms.length && !terms.every((t) => entry.search.title.includes(t) || entry.search.artist.includes(t))) {
      const line = s.lines.find((l) => terms.some((t) => norm(l.text).includes(t)));
      if (line) lyricHit = `<span class="song-lyric-hit">«${highlight(line.text.trim(), terms)}»</span>`;
    }
    const meta = [entry.artist || s.artist, formatDuration(s), FORMAT_TEXT[s.meta.format]].filter(Boolean).join(' · ');
    const badge = b
      ? `<span class="mini-grade">${b.grade}</span><span class="mini-stars">${starsText(b.stars)}</span>`
      : entry.own ? '<span class="tag-new">Tuya</span>' : entry.imported && Date.now() - (entry.addedAt ?? 0) < 864e5 ? '<span class="tag-new">Nueva</span>' : '';
    return `<button class="song-card" role="listitem" data-id="${escapeHTML(entry.id)}" style="animation-delay:${Math.min(i, 10) * 25}ms">
      ${coverHTML(s.title)}
      <span class="song-info">
        <span class="song-title">${highlight(s.title, terms)}</span>
        <span class="song-meta">${highlight(meta, terms)}</span>
        ${lyricHit}
      </span>
      <span class="song-best">${badge}</span>
    </button>`;
  }).join('');

  const empty = !list.length;
  $('#songs-empty').hidden = !empty;
  if (empty) {
    $('#songs-empty-title').textContent = !total ? 'Todavía no hay canciones' : terms.length ? `Nada coincide con «${query.trim()}»` : 'No hay canciones con este filtro';
    $('#songs-empty-text').textContent = !total ? 'Crea o importa una desde el inicio.' : 'Prueba con otras palabras o elige «Todas».';
  }
  syncPickerControls();
}

function syncPickerControls() {
  for (const b of document.querySelectorAll('#song-filters button')) b.setAttribute('aria-checked', String(b.dataset.filter === picker.filter));
  $('#song-sort').value = picker.sort;
  const labels = {
    title: ['A → Z', 'Z → A'], artist: ['A → Z', 'Z → A'], duration: ['Más cortas primero', 'Más largas primero'],
    added: ['Más antiguas primero', 'Más recientes primero'], played: ['Hace más tiempo primero', 'Más recientes primero'],
    record: ['Récord más bajo primero', 'Récord más alto primero'],
  }[picker.sort];
  const btn = $('#sort-dir');
  btn.textContent = picker.dir === 'asc' ? '↑' : '↓';
  btn.title = labels[picker.dir === 'asc' ? 0 : 1];
  btn.setAttribute('aria-label', `Orden: ${btn.title}. Pulsa para invertir`);
}

function renderHome() {
  const total = library.filter((e) => e.song).length;
  $('#practice-count').textContent = total ? `Elige entre ${plural(total, 'canción', 'canciones')}` : 'Crea o importa tu primera canción';
  const last = library.filter((e) => e.song && lastPlayed(e)).sort((a, b) => lastPlayed(b) - lastPlayed(a))[0];
  $('#continue-btn').hidden = !last;
  if (last) {
    $('#continue-cover').innerHTML = coverHTML(last.song.title);
    $('#continue-title').textContent = last.song.title;
    const b = best[last.id];
    $('#continue-meta').textContent = `Practicada ${relativeDate(lastPlayed(last))}${b ? ` · récord ${b.grade}` : ''}`;
    $('#continue-btn').onclick = () => openSongSheet(last);
  }
}

function isPicking() {
  return $('#songs').classList.contains('is-active');
}

function openPicker() {
  closeAllDialogs();
  showScreen('songs');
  if (!history.state?.songs) history.pushState({ songs: true }, '');
  renderLibrary();
  scrollTo(0, 0);
  if (matchMedia('(pointer: fine)').matches) $('#song-search').focus();
}

$('#practice-btn').addEventListener('click', openPicker);
$('#songs-back').addEventListener('click', () => (history.state?.songs ? history.back() : showScreen('home')));
$('#library').addEventListener('click', (e) => {
  const card = e.target.closest('.song-card');
  const entry = card && library.find((x) => x.id === card.dataset.id);
  if (entry) openSongSheet(entry);
});

let searchFrame = 0;
$('#song-search').addEventListener('input', (e) => {
  query = e.target.value;
  $('#search-clear').hidden = !query;
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(renderLibrary);
});
$('#search-clear').addEventListener('click', () => {
  query = '';
  $('#song-search').value = '';
  $('#search-clear').hidden = true;
  $('#song-search').focus();
  renderLibrary();
});
$('#song-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  picker.filter = b.dataset.filter;
  writeJSON('picker', picker);
  renderLibrary();
});
$('#song-sort').addEventListener('change', (e) => {
  picker.sort = e.target.value;
  picker.dir = SORT_DEFAULT_DIR[picker.sort];
  writeJSON('picker', picker);
  renderLibrary();
});
$('#sort-dir').addEventListener('click', () => {
  picker.dir = picker.dir === 'asc' ? 'desc' : 'asc';
  writeJSON('picker', picker);
  renderLibrary();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && isPicking() && document.activeElement !== $('#song-search') && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    $('#song-search').focus();
  }
});

function coverHTML(title) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<span class="cover" aria-hidden="true" style="--c1: hsl(${hue} 65% 42%); --c2: hsl(${(hue + 150) % 360} 80% 62%)"></span>`;
}

function starsText(stars) {
  const full = Math.round(stars);
  return '★'.repeat(full) + `<span class="off">${'★'.repeat(5 - full)}</span>`;
}

function formatDuration(song) {
  const s = Math.round(song.duration);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function noteName(midi) {
  return midiToName(midi, { notation: settings.notation });
}

// ---- importing ----------------------------------------------------------------

async function importFile(file) {
  if (!file) return;
  const bytes = await file.arrayBuffer();
  const entry = { id: `imp-${Date.now()}`, name: file.name, source: bytes, imported: true, addedAt: Date.now() };
  await parseEntry(entry);
  if (!entry.song) return toast(`No se pudo leer «${file.name}»: ${entry.error}`, true);
  if (!entry.song.notes.length) return toast('El archivo no tiene notas para cantar', true);
  await saveImported({ id: entry.id, name: file.name, bytes, addedAt: entry.addedAt });
  library.unshift(entry);
  renderLibrary();
  if (entry.song.meta.format === 'midi' && !entry.song.meta.hasLyrics) toast('Este MIDI no trae letra: podrás cantarlo con vocales');
  openSongSheet(entry);
}

$('#file').addEventListener('change', (e) => {
  importFile(e.target.files[0]);
  e.target.value = '';
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!isBrowsing() || !e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (isBrowsing()) importFile(e.dataTransfer.files[0]);
});

// =========================================================================
// Song sheet
// =========================================================================

function openSongSheet(entry) {
  current = entry;
  const s = entry.song;
  $('#sheet-cover').outerHTML = coverHTML(s.title).replace('class="cover"', 'class="cover cover-lg" id="sheet-cover"');
  $('#sheet-title').textContent = s.title;
  $('#sheet-artist').textContent = entry.artist || s.artist || FORMAT_TEXT[s.meta.format];
  $('#sheet-stats').innerHTML = `
    <div class="stat"><b>${formatDuration(s)}</b><span>Duración</span></div>
    <div class="stat"><b>${s.notes.length}</b><span>Notas</span></div>
    <div class="stat"><b>${noteName(s.lowest + transposeOf(entry))}–${noteName(s.highest + transposeOf(entry))}</b><span>Tesitura</span></div>`;
  const b = best[entry.id];
  $('#sheet-best').innerHTML = b
    ? `<span>Tu récord</span><span class="mini-stars">${starsText(b.stars)}</span><span>${b.grade} · ${b.score.toLocaleString('es')}</span>
       <button class="best-clear" id="best-clear" aria-label="Borrar el récord de esta canción" title="Borrar récord">
         <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>`
    : '';
  $('#delete-song').hidden = !entry.imported;
  $('#edit-btn span').textContent = entry.own ? 'Editar' : 'Editar copia';
  renderChips();
  openDialog($('#song-sheet'));
}

function renderChips() {
  const chips = [DIFFICULTY_TEXT[settings.difficulty][0]];
  if (settings.speed !== 1) chips.push(`${Math.round(settings.speed * 100)}%`);
  const t = transposeOf(current);
  if (t) chips.push(`Tono ${t > 0 ? '+' : ''}${t}`);
  if (!settings.guideVolume) chips.push('Sin guía');
  if (!settings.octaveTolerant) chips.push('Octava exacta');
  $('#sheet-chips').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
}

function transposeOf(entry) {
  return entry ? perSong[entry.id]?.transpose ?? 0 : 0;
}

$('#sheet-settings').addEventListener('click', () => openSettings());
$('#sing-btn').addEventListener('click', () => startGame('mic'));
$('#demo-btn').addEventListener('click', () => startGame('demo'));
$('#delete-song').addEventListener('click', async () => {
  if (!current?.imported) return;
  const ok = await askConfirm({ title: '¿Quitar esta canción?', text: `«${current.song.title}» se eliminará de tu biblioteca.`, ok: 'Quitar', cancel: 'Cancelar', danger: true });
  if (!ok) return;
  await removeSong(current.id);
  closeDialog($('#song-sheet'));
  toast('Canción eliminada');
});
$('#edit-btn').addEventListener('click', () => openEditorWith(current));

async function removeSong(id) {
  await deleteImported(id);
  library = library.filter((e) => e.id !== id);
  delete best[id];
  writeJSON('best', best);
  renderLibrary();
}

// =========================================================================
// Settings
// =========================================================================

// ---- ayuda ------------------------------------------------------------------------

document.querySelectorAll('[data-open-help]').forEach((b) => b.addEventListener('click', () => openDialog($('#scoring-help'))));

// ---- aspecto ---------------------------------------------------------------------

function applyTheme(theme) {
  const map = theme === 'claro' ? lightColor : null;
  document.documentElement.dataset.theme = theme;
  game.set({ colorMap: map });
  editor.colorMap = map;
  editor.draw();
  renderLibrary();
  // la barra del sistema en el móvil sigue al tema
  $('meta[name="theme-color"]').content = theme === 'claro' ? '#f6f3fb' : '#170640';
}

// ---- versión ----------------------------------------------------------------------

async function showVersion() {
  let v = 'desarrollo';
  try {
    const key = (await caches.keys()).find((k) => k.startsWith('pitchcoach-') && k !== 'pitchcoach-fonts');
    if (key) v = key.replace('pitchcoach-', '');
  } catch { /* sin caché */ }
  $('#app-version').textContent = `Versión ${v}`;
}

$('#check-update').addEventListener('click', async () => {
  const btn = $('#check-update');
  if (!swReg) return toast('En este navegador la app no se guarda para usar sin conexión: siempre tienes la última versión');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    await swReg.update();
    const found = swReg.installing ?? swReg.waiting;
    if (!found) return toast('Ya tienes la última versión');
    toast('Descargando la versión nueva…');
    if (found.state !== 'installed') {
      await new Promise((resolve) => found.addEventListener('statechange', () => found.state === 'installed' && resolve()));
    }
    applyUpdate(found);
  } catch {
    toast('No se pudo comprobar. ¿Tienes conexión?', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar actualizaciones';
  }
});

// ---- tus datos ------------------------------------------------------------------

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function syncDataUI() {
  $('#data-group').hidden = isPlaying();
  const records = Object.keys(best).length;
  const own = library.filter((e) => e.own).length;
  const imported = library.filter((e) => e.imported && !e.own).length;
  $('#data-best').textContent = records ? plural(records, 'canción con récord', 'canciones con récord') : 'Ninguno todavía';
  $('#data-songs').textContent = own + imported
    ? [own && plural(own, 'creada', 'creadas'), imported && plural(imported, 'importada', 'importadas')].filter(Boolean).join(' · ')
    : 'Ninguna todavía';
  $('[data-clear="best"]').disabled = !records;
  $('[data-clear="songs"]').disabled = !(own + imported);
}

const CLEAR_TEXT = {
  best: { title: '¿Borrar todos los récords?', text: 'Se perderán tus mejores puntuaciones y estrellas de todas las canciones.', ok: 'Borrar récords', done: 'Récords borrados' },
  songs: { title: '¿Borrar tus canciones?', text: 'Se eliminarán las canciones que has creado o importado, con sus récords. Si quieres conservar alguna, expórtala antes.', ok: 'Borrar canciones', done: 'Canciones borradas' },
  settings: { title: '¿Restablecer los ajustes?', text: 'Vuelven los valores de fábrica: dificultad, sonido, tono de cada canción, preferencias del editor y el borrador sin guardar.', ok: 'Restablecer', done: 'Ajustes restablecidos' },
  all: { title: '¿Borrar todos tus datos?', text: 'Récords, canciones creadas e importadas, ajustes y borradores. La app quedará como recién instalada.', ok: 'Borrar todo', done: 'Todos tus datos se han borrado' },
};

async function clearData(kind) {
  const t = CLEAR_TEXT[kind];
  if (!(await askConfirm({ title: t.title, text: t.text, ok: t.ok, cancel: 'Cancelar', danger: true }))) return;
  const forget = (obj) => Object.keys(obj).forEach((k) => delete obj[k]);

  if (kind === 'best' || kind === 'all') forget(best);
  if (kind === 'songs' || kind === 'all') {
    await clearImported();
    for (const e of library.filter((x) => x.imported)) {
      delete best[e.id];
      delete perSong[e.id];
    }
    library = library.filter((e) => !e.imported);
    if (current?.imported) {
      closeDialog($('#song-sheet'));
      current = null;
    }
  }
  if (kind === 'settings' || kind === 'all') {
    Object.assign(settings, DEFAULT_SETTINGS);
    forget(perSong);
    Object.assign(editor.prefs, EDITOR_DEFAULTS);
    forgetSpeakerMode();
    editor.clearAutosave();
    game.set({ ...settings });
    editor.keyboard.setNotation(settings.notation);
  }

  if (kind === 'all') {
    clearAllJSON();
  } else {
    writeJSON('best', best);
    writeJSON('per-song', perSong);
    if (kind === 'settings') {
      removeJSON('settings');
      removeJSON('editor-prefs');
    }
  }
  renderLibrary();
  syncSettingsUI();
  if (current) renderChips();
  toast(t.done);
}

document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => clearData(b.dataset.clear)));

$('#sheet-best').addEventListener('click', async (e) => {
  if (!e.target.closest('#best-clear') || !current) return;
  const ok = await askConfirm({ title: '¿Borrar este récord?', text: `Se perderá tu mejor puntuación en «${current.song.title}».`, ok: 'Borrar récord', cancel: 'Cancelar', danger: true });
  if (!ok) return;
  delete best[current.id];
  writeJSON('best', best);
  $('#sheet-best').innerHTML = '';
  renderLibrary();
  toast('Récord borrado');
});

function openSettings() {
  syncSettingsUI();
  openDialog($('#settings'));
}

function syncSettingsUI() {
  syncDataUI();
  syncSpeakerUI();
  showVersion();
  document.querySelectorAll('.segmented[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(String(settings[key]) === b.dataset.value)));
  });
  $('#difficulty-hint').textContent = DIFFICULTY_TEXT[settings.difficulty][1];
  const t = transposeOf(current);
  $('#transpose').value = t > 0 ? `+${t}` : String(t);
  $('#tr-down').disabled = !current;
  $('#tr-up').disabled = !current;
  $('#transpose-hint').textContent = current ? `Semitonos, solo para «${current.song.title}»` : 'Abre una canción para cambiar su tono';
  $('#octave').checked = settings.octaveTolerant;
  $('#guide').value = settings.guideVolume;
  $('#backing').value = settings.accompanimentVolume;
  $('#latency').value = settings.latency;
  $('#latency-value').textContent = `${Math.round(settings.latency * 1000)} ms`;

  const cands = current?.song?.meta.candidates ?? [];
  $('#track-setting').hidden = isPlaying() || cands.length < 2;
  $('#track-select').innerHTML = cands
    .map((c) => `<option value="${c.id}" ${c.id === current.song.meta.melody ? 'selected' : ''}>${escapeHTML(c.name)} · ${c.noteCount} notas${c.lyricMatches ? ' · letra' : ''}</option>`)
    .join('');
}

function updateSetting(patch) {
  if ('theme' in patch) applyTheme(patch.theme);
  Object.assign(settings, patch);
  writeJSON('settings', settings);
  game.set(patch);
  if ('notation' in patch) {
    editor.keyboard.setNotation(settings.notation);
    editor.draw();
  }
  syncSettingsUI();
  if (current) renderChips();
}

document.querySelectorAll('.segmented[data-setting]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const raw = btn.dataset.value;
    updateSetting({ [seg.dataset.setting]: isNaN(raw) ? raw : Number(raw) });
  });
});
$('#octave').addEventListener('change', (e) => updateSetting({ octaveTolerant: e.target.checked }));
$('#guide').addEventListener('input', (e) => updateSetting({ guideVolume: Number(e.target.value) }));
$('#backing').addEventListener('input', (e) => updateSetting({ accompanimentVolume: Number(e.target.value) }));
$('#latency').addEventListener('input', (e) => updateSetting({ latency: Number(e.target.value) }));

function stepTranspose(d) {
  if (!current) return;
  const v = Math.max(-12, Math.min(12, transposeOf(current) + d));
  perSong[current.id] = { ...perSong[current.id], transpose: v };
  writeJSON('per-song', perSong);
  game.set({ transpose: v });
  syncSettingsUI();
  renderChips();
  if ($('#song-sheet').open) openSongSheetStats();
}
function openSongSheetStats() {
  const s = current.song;
  const t = transposeOf(current);
  $('#sheet-stats .stat:last-child b').textContent = `${noteName(s.lowest + t)}–${noteName(s.highest + t)}`;
}
$('#tr-down').addEventListener('click', () => stepTranspose(-1));
$('#tr-up').addEventListener('click', () => stepTranspose(1));

$('#track-select').addEventListener('change', async (e) => {
  perSong[current.id] = { ...perSong[current.id], melody: e.target.value };
  writeJSON('per-song', perSong);
  await parseEntry(current);
  openSongSheetStats();
  toast('Pista de la voz cambiada');
});

$('#open-settings-home').addEventListener('click', () => {
  current = null;
  openSettings();
});

// =========================================================================
// Game
// =========================================================================

function isBrowsing() {
  return isHome() || isPicking();
}
function isHome() {
  return $('#home').classList.contains('is-active');
}
function isPlaying() {
  return $('#play').classList.contains('is-active');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
  document.body.classList.toggle('playing', id === 'play' || id === 'editor');
}

let gameRun = 0; // cambia en cada arranque y al salir: lo que llegue tarde de un arranque viejo se descarta

async function startGame(m) {
  if (!current?.song) return;
  const run = ++gameRun;
  const stale = () => run !== gameRun || !isPlaying();
  mode = m;
  if (returnTo !== 'editor') returnTo = isPicking() ? 'songs' : 'home';
  if (m === 'mic' && current.id !== 'editor-preview') {
    perSong[current.id] = { ...perSong[current.id], lastPlayed: Date.now() };
    writeJSON('per-song', perSong);
  }
  const btn = m === 'mic' ? $('#sing-btn') : $('#demo-btn');
  btn.disabled = true;
  const label = btn.querySelector('span') ?? btn;
  const prevLabel = label.textContent;
  if (m === 'mic') label.textContent = 'Activando micrófono…';

  try {
    closeAllDialogs();
    game.stop();
    releaseMic();
    game.audioContext ??= audio();
    showScreen('play');
    if (!history.state?.play) history.pushState({ play: true }, '');
    layoutHud();
    game.set({ ...settings, transpose: transposeOf(current) });
    game.load(current.song);
    $('#hud-title').textContent = current.song.title;
    $('#mode-badge').hidden = m !== 'demo';
    resetHud();
    let input = m;
    if (m === 'mic') {
      const audioSetup = await prepareAudio(current.song);
      if (stale()) return releaseMic(); // saliste durante la comprobación
      if (!audioSetup) return exitGame();
      input = audioSetup.stream;
      if (!audioSetup.guide) game.set({ guideVolume: 0, accompanimentVolume: 0 });
    } else {
      showAudioMode(null);
    }
    guard.reset();
    await game.start({ input });
    if (stale()) {
      game.stop();
      releaseMic();
      return;
    }
    keepAwake(true);
  } catch (err) {
    if (stale()) return;
    exitGame({ fromHistory: false });
    toast(err.name === 'NotAllowedError'
      ? 'Necesito permiso para usar el micrófono. Actívalo en los ajustes del navegador.'
      : err.name === 'NotFoundError' ? 'No encuentro ningún micrófono' : err.message, true);
  } finally {
    btn.disabled = false;
    label.textContent = prevLabel;
  }
}

function exitGame({ fromHistory = false } = {}) {
  gameRun++;
  audioAbort?.abort(); // corta una comprobación de audio en curso
  audioPrompt?.(null); // y cierra el aviso si estaba abierto
  game.stop();
  releaseMic();
  game.setLoop(null);
  keepAwake(false);
  closeAllDialogs();
  showScreen(returnTo);
  if (returnTo === 'editor') editor.draw();
  returnTo = 'home';
  renderLibrary();
  if (!fromHistory && history.state?.play) {
    ignorePop = true;
    history.back();
  }
  setTimeout(maybeApplyUpdate, 300);
}

function pauseGame() {
  if (game.state !== 'playing') return;
  game.pause();
  $('#loop-btn').textContent = game.loopRange ? 'Dejar de repetir la frase' : 'Repetir esta frase';
  $('#loop-btn').classList.toggle('active', !!game.loopRange);
  openDialog($('#pause-menu'));
}

function resumeGame() {
  closeDialog($('#pause-menu'));
  game.resume();
}

$('#pause-btn').addEventListener('click', pauseGame);

$('#pause-menu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'resume') resumeGame();
  if (action === 'restart') startGame(mode);
  if (action === 'loop') {
    if (game.loopRange) game.setLoop(null);
    else {
      const t = Math.max(0, game.currentTime);
      const line = current.song.lines.find((l) => t < l.end) ?? current.song.lines.at(-1);
      game.setLoop(line.start - 1, line.end + 0.4);
    }
    resumeGame();
    toast(game.loopRange ? 'Repitiendo la frase. Pausa para salir del bucle.' : 'Bucle desactivado');
  }
  if (action === 'settings') openSettings();
  if (action === 'exit') exitGame();
});
// Esc on the pause menu resumes
$('#pause-menu').addEventListener('cancel', (e) => {
  e.preventDefault();
  resumeGame();
});

document.addEventListener('keydown', (e) => {
  if (!isPlaying() || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space' || e.code === 'Escape' || e.code === 'KeyP') {
    e.preventDefault();
    pauseGame();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') pauseGame();
});

let ignorePop = false;
window.addEventListener('popstate', () => {
  if (ignorePop) {
    ignorePop = false;
    return;
  }
  if (isPlaying()) exitGame({ fromHistory: true });
  else if (isPicking() && !history.state?.songs) {
    closeAllDialogs();
    showScreen('home');
    renderLibrary();
  } else if (isEditing()) {
    // keep the editor until it confirms leaving (it may ask about unsaved changes)
    history.pushState({ editor: true }, '');
    editor.exit();
  }
});

// =========================================================================
// Audio: auriculares, cancelación de eco o sin guía
// =========================================================================

let micStream = null;
let audioAbort = null; // AbortController de la comprobación en curso
let audioPrompt = null; // resuelve el aviso abierto
let audioOk = null; // lo que funcionó con altavoz en esta sesión: { ec, guide }
const guard = new FeedbackGuard();
const deviceAudio = readJSON('audio', {}); // { ecWorks: true|false } aprendido en este dispositivo


function releaseMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

const AUDIO_ICONS = {
  headphones: ['Auriculares', '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6" rx="1.5"/>'],
  ec: ['Cancelación de eco', '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'],
  noguide: ['Sin guía', '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>'],
};

function showAudioMode(kind) {
  const el = $('#audio-mode');
  el.hidden = !kind;
  if (!kind) return;
  const [label, path] = AUDIO_ICONS[kind];
  el.title = label;
  el.setAttribute('aria-label', label);
  el.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`;
}

/** Abre el micrófono y comprueba que no capta el altavoz. Devuelve { stream, guide } o null si se cancela. */
async function prepareAudio(song) {
  const ctx = audio();
  showAudioMode(null);
  const midis = [...new Set(song.notes.map((n) => n.midi + transposeOf(current)))].slice(0, 4);
  const volume = Math.max(0.15, settings.guideVolume) * 0.6;
  const liveText = $('#live-text');
  const attempt = async (ec) => {
    releaseMic();
    micStream = await openMicrophone({ echoCancellation: ec });
    liveText.textContent = 'Comprobando audio…';
    audioAbort = new AbortController();
    const { leaking, aborted } = await checkFeedback({ audioContext: ctx, stream: micStream, midis, volume, signal: audioAbort.signal });
    audioAbort = null;
    liveText.textContent = 'Canta…';
    if (aborted) throw new DOMException('Comprobación cancelada', 'AbortError');
    return !leaking;
  };
  const done = (kind, ec, guide = true) => {
    if (kind !== 'headphones') audioOk = { ec, guide }; // con auriculares no se olvida lo elegido para el altavoz
    showAudioMode(kind);
    return { stream: micStream, guide };
  };

  // siempre primero sin cancelación: si no se capta el altavoz, auriculares y guía normal
  if (await attempt(false)) return done('headphones', false);
  // con altavoz: lo que ya funcionó, sin volver a preguntar
  if (audioOk && !audioOk.guide) return done('noguide', false, false);
  if ((audioOk?.ec || deviceAudio.ecWorks) && (await attempt(true))) return done('ec', true);

  // el micrófono capta el altavoz: se pregunta
  return new Promise((resolve) => {
    const d = $('#audio-check');
    const err = $('#audio-error');
    const ecBtn = d.querySelector('[data-choice="ec"]');
    err.hidden = true;
    ecBtn.disabled = deviceAudio.ecWorks === false;
    $('#ec-caption').hidden = !ecBtn.disabled;
    openDialog(d);

    const finish = (value) => {
      audioPrompt = null;
      d.removeEventListener('click', onClick);
      d.removeEventListener('cancel', onCancel);
      closeDialog(d);
      resolve(value);
    };
    audioPrompt = finish;
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    const onClick = async (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn || btn.classList.contains('busy')) return;
      const choice = btn.dataset.choice;
      if (choice === 'cancel') return finish(null);
      if (choice === 'noguide') {
        releaseMic();
        micStream = await openMicrophone();
        return finish(done('noguide', false, false));
      }
      btn.classList.add('busy');
      err.hidden = true;
      const ok = await attempt(choice === 'ec');
      btn.classList.remove('busy');
      if (choice === 'ec') {
        deviceAudio.ecWorks = ok;
        writeJSON('audio', deviceAudio);
      }
      if (ok) return finish(done(choice === 'ec' ? 'ec' : 'headphones', choice === 'ec'));
      if (choice === 'ec') {
        ecBtn.disabled = true;
        $('#ec-caption').hidden = false;
      } else {
        err.hidden = false;
      }
    };
    d.addEventListener('click', onClick);
    d.addEventListener('cancel', onCancel);
  });
}

/** Qué se hace cuando suena por el altavoz, para Ajustes. */
function syncSpeakerUI() {
  const learned = audioOk || deviceAudio.ecWorks !== undefined;
  $('#speaker-mode').textContent = audioOk && !audioOk.guide ? 'Sin guía'
    : audioOk?.ec || deviceAudio.ecWorks ? 'Cancelación de eco' : 'Preguntar';
  $('#speaker-reset').disabled = !learned;
}

function forgetSpeakerMode() {
  audioOk = null;
  delete deviceAudio.ecWorks;
  removeJSON('audio');
}

$('#speaker-reset').addEventListener('click', () => {
  forgetSpeakerMode();
  syncSpeakerUI();
  toast('Se preguntará en la próxima canción');
});

// Durante la partida: si la app se oye a sí misma, se para y se vuelve a preguntar.
game.on('frame', (f) => mode === 'mic' && guard.frame(f));
game.on('note', (e) => {
  if (mode !== 'mic' || !audioOk?.guide || !guard.note(e)) return;
  audioOk = null;
  if (deviceAudio.ecWorks && $('#audio-mode').title === 'Cancelación de eco') {
    deviceAudio.ecWorks = false;
    writeJSON('audio', deviceAudio);
  }
  game.pause();
  setTimeout(() => startGame('mic')); // fuera del fotograma en curso
});

// =========================================================================
// Editor
// =========================================================================

function isEditing() {
  return $('#editor').classList.contains('is-active');
}

const editor = new SongEditor({
  root: $('#editor'),
  audio,
  notation: () => settings.notation,
  toast,
  openDialog,
  closeDialog,
  confirm: askConfirm,
  async onSave(json, id) {
    id ||= `own-${Date.now()}`;
    const bytes = new TextEncoder().encode(JSON.stringify(json)).buffer;
    const prev = library.find((e) => e.id === id);
    const entry = { id, name: `${json.title}.json`, source: bytes, imported: true, own: true, addedAt: prev?.addedAt ?? Date.now() };
    await parseEntry(entry);
    await saveImported({ id, name: entry.name, bytes, addedAt: entry.addedAt, own: true });
    library = [entry, ...library.filter((e) => e.id !== id)];
    renderLibrary();
    return id;
  },
  async onTry(json) {
    const song = await loadSong(json);
    current = { id: 'editor-preview', song, artist: 'Borrador' };
    returnTo = 'editor';
    startGame('mic');
  },
  onExit() {
    showScreen('home');
    renderLibrary();
    setTimeout(maybeApplyUpdate, 300);
    if (history.state?.editor) {
      ignorePop = true;
      history.back();
    }
  },
  onDelete: (id) => removeSong(id),
  async onExport(json) {
    openExport({ song: await loadSong(json), json });
  },
});

// =========================================================================
// Exportar: MIDI con letra, audio WAV o JSON
// =========================================================================

let exportTarget = null;

function openExport({ song, json = null }) {
  exportTarget = { song, json };
  $('#export-song').textContent = `«${song.title}» · ${song.notes.length} notas`;
  openDialog($('#export'));
}

$('#export-btn').addEventListener('click', () => {
  let json = null;
  if (current.own) {
    try {
      json = JSON.parse(new TextDecoder().decode(current.source));
    } catch { /* se genera de nuevo */ }
  }
  openExport({ song: current.song, json });
});

$('#export').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-format]');
  if (!btn || !exportTarget) return;
  const { song, json } = exportTarget;
  const base = fileName(song.title);
  btn.classList.add('busy');
  try {
    let file;
    if (btn.dataset.format === 'midi') {
      file = new File([draftToMidi(songToDraft(song))], `${base}.mid`, { type: 'audio/midi' });
    } else if (btn.dataset.format === 'wav') {
      file = new File([await songToWav(song)], `${base}.wav`, { type: 'audio/wav' });
    } else {
      const data = json ?? { ...draftToJSON(songToDraft(song)), lyricsText: joinLyrics(song.notes) };
      file = new File([JSON.stringify(data, null, 2)], `${base}.json`, { type: 'application/json' });
    }
    closeDialog($('#export'));
    await deliver(file);
  } catch (err) {
    toast(`No se pudo exportar: ${err.message}`, true);
  } finally {
    btn.classList.remove('busy');
  }
});

/** En el móvil abre el menú de compartir (guardar en Archivos, enviar…); en el ordenador descarga. */
async function deliver(file) {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // el usuario cerró el menú
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Descargado: ${file.name}`);
}

function fileName(title) {
  return (title || 'mi-cancion').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mi-cancion';
}

applyTheme(settings.theme); // después de crear el juego y el editor, que también se colorean

function showEditor() {
  closeAllDialogs();
  showScreen('editor');
  if (!history.state?.editor) history.pushState({ editor: true }, '');
  requestAnimationFrame(() => editor.draw());
}

$('#create-song').addEventListener('click', () => {
  showEditor();
  if (editor.restoreAutosave()) toast('Hemos recuperado tu borrador');
  else editor.open(emptyDraft());
});

function openEditorWith(entry) {
  const song = entry.song;
  let saved = null;
  if (entry.own) {
    try {
      saved = JSON.parse(new TextDecoder().decode(entry.source));
    } catch { /* not ours after all */ }
  }
  const draft = {
    ...songToDraft(song),
    beatsPerBar: 4,
    lyricsText: saved?.lyricsText ?? joinLyrics(song.notes),
  };
  showEditor();
  editor.open(draft, { id: entry.own ? entry.id : null });
  if (!entry.own) toast(song.accompaniment.length ? 'Editas una copia (sin el acompañamiento); el original no cambia' : 'Editas una copia; el original no cambia');
}

// ---- confirm dialog ---------------------------------------------------------------

function askConfirm({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false }) {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  $('#confirm-cancel').textContent = cancel;
  $('#confirm-ok').classList.toggle('btn-danger', danger);
  openDialog(d);
  return new Promise((resolve) => {
    const done = (v) => {
      d.removeEventListener('click', onClick);
      d.removeEventListener('cancel', onCancel);
      closeDialog(d);
      resolve(v);
    };
    const onClick = (e) => {
      const a = e.target.closest('[data-answer]')?.dataset.answer;
      if (a) done(a === 'yes');
    };
    const onCancel = (e) => {
      e.preventDefault();
      done(false);
    };
    d.addEventListener('click', onClick);
    d.addEventListener('cancel', onCancel);
  });
}

// ---- HUD ------------------------------------------------------------------------

let shownScore = 0;

function resetHud() {
  shownScore = 0;
  $('#score').textContent = '0';
  $('#combo').textContent = '';
  $('#combo').className = 'combo';
  $('#streak').classList.remove('on');
}

game.on('score', ({ score, combo, multiplier }) => {
  animateScore(score);
  const el = $('#combo');
  el.textContent = combo >= 2 ? `Combo ${combo}${multiplier > 1 ? ` · ×${multiplier}` : ''}` : '';
  el.className = `combo x${multiplier}`;
});

function animateScore(target) {
  const from = shownScore;
  shownScore = target;
  const el = $('#score');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 300);
    el.textContent = Math.round(from + (target - from) * k).toLocaleString('es');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let lastLive = '';
game.on('frame', ({ pitch }) => {
  const live = $('#live-note');
  const text = pitch?.freq ? `${noteName(pitch.midi)} ${pitch.cents > 0 ? '+' : ''}${pitch.cents ?? 0}¢` : 'Canta…';
  if (text !== lastLive) $('#live-text').textContent = lastLive = text;
  live.classList.toggle('voiced', !!pitch?.freq);
  live.classList.toggle('hit', !!pitch?.hit);

  const s = game.scorer;
  const step = s.options.streakStep;
  $('#streak').classList.toggle('on', s.streak > 0.2);
  $('#streak i').style.width = `${((s.streak % step) / step) * 100}%`;
});

// ---- Results ----------------------------------------------------------------------

game.on('end', (r) => {
  keepAwake(false);
  setTimeout(() => showResults(r), 900);
});

function showResults(r) {
  const prev = best[current.id];
  const isRecord = mode === 'mic' && r.score > 0 && (!prev || r.score > prev.score);
  if (isRecord) {
    best[current.id] = { score: r.score, grade: r.grade, stars: r.stars };
    writeJSON('best', best);
  }
  $('#results-song').textContent = current.song.title + (mode === 'demo' ? ' · demo' : '');
  $('#results-title').textContent = r.percent >= 0.8 ? '¡Qué bien cantas!' : r.percent >= 0.5 ? '¡Canción completada!' : '¡Sigue practicando!';
  $('#result-stars').innerHTML = Array.from({ length: 5 }, (_, i) => {
    const fill = Math.max(0, Math.min(1, r.stars - i));
    return `<svg viewBox="0 0 24 24" class="star" style="animation-delay:${200 + i * 120}ms">
      <defs><linearGradient id="sg${i}"><stop offset="${fill * 100}%" stop-color="#ffcf4a"/><stop offset="${fill * 100}%" stop-color="rgba(255,255,255,0.18)"/></linearGradient></defs>
      <path fill="url(#sg${i})" d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4L2.8 9.3l6.4-.8z"/></svg>`;
  }).join('');
  $('#result-stars').setAttribute('aria-label', `${r.stars} de 5 estrellas`);
  const grade = $('#grade');
  grade.textContent = r.grade;
  grade.className = `grade ${r.grade}`;
  $('#record').hidden = !isRecord || !prev;
  $('#breakdown').innerHTML = `
    <div><dt>Afinación</dt><dd>${Math.round(r.percent * 100)}%</dd></div>
    <div><dt>Perfectas</dt><dd>${r.counts.perfect}</dd></div>
    <div><dt>Combo máx.</dt><dd>${r.maxCombo}</dd></div>`;
  openDialog($('#results'));
  countUp($('#result-score'), r.score, 1100);
}

function countUp(el, target, ms) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.textContent = Math.round(target * (1 - (1 - k) ** 3)).toLocaleString('es');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

$('#results').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'again') startGame(mode);
  if (action === 'library') exitGame();
});
$('#results').addEventListener('cancel', (e) => {
  e.preventDefault();
  exitGame();
});

// =========================================================================
// Layout helpers
// =========================================================================

function layoutHud() {
  const probe = getComputedStyle($('#safe-probe'));
  const hudBottom = $('#hud').getBoundingClientRect().bottom || 80;
  game.set({
    insets: { top: Math.round(hudBottom - 30), bottom: parseFloat(probe.paddingBottom) || 0 },
    playheadPosition: innerWidth < 600 ? 0.24 : 0.3,
  });
}
addEventListener('resize', () => isPlaying() && layoutHud());

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed, fine */ }
}

// ---- dialogs ----------------------------------------------------------------------

function openDialog(d) {
  cancelPendingClose(d);
  if (!d.open) d.showModal();
}

/** Un cierre animado pendiente no debe cerrar la ventana la próxima vez que se abra. */
function cancelPendingClose(d) {
  if (d._closeDone) d.removeEventListener('animationend', d._closeDone);
  d._closeDone = null;
  d.classList.remove('closing');
}

function closeDialog(d) {
  if (!d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  const done = () => {
    cancelPendingClose(d);
    d.close();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
  d._closeDone = done;
  d.addEventListener('animationend', done, { once: true });
}

function closeAllDialogs() {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    cancelPendingClose(d);
    d.close();
  });
}

document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => setTimeout(maybeApplyUpdate, 300)));

document.querySelectorAll('dialog.modal [data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(b.closest('dialog'))));

document.querySelectorAll('dialog.sheet').forEach((d) => {
  // tap on the backdrop closes sheets
  d.addEventListener('click', (e) => {
    if (e.target === d) closeDialog(d);
  });
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog(d);
  });
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(d)));
  enableSwipeToClose(d);
});

function enableSwipeToClose(d) {
  let startY = null;
  let dy = 0;
  d.addEventListener('touchstart', (e) => {
    if (d.scrollTop > 0 || innerWidth >= 720) return;
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  d.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    d.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  d.addEventListener('touchend', () => {
    if (startY == null) return;
    d.style.transform = '';
    if (dy > 90) closeDialog(d);
    startY = null;
  });
}

// ---- toast ------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 5000 : 2600);
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =========================================================================
// PWA: funcionamiento sin conexión, instalación y apertura de archivos
// =========================================================================

const ready = initLibrary();

// En local (desarrollo) no se registra, para no servir archivos antiguos de la caché;
// añade ?sw a la URL para probarlo.
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let updating = false; // solo se recarga al aplicar una versión nueva, no en la primera instalación
let swReg = null;
let waitingWorker = null;

// Se puede actualizar sin molestar si estás en la biblioteca sin nada abierto.
const canUpdateNow = () => isBrowsing() && !document.querySelector('dialog[open]') && game.state !== 'playing';

function applyUpdate(worker = waitingWorker) {
  if (!worker || updating) return;
  updating = true;
  worker.postMessage('skipWaiting');
}

/** Llamar al volver a la biblioteca: aplica una versión pendiente. */
function maybeApplyUpdate() {
  if (waitingWorker && canUpdateNow()) applyUpdate();
}

const offerUpdate = (worker) => {
  waitingWorker = worker;
  if (canUpdateNow()) return applyUpdate(worker);
  // cantando o editando: se avisa y se aplica al volver a la biblioteca
  $('#update-bar').hidden = false;
  $('#update-btn').onclick = () => {
    $('#update-btn').disabled = true;
    applyUpdate(worker);
  };
};

if ('serviceWorker' in navigator && (!isLocal || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    // una versión nueva puede estar ya esperando o descargándose al abrir la app
    const track = (w) => {
      if (!w || !navigator.serviceWorker.controller) return;
      if (w.state === 'installed') return offerUpdate(w);
      w.addEventListener('statechange', () => w.state === 'installed' && offerUpdate(w));
    };
    track(reg.waiting ?? reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    // busca versiones nuevas al volver a la app
    document.addEventListener('visibilitychange', () => !document.hidden && reg.update().catch(() => {}));
  }).catch(() => { /* sin service worker la app funciona igual, solo que no sin conexión */ });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating) return; // primera instalación: nada que recargar
    updating = false;
    location.reload();
  });
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-btn').hidden = false;
});
if (isIOS && !isStandalone()) $('#install-btn').hidden = false;

$('#install-btn').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') $('#install-btn').hidden = true;
  } else {
    openDialog($('#install-help'));
  }
});
addEventListener('appinstalled', () => {
  $('#install-btn').hidden = true;
  toast('PitchCoach instalada. Ya puedes abrirla desde su icono.');
});

// Acceso directo «Crear canción» del icono de la app
if (new URLSearchParams(location.search).get('accion') === 'crear') {
  ready.then(() => $('#create-song').click());
  history.replaceState(history.state, '', location.pathname);
}

// «Abrir con PitchCoach» desde el explorador de archivos (app instalada en ordenador)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    await ready;
    const file = await params.files[0].getFile();
    if (isPlaying() || isEditing()) return toast('Termina lo que estás haciendo y vuelve a abrir el archivo', true);
    importFile(file);
  });
}
