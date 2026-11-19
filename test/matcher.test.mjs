// Run with: node test/matcher.test.mjs
// Checks normalization and matching on tricky names from the brief.
import assert from 'node:assert/strict';
import { normalize, createMatcher, isConfident, deckNumberToTab, skillsInText } from '../js/matcher.js';
import { joinLines } from '../js/lines.js';
import { skillsToCheck, versionsToCheck, pickByText } from '../js/matcher.js';
import { guessSkill, windowShares, shares } from '../js/skill.js';
import { graySpread } from '../js/camera.js';
import { frameDiff } from '../js/detector.js';
import { cardMask, biggestPatch, looksLikeCard, trayLight } from '../js/cardFind.js';

const cards = [
  { name: 'Pineapple for Sheep?', tab: '#03' },
  { name: '*Snap*', tab: '#05' },
  { name: 'Did It Better!', tab: '#07' },
  { name: 'Impact is Family (V1)', tab: '#12' },
  { name: 'Impact is Family (V2)', tab: '#12' },
  { name: "Boss-rate Boot", tab: '#01' },
  { name: 'Chop Down', tab: '#01' },
  { name: 'Chop in the Corner', tab: '#01' },
  { name: 'Body Punches', tab: '#01' },
  { name: 'Snap Suplex', tab: '#09' },
  { name: 'Now -- Or Never', tab: '#10' },
];
const m = createMatcher(cards);
const best = (t, o) => m.match(t, o)[0];
let passed = 0;
const t = (label, fn) => { fn(); passed++; console.log('ok  ', label); };

t('normalize strips punctuation', () => {
  assert.equal(normalize('*Snap*'), 'snap');
  assert.equal(normalize('Pineapple for Sheep?'), 'pineapple for sheep');
  assert.equal(normalize('Now -- Or Never'), 'now or never');
  assert.equal(normalize('Impact is Family (VI)'), 'impact is family v1');
  assert.equal(normalize('Impact is Family (V 2)'), 'impact is family v2');
});

t('exact OCR is confident', () => {
  const r = m.match('Did It Better!');
  assert.equal(r[0].name, 'Did It Better!');
  assert.ok(isConfident(r));
});

t('OCR slips still match', () => {
  assert.equal(best('Pineapp1e for Sheep').name, 'Pineapple for Sheep?');
  assert.equal(best('*5nap*').name, '*Snap*');
  assert.equal(best('Boss rate Boot').name, 'Boss-rate Boot');
  assert.equal(best('N0w - Or Never').name, 'Now -- Or Never');
});

t('V1/V2 resolved when tag is read', () => {
  const r1 = m.match('Impact is Family (V1)');
  assert.equal(r1[0].name, 'Impact is Family (V1)');
  assert.ok(isConfident(r1), 'V1 should auto-accept');
  const r2 = m.match('Impact is Family (Vl)');
  assert.equal(r2[0].name, 'Impact is Family (V1)');
  const r3 = m.match('Impact is Family (V2)');
  assert.equal(r3[0].name, 'Impact is Family (V2)');
  assert.ok(isConfident(r3), 'V2 should auto-accept');
});

t('missing version tag asks instead of guessing', () => {
  const r = m.match('Impact is Family');
  assert.ok(r[0].name.startsWith('Impact is Family'));
  assert.ok(!isConfident(r), 'should not auto-accept without the tag');
});

t('garbage is not confident', () => {
  assert.ok(!isConfident(m.match('xqzv wkp')));
});

t('deck number narrows to the tab', () => {
  assert.equal(deckNumberToTab('#7'), '#07');
  assert.equal(deckNumberToTab('12'), '#12');
  assert.equal(deckNumberToTab('99'), null);
  assert.equal(deckNumberToTab('#23'), '#23');
  assert.equal(best('Snap Suplx', { tab: '#09' }).name, 'Snap Suplex');
  // A misread number must not hide the right card.
  assert.equal(best('*Snap*', { tab: '#09' }).name, '*Snap*');
  // Garbled read that ties two names on different decks: the number decides.
  const two = createMatcher([
    { name: 'Chop Downs', tab: '#01' },
    { name: 'Chop Downe', tab: '#04' },
  ]);
  assert.equal(two.match('CHOP DOWNX', { tab: '#04' })[0].name, 'Chop Downe');
  assert.equal(two.match('CHOP DOWNX', { tab: '#01' })[0].name, 'Chop Downs');
});

