/*
 * Drives the real oldmap.html in a browser and checks that it actually DRAWS --
 * a build passing says nothing about whether any ink reached the canvas.
 *
 * The specific failure this is written against: the wash and the rings are
 * clipped to the land path and its complement, so if PolygonLayer hands back a
 * malformed ring (no `axis` under a perspective camera, no `mapHalfWidth` on a
 * flat projector) the clip is wrong and the ink lands in the wrong place or
 * nowhere at all -- while every console log stays clean.
 *
 * Run: npm run check:oldmap   (needs the dev server on :5173)
 */
import { chromium } from 'playwright';

const URL_BASE = process.env.OLDMAP_URL ?? 'http://localhost:5173/oldmap.html';
const SHOTS = new URL('../shots-oldmap/', import.meta.url).pathname;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__oldmap?.ready === true, { timeout: 60000 });
await page.waitForTimeout(1200);

let bad = 0;
const fail = (msg) => { bad++; console.log(`  FAIL ${msg}`); };

/** Fraction of the ink canvas that is not fully transparent, and how much of
 *  that is the orange wash specifically -- the two things that go silently to
 *  zero when a clip path is wrong. */
async function inkStats() {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.oldmap-ink');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let painted = 0, warm = 0, total = 0;
    // Every 4th pixel in each direction: 16x fewer samples, same ratios.
    for (let i = 0; i < data.length; i += 16 * 4) {
      total++;
      const a = data[i + 3];
      if (a > 8) {
        painted++;
        // The wash ramps toward (206,120,44); ink and rings are grey-brown and
        // much darker, so "clearly redder than it is blue" isolates it.
        if (data[i] > 150 && data[i] - data[i + 2] > 45) warm++;
      }
    }
    return { painted: painted / total, warm: warm / total, w: c.width, h: c.height };
  });
}

for (const projection of ['globe', 'robinson', 'plateCarree']) {
  await page.evaluate((p) => window.__oldmap.setProjection(p), projection);
  await page.evaluate(() => window.__oldmap.setAge(100));
  await page.waitForTimeout(900);

  const s = await inkStats();
  const stats = await page.evaluate(() => window.__oldmap.stats());
  if (!s) { fail(`${projection}: no ink canvas`); continue; }
  console.log(`${projection.padEnd(12)} painted=${(100 * s.painted).toFixed(1)}%  `
    + `wash=${(100 * s.warm).toFixed(1)}%  mountains=${stats.mountains}`);

  // Something, but not everything: a wash that escaped its clip floods the page.
  if (s.painted < 0.01) fail(`${projection}: ink canvas is essentially blank`);
  if (s.painted > 0.92) fail(`${projection}: ink covers the whole canvas -- clip escaped`);
  if (s.warm < 0.002) fail(`${projection}: no coastal wash drawn`);
  if (stats.mountains < 50) fail(`${projection}: only ${stats.mountains} mountain glyphs at 100 Ma`);

  await page.screenshot({ path: `${SHOTS}/${projection}.png` });
}

// The wash must respond to its own toggle -- proof the warm pixels above are
// the wash and not something else that happens to be orange.
await page.evaluate((p) => window.__oldmap.setProjection(p), 'robinson');
await page.waitForTimeout(600);
const withWash = await inkStats();
await page.evaluate(() => window.__oldmap.setLayer('showWash', false));
await page.waitForTimeout(600);
const withoutWash = await inkStats();
console.log(`wash toggle   on=${(100 * withWash.warm).toFixed(1)}%  `
  + `off=${(100 * withoutWash.warm).toFixed(1)}%`);
if (!(withoutWash.warm < withWash.warm * 0.25)) {
  fail('turning the wash off barely changed the warm pixels -- they are not the wash');
}
await page.evaluate(() => window.__oldmap.setLayer('showWash', true));

// Scrubbing must change the map. A frame index that silently missed would leave
// the glyph count pinned.
const counts = [];
for (const age of [0, 50, 100, 150, 200]) {
  await page.evaluate((a) => window.__oldmap.setAge(a), age);
  await page.waitForTimeout(250);
  counts.push((await page.evaluate(() => window.__oldmap.stats())).mountains);
}
console.log(`glyphs by age  0/50/100/150/200 Ma = ${counts.join(' / ')}`);
if (new Set(counts).size < 3) fail(`glyph count barely varies with age: ${counts.join(',')}`);
if (counts.some((c) => c === 0)) fail('an age produced no glyphs at all');

await page.screenshot({ path: `${SHOTS}/scrub-200.png` });

const real = errors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
if (real.length) {
  bad++;
  console.log(`\n${real.length} console error(s):`);
  real.slice(0, 5).forEach((e) => console.log(`  ${e.slice(0, 200)}`));
}

console.log(bad === 0 ? '\nOK -- the old map draws in all three projections'
  : `\n${bad} CHECK(S) FAILED`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
