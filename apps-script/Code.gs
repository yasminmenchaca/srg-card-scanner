/**
 * SRG Card Scanner — Google Apps Script bridge
 * ============================================
 * Paste this whole file into Extensions → Apps Script in the inventory
 * spreadsheet. It is "bound" to that spreadsheet, so it never needs the
 * spreadsheet ID (getActiveSpreadsheet() finds it).
 *
 * Endpoints (deploy as a web app, see README):
 *   GET  ?token=...                      → { ok, cards: [{name, tab, foil, text?}] }
 *        text = rules text from Raw Data, only for cards that share a name
 *        with another card on the same deck ("Table (V1)" / "(V2)").
 *   POST {token, action:"append", batchId, entries:[{name, foil, count, date, notes}]}
 *                                        → { ok, rows: [rowNumber, ...] }
 *   POST {token, action:"undo", row, name}
 *                                        → { ok }
 *
 * The phone sends POST bodies as text/plain JSON. That avoids the CORS
 * "preflight" request that Apps Script can't answer.
 */

// ---- Sheet layout (from the project brief) --------------------------------
const LISTS_SHEET = 'Lists';
const RAW_SHEET = 'Raw Data';     // A name … M card_text (read only)
const LOG_SHEET = 'Count Log';
const FIRST_DATA_ROW = 2;          // row 1 is the header
const FORMULA_ROWS_END = 2000;     // D, E, H have formulas down to this row

// Count Log columns we are allowed to write. D, E and H are never touched.
const COL_NAME = 1;   // A
const COL_FOIL = 2;   // B
const COL_COUNT = 3;  // C
const COL_DATE = 6;   // F
const COL_NOTES = 7;  // G

// ---- One-time helper -------------------------------------------------------
/**
 * Run this once from the Apps Script editor (select it, press Run).
 * It creates a random token, saves it in Script Properties and logs it.
 * Copy the token from the log into the app's Settings screen.
 */
function createToken() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('Your token: ' + token);
}

// ---- Handlers --------------------------------------------------------------
function doGet(e) {
  try {
    checkToken_(e.parameter.token);
    return json_({ ok: true, cards: readCardList_() });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);

    if (body.action === 'append') return json_(appendEntries_(body));
    if (body.action === 'undo') return json_(undoRow_(body));
    if (body.action === 'cards') return json_({ ok: true, cards: readCardList_() });
    throw new Error('Unknown action: ' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// ---- Card list -------------------------------------------------------------
/**
 * Reads Lists!G2:I and returns one entry per unique name.
 * A name can appear twice (foil + regular); we keep the first tab we see
 * and record whether a foil row exists.
 */
function readCardList_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LISTS_SHEET);
  const last = sheet.getLastRow();
  if (last < FIRST_DATA_ROW) return [];
  const rows = sheet.getRange(FIRST_DATA_ROW, 7, last - 1, 3).getValues(); // G:I

  const byName = {};
  const out = [];
  rows.forEach(function (r) {
    const name = String(r[0]).trim();
    if (!name) return;
    const tab = String(r[1]).trim();
    const foil = String(r[2]).trim() === 'Yes';
    if (!byName[name]) {
      byName[name] = { name: name, tab: tab, foil: foil };
      out.push(byName[name]);
    } else if (foil) {
      byName[name].foil = true;
    }
  });
  addRulesText_(out);
  return out;
}

/**
 * Cards like "Table (V1)" / "Table (V2)" print the same title on the same
 * deck; only the rules text differs. For those cards (and only those, to keep
 * the download small) add Raw Data's card_text so the app can read the rules
 * box and tell them apart. Missing Raw Data → no text, the app just asks.
 */
