// matcher.js — turns messy OCR text into a card name from your list.
//
// Two steps:
//   1. normalize(): lower-case, strip punctuation, fix common OCR slips.
//      Both the OCR text and every card name go through it, so
//      "*Snap*" and "snap" compare as equal.
//   2. similarity(): 1 − (Levenshtein distance / longer length).
//      1.0 = identical, 0.0 = nothing in common.
//
// ~6,000 short names × one Levenshtein each takes a few milliseconds,
// so a plain loop is fast enough and needs no library.

/** Normalize a name or OCR string for comparison. */
export function normalize(s) {
  // Strip accents: "Plátano" → "platano" (OCR usually drops them anyway).
  let t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Version tags. OCR often reads "(V1)" as "(VI)", "(Vl)" or "(V|)".
  t = t.replace(/\(\s*v\s*[1il|!]\s*\)/g, ' v1 ');
  t = t.replace(/\(\s*v\s*(2|z|ii)\s*\)/g, ' v2 ');
  t = t.replace(/\(\s*v\s*(\d+)\s*\)/g, ' v$1 ');

  t = t.replace(/[’‘`´]/g, "'");   // curly quotes → straight
  t = t.replace(/[–—]/g, '-');     // en/em dash → hyphen
  t = t.replace(/'/g, '');         // "Don't" → "dont"
  t = t.replace(/[^a-z0-9]+/g, ' '); // every other symbol (? ! * - . ,) → space
  return t.replace(/\s+/g, ' ').trim();
}

/** Classic Levenshtein edit distance, two-row version. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 0 : 1 - levenshtein(a, b) / len;
}

/**
 * Build a matcher from the card list.
 * cards: [{name, tab, foil}] (unique names)
 */
export function createMatcher(cards) {
  // `base` = the name with every "(…)" removed. The sheet uses brackets for
  // things not printed on the card (skill requirement, version), so the
  // card face usually matches `base`, not the full name.
  const items = cards.map((c) => ({
    ...c,
    norm: normalize(c.name),
    base: normalize(String(c.name).replace(/\([^)]*\)/g, ' ')),
    // Skill words inside the brackets: "Press Slam (Power)" → ["power"]
    skills: bracketSkills(c.name),
  }));

  /**
   * Find the best candidates for an OCR string.
   * options.tab: e.g. "#07", read from the card's number. Cards on that tab
   *              get a small bonus. It's a hint, not a filter, so a misread
   *              number can't hide the right card.
   * Returns [{name, tab, score}] sorted best first.
   */
  function match(ocrText, { tab = null, skill = null, limit = 3 } = {}) {
    const q = normalize(ocrText);
    if (q.length < 2) return [];
    const seen = skill ? skillsInText(skill) : [];

    return items
      .map((it) => {
        let score = scoreOne(q, it);
        // Not capped at 1: an exact name on the read deck must be able to
        // beat the same name on another deck.
        if (tab && it.tab === tab) score += TAB_BONUS;
        // Skill box: "POWER 8" read → "Press Slam (Power)" beats "(Grapple)".
        if (seen.length && it.skills.length && it.skills.every((s) => seen.includes(s))) {
          score += SKILL_BONUS;
        }
        return { name: it.name, tab: it.tab, score, base: it.base, skills: it.skills, text: it.text };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, limit);
  }

  // Stacked titles: "ENTER MY RING / STEP TO MY THUNDEROUS / SLEDGEHAMMER CHOP"
  // is printed on 3 lines, and one line alone can look like a shorter card
  // ("Sledgehammer"). Collect every run of words inside every name, so the
  // app knows when a match might just be one line of a longer title.
  const parts = new Set();
  for (const it of items) {
    const w = it.base.split(' ');
    for (let i = 0; i < w.length; i++) {
      for (let j = i + 1; j <= w.length; j++) {
        if (j - i < w.length) parts.add(w.slice(i, j).join(' '));
      }
    }
  }
  const baseOf = new Map(items.map((it) => [it.name, it.base]));

  const partList = [...parts];

  /**
   * True when this match might be one line of a longer, stacked title:
   *  - the card's name also appears inside a longer card name, or
   *  - the OCR text itself reads closer to a piece of a longer name than to
   *    this card. "RAMPAGE" (bottom line of "Roaring Rolling Rampage")
   *    matched the card "Rampaige" well enough to log, but it's an exact
   *    piece of the longer name.
   */
  function isPartOfLonger(name, ocrText = '') {
    const base = baseOf.get(name);
    if (parts.has(base)) return true;
    const q = normalize(ocrText);
    if (q.length < 3 || q === base) return false;
    if (parts.has(q)) return true;
    const own = similarity(q, base ?? '');
    return partList.some((p) => Math.abs(p.length - q.length) <= 2 && similarity(q, p) > own);
  }

  return { match, isPartOfLonger, size: items.length };
}

/**
 * Score one candidate: the best of
 *   - the full name                     "headlock grapple"
 *   - the name without any (…)          "headlock"          × 0.95
 *   - the name without a bare V-tag     "steel chain"       × 0.95
 * The 0.95 means an exact full-name read still wins, and two sheet names
 * that only differ inside brackets tie, so the app asks instead of guessing.
 */
function scoreOne(q, it) {
  const { norm, base } = it;
  const qTag = versionTag(q);
  const nTag = versionTag(norm);

  // Both have a tag and they differ ("v1" read, card is "v2"): the names are
  // one letter apart, so plain similarity can't tell them apart. Penalize.
  if (qTag && nTag && qTag !== nTag) return similarity(q, norm) * 0.85;

  let s = similarity(q, norm);
  if (base !== norm) s = Math.max(s, similarity(q, base) * 0.95);
  if (nTag && !qTag) s = Math.max(s, similarity(q, norm.replace(/ v\d+$/, '')) * 0.95);
  return s;
}

// How much reading the deck number helps a candidate on that deck.
// Bigger than isConfident's minGap (0.08), so a read number can settle a tie
// between same-named cards on different decks.
const TAB_BONUS = 0.1;

// Same idea for the bottom-left skill requirement box.
const SKILL_BONUS = 0.1;

export const SKILLS = ['power', 'agility', 'technique', 'submission', 'grapple', 'strike'];

/** Skill words inside a name's brackets. */
function bracketSkills(name) {
  const inside = (String(name).match(/\(([^)]*)\)/g) || []).join(' ');
  return normalize(inside).split(' ').filter((w) => SKILLS.includes(w));
}

/**
 * Skill words in OCR text from the skill box, allowing small OCR slips
 * ("P0WER 8" → power, "TECHNIOUE" → technique). Iku Zo cards print two.
 */
export function skillsInText(text) {
  const found = [];
  for (const w of normalize(text).split(' ')) {
    if (w.length < 4) continue;
    for (const s of SKILLS) {
      if (similarity(w, s) >= 0.75 && !found.includes(s)) found.push(s);
    }
  }
  return found;
}

/**
 * When the top results are the same name on the same deck and only the skill
 * in brackets differs ("Bow to None (Grapple)" / "(Power)"), return those
 * skills so the app can check the icon color. Otherwise [].
 */
export function skillsToCheck(results, { within = 0.08 } = {}) {
  if (results.length < 2) return [];
  const [a] = results;
  const tied = results.filter((r) => a.score - r.score < within && r.base === a.base && r.tab === a.tab);
  const withSkill = tied.filter((r) => r.skills?.length === 1);
  const skills = [...new Set(withSkill.map((r) => r.skills[0]))];
  return skills.length >= 2 ? skills : [];
}

/**
 * When the top results are the same name on the same deck and each has its
 * rules text ("Table (V1)" / "Table (V2)"), return those results so the app
 * can read the rules box. Otherwise [].
 */
export function versionsToCheck(results, { within = 0.08 } = {}) {
  if (results.length < 2) return [];
  const [a] = results;
  const tied = results.filter((r) => a.score - r.score < within && r.base === a.base && r.tab === a.tab && r.text);
  return new Set(tied.map((r) => normalize(r.text))).size >= 2 ? tied : [];
}

/**
 * Pick the version whose rules text matches the OCR'd rules box best.
 * Word overlap (Dice), not edit distance: a block read has stray marks and
 * line breaks, but most words come through. Overlap counts both ways, so
 * V1's text (a subset of V2's) doesn't win a V2 read.
 * Returns { name, margin, scores } or null when nothing was read.
 */
export function pickByText(ocrText, candidates) {
  const words = (t) => normalize(t).split(' ').filter((w) => w.length >= 2);
  const read = words(ocrText);
  if (read.length < 3) return null;
  const found = (list, w) => list.some((x) => x === w || (w.length >= 4 && similarity(x, w) >= 0.75));
  const scores = candidates.map((c) => {
    const want = words(c.text);
    const hits = want.filter((w) => found(read, w)).length;
    const extra = read.filter((w) => found(want, w)).length;
    return { name: c.name, score: (hits + extra) / (want.length + read.length) };
  }).sort((x, y) => y.score - x.score);
  return { name: scores[0].name, margin: scores[0].score - (scores[1]?.score ?? 0), scores };
}

const versionTag =(t) => (t.match(/ (v\d+)$/) || [])[1] || null;

/**
 * Decide whether the top result is safe to accept without asking.
 * minScore: the top score must reach this.
 * minGap:   and beat the runner-up by at least this much.
 */
export function isConfident(results, { minScore = 0.85, minGap = 0.08 } = {}) {
  if (!results.length) return false;
  const [a, b] = results;
  const gap = b ? a.score - b.score : a.score;
  // Normal rule: a high score that beats the runner-up.
  if (a.score >= minScore && gap >= minGap) return true;
  // Messy read, but nothing else comes close: "IDCK(UPE" → Lock Up 0.72,
  // next best 0.33. Seen on real rig photos with hard-to-read title fonts.
  if (a.score >= STRONG_LEAD.minScore && gap >= STRONG_LEAD.minGap) return true;
  return false;
}
const STRONG_LEAD = { minScore: 0.65, minGap: 0.3 };

/** Turn OCR text like "#7", "07" or "No. 7" into a tab name like "#07". */
export function deckNumberToTab(ocrText) {
  const m = String(ocrText || '').replace(/[oO]/g, '0').match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 30) return null;
  return '#' + String(n).padStart(2, '0');
}
