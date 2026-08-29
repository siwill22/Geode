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

// --- time-dependent checks --------------------------------------------------

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? 'ok ' : 'FAIL'}] ${name}  ${detail}`);
}

console.log('\ntime axis:');

// 12. The drift fixture pins down which FRAME is bound, not which we meant to
// bind. Its blob sits at lon = age x 0.5, so reading the volume at two ages
// catches an off-by-one frame index or a reversed series -- neither of which is
// visible in a render of real convection output.
await apply('setModel', 'fixture-drift');
for (const [age, onLon, offLon] of [[0, 0, 100], [200, 100, 0]]) {
  await apply('setAge', age);
  const on = await page.evaluate(
    ([lon]) => window.__geode.probeVolume(lon, 0, 1000), [onLon]);
  const off = await page.evaluate(
    ([lon]) => window.__geode.probeVolume(lon, 0, 1000), [offLon]);
  check(`drift blob at ${age} Ma is at lon ${onLon}`,
    on.value > 1.5 && off.value < 0.5,
    `lon ${onLon} -> ${on.value.toFixed(2)}, lon ${offLon} -> ${off.value.toFixed(2)}`);
}

// 13. The convection model itself.
await apply('setAge', 0);
await apply('setModel', 'opt1');
await apply('setPolygon', {
  verts: [[-140, 40], [-90, 10], [-120, -40], [-180, -20], [-175, 25]],
  depthKm: 2890,
});
await apply('setCamera', { lon: -140, lat: 35, dist: 2.8 });
await shot('12-opt1-0Ma-pacific');
await apply('setAge', 100);
await shot('13-opt1-100Ma-pacific');

// Polarity, from the data rather than by eye: the deep Pacific is the LLSVP and
// must be HOT. If the ramp were inverted the render would still look plausible.
const llsvp = await page.evaluate(() => window.__geode.probeVolume(-160, -10, 2600));
check('Pacific LLSVP is hot at 2600 km', llsvp.value > 0,
  `${llsvp.value.toFixed(0)} ${llsvp.units}`);

// The point of putting the two datasets together: the mantle under a trench
// should be COLD. This locates itself from the boundary file rather than from a
// present-day guess -- at 100 Ma the trenches are not where they are today, and
// a hardcoded lon/lat tests the tester, not the data. It is also the one check
// that would catch the surface and the volume being in different reference
// frames, which is invisible in either layer alone.
const bframe = await (await fetch(
  'http://localhost:5173/archive/boundaries/frames/boundaries_100Ma.geojson')).json();
const trench = [];
for (const f of bframe.features) {
  if (f.properties.boundary_type !== 'subduction') continue;
  for (let i = 0; i < f.geometry.coordinates.length; i += 4) {
    trench.push(f.geometry.coordinates[i]);
  }
}
const slab = await page.evaluate(([pts, depth]) => {
  const P = (lon, lat) => window.__geode.probeVolume(lon, lat, depth).value;
  let s = 0;
  for (const [lon, lat] of pts) s += P(lon, lat);
  let g = 0, n = 0;
  for (let lon = -180; lon < 180; lon += 4) {
    for (let lat = -80; lat <= 80; lat += 4) { g += P(lon, lat); n++; }
  }
  return { trench: s / pts.length, global: g / n, n: pts.length };
}, [trench, 300]);
check('mantle under 100 Ma trenches is cold',
  slab.trench < 0 && slab.trench < slab.global - 20,
  `${slab.n} trench points: ${slab.trench.toFixed(0)} K vs `
  + `${slab.global.toFixed(0)} K global, at 300 km`);

// 14. Boundaries: nothing may be drawn outside the sphere's silhouette. The
// library's reference projector is orthographic (horizon at dot = 0); under
// perspective it is at R/d, and using the orthographic test would smear a band
// of the far side over the limb.
await apply('setAge', 0);
await apply('setCamera', { lon: -60, lat: 20, dist: 3.0 });
await shot('14-boundaries-0Ma');
await apply('setAge', 100);
await shot('15-boundaries-100Ma');

const hz = await page.evaluate(() => window.__geode.probeHorizon());
check('projector uses the perspective horizon',
  hz.inside && !hz.outside && !hz.beyond,
  `d=${hz.cameraDistance.toFixed(2)}, horizon ${hz.horizonDeg.toFixed(1)} deg; `
  + `inside=${hz.inside} outside=${hz.outside} beyond=${hz.beyond}`);

const bnd = await page.evaluate(() => window.__geode.probeBoundaries());
check('boundary frame tracks the age', bnd.frameTime === 100,
  `age ${bnd.age} -> frame ${bnd.frameTime} Ma, volume frame `
  + `${bnd.volumeFrame?.age_ma} Ma`);

// 15. Boundaries must be culled where the cutaway removed the ground under them.
await apply('setPolygon', {
  verts: [[-140, 40], [-90, 10], [-120, -40], [-180, -20], [-175, 25]],
  depthKm: 2890,
});
await apply('setCamera', { lon: -140, lat: 20, dist: 2.8 });
await shot('16-boundaries-over-cutaway');

const stats = await page.evaluate(() => window.__geode.stats());
console.log('\nstats:', JSON.stringify(stats, null, 2));
if (errors.length) {
  console.log('\nconsole errors:');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
