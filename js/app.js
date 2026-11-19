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
import { createMatcher, isConfident, deckNumberToTab, skillsToCheck } from './matcher.js';
import { joinLines, LINES_AROUND } from './lines.js';
import { guessSkill, windowShares, shares, areaPixels, ICON, BESIDE } from './skill.js';
import { startCamera, cropForOcr, boxSpread } from './camera.js';
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
let cardRect;              // where the card sits in the camera picture (saved)
let mode = 'live';
let stream = null;
let detector = null;
let busy = false;          // an OCR read is running
let pendingChoice = null;  // { resolve } while the picker is open
let snapRect = null;       // card box used in snap mode (not saved)
let audioCtx = null;
let wakeLock = null;

// ONE box, set once for your rig: the whole card. Names and numbers sit in
// different spots on different card designs, so instead of fixed boxes the
// app slides a thin strip over the card and keeps whatever reads as a real
// card name (see ocrCurrent). Default = where your rig put the card in the
// test screenshots (portrait 1080×1920 camera).
const DEFAULT_CARD = { x: 0.18, y: 0.26, w: 0.61, h: 0.49 };

// Boxes drawn on the stage: the editable card outline, plus two markers that
// show where the last read found the name and the number.
const cardBox = createBox($('layer'), { label: 'card', color: '#ffd400', onChange: saveCardBox });
const nameMark = createBox($('layer'), { label: 'name', color: '#22c55e' });
const numMark = createBox($('layer'), { label: '#', color: '#22d3ee' });
nameMark.show(false);
numMark.show(false);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
init();

async function init() {
  settings = await loadSettings();
  cardRect = (await kvGet('cardBox')) || DEFAULT_CARD;
  $('sessionInput').value = settings.session;
  setFoil(settings.foil);
  setMode('live');

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
// Modes and boxes
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
  applyBoxes();
}

function updateStageMsg() {
  const hasMedia = mode === 'snap' ? !$('photo').hidden : !!stream;
  $('stage').classList.toggle('empty', !hasMedia);
  $('stageMsg').hidden = hasMedia;
  $('stageMsg').textContent = mode === 'snap' ? 'Tap Take photo' : 'Tap Start camera';
  if (mode === 'calibrate' && !stream) $('stageMsg').textContent = 'Start the camera in Live first';
}

/** The card box is editable on the Boxes tab (saved) and in Snap (per photo). */
function applyBoxes() {
  cardBox.set(mode === 'snap' && snapRect ? snapRect : cardRect);
  cardBox.setEditable(mode === 'calibrate' || mode === 'snap');
  nameMark.show(false);
  numMark.show(false);
}

async function saveCardBox() {
  if (mode === 'snap') { snapRect = cardBox.get(); return; }
  cardRect = cardBox.get();
  await kvSet('cardBox', cardRect);
}

const currentCard = () => (mode === 'snap' && snapRect ? snapRect : cardRect);