// Names seen on the srgpc.net deck pages. Cards print names in ALL CAPS
// and (it seems) without the (V1)/(V2) tag.
const real = createMatcher([
  { name: '3/4 Wrist Lock', tab: '#03' },
  { name: 'Plátano Counter Dropkick', tab: '#01' },
  { name: 'Frog Slime Potion #03', tab: '#03' },
  { name: 'Peg Leg Potion #2', tab: '#02' },
  { name: 'Steel Chain', tab: '#03' },
  { name: 'Steel Chain V2', tab: '#03' },
  { name: 'Smash Into the Cage (V1)', tab: '#02' },
  { name: 'Smash Into the Cage (V2)', tab: '#02' },
  { name: 'Mr. & Mrs. Cringe', tab: '#03' },
  { name: 'Short Squeeze Hold (V1)', tab: '#03' },
  { name: 'Short Squeeze Hold (V2)', tab: '#03' },
]);
const rbest = (t) => real.match(t)[0];

t('all-caps card text matches', () => {
  assert.equal(rbest('3/4 WRIST LOCK').name, '3/4 Wrist Lock');
  assert.equal(rbest('MR. & MRS. CRINGE').name, 'Mr. & Mrs. Cringe');
  assert.ok(isConfident(real.match('3/4 WRIST LOCK')));
});

t('accents and # in names', () => {
  assert.equal(normalize('Plátano Counter Dropkick'), 'platano counter dropkick');
  assert.ok(isConfident(real.match('PLATANO COUNTER DROPKICK')));
  assert.equal(rbest('FROG SLIME POTION #03').name, 'Frog Slime Potion #03');
  assert.equal(rbest('PEG LEG POTION #2').name, 'Peg Leg Potion #2');
});

t('untagged card face asks between versions', () => {
  for (const q of ['STEEL CHAIN', 'SMASH INTO THE CAGE', 'SHORT SQUEEZE HOLD']) {
    const r = real.match(q);
    assert.ok(!isConfident(r), q + ' should open the picker');
    assert.ok(r[1].name.toLowerCase().startsWith(q.toLowerCase()), q + ' runner-up is the other version');
  }
});

// Brackets in the sheet that are not printed on the card.
const br = createMatcher([
  { name: 'Arm Bar (Submission 3+)', tab: '#04' },
  { name: 'Hip Toss (Grapple)', tab: '#05' },
  { name: 'Hip Toss (Strike)', tab: '#06' },
  { name: 'Hip Tosser', tab: '#06' },
  { name: 'Arm Drag', tab: '#05' },
]);

t('bracket text is optional', () => {
  const r = br.match('ARM BAR');
  assert.equal(r[0].name, 'Arm Bar (Submission 3+)');
  assert.ok(isConfident(r), 'only one Arm Bar → auto-accept');
});

t('names differing only in brackets ask', () => {
  const r = br.match('HIP TOSS');
  assert.ok(!isConfident(r));
  assert.deepEqual(r.slice(0, 2).map((x) => x.name).sort(), ['Hip Toss (Grapple)', 'Hip Toss (Strike)']);
  // Deck number breaks the tie when the two live on different decks.
  const r2 = br.match('HIP TOSS', { tab: '#06' });
  assert.equal(r2[0].name, 'Hip Toss (Strike)');
  assert.ok(isConfident(r2));
});

// Real same-deck pairs from srgpc.net skill tag pages.
const sk = createMatcher([
  { name: 'Press Slam (Power)', tab: '#20' },
  { name: 'Press Slam (Grapple)', tab: '#20' },
  { name: 'Enzuigiri (Agility)', tab: '#13' },
  { name: 'Enzuigiri (Strike)', tab: '#13' },
  { name: 'Chugga-Chugga Chugga-Chugga Chugga-Chugga, Chug! (Agility)', tab: '#09' },
  { name: 'Chugga-Chugga Chugga-Chugga Chugga-Chugga, Chug! (Submission)', tab: '#09' },
  { name: 'Super Powerbomb', tab: '#20' },
]);

t('skill words read from the skill box', () => {
  assert.deepEqual(skillsInText('POWER 8'), ['power']);
  assert.deepEqual(skillsInText('P0WER 8'), ['power']);
  assert.deepEqual(skillsInText('TECHNIOUE 8'), ['technique']);
  assert.deepEqual(skillsInText('AGILITY 8 STRIKE 8').sort(), ['agility', 'strike']);
  assert.deepEqual(skillsInText('8'), []);
});

