// app.js — wires everything together.
//
// Flow for one card:
//   detector says "a card settled"  (live)   or  you tap "Read name"  (snap)
//     → cropForOcr()   cut out + clean up the name box
//     → readLine()     Tesseract OCR (in a worker)
//     → matcher.match  fuzzy match against your card list
//     → confident? log it + beep : show the 3-choice picker
//     → addEntry()     save locally, sync to the sheet in batches

import { kvGet, kvSet, loadSettings, saveSettings, entriesBySession, entriesByStatus } from './storage.js';
import { fetchCards } from './api.js';
import { createMatcher, isConfident, deckNumberToTab } from './matcher.js';
import { startCamera, cropForOcr } from './camera.js';
import { initOcr, readLine } from './ocr.js';
import { CardDetector } from './detector.js';
import { createBox } from './boxEditor.js';
import { newEntry, addEntry, syncNow, undoEntry, onSyncChange } from './sync.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings;
let matcher = createMatcher([]);
let presets;
let mode = 'live';
let stream = null;
let detector = null;
let busy = false;          // an OCR read is running
let pendingChoice = null;  // { resolve } while the picker is open
let snapBox = null;        // box used in snap mode (not saved)
let audioCtx = null;
let wakeLock = null;

// Where the name sits differs per card type, so each preset has its own box.
// `number` is the optional deck-number box (deck cards only).
// Deck cards print the name in an all-caps strip at the top-left (the
// top-right box is card type / move type, not useful here). The deck
// number ("#23") is always in the bottom-right corner.
// Full-art cards put the name strip lower down.
// These defaults assume the card roughly fills the frame; drag them to fit
// your rig on the Boxes tab.
// Keep this box tight inside the blue "#23" patch: white area around it
// makes the OCR return nothing.
const DECK_NUMBER = { x: 0.765, y: 0.845, w: 0.11, h: 0.05 };
// Skill requirement ("POWER 8") sits in the bottom-left corner. It is only
// read when the name alone can't decide, e.g. "Press Slam (Power)" vs
// "Press Slam (Grapple)", which share deck #20.
const DECK_SKILL = { x: 0.06, y: 0.83, w: 0.3, h: 0.06 };
const DEFAULT_PRESETS = {
  deck:       { name: { x: 0.06, y: 0.05, w: 0.66, h: 0.05 }, number: DECK_NUMBER, useNumber: true, skill: DECK_SKILL, useSkill: true },
  fullart:    { name: { x: 0.10, y: 0.14, w: 0.50, h: 0.07 }, number: DECK_NUMBER, useNumber: true, skill: DECK_SKILL, useSkill: true },
  competitor: { name: { x: 0.06, y: 0.05, w: 0.66, h: 0.05 }, number: null, useNumber: false },
  entrance:   { name: { x: 0.06, y: 0.05, w: 0.66, h: 0.05 }, number: null, useNumber: false },
};

// Boxes drawn on the stage.
const nameBox = createBox($('layer'), { label: 'name', color: '#ffd400', onChange: saveBoxes });
const numberBox = createBox($('layer'), { label: '#', color: '#22d3ee', onChange: saveBoxes });
const skillBox = createBox($('layer'), { label: 'skill', color: '#f472b6', onChange: saveBoxes });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
init();

async function init() {
  settings = await loadSettings();
  // Merge per preset so boxes added in newer versions (e.g. skill) appear
  // even if older saved presets lack them.
  const saved = (await kvGet('presets')) || {};
  presets = {};
  for (const k of Object.keys(DEFAULT_PRESETS)) presets[k] = { ...DEFAULT_PRESETS[k], ...(saved[k] || {}) };
  $('presetSelect').value = (await kvGet('activePreset')) || 'deck';
  $('sessionInput').value = settings.session;
  setFoil(settings.foil);
  setMode('live');
  applyPreset();

  // 1. Use the cached card list right away (works offline)…
  const cached = await kvGet('cards');
  if (cached) useCards(cached.cards, cached.at);
  // 2. …then refresh it from the sheet in the background.
  if (settings.url && settings.token) refreshCards();
  else toast('Open ⚙ Settings and paste your web app URL and token.');

  onSyncChange(renderSync);
  await renderSession();

  // Retry syncing whenever the phone comes back online, and every minute.
  window.addEventListener('online', () => syncNow(settings));
  setInterval(() => syncNow(settings), 60000);
  syncNow(settings);

  initOcr().catch((e) => toast('OCR failed to load: ' + e.message));
}

