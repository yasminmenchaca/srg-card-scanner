// lines.js — stacked titles: join name lines read at different heights.
import { normalize, similarity } from './matcher.js';

const better = (a, b) => (a?.results[0]?.score ?? -1) > (b?.results[0]?.score ?? -1);

// Stacked titles put 2–3 lines about 0.03–0.05 of the card apart.
export const LINES_AROUND = 0.13; // how far above/below a hit to look for more lines
const MAX_LINE_GAP = 0.08; // two strips further apart than this aren't one title

/**
 * Stacked titles ("ENTER MY RING / STEP TO MY THUNDEROUS / SLEDGEHAMMER CHOP"):
 * each strip reads one line. Group strips that read the same line, then try
 * 2 and 3 lines in top-to-bottom order as one name. Returns the best join,
 * or null. Costs no extra OCR, only matching.
 */
export function joinLines(matcher, tried, tab) {
  // One entry per printed line, top to bottom. Neighbouring strips often read
  // the same line, so similar text = same line (keep the longer read).
  const lines = [];
  for (const r of [...tried].sort((a, b) => a.y - b.y)) {
    const t = normalize(r.text);
    if (t.replace(/ /g, '').length < 4) continue; // empty or a stray mark
    const last = lines[lines.length - 1];
    if (last && similarity(t, last.norm) >= 0.5) {
      if (t.length > last.norm.length) Object.assign(last, { norm: t, r });
      last.y2 = r.y;
    } else {
      lines.push({ norm: t, r, y: r.y, y2: r.y });
    }
  }

  let best = null;
  const tryJoin = (picked) => {
    const text = picked.map((l) => l.r.text).join(' ');
    const results = matcher.match(text, { tab, limit: 3 });
    const top = picked[0].r, low = picked[picked.length - 1].r;
    const rect = { ...top.rect, h: low.rect.y + low.rect.h - top.rect.y };
    const r = { crop: top.crop, text, rect, results, y: top.y };
    if (!best || better(r, best)) best = r;
  };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length && lines[j].y - lines[i].y2 <= MAX_LINE_GAP; j++) {
      tryJoin([lines[i], lines[j]]);
      for (let k = j + 1; k < lines.length && lines[k].y - lines[j].y2 <= MAX_LINE_GAP; k++) {
        tryJoin([lines[i], lines[j], lines[k]]);
      }
    }
  }
  return best;
}

