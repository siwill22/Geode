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
// The deployed (but not the dev) archive gzips this frame -- see
// prep/pack_deploy.mjs -- so try the plain path first and fall back to
// `.gz`, decompressing the same way core/volume.ts's fetchVolumeBytes does,
// rather than hardcoding which one this run's archive happens to have.
async function fetchMaybeGzippedJSON(url) {
  let res = await fetch(url);
  // A missing static file 404s against a static host, but Vite's dev server
  // falls back to serving index.html (200, text/html) for anything it
  // doesn't recognise -- so "not ok" alone isn't enough to detect a miss.
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('html')) {
    res = await fetch(`${url}.gz`);
  }
  if (!res.ok) throw new Error(`${url}(.gz): ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const gzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!gzipped) return JSON.parse(new TextDecoder().decode(raw));
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

const bframe = await fetchMaybeGzippedJSON(
  'http://localhost:5173/archive/boundaries/frames/boundaries_100Ma.geojson');
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

// --- isosurfaces ------------------------------------------------------------

console.log('\nisosurfaces:');

/** Same as apply(), without the settle delay -- for tight probe loops. */
async function call(fn, arg) {
  return page.evaluate(([f, a]) => window.__geode[f](a), [fn, arg]);
}

/** Same as call(), for hooks that take more than one positional argument. */
async function callArgs(fn, args) {
  return page.evaluate(([f, a]) => window.__geode[f](...a), [fn, args]);
}

// 17. Where is the isosurface, really?
//
// fixture-ramp is linear in depth from -1 at 0 km to +1 at 2840 km, so an
// isosurface at V is exactly a sphere at depth (V+1)/2 x 2840. Measuring that
// sphere on screen is not accurate enough to be worth much: at a normal camera
// distance one pixel of silhouette radius is ~17 km of depth, and half a depth
// texel -- the error a second, subtly different sampling convention would
// produce -- is only ~7 km.
//
// So locate it against the cutaway floor instead. The floor cap is a sphere at
// depthToRadius(cutDepthKm), and bisecting the cut depth for the moment the
// isosurface stops poking through it is limited by the bisection, not by the
// screen. It also couples the two samplers: the floor reads the volume through
// the same volumeUVW the isosurface marches.
await apply('setModel', 'fixture-ramp');
await apply('setPolygon', {
  verts: [[-40, 40], [40, 40], [40, -40], [-40, -40]], depthKm: 1600,
});
await apply('setCamera', { lon: 0, lat: 0, dist: 2.6 });

async function flipDepthKm(V) {
  await call('setIsosurface', {
    coldEnabled: true, hotEnabled: false, coldValue: V,
    depthMinKm: 0, depthMaxKm: 2840, steps: 96,
  });
  let lo = 100;    // floor shallow -> floor hides the isosurface
  let hi = 2800;   // floor deep    -> isosurface pokes through
  for (let i = 0; i < 12; i++) {
    const mid = 0.5 * (lo + hi);
    await call('setCutDepth', mid);
    const r = await call('probeIsoAboveFloor');
    if (r.chromatic > r.boxPixels / 2) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

const isoV = [-0.5, 0, 0.5];
const isoD = [];
for (const V of isoV) isoD.push(await flipDepthKm(V));

// Fit depth = slope * pDep + intercept, with pDep = (V+1)/2. Splitting the two
// matters: a half- or whole-texel sampling error moves the INTERCEPT by 7.4 or
// 14.9 km and leaves the slope alone. The slope carries a small excess of its
// own -- the software rasteriser's linear filtering of the uint8 volume is good
// to roughly half a code, which is ~5 km of depth at the deep end -- so it gets
// the loose bound and the intercept gets the tight one.
const isoSlope = (isoD[2] - isoD[0]) / 0.5;
const isoIntercept = isoD[0] - 0.25 * isoSlope;
console.log('  ramp flip depths: '
  + isoV.map((v, i) => `V=${v} -> ${isoD[i].toFixed(2)} km`).join(', '));
check('isosurface depth mapping has no texel offset',
  Math.abs(isoIntercept) < 3,
  `intercept ${isoIntercept.toFixed(2)} km (half a texel is 7.4 km)`);
check('isosurface depth mapping is to scale',
  Math.abs(isoSlope / 2840 - 1) < 0.01,
  `slope ${isoSlope.toFixed(1)} km vs 2840`);

// 18. The isosurface must sort against the rest of the scene by the depth of
// its HIT, not of its proxy sphere. Both directions, because only writing
// gl_FragDepth at all gets one of them right by accident.
await call('setIsosurface', {
  coldEnabled: true, hotEnabled: false, coldValue: 0,
  depthMinKm: 0, depthMaxKm: 2840, steps: 96,
});
await apply('setCutDepth', 500);
const above = await call('probeScreen');
await apply('setCutDepth', 2890);
const below = await call('probeScreen');
const isBlue = (p) => p.rgb[2] - p.rgb[0] > 30;
check('isosurface sorts by its hit depth, not its proxy',
  !isBlue(above) && isBlue(below),
  `floor at 500 km -> ${above.rgb}, floor at 2832 km -> ${below.rgb}`);

// 19. Two surfaces at once, on a field that is symmetric by construction: the
// checkerboard is +-2 everywhere, so isosurfaces at -1 and +1 must both appear
// and in comparable amounts. A single shared or mirrored isovalue shows up here
// as one colour missing.
await apply('setModel', 'fixture-check');
await apply('setPolygon', { verts: [[-40, 40], [40, 40], [40, -40], [-40, -40]], depthKm: 2890 });
await apply('setCamera', { lon: 0, lat: 20, dist: 3.2 });
await apply('setSurfaceOpacity', 0.12);
await call('setIsosurface', {
  coldEnabled: true, hotEnabled: true, coldValue: -1, hotValue: 1,
  depthMinKm: 200, depthMaxKm: 2800, steps: 96,
});
await shot('17-isosurface-checkerboard');
const chk = await call('probeSilhouette');
check('both isosurfaces drawn, independently',
  chk.coldPixels > 1000 && chk.hotPixels > 1000
  && Math.max(chk.coldPixels, chk.hotPixels)
     / Math.min(chk.coldPixels, chk.hotPixels) < 2.5,
  `cold ${chk.coldPixels} px, hot ${chk.hotPixels} px`);

// 19b. The isosurface must be lit BY the key light, not against it.
//
// fixture-ramp rises with depth, so its gradient points radially inward and the
// cold region is everything ABOVE the isosurface -- the camera ray enters the
// shell already inside it, and the sphere we see is the far wall of that
// region, with its outward normal pointing away from us at every pixel. That
// makes it the purest possible case of the shading the fix addresses: without
// flipping the normal toward the viewer, ndl inverts and the lit half of the
// disc renders DARKER than the unlit half (and rim pins to 1.0 everywhere,
// which is the uniform interior glow the whole thing was reported as).
//
// The cutaway, the surface sphere and the boundaries all have to go: this shot
// is read by eye, and with them left on the frame is mostly cut wall -- the
// RdBu midpoint on the wall is a white band that looks exactly like the rim
// artefact being tested for. probeSilhouette hides them for the measurement
// either way, so this is purely so the picture shows the thing it checks.
await apply('setModel', 'fixture-ramp');
await apply('clearPolygon');
await apply('setSurfaceMode', 'none');
await apply('setBoundaries', false);
await apply('setCamera', { lon: 0, lat: 0, dist: 2.6 });
await call('setIsosurface', {
  coldEnabled: true, hotEnabled: false, coldValue: 0,
  depthMinKm: 0, depthMaxKm: 2840, steps: 96,
});
await shot('17b-isosurface-lighting');
const lit = await call('probeSilhouette');
check('isosurface is lit from the key light, not against it',
  lit.litMean > lit.unlitMean * 1.15,
  `lit ${lit.litMean.toFixed(1)} vs unlit ${lit.unlitMean.toFixed(1)}`);
// Put the scene back the way 19 left it, or the figure at 21 loses its globe.
await apply('setSurfaceMode', 'topography');
await apply('setBoundaries', true);

// 20. The isosurface has to follow the time axis, not just the age label. The
// drift blob sits at lon = age x 0.5, so with the camera between 0 and 100 E
// its silhouette must cross the centre of the frame as the age is scrubbed. A
// material left pointing at the previous frame's texture does not move.
await apply('setModel', 'fixture-drift');
await apply('setCamera', { lon: 50, lat: 0, dist: 3.0 });
await call('setIsosurface', {
  coldEnabled: false, hotEnabled: true, hotValue: 1,
  depthMinKm: 200, depthMaxKm: 2800, steps: 96,
});
const driftX = [];
for (const age of [0, 200]) {
  await apply('setAge', age);
  driftX.push(await call('probeSilhouette'));
}
check('isosurface tracks the loaded frame',
  driftX[0].pixels > 500 && driftX[1].pixels > 500
  && driftX[0].centroidOffsetX * driftX[1].centroidOffsetX < 0,
  `0 Ma centroid ${driftX[0].centroidOffsetX?.toFixed(0)} px, `
  + `200 Ma ${driftX[1].centroidOffsetX?.toFixed(0)} px`);

// 21. The figure the feature exists for: slabs and plumes in the convection
// model, seen through a globe made transparent.
await apply('setAge', 0);
await apply('setModel', 'opt1');
await apply('setSurfaceOpacity', 0.1);
await apply('setCamera', { lon: -60, lat: 20, dist: 3.0 });
await call('setIsosurface', {
  coldEnabled: true, hotEnabled: true, coldValue: -250, hotValue: 250,
  depthMinKm: 200, depthMaxKm: 2800, steps: 128,
});
await shot('18-opt1-isosurfaces-0Ma');
await apply('setAge', 120);
await shot('19-opt1-isosurfaces-120Ma');
await apply('setSurfaceOpacity', 1);

// 22. The polygon overlay must be hidden by the globe.
//
// It sits at R_SURFACE * 1.002 to avoid z-fighting, and the globe surface is a
// transparent material, so three.js draws the surface in a LATER pass than the
// opaque overlay and the depth buffer never hides it -- the polygon showed
// straight through the planet. It is culled against the perspective horizon
// instead.
//
// Three orientations, because "far side draws nothing" alone is also satisfied
// by culling everything, and by the wrong horizon. dot > 0 is the ORTHOGRAPHIC
// limit; under perspective the visible cap ends at R/d, which at d = 3 is 70
// degrees rather than 90. Only the graded near/limb/far result separates the
// correct test from both failure modes.
console.log('\npolygon overlay occlusion:');
await call('setPolygon', {
  verts: [[-25, 25], [25, 25], [25, -25], [-25, -25]], depthKm: 1500,
});

async function overlayPixels() {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const g = document.createElement('canvas');
    g.width = c.width; g.height = c.height;
    const ctx = g.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let outline = 0, handles = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], bb = d[i + 2];
      if (r > 200 && gg > 150 && gg < 225 && bb < 110) outline++;   // 0xffcc33
      if (r > 245 && gg > 245 && bb > 245) handles++;               // 0xffffff
    }
    return { outline, handles };
  });
}

const seen = {};
for (const [where, lon] of [['near', 0], ['limb', 90], ['far', 180]]) {
  await apply('setCamera', { lon, lat: 0, dist: 3.0 });
  seen[where] = await overlayPixels();
}
check('polygon overlay is drawn when it faces the camera',
  seen.near.outline > 200 && seen.near.handles > 200,
  `near ${seen.near.outline} outline, ${seen.near.handles} handle px`);
check('polygon overlay is hidden behind the globe',
  seen.far.outline === 0 && seen.far.handles === 0,
  `far ${seen.far.outline} outline, ${seen.far.handles} handle px`);
check('polygon overlay is clipped at the perspective horizon, not at 90 deg',
  seen.limb.outline > 0 && seen.limb.outline < seen.near.outline * 0.5,
  `limb ${seen.limb.outline} vs near ${seen.near.outline} outline px`);

// --- depth slice --------------------------------------------------------

console.log('\ndepth slice:');

function colourClose(a, b, tol = 3) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

// Clear whatever the isosurface/polygon-overlay sections above left active,
// so the depth slice is being read against a known-quiet scene.
await call('setIsosurface', { coldEnabled: false, hotEnabled: false });
await call('clearPolygon');
await apply('setSurfaceMode', 'none');

// 23. fixture-ramp is a pure function of depth, so a slice must render as
// ONE uniform colour across the whole globe -- and a different colour at a
// different depth, so the check cannot pass by rendering nothing at all.
await apply('setModel', 'fixture-ramp');
await apply('setCamera', { lon: 0, lat: 0, dist: 2.6 });
async function sliceColourAt(depthKm) {
  await callArgs('setDepthSlice', [{ enabled: true, sinkingEnabled: false, depthKm }]);
  const pts = [[0, 0], [0.4, 0.2], [-0.4, 0.2], [0.2, -0.4], [-0.2, -0.4]];
  const rgbs = [];
  for (const [nx, ny] of pts) rgbs.push((await call('probeScreen', { nx, ny })).rgb);
  return rgbs;
}
const shallow = await sliceColourAt(100);
const deep = await sliceColourAt(2700);
const uniform = (rgbs) => rgbs.every((c) => colourClose(c, rgbs[0]));
check('depth slice is one uniform colour across the whole globe',
  uniform(shallow) && uniform(deep),
  `100 km: ${JSON.stringify(shallow)}; 2700 km: ${JSON.stringify(deep)}`);
check('depth slice colour actually depends on depth',
  !colourClose(shallow[0], deep[0], 10),
  `100 km ${shallow[0]} vs 2700 km ${deep[0]}`);
await shot('20-depth-slice-fixture-ramp');

// 24. fixture-check's 30 deg cells catch a lon/lat axis swap that a real
// dataset would hide. Ground truth is probeVolume, which decodes the raw
// texture directly; the render is read back through the shader's own debug
// mode 3 (raw encoded sample, greyscale) rather than through a guessed
// colormap-to-RGB heuristic, so the comparison is exact rather than by eye.
// Probe points sit at the MIDPOINT of each 30 deg cell (offset 15 deg),
// never on a cell boundary, where the checkerboard's sign is genuinely zero
// and the render's bilinear filtering makes the sign ambiguous by design.
await apply('setModel', 'fixture-check');
await callArgs('setDepthSlice', [{ enabled: true, sinkingEnabled: false, depthKm: 300 }]);
await call('setDebug', 3);
let mismatches = 0;
let checked = 0;
for (const lon of [-165, -105, -45, 15, 75, 135]) {
  for (const lat of [-75, -45, -15, 15, 45, 75]) {
    await apply('setCamera', { lon, lat, dist: 2.6 });
    const truth = await callArgs('probeVolume', [lon, lat, 300]);
    const rendered = await call('probeScreen', { nx: 0, ny: 0 });
    // uDebug=3 outputs the raw encoded sample (code/255) as vec3(d); decode
    // it the same way probeVolume decodes the texture byte it read.
    const renderedValue = rendered.rgb[0] / 255;
    const truthEncoded = truth.code / 255;
    checked++;
    if (Math.abs(renderedValue - truthEncoded) > 2 / 255) mismatches++;
  }
}
await call('setDebug', 0);
check('depth slice has no lon/lat axis swap (30 deg cells)', mismatches === 0,
  `${mismatches} of ${checked} cell centres disagreed with the raw texture`);

// 25. Agreement with the cutaway wall/floor at the same depth: both derive
// depth from the SAME shader formula (the floor from world position, the
// slice from uSliceDepthKm), so probing them separately at the same depth
// must give the same colour -- direct proof the shared material path
// actually took effect, not a copy that happens to look right.
await apply('setModel', 'fixture-ramp');
await callArgs('setDepthSlice', [{ enabled: false }]);
await apply('setPolygon', {
  verts: [[-40, 40], [40, 40], [40, -40], [-40, -40]], depthKm: 1400,
});
await apply('setCamera', { lon: 0, lat: 0, dist: 2.6 });
const floorRGB = (await call('probeScreen', { nx: 0, ny: 0 })).rgb;
await callArgs('setDepthSlice', [{ enabled: true, sinkingEnabled: false, depthKm: 1400 }]);
const sliceRGB = (await call('probeScreen', { nx: 0, ny: 0 })).rgb;
check('depth slice agrees with the cutaway floor at the same depth',
  colourClose(floorRGB, sliceRGB),
  `floor ${floorRGB} vs slice ${sliceRGB} at 1400 km`);
await callArgs('setDepthSlice', [{ enabled: false }]);
await call('clearPolygon');

// 26. Sinking-rate arithmetic is pure, so it gets plain assertions rather
// than a screenshot: single-rate reduces to rate x age x 10, and the
// two-segment model breaks cleanly at 660 km.
const singleRate = await callArgs('sinkingDepthKm', [50, 1.2, 1.2]);
check('sinking depth: single rate reduces to rate x age x 10',
  Math.abs(singleRate - 600) < 1e-6,
  `50 Ma at 1.2 cm/yr -> ${singleRate} km, expected 600 km`);

const ageAtBreak = 660 / (1.2 * 10); // 55 Ma
const expectedTwoSeg = 660 + 2.0 * 10 * (100 - ageAtBreak);
const twoSeg = await callArgs('sinkingDepthKm', [100, 1.2, 2.0]);
check('sinking depth: two-segment model breaks at 660 km',
  Math.abs(twoSeg - expectedTwoSeg) < 1e-6,
  `100 Ma, upper 1.2 / lower 2.0 cm/yr -> ${twoSeg.toFixed(1)} km, `
  + `expected ${expectedTwoSeg.toFixed(1)} km`);

// 27. The tomography/convection guard must be rejected, not silently
// ignored -- checked through the real state-mutation path, not a UI-only
// disabled control that the underlying state could still be poked around.
await apply('setModel', 'opt1'); // type: convection
const rejected = await callArgs('setDepthSlice', [{ enabled: true, sinkingEnabled: true }]);
check('sinking mode is rejected on a convection model',
  rejected.sinkingEnabled === false,
  `opt1 (convection): sinkingEnabled after request = ${rejected.sinkingEnabled}`);

await apply('setModel', 'fixture-ramp'); // type: tomography
const accepted = await callArgs('setDepthSlice', [{ enabled: true, sinkingEnabled: true, depthKm: 660 }]);
check('sinking mode is accepted on a tomography model',
  accepted.sinkingEnabled === true,
  `fixture-ramp (tomography): sinkingEnabled after request = ${accepted.sinkingEnabled}`);

// 28. The readout line states the mantle is present-day under sinking mode,
// so a locked slice can never be misread as a real snapshot at that age.
await apply('setAge', 120);
const info = await page.evaluate(() => document.querySelector('.timeinfo')?.textContent ?? '');
check('readout states the mantle is present-day under sinking mode',
  info.includes('slice') && info.includes('cm/yr') && info.includes('mantle present-day'),
  info);
await shot('21-depth-slice-sinking-readout');

// Leave the scene clean for anything appended after this.
await callArgs('setDepthSlice', [{ enabled: false, sinkingEnabled: false }]);
await apply('setSurfaceMode', 'topography');
await apply('setAge', 0);

// --- multi-globe sync --------------------------------------------------
//
// Age and depth-slice are broadcast, not shared state: a real edit on one
// instance pushes the new value into every OTHER instance's own state. This
// needs a genuine second globe, unlike every check above (which deliberately
// only ever targets primary() -- see the comment on window.__geode in
// main.ts), so it gets its own generalized *On(index, ...) hooks.

console.log('\nmulti-globe sync:');

await apply('addGlobe');

// 29. Off by default: an edit on globe 1 must not reach globe 2.
await callArgs('setAgeOn', [0, 40]);
let g2 = await call('instanceState', 1);
check('age sync off: globe 2 unaffected by a globe 1 edit',
  g2.age === 0,
  `globe 1 -> 40 Ma, globe 2 age = ${g2.age} Ma`);

// 30. Turning sync on snaps every OTHER globe to the focused one immediately
// -- no additional edit should be needed to bring them into agreement.
await call('setSyncAge', true);
g2 = await call('instanceState', 1);
check('age sync on: globe 2 snaps to globe 1 immediately',
  g2.age === 40,
  `globe 1 = 40 Ma, globe 2 snapped to ${g2.age} Ma`);

// 31. Live propagation while sync stays on.
await callArgs('setAgeOn', [0, 90]);
g2 = await call('instanceState', 1);
check('age sync on: a live edit propagates',
  g2.age === 90,
  `globe 1 -> 90 Ma, globe 2 = ${g2.age} Ma`);

// 32. Turning sync off must stop propagation again, not leave it latched on.
await call('setSyncAge', false);
await callArgs('setAgeOn', [0, 10]);
g2 = await call('instanceState', 1);
check('age sync off: stops propagating',
  g2.age === 90,
  `globe 1 -> 10 Ma, globe 2 stayed at ${g2.age} Ma`);
await callArgs('setAgeOn', [0, 0]);
await callArgs('setAgeOn', [1, 0]);

// 33-36. Same four-step pattern for the depth slice, against a manual depth
// (sinking mode is covered separately by check 37 below).
await callArgs('setDepthSliceOn', [0, { enabled: true, depthKm: 500 }]);
let d2 = await call('instanceState', 1);
check('depth-slice sync off: globe 2 unaffected by a globe 1 edit',
  d2.depthSlice.enabled === false,
  `globe 1 -> enabled @500 km, globe 2 depth slice = ${JSON.stringify(d2.depthSlice)}`);

await call('setSyncDepthSlice', true);
d2 = await call('instanceState', 1);
check('depth-slice sync on: globe 2 snaps to globe 1 immediately',
  d2.depthSlice.enabled === true && d2.depthSlice.depthKm === 500,
  `globe 2 depth slice = ${JSON.stringify(d2.depthSlice)}`);

await callArgs('setDepthSliceOn', [0, { depthKm: 800 }]);
d2 = await call('instanceState', 1);
check('depth-slice sync on: a live edit propagates',
  d2.depthSlice.depthKm === 800,
  `globe 1 -> 800 km, globe 2 = ${d2.depthSlice.depthKm} km`);

await call('setSyncDepthSlice', false);
await callArgs('setDepthSliceOn', [0, { depthKm: 300 }]);
d2 = await call('instanceState', 1);
check('depth-slice sync off: stops propagating',
  d2.depthSlice.depthKm === 800,
  `globe 1 -> 300 km, globe 2 stayed at ${d2.depthSlice.depthKm} km`);

// 37. A follower on a different model keeps its OWN tomography/convection
// guard even while sync is on: the broadcast writes sinkingEnabled=true into
// the follower's state, but that follower's own applyDepthSlice() must still
// reject it for a convection model, same as it would for a manual edit.
await call('setSyncDepthSlice', true);
await callArgs('setModelOn', [1, 'opt1']); // globe 2: convection
await callArgs('setDepthSliceOn', [0, { enabled: true, sinkingEnabled: true, depthKm: 660 }]);
d2 = await call('instanceState', 1);
check("depth-slice sync respects a follower's own tomography/convection guard",
  d2.depthSlice.sinkingEnabled === false,
  `globe 1 (tomography) broadcasts sinkingEnabled=true, `
  + `globe 2 (opt1/convection) sinkingEnabled = ${d2.depthSlice.sinkingEnabled}`);

// Leave the scene clean for anything appended after this.
await call('setSyncAge', false);
await call('setSyncDepthSlice', false);
await callArgs('setDepthSliceOn', [0, { enabled: false, sinkingEnabled: false }]);
await callArgs('setDepthSliceOn', [1, { enabled: false, sinkingEnabled: false }]);
await apply('removeGlobe');

// --- panel layout ------------------------------------------------------

console.log('\npanel layout:');

// 38. Age and depth slice are the controls scrubbed constantly while
// exploring a model, so they live at the panel ROOT (see ui.ts), not inside
// a folder that has to be opened first -- unlike every other control, which
// starts inside a closed or open FOLDER but a folder nonetheless. Checked by
// name text rather than a fixed DOM index, since that survives folder
// reordering.
const quickAccessVisible = await page.evaluate(() => {
  const byName = (text) => [...document.querySelectorAll('.lil-gui .lil-controller')]
    .find((c) => c.querySelector('.lil-name')?.textContent === text);
  const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
  return {
    age: visible(byName('age (Ma)')),
    depthEnabled: visible(byName('depth slice')),
    depthKm: visible(byName('depth (km)')),
  };
});
check('age/depth-slice controls are visible with no folder opened',
  quickAccessVisible.age && quickAccessVisible.depthEnabled && quickAccessVisible.depthKm,
  JSON.stringify(quickAccessVisible));

// 39. The hint text starts hidden behind the 'i' icon and toggles on click.
const hintInitiallyHidden = await page.evaluate(
  () => document.getElementById('hint')?.hidden === true);
await page.click('#hint-toggle');
const hintShown = await page.evaluate(
  () => document.getElementById('hint')?.hidden === false);
await page.click('#hint-toggle');
const hintHiddenAgain = await page.evaluate(
  () => document.getElementById('hint')?.hidden === true);
check('hint text starts hidden and toggles with the i icon',
  hintInitiallyHidden && hintShown && hintHiddenAgain,
  `initially hidden=${hintInitiallyHidden}, shown after click=${hintShown}, `
  + `hidden after second click=${hintHiddenAgain}`);

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