async function refreshCards() {
  try {
    $('cardCount').textContent = 'loading card list…';
    const cards = await fetchCards(settings);
    const at = new Date().toISOString();
    await kvSet('cards', { cards, at });
    useCards(cards, at);
  } catch (e) {
    toast('Could not load card list: ' + e.message);
    $('cardCount').textContent = matcher.size ? `${matcher.size} names (cached)` : 'no card list';
  }
}

function useCards(cards, at) {
  matcher = createMatcher(cards);
  const when = at ? new Date(at).toLocaleString() : '';
  $('cardCount').textContent = `${cards.length.toLocaleString()} names`;
  $('cardCount').title = 'Loaded ' + when;
}

// ---------------------------------------------------------------------------
// Modes and presets
// ---------------------------------------------------------------------------
document.querySelectorAll('.modes button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode))
);

function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));

  const showPhoto = m === 'snap';
  $('video').hidden = showPhoto;
  $('photo').hidden = !showPhoto || !$('photo').width;
  updateStageMsg();

  if (detector) detector.paused = m !== 'live';
  applyPreset();
}

function updateStageMsg() {
  const hasMedia = mode === 'snap' ? !$('photo').hidden : !!stream;
  $('stage').classList.toggle('empty', !hasMedia);
  $('stageMsg').hidden = hasMedia;
  $('stageMsg').textContent = mode === 'snap' ? 'Tap Take photo' : 'Tap Start camera';
  if (mode === 'calibrate' && !stream) $('stageMsg').textContent = 'Start the camera in Live first';
}

$('presetSelect').addEventListener('change', async () => {
  await kvSet('activePreset', $('presetSelect').value);
  applyPreset();
});

$('useNumber').addEventListener('change', () => {
  preset().useNumber = $('useNumber').checked;
  saveBoxes();
  applyPreset();
});

const preset = () => presets[$('presetSelect').value];

/** Show the current preset's boxes; editable only on the Boxes tab. */
function applyPreset() {
  const p = preset();
  const editing = mode === 'calibrate';
  nameBox.set(mode === 'snap' && snapBox ? snapBox : p.name);
  nameBox.setEditable(editing || mode === 'snap');

  const hasNumber = !!p.number;
  $('useNumber').closest('label').hidden = !hasNumber;
  $('useNumber').checked = p.useNumber;
  numberBox.show(hasNumber && (p.useNumber || editing) && mode !== 'snap');
  if (hasNumber) numberBox.set(p.number);
  numberBox.setEditable(editing);

  const hasSkill = !!p.skill;
  $('useSkill').closest('label').hidden = !hasSkill;
  $('useSkill').checked = !!p.useSkill;
  skillBox.show(hasSkill && (p.useSkill || editing) && mode !== 'snap');
  if (hasSkill) skillBox.set(p.skill);
  skillBox.setEditable(editing);
}

$('useSkill').addEventListener('change', () => {
  preset().useSkill = $('useSkill').checked;
  saveBoxes();
  applyPreset();
});

