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

/** Fraction of the ink canvas that is not fully transparent, how much of that is
 *  the orange wash specifically, and the painted bounding box -- the things that
 *  go silently wrong when a clip path is. */
async function inkStats() {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.oldmap-ink');
    if (!c) return null;
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let painted = 0, warm = 0, total = 0;
    let minx = 1e9, maxx = -1;
    for (let y = 0; y < c.height; y += 4) {
      for (let x = 0; x < c.width; x += 4) {
        total++;
        const i = (y * c.width + x) * 4;
        if (data[i + 3] > 8) {
          painted++;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          // The wash ramps toward (206,120,44); ink and rings are grey-brown and
          // much darker, so "clearly redder than it is blue" isolates it.
          if (data[i] > 150 && data[i] - data[i + 2] > 45) warm++;
        }
      }
    }
    return { painted: painted / total, warm: warm / total, minx, maxx, w: c.width };
  });
}

/**
 * Read inkStats only once two consecutive reads agree.
 *
 * A fixed delay is not enough and quietly corrupted this check: switching
 * Projection rebuilds the camera and OrbitControls damps into place over several
 * frames, so a read too soon returns the PREVIOUS projection's ink. That is how
 * Robinson and Plate Carree came to report byte-identical coverage while their
 * screenshots plainly differed.
 */
async function stableInkStats(label) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const s = await inkStats();
    if (prev && s && Math.abs(s.painted - prev.painted) < 1e-6
      && s.minx === prev.minx && s.maxx === prev.maxx) return s;
    prev = s;
    await page.waitForTimeout(250);
  }
  fail(`${label}: ink never settled`);
  return prev;
}

for (const projection of ['globe', 'robinson', 'plateCarree']) {
  await page.evaluate((p) => window.__oldmap.setProjection(p), projection);
  await page.evaluate(() => window.__oldmap.setAge(100));
  const s = await stableInkStats(projection);
  const stats = await page.evaluate(() => window.__oldmap.stats());
  if (!s) { fail(`${projection}: no ink canvas`); continue; }
  console.log(`${projection.padEnd(12)} active=${String(stats.projection).padEnd(12)} `
    + `painted=${(100 * s.painted).toFixed(2)}%  `
    + `wash=${(100 * s.warm).toFixed(2)}%  x=${s.minx}..${s.maxx}  `
    + `mountains=${stats.mountains}`);
  if (stats.projection !== projection) fail(`asked for ${projection}, got ${stats.projection}`);

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
const withWash = await stableInkStats('wash on');
await page.evaluate(() => window.__oldmap.setLayer('showWash', false));
const withoutWash = await stableInkStats('wash off');
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

// Mountains must stand on land. Prep guarantees it at the age the rule last
// held, but a glyph persists for up to `decay` Myr afterwards and can be carried
// offshore in that time, so the viewer re-tests against its own land raster.
// Sampled from the ink canvas: a glyph centre over ocean would sit on a ring or
// on bare paper rather than on the wash/land side of the coastline.
await page.evaluate((p) => window.__oldmap.setProjection(p), 'plateCarree');
await page.evaluate(() => window.__oldmap.setAge(100));
await stableInkStats('land cull');
const audit = await page.evaluate(() => window.__oldmap.mountainAudit());
console.log(`land cull      ${audit.drawn} drawn, ${audit.culled} culled `
  + `of ${audit.visible} on screen`);
if (audit.drawn < 50) fail(`only ${audit.drawn} glyphs survived the land test`);

// The subduction debug layer must actually load and draw when asked.
await page.evaluate(() => window.__oldmap.setLayer('showTrenches', true));
await page.waitForTimeout(4000);
const trench = await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => !x.className && x.width > 0);
  return window.__oldmap.stats().trenches;
});
console.log(`trench layer   visible=${trench}`);
if (!trench) fail('the subduction debug layer did not switch on');
await page.screenshot({ path: `${SHOTS}/trenches.png` });
await page.evaluate(() => window.__oldmap.setLayer('showTrenches', false));

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
