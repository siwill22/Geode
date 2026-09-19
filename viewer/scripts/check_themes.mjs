#!/usr/bin/env node
/**
 * The Theme legibility gate (docs/adr/0041) and grid-coverage check.
 *
 * Fails the build if two roles that can appear together in a Theme fall below
 * CIEDE2000 dE 15 under normal, deuteranopian or protanopian simulation.
 * Tritanopia is reported but advisory: at roughly 0.01% prevalence it is worth
 * knowing about and not worth blocking on.
 *
 * Why a hard gate rather than an eyeball: the palette this replaced had three
 * near-interchangeable pale blues (`other`/`velocity` at dE 7.1 under NORMAL
 * vision) and survived careful hand-tuning, a written rationale, and everyone
 * being happy with it. See docs/adr/0041 for the measurements.
 *
 * Usage:  node scripts/check_themes.mjs [--verbose]
 */
import {
  THEMES, ROLE_NAMES, RAMP_NAMES, coOccurringPairs, outlineColour,
  boundaryStyle, velocityStyle,
} from '../vendor/petrify/js/themes.js';
import { distanceUnder, hexToRgb } from '../vendor/petrify/js/colour.js';

const THRESHOLD = 15;
const GATED = ['normal', 'deuteranopia', 'protanopia'];
const ADVISORY = ['tritanopia'];
const verbose = process.argv.includes('--verbose');

let failures = 0;
let advisories = 0;

const fail = (msg) => { console.error(`  FAIL  ${msg}`); failures++; };

// --- 1. every Theme is structurally complete ---------------------------------

const seenIds = new Set();
for (const t of THEMES) {
  if (seenIds.has(t.id)) fail(`duplicate theme id '${t.id}'`);
  seenIds.add(t.id);

  for (const r of ROLE_NAMES) {
    if (!t.roles[r]) fail(`${t.id}: missing role '${r}'`);
    else { try { hexToRgb(t.roles[r]); } catch (e) { fail(`${t.id}.${r}: ${e.message}`); } }
  }
  for (const r of RAMP_NAMES) {
    const ramp = t.roles[r];
    if (!Array.isArray(ramp) || ramp.length !== 2) {
      fail(`${t.id}: ramp '${r}' must be [slow, fast]`);
    } else ramp.forEach((c) => { try { hexToRgb(c); } catch (e) { fail(`${t.id}.${r}: ${e.message}`); } });
  }
  if (!['light', 'dark'].includes(t.lightness)) fail(`${t.id}: bad lightness '${t.lightness}'`);
  if (!['warm', 'cool', 'neutral'].includes(t.temperature)) fail(`${t.id}: bad temperature '${t.temperature}'`);
  if (!['contrast', 'shade', 'none'].includes(t.outline)) fail(`${t.id}: bad outline '${t.outline}'`);
  if (!(t.weight > 0.4 && t.weight < 3)) fail(`${t.id}: weight ${t.weight} outside sane range 0.4-3`);
  if (!t.description || t.description.length < 20) fail(`${t.id}: needs a real description (the skill matches on it)`);

  // The resolvers must not throw, and boundary style must stay COMPLETE per
  // type -- a partial entry would be shallow-merged over DEFAULT_STYLE and
  // silently drop its width.
  const bs = boundaryStyle(t);
  for (const [type, s] of Object.entries(bs)) {
    if (!s.stroke || typeof s.width !== 'number' || !s.label) {
      fail(`${t.id}: boundaryStyle.${type} is incomplete (stroke/width/label all required)`);
    }
  }
  velocityStyle(t);
}

// --- 2. the legibility gate ---------------------------------------------------

console.log(`\nLegibility gate: dE${THRESHOLD} over ${GATED.join(', ')}\n`);

for (const t of THEMES) {
  const pen = outlineColour(t);
  const colourOf = (role) => (role === 'outline' ? pen : t.roles[role]);
  const pairs = coOccurringPairs(t);

  let worst = { d: Infinity, pair: null, kind: null };
  const bad = [];

  for (const [a, b] of pairs) {
    const ca = colourOf(a);
    const cb = colourOf(b);
    if (!ca || !cb) continue; // outline:'none' has no pen; its pairs are skipped
    for (const kind of GATED) {
      const d = distanceUnder(ca, cb, kind);
      if (d < worst.d) worst = { d, pair: [a, b], kind };
      if (d < THRESHOLD) bad.push({ a, b, kind, d });
    }
  }

  const advisoryHits = [];
  for (const [a, b] of pairs) {
    const ca = colourOf(a); const cb = colourOf(b);
    if (!ca || !cb) continue;
    for (const kind of ADVISORY) {
      const d = distanceUnder(ca, cb, kind);
      if (d < THRESHOLD) advisoryHits.push({ a, b, kind, d });
    }
  }

  const tag = `${t.id} (${t.lightness}/${t.temperature}, w${t.weight}, ${t.outline})`;
  if (bad.length) {
    console.error(`  FAIL  ${tag}`);
    for (const x of bad.sort((p, q) => p.d - q.d).slice(0, 6)) {
      console.error(`          ${x.d.toFixed(1)}  ${x.a} / ${x.b}  [${x.kind}]`);
    }
    failures++;
  } else {
    console.log(`  ok    ${tag}  worst ${worst.d.toFixed(1)} (${worst.pair.join('/')} ${worst.kind})`);
  }
  if (advisoryHits.length) {
    advisories += advisoryHits.length;
    if (verbose) {
      for (const x of advisoryHits.sort((p, q) => p.d - q.d).slice(0, 3)) {
        console.log(`          advisory ${x.d.toFixed(1)}  ${x.a} / ${x.b}  [${x.kind}]`);
      }
    }
  }
}

