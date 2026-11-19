// skill.js — guesses the skill requirement from the icon's COLOR.
//
// The icon (bottom-left: a round "8+" badge, or the Iku Zo hexagon) is too
// small for OCR, but every skill has its own color:
//   Power red · Technique orange · Strike yellow · Agility green
//   Grapple blue · Submission purple
//
// Used only for names that are identical except for the skill in brackets,
// on the same deck ("Bow to None (Grapple)" / "(Power)" / "(Strike)").
// It's a HINT: the guess goes first in the picker, it never logs on its own.
// Tested on 60 srgpc.net scans: about 2 in 3 guesses are made, and 2 in ~300
// were wrong (a dark purple icon that didn't register; an odd card design).
// Good for saving a tap, not good enough to write to the sheet unasked.

// Hue ranges in degrees (0–360). Red wraps around 0.
export const SKILL_HUES = {
  power: [[345, 360], [0, 15]],
  technique: [[18, 48]],
  strike: [[50, 75]],
  agility: [[85, 150]],
  grapple: [[200, 245]],
  submission: [[250, 300]],
};
const SKILLS = Object.keys(SKILL_HUES);

// Areas as fractions of the card.
// ICON: where the badge/hexagon sits on every design (bottom-left corner).
export const ICON = { x: 0.04, y: 0.82, w: 0.22, h: 0.16 };
// BESIDE: same height, right of the icon (copyright line). A color that's
// common here is the card's frame, so it can't prove anything about the icon.
export const BESIDE = { x: 0.3, y: 0.82, w: 0.2, h: 0.16 };
// A window about the size of the badge's inside, as a fraction of ICON.
const WIN = { w: 0.25, h: 0.18 };

/** Skill index per pixel (-1 = dark, gray, or another color). */
function skillMap(data) {
  const out = new Int8Array(data.length / 4).fill(-1);
  for (let p = 0; p < out.length; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 60 || max - min < 50) continue;
    const d = max - min;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    for (let k = 0; k < SKILLS.length; k++) {
      if (SKILL_HUES[SKILLS[k]].some(([lo, hi]) => h >= lo && h < hi)) { out[p] = k; break; }
    }
  }
  return out;
}

/** Share of the whole area in each skill color: {power: 0.1, ...} */
export function shares(data) {
  const m = skillMap(data);
  const c = new Array(SKILLS.length).fill(0);
  for (const k of m) if (k >= 0) c[k]++;
  return Object.fromEntries(SKILLS.map((s, k) => [s, c[k] / (m.length || 1)]));
}

/**
 * Best badge-sized window per skill: slide a small window over the icon area
 * and keep the highest share of each color. A solid badge scores ~0.85–1.
 */
export function windowShares(data, width, height) {
  const m = skillMap(data);
  const ww = Math.max(1, Math.round(WIN.w * width));
  const wh = Math.max(1, Math.round(WIN.h * height));
  const step = Math.max(1, Math.round(ww / 4));
  const best = new Array(SKILLS.length).fill(0);
  for (let y = 0; y + wh <= height; y += step) {
    for (let x = 0; x + ww <= width; x += step) {
      const c = new Array(SKILLS.length).fill(0);
      for (let yy = y; yy < y + wh; yy++) {
        for (let xx = x; xx < x + ww; xx++) {
          const k = m[yy * width + xx];
          if (k >= 0) c[k]++;
        }
      }
      for (let k = 0; k < c.length; k++) best[k] = Math.max(best[k], c[k] / (ww * wh));
    }
  }
  return Object.fromEntries(SKILLS.map((s, k) => [s, best[k]]));
}

/**
 * Guess one of `candidates` (e.g. ["grapple", "power"]), or null.
 * win:    windowShares() of the ICON area
 * beside: shares() of the BESIDE area
 */
export function guessSkill(win, beside, candidates) {
  const frame = candidates.filter((s) => beside[s] >= FRAME);
  const other = candidates.filter((s) => beside[s] < FRAME);
  // A solid badge in a color that is NOT the frame's.
  const strong = other.filter((s) => win[s] >= BADGE);
  if (strong.length === 1 && other.every((s) => s === strong[0] || win[s] < 0.3)) return strong[0];
  // Badge is the same color as the frame: only if no other option shows up.
  if (!strong.length && frame.length === 1 && other.every((s) => win[s] < 0.1) && win[frame[0]] >= BADGE) {
    return frame[0];
  }
  return null;
}
const BADGE = 0.85; // window this full of one color = a badge
const FRAME = 0.15; // this much of BESIDE in one color = frame color

/** RGBA bytes of one area of the camera frame or photo. rect = fractions of the source. */
export function areaPixels(src, rect) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w * sw));
  c.height = Math.max(1, Math.round(rect.h * sh));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, Math.round(rect.x * sw), Math.round(rect.y * sh), c.width, c.height, 0, 0, c.width, c.height);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}
