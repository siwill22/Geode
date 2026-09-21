#!/usr/bin/env node
/**
 * Theme lab render check: boots the lab against a preview build, shoots every
 * Theme on one globe, then shoots a four-up side-by-side comparison.
 *
 * Runs against `vite preview`, never the dev server -- HMR reloads the page
 * mid-run and kills the harness at a random step.
 *
 * Usage:  node scripts/check_themelab.mjs [outDir] [baseUrl]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots-themelab';
const BASE = process.argv[3] ?? 'http://localhost:4174';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/themelab.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__themelab?.ready === true, { timeout: 45000 });
// One extra frame beyond "ready": boot resolves when data is applied, not when
// the first paint using it has landed.
await page.waitForTimeout(600);

const ids = await page.evaluate(() => window.__themelab.themeIds());
console.log(`themes: ${ids.join(', ')}`);

const AGE = 120;
await page.evaluate((a) => window.__themelab.setAge(a), AGE);
await page.waitForTimeout(400);

let failures = 0;
for (const id of ids) {
  await page.evaluate((i) => window.__themelab.setTheme(i, 0), id);
  await page.waitForTimeout(350);
  const state = await page.evaluate(() => window.__themelab.instanceState(0));
  if (state.themeId !== id) {
    console.error(`  FAIL ${id}: instance reports '${state.themeId}'`);
    failures++;
  }
  await page.screenshot({ path: `${OUT}/${id}.png` });
  const pen = state.outline === null ? 'none' : `#${state.outline.toString(16).padStart(6, '0')}`;
  console.log(`  ok   ${id.padEnd(10)} page #${state.page.toString(16).padStart(6, '0')}`
    + `  land #${state.land.toString(16).padStart(6, '0')}  pen ${pen}  w${state.weight}`);
}

// --- side-by-side: the thing the viewer exists for -------------------------
await page.evaluate(() => window.__themelab.setTheme('abyssal', 0));
for (const id of ['parchment', 'playroom', 'blueprint']) {
  await page.evaluate((i) => window.__themelab.addGlobe(i), id);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(900);

const n = await page.evaluate(() => window.__themelab.globeCount());
if (n !== 4) { console.error(`  FAIL expected 4 globes, got ${n}`); failures++; }

const states = await page.evaluate(
  () => [0, 1, 2, 3].map((i) => window.__themelab.instanceState(i)),
);
const pages = new Set(states.map((s) => s.page));
if (pages.size !== 4) {
  console.error(`  FAIL the four tiles share page colours (${pages.size} distinct) -- `
    + 'the per-instance scissored clear is not working');
  failures++;
} else {
  console.log(`  ok   4 tiles, 4 distinct page colours: `
    + states.map((s) => s.themeId).join(', '));
}

await page.screenshot({ path: `${OUT}/side-by-side.png` });

if (errors.length) {
  console.error(`\npage errors:\n  ${errors.join('\n  ')}`);
  failures++;
}

await browser.close();
if (failures) { console.error(`\n${failures} failure(s).\n`); process.exit(1); }
console.log(`\nwrote ${ids.length + 1} shots to ${OUT}/\n`);