// --- 3. Themes must differ from EACH OTHER, not just internally ---------------
//
// The gate above bounds accents WITHIN a Theme and says nothing across them.
// The first nine Themes passed it while sharing effectively one set of boundary
// inks -- mean cross-Theme accent separation of 5.8-9.8 dE, below the floor
// required inside a single Theme, and three Themes with a byte-identical
// accentMuted. Nine backgrounds is not nine Themes, so this is checked too.
//
// The floor is deliberately lower than the within-Theme one: two Themes are
// never on screen together except in the theme lab, so they need to be
// *recognisably* different, not simultaneously legible.

const CROSS_MEAN_MIN = 12;   // per role, averaged over every Theme pair
const PAIR_SET_MIN = 9;      // per Theme PAIR, averaged over the five accents
const ACCENTS = ['accentHot', 'accentWarm', 'accentBright', 'accentMuted', 'accentCool'];

// Measured per ROLE, and separately per THEME PAIR, because they catch
// different failures. Two Themes sharing one red is a coincidence and fine --
// Frost and Playroom do, and are unmistakable from each other anyway because
// their substrates differ enormously. Two Themes sharing a whole INK SET is the
// actual defect. A per-role "closest pair" rule would forbid the coincidence
// and miss nothing extra, so it is not used.
console.log('\nCross-Theme variation, per role (mean over all Theme pairs):\n');
for (const role of ACCENTS) {
  const cs = THEMES.map((t) => t.roles[role]);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) { sum += distanceUnder(cs[i], cs[j], 'normal'); n++; }
  }
  const mean = sum / n;
  console.log(`  ${mean < CROSS_MEAN_MIN ? 'FAIL' : 'ok  '}  ${role.padEnd(13)} mean ${mean.toFixed(1)}`);
  if (mean < CROSS_MEAN_MIN) {
    fail(`${role} varies too little across Themes (mean ${mean.toFixed(1)} < ${CROSS_MEAN_MIN}) -- `
      + 'the Themes are sharing one palette and differing only in substrate');
  }
}

console.log('\nClosest Theme pairs, by whole ink set:\n');
const pairs = [];
for (let i = 0; i < THEMES.length; i++) {
  for (let j = i + 1; j < THEMES.length; j++) {
    const a = THEMES[i];
    const b = THEMES[j];
    const mean = ACCENTS
      .reduce((acc, r) => acc + distanceUnder(a.roles[r], b.roles[r], 'normal'), 0) / ACCENTS.length;
    const identical = ACCENTS.filter((r) => a.roles[r].toLowerCase() === b.roles[r].toLowerCase());
    pairs.push({ a: a.id, b: b.id, mean, identical });
  }
}
pairs.sort((p, q) => p.mean - q.mean);
for (const p of pairs.slice(0, 3)) {
  console.log(`  ${p.mean < PAIR_SET_MIN ? 'FAIL' : 'ok  '}  ${p.a} / ${p.b}   mean ${p.mean.toFixed(1)}`);
}
for (const p of pairs) {
  if (p.mean < PAIR_SET_MIN) {
    fail(`'${p.a}' and '${p.b}' share an ink set (mean ${p.mean.toFixed(1)} < ${PAIR_SET_MIN})`);
  }
  if (p.identical.length) {
    fail(`'${p.a}' and '${p.b}' have byte-identical ${p.identical.join(', ')}`);
  }
}

// --- 4. grid coverage ---------------------------------------------------------

console.log('\nGrid coverage (lightness x temperature):\n');
const missing = [];
for (const l of ['light', 'dark']) {
  const row = [];
  for (const temp of ['warm', 'cool', 'neutral']) {
    const hits = THEMES.filter((t) => t.lightness === l && t.temperature === temp);
    if (!hits.length) missing.push(`${l}/${temp}`);
    row.push(`${temp}: ${hits.map((t) => t.id).join(', ') || '--'}`);
  }
  console.log(`  ${l.padEnd(6)}  ${row.join('   |   ')}`);
}
if (missing.length) {
  fail(`grid cells with no Theme: ${missing.join(', ')} -- a plain-language `
    + 'request for one of these would land on nothing (docs/adr/0041)');
}
if (THEMES.length < 5 || THEMES.length > 10) {
  fail(`${THEMES.length} Themes; the intended set is 5-10`);
}

// --- report -------------------------------------------------------------------

console.log('');
if (advisories) console.log(`  ${advisories} advisory (tritanopia) hit(s); not gated.`);
if (failures) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}
console.log(`${THEMES.length} Themes pass.\n`);
