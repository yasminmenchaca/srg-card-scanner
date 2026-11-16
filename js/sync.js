// sync.js — the offline-first queue.
//
// Every logged card is saved to IndexedDB first (status "pending"), then
// sent to the sheet in batches of up to 10. If Wi-Fi drops, entries just
// wait and go out on the next attempt.
//
// Entry lifecycle:
//   pending (no batchId)  → can be undone locally, nothing sent yet
//   pending (has batchId) → a send was tried; the sheet may or may not
//                           have it. We resend with the SAME batchId and the
//                           script returns its saved result instead of
//                           writing twice.
//   synced (has row)      → in the sheet; undo asks the script to clear it.

import { putEntry, deleteEntry, entriesByStatus } from './storage.js';
import { appendEntries, undoRow } from './api.js';

const BATCH = 10;
let busy = false;
const listeners = new Set();

export const onSyncChange = (fn) => listeners.add(fn);
const emit = (state) => listeners.forEach((fn) => fn(state));

export function newEntry({ name, foil, count = 1, notes }) {
  const now = new Date();
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(now.getTime()) + Math.random(),
    seq: now.getTime() + Math.random(), // sort order
    name,
    foil: foil ? 'Yes' : '',
    count,
    date: localDate(now),
    notes,
    session: notes,
    status: 'pending',
    batchId: null,
    row: null,
  };
}

/** yyyy-mm-dd in the phone's local time zone. */
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function addEntry(entry, settings) {
  await putEntry(entry);
  const pending = await entriesByStatus('pending');
  emit({ pending: pending.length });
  if (pending.length >= settings.syncEvery) syncNow(settings);
}

/** Send everything that is waiting, one batch at a time. */
export async function syncNow(settings) {
  if (busy || !settings.url || !settings.token) return;
  busy = true;
  try {
    for (;;) {
      const pending = await entriesByStatus('pending');
      if (!pending.length) break;
      emit({ pending: pending.length, sending: true });

      // Finish an interrupted batch first, so its batchId is reused.
      const stuckId = pending.find((e) => e.batchId)?.batchId;
      let batch;
      if (stuckId) {
        batch = pending.filter((e) => e.batchId === stuckId);
      } else {
        batch = pending.slice(0, BATCH);
        const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
        for (const e of batch) {
          e.batchId = batchId;
          await putEntry(e); // save the batchId BEFORE sending
        }
      }

      const payload = batch.map(({ name, foil, count, date, notes }) => ({ name, foil, count, date, notes }));
      const res = await appendEntries(settings, batch[0].batchId, payload);
      for (let i = 0; i < batch.length; i++) {
        batch[i].status = 'synced';
        batch[i].row = res.rows[i];
        await putEntry(batch[i]);
      }
    }
    emit({ pending: 0, ok: true, at: new Date() });
  } catch (err) {
    const pending = await entriesByStatus('pending');
    emit({ pending: pending.length, error: err.message });
  } finally {
    busy = false;
  }
}

/**
 * Undo one entry. Returns a message for the UI.
 * Throws if the entry is mid-send or the sheet refuses.
 */
export async function undoEntry(entry, settings) {
  if (entry.status === 'pending' && !entry.batchId) {
    await deleteEntry(entry.id);
    return 'Removed (it had not been sent yet).';
  }
  if (entry.status === 'pending') {
    throw new Error('This card is mid-send. Tap Sync, then Undo again.');
  }
  await undoRow(settings, entry.row, entry.name);
  await deleteEntry(entry.id);
  return `Cleared row ${entry.row} in Count Log.`;
}