/** Turn a box given in card fractions into a box in picture fractions. */
function onCard(card, r) {
  return { x: card.x + r.x * card.w, y: card.y + r.y * card.h, w: r.w * card.w, h: r.h * card.h };
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------
$('startBtn').addEventListener('click', async () => {
  unlockAudio();
  if (stream) return stopLive();
  try {
    stream = await startCamera($('video'));
    camShape = { w: $('video').videoWidth, h: $('video').videoHeight };
    $('startBtn').textContent = 'Stop camera';
    updateStageMsg();
    keepAwake();
    detector = new CardDetector($('video'), { onCard: () => readCard($('video'), { auto: true }), onLevel: renderMeter });
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
// Coming back to the app: iPhone may have paused the camera feed, so start a
// fresh one. It can come back in the other shape (landscape instead of
// portrait), which squeezes the picture and moves the card out from under
// the boxes. So remember the shape it had at the start, and if the new feed
// differs, ask again with width and height swapped.
let camShape = null; // { w, h } of the feed when Start camera was tapped

const isTall = (s) => s.h > s.w;

async function restartCamera() {
  const v = $('video');
  stream?.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
  await new Promise((r) => setTimeout(r, 300)); // let the page finish coming back
  const wrongShape = () => camShape && isTall({ w: v.videoWidth, h: v.videoHeight }) !== isTall(camShape);
  stream = await startCamera(v);
  // Try the size it had at the start, then the same size turned sideways.
  for (const ask of camShape ? [{ width: camShape.w, height: camShape.h }, { width: camShape.h, height: camShape.w }] : []) {
    if (!wrongShape()) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = await startCamera(v, ask);
  }
  if (wrongShape()) toast('Camera came back in a different shape. Tap Stop camera, then Start camera.');
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !stream) return;
  keepAwake();
  try {
    await restartCamera();
    detector?.settle(); // don't re-log the card that's already there
  } catch (e) {
    toast('Camera error: ' + e.message);
  }
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
// ---- Strip search -----------------------------------------------------------
// Tesseract only reads well when the crop hugs one line of text: a loose box
// with border, art or the "LEAD / GRAPPLE" label reads nothing. Since the
// name sits at different heights on different card designs, we slide a thin
// strip down the top of the card and keep the strip whose text matches a
// card name best. All positions are fractions of the card.
//
// Tested on rig photos: standard frames have the name at y≈0.095, so that
// spot is tried first (then whatever spot worked last), and the search stops
// at the first confident match. Most cards cost 1–2 OCR passes; odd layouts
// cost more.
const NAME = { from: 0.02, to: 0.26, step: 0.015, h: 0.055 };
const NAME_WIDTHS = [[0.08, 0.62], [0.04, 0.74]]; // narrow first: skips the label
const NUMBER_YS = [0.88, 0.86, 0.9, 0.84, 0.92, 0.82, 0.8]; // "#NN", bottom-right
const NUMBER_X = [0.68, 0.97];
let lastNameY = 0.095;

/** Strip heights to try, nearest to the last good one first. */
function nameYs() {
  const ys = [];
  for (let y = NAME.from; y <= NAME.to + 1e-9; y += NAME.step) ys.push(+y.toFixed(3));
  return ys.sort((a, b) => Math.abs(a - lastNameY) - Math.abs(b - lastNameY));
}

const better = (a, b) => (a?.results[0]?.score ?? -1) > (b?.results[0]?.score ?? -1);

/** Find the deck number: first bottom-right strip that reads "#" + 2 digits. */
async function findNumber(src, card) {
  for (const y of NUMBER_YS) {
    const rect = onCard(card, { x: NUMBER_X[0], y, w: NUMBER_X[1] - NUMBER_X[0], h: 0.06 });
    const { text } = await readLine(cropForOcr(src, rect, { plain: true }), 'number');
    const m = text.replace(/\s/g, '').match(/#(\d{2})/);
    if (m) {
      const tab = deckNumberToTab(m[1]);
      if (tab) return { tab, rect };
    }
  }
  return { tab: null, rect: null };
}

/** OCR one strip and match it. */
async function tryStrip(src, rect, variant, tab) {
  const crop = cropForOcr(src, rect, variant);
  const { text } = await readLine(crop, 'name');
  return { crop, text, rect, results: matcher.match(text, { tab, limit: 3 }) };
}

/** Find the card's name and number. Does not log anything. */
async function ocrCurrent(src) {
  const card = currentCard();
  const num = await findNumber(src, card);
  const tab = num.tab;

  // Pass 1: every strip height, narrow strip, plain grayscale. Stop early,
  // unless the match is a name that also sits inside a longer name: then it
  // may be one line of a stacked title, so read the lines around it too.
  let best = null;
  let near = null; // only read heights close to this one
  const tried = [];
  for (const y of nameYs()) {
    if (near !== null && Math.abs(y - near) > LINES_AROUND) continue;
    const [x0, x1] = NAME_WIDTHS[0];
    const rect = onCard(card, { x: x0, y, w: x1 - x0, h: NAME.h });
    const r = { ...(await tryStrip(src, rect, { plain: true }, tab)), y };
    tried.push(r);
    if (!best || better(r, best)) best = r;
    if (near === null && isConfident(r.results, settings)) {
      if (!matcher.isPartOfLonger(r.results[0].name)) break;
      near = y;
    }
  }

  // Stacked titles: join lines read at different heights.
  const joined = joinLines(matcher, tried, tab);
  if (joined && better(joined, best)) best = joined;

  // Pass 2: not sure yet → retry the 2 most promising heights with
  // black/white and with a wider strip (for long names).
  if (!isConfident(best.results, settings)) {
    const top2 = tried.filter((r) => r.results.length).sort((a, b) => better(a, b) ? -1 : 1).slice(0, 2);
    outer: for (const t of top2) {
      for (const [x0, x1] of NAME_WIDTHS) {
        const rect = onCard(card, { x: x0, y: t.y, w: x1 - x0, h: NAME.h });
        for (const v of [{ threshold: true, invert: false }, { plain: true }]) {
          if (x0 === NAME_WIDTHS[0][0] && v.plain) continue; // already tried in pass 1
          const r = { ...(await tryStrip(src, rect, v, tab)), y: t.y };
          if (better(r, best)) best = r;
          if (isConfident(r.results, settings)) break outer;
        }
      }
    }
  }

  // Same name, same deck, only the skill differs: guess from the icon's color
  // and put that card first in the picker. Never auto-logs (see skill.js).
  let skill = null;
  const options = skillsToCheck(best.results);
  if (options.length) {
    const icon = areaPixels(src, onCard(card, ICON));
    const beside = areaPixels(src, onCard(card, BESIDE));
    skill = guessSkill(windowShares(icon.data, icon.width, icon.height), shares(beside.data), options);
    if (skill) {
      const i = best.results.findIndex((r) => r.skills?.[0] === skill);
      if (i > 0) {
        const results = [...best.results];
        const [hit] = results.splice(i, 1);
        best = { ...best, results: [hit, ...results] }; // same scores → still asks
      }
    }
  }

  if (isConfident(best.results, settings)) lastNameY = best.y;
  return { ...best, tab, numRect: num.rect, skill, skillOptions: options };
}

// Bare tray: the card box is almost one flat gray (brightness spread 7–11 on
// the rig); any card is 25+. Below this, an automatic read is skipped, so the
// tray's edges can't be read as a short name like "TNT".
const EMPTY_SPREAD = 18;
// An automatic read needs at least this many letters/digits. The tray's edge
// read as "TN"; the shortest real names (TNT, GGP) have 3.
const MIN_CHARS = 3;

async function readCard(src, { auto = false } = {}) {
  if (busy || pendingChoice) return;
  if (!matcher.size) return toast('No card list loaded yet.');
  if (auto) {
    // Empty: skip quietly. The detector already waits for the next motion.
    if (boxSpread(src, currentCard()) < EMPTY_SPREAD) return;
  }
  busy = true;
  try {
    const r = await ocrCurrent(src);
    if (auto && r.text.replace(/[^a-z0-9]/gi, '').length < MIN_CHARS) {
      showLastRead(r, 'too little text: skipped (tap Read now to force)');
      return;
    }
    let tabNote = r.tab ? ` · deck ${r.tab}` : ' · no # found';
    if (r.skillOptions.length) tabNote += r.skill ? ` · icon: ${r.skill}` : ' · icon color unclear';

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
  // Mark where the name and number were found on the picture.
  // Only on the Boxes tab (Test read): in Live they sat on the card and
  // looked like boxes you had to move.
  const marks = mode === 'calibrate';
  if (r.rect) nameMark.set(r.rect);
  if (r.numRect) numMark.set(r.numRect);
  nameMark.show(marks && !!r.rect);
  numMark.show(marks && !!r.numRect);
  $('lastRead').hidden = false;
  const pv = $('cropPreview');
  pv.width = r.crop.width;
  pv.height = r.crop.height;
  pv.getContext('2d').drawImage(r.crop, 0, 0);
  $('ocrText').textContent = r.text || '(nothing)';
  const v = $('video');
  const cam = stream && v.videoWidth ? ` · camera ${v.videoWidth}×${v.videoHeight}` : '';
  const list = matcher.size ? '' : ' · NO CARD LIST (⚙ Settings)';
  $('matchText').textContent = matchLine + cam + list;
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
    el.value = settings[el.name] ?? '';
  }
  $('settings').showModal();
});

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  for (const el of form.elements) {
    if (!el.name) continue;
    if (NUMBER_FIELDS.includes(el.name)) settings[el.name] = Number(el.value);
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
  cardBox.flash(kind);
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
