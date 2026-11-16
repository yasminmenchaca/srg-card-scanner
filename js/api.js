// api.js — talks to the Apps Script web app.
//
// GET  returns the card list.
// POST sends JSON as text/plain. A JSON content type would make the
// browser send a CORS "preflight" OPTIONS request first, which Apps
// Script cannot answer. text/plain skips it. Apps Script still reads
// the body as e.postData.contents.

async function call(url, init) {
  const res = await fetch(url, { redirect: 'follow', ...init });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Unknown error');
  return data;
}

export async function fetchCards({ url, token }) {
  const data = await call(url + '?token=' + encodeURIComponent(token), { method: 'GET' });
  return data.cards;
}

function post(url, body) {
  return call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
}

export const appendEntries = ({ url, token }, batchId, entries) =>
  post(url, { token, action: 'append', batchId, entries });

export const undoRow = ({ url, token }, row, name) =>
  post(url, { token, action: 'undo', row, name });