async function saveBoxes() {
  if (mode === 'snap') { snapBox = nameBox.get(); return; }
  const p = preset();
  p.name = nameBox.get();
  if (p.number) p.number = numberBox.get();
  if (p.skill) p.skill = skillBox.get();
  await kvSet('presets', presets);
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------
$('startBtn').addEventListener('click', async () => {
  unlockAudio();
  if (stream) return stopLive();
  try {
    stream = await startCamera($('video'));
    $('startBtn').textContent = 'Stop camera';
    updateStageMsg();
    keepAwake();
    detector = new CardDetector($('video'), { onCard: () => readCard($('video')), onLevel: renderMeter });
    detector.setOptions(settings);
    detector.start();
  } catch (e) {
    toast('Camera error: ' + e.message);
  }
});

function stopLive() {
  detector?.stop();
  detector = null;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('startBtn').textContent = 'Start camera';
  wakeLock?.release().catch(() => {});
  updateStageMsg();
  renderMeter(null);
}

$('readNowBtn').addEventListener('click', () => {
  unlockAudio();
  if (stream) readCard($('video'));
});

function renderMeter(lvl) {
  if (!lvl) { $('meterBar').style.width = '0'; $('meterText').textContent = 'idle'; return; }
  const pct = Math.min(100, (lvl.diff / (settings.motion * 2)) * 100);
  $('meterBar').style.width = pct + '%';
  $('meterBar').style.background = lvl.diff > settings.motion ? 'var(--warn)' : lvl.diff < settings.still ? 'var(--ok)' : 'var(--accent)';
  const label = { ready: 'ready to read', waitMotion: 'waiting for next card', moving: 'card moving…' }[lvl.state];
  $('meterText').textContent = busy ? 'reading…' : `${label} · motion ${lvl.diff.toFixed(1)}`;
}

// The screen turning off would stop the camera mid-batch.
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream) keepAwake();
});

// ---------------------------------------------------------------------------
// Snap mode (still photo fallback)
// ---------------------------------------------------------------------------
$('photoInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  // Shrink very large photos so OCR stays quick.
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = $('photo');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  c.hidden = false;
  $('snapReadBtn').disabled = false;
  updateStageMsg();
  ev.target.value = ''; // allow the same file again
});

$('snapReadBtn').addEventListener('click', () => {
  unlockAudio();
  readCard($('photo'));
});

$('testReadBtn').addEventListener('click', async () => {
  if (!stream) return toast('Start the camera in Live first.');
  const r = await ocrCurrent($('video'));
  showLastRead(r, r.results[0] ? `best: ${r.results[0].name} (${r.results[0].score.toFixed(2)})` : 'no match');
});

// ---------------------------------------------------------------------------
// Reading one card
// ---------------------------------------------------------------------------
// Image clean-ups to try, in order. The first one that gives a confident
// match wins, so most cards cost one OCR pass. SRG names are white with a
// black outline over artwork: "plain" usually reads them best.
const VARIANTS = [
  { plain: true },
  { invert: true },
  { invert: true, threshold: true },
];

/** Crop, OCR and match. Does not log anything. */
async function ocrCurrent(src) {
  const p = preset();

  // Deck number first, so it can help every name attempt.
  let tab = null;
  if (p.number && p.useNumber && mode !== 'snap') {
    for (const v of VARIANTS.slice(0, 2)) {
      tab = deckNumberToTab((await readLine(cropForOcr(src, p.number, v), 'number')).text);
      if (tab) break;
    }
  }

  const box = mode === 'snap' ? nameBox.get() : p.name;
  const variants = settings.threshold ? [{ invert: 'auto', threshold: true }, ...VARIANTS] : VARIANTS;
  let best = null;
  for (const v of variants) {
    const crop = cropForOcr(src, box, v);
    const { text } = await readLine(crop, 'name');
    const results = matcher.match(text, { tab, limit: 3 });
    const top = results[0]?.score ?? -1;
    if (!best || top > (best.results[0]?.score ?? -1)) best = { crop, text, tab, results };
    if (isConfident(results, settings)) break;
  }

  // Still unsure? Read the skill box and match again. Most cards never get
  // here, so the extra OCR pass only costs time on bracketed look-alikes.
  if (!isConfident(best.results, settings) && p.skill && p.useSkill && mode !== 'snap') {
    for (const v of VARIANTS.slice(0, 2)) {
      const skill = (await readLine(cropForOcr(src, p.skill, v), 'name')).text;
      const results = matcher.match(best.text, { tab, skill, limit: 3 });
      if (results[0] && results[0].score > (best.results[0]?.score ?? -1)) {
        best = { ...best, results, skill };
        break;
      }
    }
  }
  return best;
}

