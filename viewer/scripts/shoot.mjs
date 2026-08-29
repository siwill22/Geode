/**
 * Drive the viewer headlessly and capture screenshots.
 *
 * Used to check the acceptance criteria that are only checkable by eye:
 * fixture orientation, the floor of a partial cut, antimeridian and pole
 * polygons, and the grey band on a model that does not reach the surface.
 *
 *   node scripts/shoot.mjs <outdir>
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots';
const URL = 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load' });

// Wait for the app to finish its initial loads.
await page.waitForFunction(() => window.__geode?.ready === true, { timeout: 120000 });

async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

async function apply(fn, arg) {
  await page.evaluate(([f, a]) => window.__geode[f](a), [fn, arg]);
  await page.waitForTimeout(400);
}

console.log('capturing:');

// 1. Globe at present day, topography surface.
await apply('setAge', 0);
await apply('setCamera', { lon: -60, lat: 20, dist: 3.0 });
await shot('01-globe-topography');

// 1b. Flat surface, to check the shading reads as a sphere on its own.
await apply('setSurfaceMode', 'flat');
await shot('01b-globe-flat-shaded');
await apply('setSurfaceMode', 'topography');

// 2. Reconstruction: coastlines at 120 Ma must differ and lose young features.
// Also checks that topography auto-switches to the reconstructable land fill.
await apply('setAge', 120);
await shot('02-globe-120Ma-landfill');
await apply('setAge', 0);
await apply('setSurfaceMode', 'topography');

// 3. A full-depth cutaway over the Pacific -- the LLSVP should be visible.
await apply('setPolygon', {
  verts: [[-140, 40], [-90, 10], [-120, -40], [-180, -20], [-175, 25]],
  depthKm: 2890,
});
await apply('setCamera', { lon: -140, lat: 35, dist: 2.8 });
await shot('03-cut-pacific-full');

// 4. A partial cut: the floor must be present, not a hole.
await apply('setCutDepth', 1000);
await shot('04-cut-1000km-floor');
await apply('setCutDepth', 2890);

// 5. Antimeridian-spanning polygon.
await apply('setPolygon', {
  verts: [[160, 30], [-160, 30], [-160, -30], [160, -30]],
  depthKm: 2890,
});
await apply('setCamera', { lon: 180, lat: 20, dist: 2.8 });
await shot('05-antimeridian');

// 6. Polygon enclosing the North Pole.
await apply('setPolygon', {
  verts: [[0, 60], [90, 60], [180, 60], [-90, 60]],
  depthKm: 2890,
});
await apply('setCamera', { lon: 0, lat: 75, dist: 3.0 });
await shot('06-north-pole');
await apply('setCamera', { lon: -150, lat: 15, dist: 3.0 });

// 7. Checkerboard fixture: cells and sign flips at 660 / 1800 km.
await apply('setPolygon', {
  verts: [[-150, 45], [-60, 45], [-60, -45], [-150, -45]],
  depthKm: 2890,
});
await apply('setCamera', { lon: -105, lat: 30, dist: 2.6 });
await apply('setModel', 'fixture-check');
await shot('07-fixture-checkerboard');

// 8. Depth ramp fixture: isolates the depth axis.
await apply('setModel', 'fixture-ramp');
await shot('08-fixture-ramp');

// 9. SEMUCB: grey band where the model does not reach the surface.
// Its valid range starts at 48 km, which is only ~1.7% of the mantle -- a few
// pixels on a full-depth cut. Use a shallow cut so the band is measurable.
await apply('setModel', 'semucb');
await apply('setCutDepth', 250);
await apply('setCamera', { lon: -105, lat: 30, dist: 2.35 });
await shot('09-semucb-grey-band');

const band = await page.evaluate(() => window.__geode.probeNoData());
console.log('  no-data probe:', JSON.stringify(band));

await apply('setCutDepth', 2890);
await apply('setCamera', { lon: -105, lat: 30, dist: 2.6 });

// 10. REVEAL Vp, same geometry -- variable swap leaves the cut untouched.
await apply('setModel', 'reveal');
await apply('setVariable', 'vp');
await shot('10-reveal-vp');
await apply('setVariable', 'vs');
await shot('11-reveal-vs');

const stats = await page.evaluate(() => window.__geode.stats());
console.log('\nstats:', JSON.stringify(stats, null, 2));
if (errors.length) {
  console.log('\nconsole errors:');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}
await browser.close();
