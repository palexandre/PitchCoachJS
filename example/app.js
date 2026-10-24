import { PitchCoach, loadSong, midiToName, songToDraft, joinLyrics, draftToJSON, draftToMidi, songToWav } from '../src/index.js';
import { readJSON, writeJSON, removeJSON, clearAllJSON, listImported, saveImported, deleteImported, clearImported } from './store.js';
import { SongEditor, emptyDraft, EDITOR_DEFAULTS } from './editor.js';

const $ = (sel) => document.querySelector(sel);

const BUILTIN = [
  { id: 'songs/martinillo.mid', artist: 'Tradicional' },
  { id: 'songs/estrellita.txt', artist: 'Tradicional' },
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
  theme: 'invertido',
};
const DIFFICULTY_TEXT = {
  facil: ['Fácil', 'Margen de ±1 semitono'],
  normal: ['Normal', 'Margen de ±½ semitono'],
  dificil: ['Difícil', 'Afinación fina, ±30 cents'],
};
const FORMAT_TEXT = { midi: 'MIDI', ultrastar: 'UltraStar', json: 'JSON' };

const settings = readJSON('settings', DEFAULT_SETTINGS);
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
  } catch (err) {
    entry.song = null;
    entry.error = err.message;
  }
  return entry;
}

function renderLibrary() {
  const el = $('#library');
  el.innerHTML = '';
  library.forEach((entry, i) => {
    if (!entry.song) return;
    const s = entry.song;
    const b = best[entry.id];
    const btn = document.createElement('button');
    btn.className = 'song-card';
    btn.setAttribute('role', 'listitem');
    btn.style.animationDelay = `${i * 40}ms`;
    btn.innerHTML = `
      ${coverHTML(s.title)}
      <span class="song-info">
        <span class="song-title"></span>
        <span class="song-meta"></span>
      </span>
      <span class="song-best">${b
        ? `<span class="mini-grade">${b.grade}</span><span class="mini-stars">${starsText(b.stars)}</span>`
        : entry.own ? '<span class="tag-new">Tuya</span>' : entry.imported && Date.now() - (entry.addedAt ?? 0) < 864e5 ? '<span class="tag-new">Nueva</span>' : ''}
      </span>`;
    btn.querySelector('.song-title').textContent = s.title;
    btn.querySelector('.song-meta').textContent = [entry.artist || s.artist, formatDuration(s), FORMAT_TEXT[s.meta.format]].filter(Boolean).join(' · ');
    btn.addEventListener('click', () => openSongSheet(entry));
    el.append(btn);
  });
}

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
  if (!isHome() || !e.dataTransfer?.types.includes('Files')) return;
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
  if (isHome()) importFile(e.dataTransfer.files[0]);
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
  document.documentElement.dataset.theme = theme;
  // la barra del sistema en el móvil también se invierte
  $('meta[name="theme-color"]').content = theme === 'invertido' ? '#e8f9bf' : '#170640';
}
applyTheme(settings.theme);

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

async function startGame(m) {
  if (!current?.song) return;
  mode = m;
  const btn = m === 'mic' ? $('#sing-btn') : $('#demo-btn');
  btn.disabled = true;
  const label = btn.querySelector('span') ?? btn;
  const prevLabel = label.textContent;
  if (m === 'mic') label.textContent = 'Activando micrófono…';

  try {
    closeAllDialogs();
    game.audioContext ??= audio();
    showScreen('play');
    if (!history.state?.play) history.pushState({ play: true }, '');
    layoutHud();
    game.set({ ...settings, transpose: transposeOf(current) });
    game.load(current.song);
    $('#hud-title').textContent = current.song.title;
    $('#mode-badge').hidden = m !== 'demo';
    resetHud();
    await game.start({ input: m });
    keepAwake(true);
  } catch (err) {
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
  game.stop();
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
  if (action === 'restart') {
    closeDialog($('#pause-menu'));
    resetHud();
    game.start({ input: mode });
  }
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
  else if (isEditing()) {
    // keep the editor until it confirms leaving (it may ask about unsaved changes)
    history.pushState({ editor: true }, '');
    editor.exit();
  }
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
  if (action === 'again') {
    closeDialog($('#results'));
    resetHud();
    game.start({ input: mode });
    keepAwake(true);
  }
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
  d.classList.remove('closing');
  if (!d.open) d.showModal();
}

function closeDialog(d) {
  if (!d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  const done = () => {
    d.classList.remove('closing');
    d.close();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else d.addEventListener('animationend', done, { once: true });
}

function closeAllDialogs() {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    d.classList.remove('closing');
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
const canUpdateNow = () => isHome() && !document.querySelector('dialog[open]') && game.state !== 'playing';

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