async function readCard(src) {
  if (busy || pendingChoice) return;
  if (!matcher.size) return toast('No card list loaded yet.');
  busy = true;
  try {
    const r = await ocrCurrent(src);
    const tabNote = (r.tab ? ` · tab ${r.tab}` : '') + (r.skill ? ` · skill "${r.skill}"` : '');

    if (!r.results.length) {
      // Nothing readable: probably no card under the camera. Wait for motion.
      showLastRead(r, 'no text found' + tabNote);
      return;
    }

    if (isConfident(r.results, settings)) {
      const best = r.results[0];
      await logCard(best.name);
      showLastRead(r, `✓ ${best.name} (${best.score.toFixed(2)})${tabNote}`);
      beep(880);
      flash('ok');
      return;
    }

    // Low confidence: stop and ask.
    beep(330);
    flash('ask');
    showLastRead(r, `? best ${r.results[0].name} (${r.results[0].score.toFixed(2)})${tabNote}`);
    busy = false; // allow "Read again" from inside the picker
    const pick = await askUser(r);
    if (pick === '__retry__') {
      detector?.readNow();
      if (mode === 'snap') return readCard(src);
    } else if (pick) {
      await logCard(pick);
      beep(880);
      flash('ok');
    }
  } catch (e) {
    toast('Read failed: ' + e.message);
  } finally {
    busy = false;
    if (detector && mode === 'live' && !pendingChoice) {
      detector.paused = false;
    }
  }
}

function showLastRead(r, matchLine) {
  $('lastRead').hidden = false;
  const pv = $('cropPreview');
  pv.width = r.crop.width;
  pv.height = r.crop.height;
  pv.getContext('2d').drawImage(r.crop, 0, 0);
  $('ocrText').textContent = r.text || '(nothing)';
  $('matchText').textContent = matchLine;
}

// ---------------------------------------------------------------------------
// Low-confidence picker
// ---------------------------------------------------------------------------
/** Shows the 3 best guesses. Resolves with a name, '__retry__' or null (skip). */
function askUser(r) {
  if (detector) detector.paused = true;
  $('chooserOcr').textContent = r.text || '(nothing)';
  fillChoices($('choices'), r.results);
  $('chooserSearch').value = '';
  $('searchChoices').innerHTML = '';
  $('chooser').hidden = false;
  return new Promise((resolve) => {
    pendingChoice = {
      resolve: (v) => {
        pendingChoice = null;
        $('chooser').hidden = true;
        if (detector) detector.paused = mode !== 'live';
        resolve(v);
      },
    };
  });
}

function fillChoices(container, results) {
  container.innerHTML = '';
  for (const c of results) {
    const b = document.createElement('button');
    b.className = 'choice';
    b.innerHTML = `<span></span><small>${c.tab} · ${Math.round(Math.min(1, c.score) * 100)}%</small>`;
    b.firstChild.textContent = c.name; // textContent: names are never treated as HTML
    b.addEventListener('click', () => pendingChoice?.resolve(c.name));
    container.appendChild(b);
  }
}

$('chooserSearch').addEventListener('input', (ev) => {
  const q = ev.target.value;
  fillChoices($('searchChoices'), q.length >= 2 ? matcher.match(q, { limit: 5 }) : []);
});
$('skipBtn').addEventListener('click', () => pendingChoice?.resolve(null));
$('retryBtn').addEventListener('click', () => pendingChoice?.resolve('__retry__'));

// ---------------------------------------------------------------------------
// Logging, session panel, undo, sync
// ---------------------------------------------------------------------------
async function logCard(name) {
  const entry = newEntry({ name, foil: settings.foil, notes: settings.session });
  await addEntry(entry, settings);
  await renderSession();
}

const currentEntries = () => entriesBySession(settings.session);

