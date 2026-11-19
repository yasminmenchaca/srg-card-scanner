// cardFind.js — find the card's real outline near the saved card box.
//
// The saved box is drawn once on the Setup tab, but the card doesn't always
// sit there: lower in the tray it looks smaller, and cards land a little
// off-center. Then the name strips miss the title, OCR reads art, and every
// read takes 20+ passes. So before each read we look for the card itself.
//
// The rig is white; cards (and sleeve backs: gold, pink, black…) are darker
// or more colorful. Pixels that aren't "light and gray" are card; the biggest
// connected patch of them is the card. No black border needed.
// If the patch doesn't look like a card, we return null and the app uses the
// saved box as before.

import { sourceSize } from './camera.js';

const SEARCH_GROW = 0.25; // look this much (of the box size) beyond each side
const THUMB_W = 160;      // work on a small copy: fast, and blurs out glare specks
export const DARKER = 0.6; // darker than this share of the tray's brightness = card
export const COLOR = 45;  // max-min channel spread above this = card (tray is gray)

const lightOf = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;

/**
 * How bright the bare tray is: the 85th percentile of the outer ring of
 * the search area (mostly tray; dark rig corners and shadows sit lower). Room light changes a lot (your video: ~120,
 * phone photos: ~220), so the cutoff is measured on every read.
 */
export function trayLight(data, W, H) {
  const v = [];
  for (let x = 0; x < W; x++) v.push(lightOf(data, x * 4), lightOf(data, ((H - 1) * W + x) * 4));
  for (let y = 0; y < H; y++) v.push(lightOf(data, y * W * 4), lightOf(data, (y * W + W - 1) * 4));
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.85)];
}

/**
 * Card / not-card mask for RGBA pixels: 1 where the pixel is much darker
 * than the tray (tray shadows are only a bit darker), or colorful. Exported for tests.
 */
export function cardMask(data, tray) {
  const m = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    m[p] = (r + g + b) / 3 < tray * DARKER || spread > COLOR ? 1 : 0;
  }
  return m;
}

/**
 * Bounding box of the biggest 4-connected patch of 1s in a W×H mask.
 * Returns { x0, y0, x1, y1, n } in mask pixels (x1/y1 exclusive), or null.
 */
export function biggestPatch(m, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let best = null;
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || seen[i]) continue;
    let top = 0, n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[top++] = i;
    seen[i] = 1;
    while (top) {
      const p = stack[--top];
      const x = p % W, y = (p / W) | 0;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && m[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[top++] = p - W; }
      if (y < H - 1 && m[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    if (!best || n > best.n) best = { x0, y0, x1: x1 + 1, y1: y1 + 1, n };
  }
  return best;
}

/**
 * Is this patch (in real pixels) a plausible card for a saved box of
 * boxW×boxH pixels? Card-shaped, mostly filled, and not wildly bigger or
 * smaller than the box.
 */
export function looksLikeCard(pw, ph, fill, boxW, boxH) {
  const ratio = ph / pw;
  const size = (pw * ph) / (boxW * boxH);
  return ratio > 1.2 && ratio < 1.6 && fill > 0.6 && size > 0.35 && size < 1.8;
}

/**
 * Find the card near `box` (fractions of the picture).
 * Returns the card's outline in picture fractions, or null (use `box`).
 */
export function findCard(src, box) {
  const { w: sw, h: sh } = sourceSize(src);
  if (!sw || !sh) return null;
  const gx = box.w * SEARCH_GROW, gy = box.h * SEARCH_GROW;
  const ax = Math.max(0, box.x - gx), ay = Math.max(0, box.y - gy);
  const aw = Math.min(1, box.x + box.w + gx) - ax, ah = Math.min(1, box.y + box.h + gy) - ay;

  const W = THUMB_W;
  const H = Math.max(1, Math.round((W * ah * sh) / (aw * sw)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, ax * sw, ay * sh, aw * sw, ah * sh, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const patch = biggestPatch(cardMask(data, trayLight(data, W, H)), W, H);
  if (!patch) return null;

  const pxPerThumb = (aw * sw) / W; // real pixels per thumbnail pixel (same both ways)
  const pw = (patch.x1 - patch.x0) * pxPerThumb, ph = (patch.y1 - patch.y0) * pxPerThumb;
  const fill = patch.n / ((patch.x1 - patch.x0) * (patch.y1 - patch.y0));
  if (!looksLikeCard(pw, ph, fill, box.w * sw, box.h * sh)) return null;

  return {
    x: ax + (patch.x0 / W) * aw,
    y: ay + (patch.y0 / H) * ah,
    w: ((patch.x1 - patch.x0) / W) * aw,
    h: ((patch.y1 - patch.y0) / H) * ah,
  };
}