t('same-deck bracket pairs: name alone asks, skill box decides', () => {
  assert.ok(!isConfident(sk.match('PRESS SLAM', { tab: '#20' })));
  const p = sk.match('PRESS SLAM', { tab: '#20', skill: 'GRAPPLE 8' });
  assert.equal(p[0].name, 'Press Slam (Grapple)');
  assert.ok(isConfident(p));
  const e = sk.match('ENZUIGIRI', { tab: '#13', skill: 'AGILITY 8' });
  assert.equal(e[0].name, 'Enzuigiri (Agility)');
  assert.ok(isConfident(e));
  const c = sk.match('CHUGGA-CHUGGA CHUGGA-CHUGGA CHUGGA-CHUGGA, CHUG!', { skill: 'SUBMISSI0N 8' });
  assert.equal(c[0].name, 'Chugga-Chugga Chugga-Chugga Chugga-Chugga, Chug! (Submission)');
  assert.ok(isConfident(c));
});

t('skill box does not override a clearly different name', () => {
  // "Super Powerbomb" has no brackets; a POWER read must not push Press Slam over it.
  assert.equal(sk.match('SUPER POWERBOMB', { skill: 'POWER 8' })[0].name, 'Super Powerbomb');
});

t('messy read with a big lead is accepted', () => {
  const lk = createMatcher([
    { name: 'Lock Up', tab: '#02' }, { name: 'Lock Down', tab: '#05' }, { name: 'Lockjaw', tab: '#03' },
    { name: 'Lockdown Hold', tab: '#24' }, { name: 'Leg & Arm Lock', tab: '#06' }, { name: 'Lock Out', tab: '#09' },
  ]);
  // Real OCR outputs from rig photos of "LOCK UP".
  assert.ok(isConfident(lk.match('IDCK(UPE', { tab: '#02' })));
  assert.ok(isConfident(lk.match('HlocK(UP', { tab: '#02' })));
  // Lead too small → still asks.
  assert.ok(!isConfident(lk.match('LOCK D', {})));
});

// Stacked titles: one name printed on 3 lines.
const st = createMatcher([
  { name: 'Enter My Ring Step to My Thunderous Sledgehammer Chop', tab: '#16' },
  { name: 'Sledgehammer', tab: '#04' },
  { name: 'Sledgehammer The Quad', tab: '#11' },
  { name: 'Going Over the Sledgehammer', tab: '#12' },
  { name: 'Lock Up', tab: '#02' },
]);

t('names inside longer names are flagged', () => {
  assert.ok(st.isPartOfLonger('Sledgehammer'));
  assert.ok(!st.isPartOfLonger('Lock Up'));
  assert.ok(!st.isPartOfLonger('Enter My Ring Step to My Thunderous Sledgehammer Chop'));
});

t('stacked title lines are joined', () => {
  // Real strip reads from a card photo, top to bottom, plus some art noise.
  const strip = (y, text) => ({ y, text, rect: { x: 0, y, w: 0.5, h: 0.055 }, results: st.match(text, { tab: '#16' }) });
  const tried = [
    strip(0.065, 'rT T7T rv" "vor r-1rrvwvm'),
    strip(0.08, 'ENTERIMYIRING!'),
    strip(0.095, 'ENTEDRIRMMVIDINC!'),
    strip(0.11, 'ALLL RIMIVAR JN CG'),
    strip(0.125, 'STERSTOIMY4THUNDET'),
    strip(0.14, 'STETSTOIMYaTHUNDEF'),
    strip(0.155, 'SUEDGEHAMMERIGHE'),
    strip(0.2, 'WE 9'),
  ];
  const j = joinLines(st, tried, '#16');
  assert.equal(j.results[0].name, 'Enter My Ring Step to My Thunderous Sledgehammer Chop');
  assert.ok(isConfident(j.results));
  // The bottom line alone must not log a different card.
  assert.ok(!isConfident(st.match('SUEDGEHAMMERIGHE', { tab: '#16' })) ||
    st.match('SUEDGEHAMMERIGHE', { tab: '#16' })[0].name.startsWith('Enter'));
});

// From a scan: the bottom line "RAMPAGE" alone auto-logged "Rampaige".
t('one line of a stacked title that looks like another card', () => {
  const rr = createMatcher([
    { name: 'Roaring Rolling Rampage', tab: '#14' },
    { name: 'Rampaige', tab: '#20' },
    { name: 'Lock Up', tab: '#02' },
  ]);
  const line = rr.match('RAMPAGE', { tab: '#14' });
  assert.equal(line[0].name, 'Rampaige'); // why it went wrong
  assert.ok(rr.isPartOfLonger('Rampaige', 'RAMPAGE'));
  assert.ok(rr.isPartOfLonger('Rampaige', 'RAMPACE')); // OCR slip still caught
  assert.ok(!rr.isPartOfLonger('Rampaige', 'RAMPAIGE')); // the real card still logs at once
  assert.ok(!rr.isPartOfLonger('Lock Up', 'LOCK UP'));
  const strip = (y, text) => ({ y, text, rect: { x: 0, y, w: 0.5, h: 0.055 }, results: rr.match(text, { tab: '#14' }) });
  const j = joinLines(rr, [strip(0.08, 'ROARING ROLLING'), strip(0.125, 'RAMPAGE')], '#14');
  assert.equal(j.results[0].name, 'Roaring Rolling Rampage');
});