async function renderSession() {
  const entries = await currentEntries();
  $('totalCount').textContent = entries.reduce((n, e) => n + e.count, 0);
  const list = $('sessionList');
  list.innerHTML = '';
  for (const e of [...entries].reverse().slice(0, 100)) {
    const li = document.createElement('li');
    li.className = e.status;
    const name = document.createElement('span');
    name.textContent = e.name;
    if (e.foil) name.insertAdjacentHTML('beforeend', '<span class="foil-tag">FOIL</span>');
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = e.status === 'synced' ? `✓ row ${e.row}` : '⏳ waiting';
    li.append(name, st);
    list.appendChild(li);
  }
  $('undoBtn').disabled = !entries.length;

  // Keep the chip's "N waiting" in step with the list (all sessions).
  const pending = (await entriesByStatus('pending')).length;
  if (!$('syncChip').classList.contains('bad') || !pending) renderSync({ pending, quiet: true });
}

$('undoBtn').addEventListener('click', async () => {
  const entries = await currentEntries();
  const last = entries[entries.length - 1];
  if (!last) return;
  try {
    const msg = await undoEntry(last, settings);
    toast(`Undid "${last.name}". ${msg}`);
    beep(220);
  } catch (e) {
    toast('Undo failed: ' + e.message);
  }
  await renderSession();
});

$('syncBtn').addEventListener('click', async () => {
  await syncNow(settings);
  await renderSession();
});
$('syncChip').addEventListener('click', () => $('syncBtn').click());

let lastSyncAt = null;
function renderSync(s) {
  if (s.at) lastSyncAt = s.at;
  s = { ...s, at: lastSyncAt };
  const chip = $('syncChip');
  chip.className = 'chip';
  if (s.sending) { chip.textContent = `sending ${s.pending}…`; chip.classList.add('warn'); }
  else if (s.error) { chip.textContent = `${s.pending} waiting · ${navigator.onLine ? 'error' : 'offline'}`; chip.classList.add('bad'); chip.title = s.error; }
  else if (s.pending) { chip.textContent = `${s.pending} waiting`; chip.classList.add('warn'); }
  else { chip.textContent = s.at ? `synced ${s.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'all synced'; chip.classList.add('ok'); }
  if ((s.ok || s.error) && !s.quiet) renderSession();
}

$('sessionInput').addEventListener('change', async (ev) => {
  settings.session = ev.target.value.trim() || 'Session';
  await saveSettings(settings);
  await renderSession();
});

// ---------------------------------------------------------------------------
// Foil toggle
// ---------------------------------------------------------------------------
$('foilBtn').addEventListener('click', async () => {
  setFoil(!settings.foil);
  await saveSettings(settings);
});

function setFoil(on) {
  settings.foil = on;
  $('foilBtn').setAttribute('aria-pressed', String(on));
  $('foilBtn').textContent = on ? 'FOIL ON' : 'FOIL OFF';
  document.body.classList.toggle('foil', on);
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
const form = document.querySelector('.settings-form');
const NUMBER_FIELDS = ['minScore', 'minGap', 'stableMs', 'motion', 'still', 'syncEvery'];

$('settingsBtn').addEventListener('click', () => {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name] ?? '';
  }
  $('settings').showModal();
});

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') settings[el.name] = el.checked;
    else if (NUMBER_FIELDS.includes(el.name)) settings[el.name] = Number(el.value);
    else settings[el.name] = el.value.trim();
  }
  await saveSettings(settings);
  detector?.setOptions(settings);
  toast('Settings saved.');
  if (settings.url && settings.token) refreshCards();
});

$('reloadCardsBtn').addEventListener('click', async () => {
  // Use what's typed in the form even before Save.
  settings.url = form.elements.url.value.trim();
  settings.token = form.elements.token.value.trim();
  await refreshCards();
  toast(`${matcher.size} names loaded.`);
});

// ---------------------------------------------------------------------------
// Feedback: beep, flash, toast
// ---------------------------------------------------------------------------
// Browsers only allow sound after a tap, so we create the AudioContext then.
function unlockAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(freq = 880, ms = 120) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + ms / 1000);
}

function flash(kind) {
  nameBox.flash(kind);
  if (kind === 'ok') {
    $('stage').classList.add('flash-ok');
    setTimeout(() => $('stage').classList.remove('flash-ok'), 400);
  }
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
