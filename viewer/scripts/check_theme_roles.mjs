#!/usr/bin/env node
/**
 * "Elements claim roles, never colours" -- enforced (docs/adr/0040).
 *
 * Greps core/ render paths for colour literals and fails on anything not in the
 * allowlist below. Convention alone produced the state this replaced: nine
 * drawable layers in core/, exactly one of which read the old PALETTE.
 *
 * THE ALLOWLIST IS THE USEFUL HALF. It turns "this element should not be
 * themed" from a comment into a fact something checks, and every entry has to
 * carry a reason. Adding one is a reviewed one-line diff; forgetting to is a
 * red build.
 *
 * Usage:  node scripts/check_theme_roles.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE = new URL('../src/core/', import.meta.url).pathname;

/**
 * file -> { literal -> why }. A literal listed here may appear in that file
 * any number of times; it may not appear anywhere else.
 */
const ALLOW = {
  'theme.ts': {
    '*': 'the module that resolves Themes; role hexes necessarily pass through it',
  },
  'material.ts': {
    '0x171717': 'in a comment, explaining the colour-space passthrough this file exists for',
    '0x555555': 'No-Data Style grey -- a cell never computed, not furniture. Runtime toggle (ADR-0005), outside Themes',
    '0xcccccc': 'No-Data Style light grey, same reasoning',
    '0xffffff': 'No-Data Style white, same reasoning',
  },
  'boundaries.ts': {
    '0x000000': "pre-Theme default subduction stroke; superseded by applyTheme() on any themed wrapper, kept as the seed for callers that never theme",
  },
  'timeSeriesPanel.ts': {
    '0x7fd0ff': 'chart series colour -- panel chrome, which Themes deliberately do not govern (ADR-0038)',
    '0xffb454': 'chart series colour, same reasoning',
  },
  'coastlines.ts': {
    '0x808080': 'fallback land for a caller OUTSIDE the Theme system (deformation viewer grey continents)',
    '0xffffff': 'shader uniform seed, overwritten by applyTheme() before first paint',
  },
  'windGlyphs.ts': {
    '0xffffff': 'material seed, overwritten by applyTheme()',
  },
  'windStreaks.ts': {
    '0x1f5c7a': 'DEFAULT_FLOW_RAMP -- the rampFlow role default for a wrapper that never themes',
    '0xeaffff': 'DEFAULT_FLOW_RAMP, same',
  },
  'trackedParticles.ts': {
    '0x2ea043': 'DEFAULT_TRACK_RAMP -- the rampTrack role default for a wrapper that never themes',
    '0xe6ffe9': 'DEFAULT_TRACK_RAMP, same',
    '0xffffff': 'particle head material seed',
  },
};

const LITERAL = /0x[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{6}\b/g;

let failures = 0;
const files = readdirSync(CORE).filter((f) => f.endsWith('.ts'));

for (const file of files) {
  const allow = ALLOW[file] || {};
  if (allow['*']) continue;
  const text = readFileSync(join(CORE, file), 'utf8');
  const seen = new Map();
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LITERAL)) {
      const lit = m[0].toLowerCase().replace(/^#/, '0x');
      if (!seen.has(lit)) seen.set(lit, i + 1);
    }
  });
  for (const [lit, lineNo] of seen) {
    const allowed = Object.keys(allow).some((k) => k.toLowerCase() === lit);
    if (!allowed) {
      console.error(
        `  FAIL  core/${file}:${lineNo}  hardcoded colour ${lit}\n`
        + '          Elements claim a Theme Role, they do not name colours (docs/adr/0040).\n'
        + '          If this genuinely should not be themed, add it to ALLOW in this\n'
        + '          script with a one-line reason.',
      );
      failures++;
    }
  }
}

// An allowlist entry that no longer matches anything is stale and misleading.
for (const [file, entries] of Object.entries(ALLOW)) {
  if (entries['*']) continue;
  let text;
  try { text = readFileSync(join(CORE, file), 'utf8').toLowerCase(); } catch {
    console.error(`  FAIL  allowlist names core/${file}, which does not exist`);
    failures++;
    continue;
  }
  for (const lit of Object.keys(entries)) {
    if (!text.includes(lit.toLowerCase()) && !text.includes(lit.toLowerCase().replace(/^0x/, '#'))) {
      console.error(`  FAIL  stale allowlist entry: core/${file} no longer contains ${lit}`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}
console.log(`core/ is clean: ${files.length} files, `
  + `${Object.keys(ALLOW).length - 1} with allowlisted exceptions.\n`);