// V1/V2: same title and deck, only the rules text differs (Raw Data card_text).
t('versions are told apart by rules text', () => {
  const v1 = 'If you roll Grapple for your Finish roll-- your roll is +1.';
  const v2 = 'If you roll Grapple for your Finish roll-- it is +1.\nIf this match has "Table" in the name-- choose 1 card your opponent has in play and discard it.';
  const tm = createMatcher([
    { name: 'Table (V1)', tab: '#02', text: v1 }, { name: 'Table (V2)', tab: '#02', text: v2 },
    { name: 'Tables Turned', tab: '#02' },
  ]);
  const res = tm.match('TABLE', { tab: '#02' });
  assert.ok(!isConfident(res)); // the title alone can't tell them apart
  const vs = versionsToCheck(res);
  assert.deepEqual(vs.map((r) => r.name).sort(), ['Table (V1)', 'Table (V2)']);

  // Messy block reads, like Tesseract gives on a rig photo.
  const readV1 = 'IF YOU ROLL GRAPPLE FOR YOUR\nFINISH ROLL, YOUR ROLL IS +1.';
  const readV2 = 'IF YOU ROLL GRAPPLE FOR YOUR FINISH\nROLL, IT IS +1. IF THIS MATCH HAS\n"TABLE" IN THE NAME, CHOOSE 1 CARD YOUR\nOPPONENT HAS IN PLAY AND DISCAFD IT.';
  const p1 = pickByText(readV1, vs), p2 = pickByText(readV2, vs);
  assert.equal(p1.name, 'Table (V1)'); assert.ok(p1.margin >= 0.2, `v1 margin ${p1.margin}`);
  assert.equal(p2.name, 'Table (V2)'); assert.ok(p2.margin >= 0.2, `v2 margin ${p2.margin}`);
  assert.equal(pickByText('~ |', vs), null); // nothing read → no guess

  // Cards without text (old Apps Script) → no rules check, the picker asks.
  const old = createMatcher([{ name: 'Table (V1)', tab: '#02' }, { name: 'Table (V2)', tab: '#02' }]);
  assert.deepEqual(versionsToCheck(old.match('TABLE', { tab: '#02' })), []);
});

// From a scan: "E7A" auto-logged ETA for an FTL card.
t('short names only log on an exact read', () => {
  const sm = createMatcher([
    { name: 'ETA', tab: '#28' }, { name: 'FTL', tab: '#30' }, { name: 'E.T.F.', tab: '#28' },
    { name: 'EDM', tab: 'Single Competitor Cards' }, { name: 'Leg Trap', tab: '#12' },
  ]);
  for (const junk of ['E7A', 'FTA', 'EDN']) assert.ok(!isConfident(sm.match(junk, { tab: '#28' })), junk);
  for (const [read, name] of [['ETA', 'ETA'], ['FTL', 'FTL'], ['ETF', 'E.T.F.']]) {
    const r = sm.match(read, { tab: '#28' });
    assert.equal(r[0].name, name); assert.ok(isConfident(r), read);
  }
});

// Card outline: fake W×H picture, light gray tray with a darker diagonal
// shadow band, and a card (purple, black rim, white text box) in it.
function trayPic(W, H, card) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let c = Math.abs(x - y) < 8 ? [170, 172, 175] : [215, 218, 222]; // shadow band / tray
    if (card && x >= card.x0 && x < card.x1 && y >= card.y0 && y < card.y1) {
      const rim = x < card.x0 + 2 || x >= card.x1 - 2 || y < card.y0 + 2 || y >= card.y1 - 2;
      const textBox = y > card.y0 + 0.6 * (card.y1 - card.y0) && y < card.y0 + 0.85 * (card.y1 - card.y0);
      c = rim ? [20, 20, 25] : textBox && x % 3 ? [240, 240, 240] : [60, 40, 110];
    }
    d.set([...c, 255], i);
  }
  return d;
}