function addRulesText_(cards) {
  const baseKey = function (c) {
    return c.tab + '|' + c.name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  };
  const groups = {};
  cards.forEach(function (c) { const k = baseKey(c); groups[k] = (groups[k] || 0) + 1; });
  const shared = cards.filter(function (c) { return groups[baseKey(c)] > 1; });
  if (!shared.length) return;

  const raw = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RAW_SHEET);
  if (!raw || raw.getLastRow() < 2) return;
  const rows = raw.getRange(2, 1, raw.getLastRow() - 1, 13).getValues(); // A:M
  const textOf = {};
  rows.forEach(function (r) {
    const name = String(r[0]).trim();
    if (name && !(name in textOf)) textOf[name] = String(r[12]).trim();
  });
  shared.forEach(function (c) { if (textOf[c.name]) c.text = textOf[c.name]; });
}

// ---- Append ----------------------------------------------------------------
function appendEntries_(body) {
  const entries = body.entries || [];
  if (!entries.length) return { ok: true, rows: [] };

  // If the phone retries a batch whose first reply got lost, return the
  // saved result instead of writing the rows a second time.
  const cache = CacheService.getScriptCache();
  const cacheKey = body.batchId ? 'batch_' + body.batchId : null;
  if (cacheKey) {
    const seen = cache.get(cacheKey);
    if (seen) return JSON.parse(seen);
  }

  const validNames = {};
  readCardList_().forEach(function (c) { validNames[c.name] = true; });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // wait up to 30 s for another batch to finish
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
    const rows = [];
    const freeRows = emptyRows_(sheet, entries.length);

    entries.forEach(function (en, i) {
      const row = freeRows[i];
      const name = String(en.name || '').trim();
      if (!validNames[name]) throw new Error('Not in card list: "' + name + '"');
      const count = Math.max(1, Math.round(Number(en.count) || 1));
      const foil = en.foil === 'Yes' || en.foil === true ? 'Yes' : '';

      // Two writes per row so columns D and E are never touched.
      sheet.getRange(row, COL_NAME, 1, 3).setValues([[name, foil, count]]); // A:C
      sheet.getRange(row, COL_DATE, 1, 2).setValues([[en.date || '', en.notes || '']]); // F:G
      rows.push(row);
    });

    SpreadsheetApp.flush();
    const result = { ok: true, rows: rows, beyondFormulas: rows.some(function (r) { return r > FORMULA_ROWS_END; }) };
    if (cacheKey) cache.put(cacheKey, JSON.stringify(result), 21600); // 6 hours
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the first `n` row numbers (from row 2 down) whose column A is
 * empty. Reads column A once. Rows left empty by an undo get reused.
 */
function emptyRows_(sheet, n) {
  const last = Math.max(sheet.getLastRow(), FIRST_DATA_ROW);
  const values = sheet.getRange(FIRST_DATA_ROW, COL_NAME, last - FIRST_DATA_ROW + 1, 1).getValues();
  const free = [];
  for (let i = 0; i < values.length && free.length < n; i++) {
    if (String(values[i][0]).trim() === '') free.push(FIRST_DATA_ROW + i);
  }
  let next = last + 1;
  while (free.length < n) free.push(next++);
  return free;
}

// ---- Undo ------------------------------------------------------------------
/**
 * Clears A, B, C, F, G of one row, but only if column A still holds the
 * name we expect. That stops an undo from wiping a row someone edited.
 */
function undoRow_(body) {
  const row = Number(body.row);
  if (!(row >= FIRST_DATA_ROW)) throw new Error('Bad row');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
    const current = String(sheet.getRange(row, COL_NAME).getValue()).trim();
    if (current !== String(body.name).trim()) {
      throw new Error('Row ' + row + ' now holds "' + current + '", not undone');
    }
    sheet.getRange(row, COL_NAME, 1, 3).clearContent(); // A:C
    sheet.getRange(row, COL_DATE, 1, 2).clearContent(); // F:G
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---- Helpers ---------------------------------------------------------------
function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected) throw new Error('No TOKEN in Script Properties. Run createToken() once.');
  if (token !== expected) throw new Error('Bad token');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
