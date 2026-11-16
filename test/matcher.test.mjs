// Run with: node test/matcher.test.mjs
// Checks normalization and matching on tricky names from the brief.
import assert from 'node:assert/strict';
import { normalize, createMatcher, isConfident, deckNumberToTab, skillsInText } from '../js/matcher.js';

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

console.log(`\n${passed} tests passed`);