t('card outline found against the tray, shadows ignored', () => {
  const W = 100, H = 140, card = { x0: 25, y0: 30, x1: 75, y1: 100 };
  const d = trayPic(W, H, card);
  const p = biggestPatch(cardMask(d, trayLight(d, W, H)), W, H);
  assert.deepEqual([p.x0, p.y0, p.x1, p.y1], [25, 30, 75, 100]);
  const pw = p.x1 - p.x0, ph = p.y1 - p.y0;
  assert.ok(looksLikeCard(pw, ph, p.n / (pw * ph), 56, 78)); // saved box a bit bigger
  // Empty tray: the shadow band alone isn't card.
  const e = trayPic(W, H, null);
  assert.equal(biggestPatch(cardMask(e, trayLight(e, W, H)), W, H), null);
  // A long thin patch (rig edge) isn't a card.
  assert.ok(!looksLikeCard(10, 140, 1, 56, 78));
});

// Same name + deck, only the skill differs → check the icon color.
t('skill-only ties ask for the icon color', () => {
  const bt = createMatcher([
    { name: 'Bow to None (Grapple)', tab: '#08' }, { name: 'Bow to None (Power)', tab: '#08' },
    { name: 'Bow to None (Strike)', tab: '#08' }, { name: 'Bow Down', tab: '#08' },
  ]);
  assert.deepEqual(skillsToCheck(bt.match('BOW TO NONE', { tab: '#08' })).sort(), ['grapple', 'power', 'strike']);
  assert.deepEqual(skillsToCheck(sk.match('SUPER POWERBOMB')), []);
});

// Fake pixels: a W×H area filled with `bg`, plus a solid badge.
function area(W, H, bg, badge) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inBadge = badge && x >= 4 && x < 20 && y >= 4 && y < 14;
    d.set([...(inBadge ? badge : bg), 255], (y * W + x) * 4);
  }
  return d;
}
const RED = [220, 30, 30], BLUE = [40, 70, 220], YELLOW = [235, 220, 40], BLACK = [10, 10, 10];
const guess = (icon, frame, opts) => guessSkill(windowShares(icon, 48, 40), shares(frame), opts);

t('icon color guess', () => {
  // Red badge on a black frame → power.
  assert.equal(guess(area(48, 40, BLACK, RED), area(40, 40, BLACK), ['power', 'grapple']), 'power');
  // Red badge on a yellow (strike-colored) frame → power, not strike.
  assert.equal(guess(area(48, 40, YELLOW, RED), area(40, 40, YELLOW), ['power', 'strike']), 'power');
  // Yellow badge on a yellow frame, no other option visible → strike.
  assert.equal(guess(area(48, 40, YELLOW, YELLOW), area(40, 40, YELLOW), ['power', 'strike']), 'strike');
  // Nothing colored → no guess.
  assert.equal(guess(area(48, 40, BLACK), area(40, 40, BLACK), ['power', 'grapple']), null);
  // Two badges (Iku Zo two-skill hexagon) → no guess.
  const two = area(48, 40, BLACK, RED);
  for (let y = 24; y < 34; y++) for (let x = 4; x < 20; x++) two.set([...BLUE, 255], (y * 48 + x) * 4);
  assert.equal(guess(two, area(40, 40, BLACK), ['power', 'grapple']), null);
});

t('foil shine is not motion, a card sliding in is', () => {
  const N = 64 * 48;
  const card = new Uint8Array(N).map((_, i) => (i * 37) % 200 + 20);
  // Shine shifts: every pixel 6–14 brighter, a glare spot (~9% of the picture) +16.
  const shine = card.map((g, i) => Math.min(255, g + 6 + (i % 9) + (i % 64 < 6 ? 16 : 0)));
  assert.ok(frameDiff(card, shine) < 4, 'shine counts as still');
  // Next card slides in over the top half: those pixels change completely.
  const slide = card.map((g, i) => (i < N / 2 ? 255 - g : g));
  assert.ok(frameDiff(card, slide) > 12, 'slide counts as moving');
});

t('empty tray vs card (brightness spread)', () => {
  // White tray with faint shading → low spread.
  const tray = area(48, 64, [200, 200, 195]);
  for (let i = 0; i < tray.length; i += 4) tray[i] = tray[i + 1] = tray[i + 2] = 180 + ((i / 4) % 48) / 4;
  assert.ok(graySpread(tray) < 18);
  // Card: dark border, light name bar, busy art → high spread.
  const card = area(48, 64, BLACK, [240, 240, 240]);
  for (let y = 20; y < 50; y++) for (let x = 4; x < 44; x++) card.set([(x * 37) % 255, (y * 53) % 255, 90, 255], (y * 48 + x) * 4);
  assert.ok(graySpread(card) > 25);
});

console.log(`\n${passed} tests passed`);
