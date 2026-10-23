import { Entona, loadSong, midiToName } from '../src/index.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const game = new Entona(canvas, { notation: 'solfege' });

let currentSource = null; // File or URL, to reload with another melody track
let lastInput = 'mic';

// ---- loading ---------------------------------------------------------------

async function load(source, opts = {}) {
  try {
    const song = await loadSong(source, opts);
    currentSource = source;
    game.load(song);
    showTracks(song);
    setPlaying(false);
    $('events').innerHTML = '';
  } catch (err) {
    alert(`No se pudo cargar la canción:\n${err.message}`);
  }
}

function showTracks(song) {
  const cands = song.meta.candidates ?? [];
  $('track-field').hidden = cands.length < 2;
  $('track-select').innerHTML = cands
    .map((c) => `<option value="${c.id}" ${c.id === song.meta.melody ? 'selected' : ''}>
      ${c.name} · canal ${c.channel + 1} · ${c.noteCount} notas${c.lyricMatches ? ' · con letra' : ''}</option>`)
    .join('');
}

$('song-select').addEventListener('change', (e) => load(e.target.value));
$('file').addEventListener('change', (e) => e.target.files[0] && load(e.target.files[0]));
$('track-select').addEventListener('change', (e) => load(currentSource, { melody: e.target.value }));

// drag & drop on the stage
const stage = canvas.parentElement;
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragging');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) load(file);
});

// ---- transport ---------------------------------------------------------------

async function play(input) {
  lastInput = input;
  try {
    await game.start({ input });
    setPlaying(true);
  } catch (err) {
    alert(err.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono 🎤' : err.message);
  }
}

function setPlaying(on) {
  $('pause').disabled = !on;
  $('restart').disabled = !on;
  $('pause').textContent = '⏸ Pausa';
}

$('sing').addEventListener('click', () => play('mic'));
$('demo').addEventListener('click', () => play('demo'));
$('restart').addEventListener('click', () => play(lastInput));
$('pause').addEventListener('click', () => {
  game.togglePause();
  $('pause').textContent = game.state === 'paused' ? '▶ Seguir' : '⏸ Pausa';
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    game.togglePause();
  }
});

// ---- settings ----------------------------------------------------------------

$('difficulty').addEventListener('change', (e) => game.set({ difficulty: e.target.value }));
$('speed').addEventListener('change', (e) => game.set({ speed: Number(e.target.value) }));
$('guide').addEventListener('input', (e) => game.set({ guideVolume: Number(e.target.value) }));
$('backing').addEventListener('input', (e) => game.set({ accompanimentVolume: Number(e.target.value) }));
$('octave').addEventListener('change', (e) => game.set({ octaveTolerant: e.target.checked }));

const transpose = (d) => {
  const v = Math.max(-12, Math.min(12, game.options.transpose + d));
  game.set({ transpose: v });
  $('transpose').value = v > 0 ? `+${v}` : v;
};
$('tr-down').addEventListener('click', () => transpose(-1));
$('tr-up').addEventListener('click', () => transpose(1));

$('loop').addEventListener('change', (e) => {
  if (!e.target.checked || !game.song) return game.setLoop(null);
  const t = Math.max(0, game.currentTime);
  const line = game.song.lines.find((l) => t < l.end) ?? game.song.lines.at(-1);
  game.setLoop(line.start - 0.8, line.end + 0.4);
});

// ---- game events -------------------------------------------------------------

const RATING_TEXT = { perfect: '★ Perfecto', great: 'Genial', good: 'Bien', miss: 'Fallo' };

game.on('note', ({ note, rating, accuracy, points }) => {
  const li = document.createElement('li');
  li.className = rating;
  li.innerHTML = `<b>${note.lyric || '♪'}</b> <span>${midiToName(note.midi + game.options.transpose, { notation: 'solfege' })}</span>
    <em>${RATING_TEXT[rating]} · ${Math.round(accuracy * 100)}%</em> <strong>+${points}</strong>`;
  $('events').prepend(li);
  while ($('events').children.length > 8) $('events').lastChild.remove();
});

game.on('frame', ({ pitch }) => {
  const el = $('live-note');
  if (pitch?.freq) {
    el.textContent = `${pitch.name} ${pitch.cents > 0 ? '+' : ''}${pitch.cents}¢`;
    el.classList.toggle('hit', pitch.hit);
  } else {
    el.textContent = '–';
    el.classList.remove('hit');
  }
});

game.on('end', (r) => {
  setPlaying(false);
  $('restart').disabled = false;
  console.log('Resultado', r);
});

load($('song-select').value);
