/**
 * Drive wp10porphyry.html in a real browser and shoot the states that matter: two rungs
 * (0: anywhere; 1a: within 500 km of subduction) at 0, 20, 100 and 300 Ma, a line picked
 * in the depth chart and found on the map, a simulated porphyry clicked on the map,
 * colour by fate, the other walk setting, the globe, and today's predicted finds against the
 * real ones. The legend
 * text is printed beside each shot so the counts can be read against the picture.
 *
 * Also checks, without a picture:
 *  - every real porphyry drawn at its own age sits where RiftsClimate placed it then
 *    (m_lon, m_lat), i.e. the deposit viewer's plates and the WP10 analysis agree;
 *  - every simulated porphyry drawn sits on its place's box at that age.
 *
 * Needs the dev server up:  npx vite --port 5183 &  node scripts/check_wp10porphyry.mjs [outdir] [url]
 * (another port: pass the url, e.g. http://localhost:5184/wp10porphyry.html)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots-wp10porphyry';
const URL = process.argv[3] || 'http://localhost:5183/wp10porphyry.html';
mkdirSync(OUT, { recursive: true });

// The full Chromium build, as check_riftsclimate.mjs (the headless shell leaves the WebGL
// canvas unrepainted under the lil-gui column in screenshots).
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"], #error', { timeout: 90000 });
await page.waitForTimeout(1500);
const errBox = await page.$('#error');
if (errBox) console.log('PAGE ERROR BOX:\n' + (await errBox.innerText()));

async function setControl(label, value, kind) {
  const err = await page.evaluate(([label, v, kind]) => {
    const rows = [...document.querySelectorAll('.lil-controller')];
    const row = rows.find((r) => r.querySelector('.lil-name')?.textContent?.trim() === label);
    if (!row) return `no controller "${label}"`;
    if (kind === 'select') {
      const sel = row.querySelector('select');
      const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(v));
      if (!opt) return `"${label}" has no option "${v}"`;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (kind === 'bool') {
      const box = row.querySelector('input[type=checkbox]');
      if (box.checked !== v) box.click();
    }
    return null;
  }, [label, value, kind]);
  if (err) throw new Error(err);
  await page.waitForTimeout(700);
}

async function setAge(age) {
  await page.evaluate((a) => {
    const el = document.querySelector('.age-slider');
    el.value = String(a);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, age);
  await page.waitForTimeout(900);
}

async function setProjection(mode) {
  for (let i = 0; i < 3; i++) {
    if (await page.evaluate(() => window.__wp10.view.projection) === mode) break;
    await page.click('#projection-toggle');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(800);
}

const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`--- ${name} ---`);
  console.log((await text('.legend')).trim().replace(/\n+/g, ' | '));
}

/** Real porphyries drawn at their own age: angular distance between the deposit viewer's
 *  reconstruction and RiftsClimate's m_lon/m_lat, in km. */
async function checkRealPositions() {
  const r = await page.evaluate(() => {
    const inst = window.__wp10;
    const layer = inst.realLayer.layer;
    const f = inst.deps.finds.porphyries;
    const row = new Map(f.deposit_id.map((id, i) => [id, i]));
    const out = [];
    const toVec = (lon, lat) => {
      const a = lon * Math.PI / 180; const b = lat * Math.PI / 180;
      return [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
    };
    for (let i = 0; i < layer.points.length; i++) {
      const p = layer.points[i];
      const k = row.get(p.deposit_id);
      if (f.m_lon[k] == null) continue;
      layer.setTime(f.age_ma[k]);
      if (!layer._live[i]) { out.push(null); continue; }
      const v = [layer._xyz[i * 3], layer._xyz[i * 3 + 1], layer._xyz[i * 3 + 2]];
      const w = toVec(f.m_lon[k], f.m_lat[k]);
      const dot = Math.max(-1, Math.min(1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2]));
      out.push(Math.acos(dot) * 6371);
    }
    layer.setTime(inst.view.age);
    return out;
  });
  const d = r.filter((x) => x !== null).sort((a, b) => a - b);
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  console.log(`real porphyries at their own age: ${d.length} drawn, ${r.length - d.length} not drawable; `
    + `distance to RiftsClimate's position: median ${q(0.5).toFixed(1)} km, 95% ${q(0.95).toFixed(1)} km, `
    + `max ${d[d.length - 1].toFixed(1)} km; over 50 km: ${d.filter((x) => x > 50).length}`);
}

/** Simulated porphyries drawn: each on its place's box position at this age. */
async function checkSimPositions() {
  const r = await page.evaluate(() => {
    const inst = window.__wp10;
    const pts = inst.simLayer.payload().points;
    const s = inst.boxes.snapshotAt(inst.view.age);
    let bad = 0;
    for (const p of pts) {
      const pos = inst.boxes.position(inst.walkers.s.place[p.w], s);
      if (!pos || Math.abs(pos[0] - p.lon) > 1e-9 || Math.abs(pos[1] - p.lat) > 1e-9) bad++;
      if (!inst.walkers.exists(p.w, inst.view.age)) bad++;
    }
    return { n: pts.length, bad };
  });
  console.log(`simulated porphyries drawn: ${r.n}; off their place's box or not existing: ${r.bad}`);
}

await checkRealPositions();

for (const rung of ['1a', '0']) {
  await setControl('Where they form (rung)', rung, 'select');
  for (const age of [0, 20, 100, 300]) {
    await setAge(age);
    await checkSimPositions();
    await shot(`rung${rung}-${String(age).padStart(3, '0')}Ma`);
  }
}

// Rung 1a at 100 Ma: pick a found-today line in the depth chart; the map should find it.
await setControl('Where they form (rung)', '1a', 'select');
await setAge(100);
const pick = await page.evaluate(() => {
  const ch = window.__wp10.charts;
  const w = ch.data.walkers;
  const box = ch.depthCanvas.getBoundingClientRect();
  for (const i of ch.drawn) {
    if (w.s.fate[i] !== 0 || w.s.age_ma[i] < 30) continue;
    const p = ch.paths.get(i);
    const k = Math.floor(p.length / 4) * 2;
    return { i, x: box.left + p[k], y: box.top + p[k + 1] };
  }
  return null;
});
if (pick) {
  await page.mouse.move(pick.x, pick.y);
  await page.waitForTimeout(300);
  await page.mouse.click(pick.x, pick.y);
  await page.waitForTimeout(900);
  const sel = await page.evaluate(() => ({ sel: window.__wp10.selection, age: window.__wp10.view.age,
    hl: window.__wp10.simLayer.layer.hovered }));
  console.log(`chart pick: line ${pick.i} -> selected ${JSON.stringify(sel.sel)} at ${sel.age} Ma; map ring on point ${sel.hl}`);
  await shot('pick-line-in-chart');
}

// The place states coloured one share at a time (rung 1a, 100 Ma), and a click on a place.
await page.evaluate(() => { const w = window.__wp10; w.view.formationColour = 'rate'; w.select(null); w.applyLayers(); });
await page.mouse.move(5, 895);   // away from the chart, so no hover tip lingers
for (const share of ['eroded', 'within_reach', 'buried', 'found_today']) {
  await page.evaluate((sh) => { const w = window.__wp10; w.view.stateColour = sh; w.applyLayers(); }, share);
  await page.waitForTimeout(400);
  await shot(`rung1a-100Ma-share-${share}`);
}
await page.evaluate(() => { const w = window.__wp10; w.view.stateColour = 'mix'; w.applyLayers(); });
await page.waitForTimeout(500);   // rebuilt layers have screen positions only after the next draw
const place = await page.evaluate(() => {
  const L = window.__wp10.stateLayer.layer;
  for (let i = L.points.length - 1; i >= 0; i--) {
    const s = L._screen[i];
    if (s && s[0] > 320 && s[0] < window.__wp10.mapRect.width - 260 && s[1] > 250 && s[1] < 650) return { x: s[0], y: s[1] };
  }
  return null;
});
console.log('place target:', JSON.stringify(place));
if (place) {
  await page.evaluate(() => { const w = window.__wp10; w.view.real = false; w.view.boundaries = false; w.applyLayers(); });
  await page.mouse.click(place.x, place.y);
  await page.waitForTimeout(500);
  console.log('place click:', JSON.stringify(await page.evaluate(() => window.__wp10.selection)));
  await shot('rung1a-100Ma-place-click');
  await page.evaluate(() => { const w = window.__wp10; w.view.real = true; w.view.boundaries = true; w.select(null); w.applyLayers(); });
}

// The individual sample on the map (off by default): click a lone one.
await page.evaluate(() => { const w = window.__wp10; w.view.simulated = true; w.applyLayers(); });
// Click a lone simulated porphyry on the map.
const target = await page.evaluate(() => {
  const L = window.__wp10.simLayer.layer;
  const mapW = window.__wp10.mapRect.width;
  for (let i = 0; i < L.points.length; i++) {
    const s = L._screen[i];
    if (!s || s[0] < 320 || s[0] > mapW - 260 || s[1] < 200 || s[1] > 700) continue;
    if (L.clusterSizeAt(s[0], s[1]) > 1) continue;
    return { x: s[0], y: s[1], w: L.points[i].w };
  }
  return null;
});
console.log('simulated target:', JSON.stringify(target));
if (target) {
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(800);
  const sel = await page.evaluate(() => window.__wp10.selection);
  console.log(`map click on walker ${target.w}: selected ${JSON.stringify(sel)}`, sel?.id === target.w ? 'MATCH' : 'MISMATCH');
  await shot('click-simulated-on-map');
}

await page.evaluate(() => { window.__wp10.view.simColour = 'fate'; window.__wp10.applyLayers(); });
await page.waitForTimeout(500);
await shot('rung1a-100Ma-fate');
await page.evaluate(() => { const w = window.__wp10; w.view.simColour = 'depth'; w.view.simulated = false; w.applyLayers(); });

await setControl('Only those found today', true, 'bool');
await setAge(0);
await shot('rung1a-000Ma-only-found-lines');
await setControl('Only those found today', false, 'bool');

await page.evaluate(() => { const w = window.__wp10; w.view.finds = true; w.view.findsColour = 'difference'; w.applyLayers(); });
await page.waitForTimeout(500);
await shot('rung1a-000Ma-finds-difference');
await page.evaluate(() => { const w = window.__wp10; w.view.finds = false; w.view.findsColour = 'predicted'; w.applyLayers(); });

await setAge(50);
await page.evaluate(() => { const w = window.__wp10; w.view.formation = true; w.view.states = false; w.view.formationColour = 'rate_found'; w.applyLayers(); });
await page.waitForTimeout(500);
await shot('rung1a-050Ma-forming-and-found');

await page.evaluate(() => { window.__wp10.view.formationColour = 'rate'; window.__wp10.applyLayers(); });
// The fitted distance rungs: bands (1d) and a hump (1e), under both walk settings.
for (const rung of ['1d', '1e']) {
  await setControl('Where they form (rung)', rung, 'select');
  await shot(`rung${rung}-050Ma-rate`);
}
await setAge(10);
await shot('rung1e-010Ma-rate');
await setControl('Walk setting', 'our 5 Myr fit', 'select');
await shot('rung1e-5Myr-010Ma-rate');
await setControl('Where they form (rung)', '1d', 'select');
await shot('rung1d-5Myr-010Ma-rate');
await setControl('Walk setting', 'Kesler', 'select');

// The depth chart with 300 and 5000 lines, and found today only; how long a redraw takes.
await setControl('Where they form (rung)', '1a', 'select');
await setAge(60);
for (const [lines, only] of [[300, false], [5000, false], [300, true]]) {
  const t = await page.evaluate(([lines, only]) => {
    const w = window.__wp10;
    w.view.lines = lines; w.view.onlyFound = only;
    const t0 = performance.now();
    w.charts.setOptions(w.chartOptions());
    const t1 = performance.now();
    w.ui.refreshDisplay();
    const ch = w.charts;
    const f = ch.drawn.filter((i) => ch.data.walkers.s.fate[i] === 0).length;
    // A hover over the middle of the chart: how long finding the nearest line takes.
    const t2 = performance.now();
    for (let k = 0; k < 20; k++) ch.nearest(200 + k, 120);
    const t3 = performance.now();
    return { redraw: t1 - t0, hover: (t3 - t2) / 20, drawn: ch.drawn.length, found: f, n: ch.data.walkers.n };
  }, [lines, only]);
  console.log(`chart, ${lines} lines${only ? ', found today only' : ''}: ${t.drawn} drawn (${t.found} found today) of ${t.n}; `
    + `redraw ${t.redraw.toFixed(0)} ms, nearest-line lookup ${t.hover.toFixed(1)} ms`);
  await page.waitForTimeout(300);
  await shot(`chart-${lines}-lines${only ? '-found-only' : ''}`);
}
await page.evaluate(() => { const w = window.__wp10; w.view.lines = 1000; w.view.onlyFound = false;
  w.charts.setOptions(w.chartOptions()); w.ui.refreshDisplay(); });

// Plate boundaries at 14, 40, 140 and 310 Ma, coloured by type and by closing/opening rate,
// with a sense check: labelled subduction zones should mostly close, ridges mostly open.
await page.evaluate(() => { const w = window.__wp10; w.view.formationColour = 'rate'; w.view.simulated = false;
  w.view.real = true; w.view.formation = true; w.view.states = false; w.applyLayers(); });
for (const age of [14, 40, 140, 310]) {
  await setAge(age);
  const stats = await page.evaluate(() => {
    const w = window.__wp10;
    const bl = w.boundaryLines;
    const out = {};
    for (let f = 0; f < bl.features.length; f++) {
      const lab = bl.labelOf(f);
      const o = (out[lab] ??= { closing: 0, opening: 0, unknown: 0 });
      for (const c of bl.feature(f)[3]) { if (c == null) o.unknown++; else if (c > 0) o.closing++; else o.opening++; }
    }
    return { snap: w.boundarySnap, teeth: w.teeth.visible, teethFrame: w.teeth.frameTime, out };
  });
  const fmt = (lab) => { const o = stats.out[lab]; if (!o) return `${lab}: none`;
    const n = o.closing + o.opening; return `${lab}: ${Math.round(100 * o.closing / Math.max(1, n))}% of ${n} points closing (${o.unknown} unknown)`; };
  console.log(`boundaries at ${age} Ma: snapshot ${stats.snap} Ma, teeth ${stats.teeth ? `frame ${stats.teethFrame} Ma` : 'off'}; `
    + ['SubductionZone', 'MidOceanRidge', 'OrogenicBelt', 'Transform'].map(fmt).join('; '));
  await page.evaluate(() => { window.__wp10.view.boundaryColour = 'label'; window.__wp10.applyLayers(); });
  await page.waitForTimeout(600);
  await shot(`boundaries-type-${String(age).padStart(3, '0')}Ma`);
  await page.evaluate(() => { window.__wp10.view.boundaryColour = 'convergence'; window.__wp10.applyLayers(); });
  await page.waitForTimeout(400);
  await shot(`boundaries-rate-${String(age).padStart(3, '0')}Ma`);
}
// Click a boundary: the popup names its type, its rate there and the snapshot.
await setAge(40);
const onLine = await page.evaluate(() => {
  const bl = window.__wp10.boundaryLines;
  const mapW = window.__wp10.mapRect.width;
  for (const d of bl.drawn) {
    if (bl.labelOf(d.feature) !== 'SubductionZone') continue;
    for (const p of d.pts) if (p && p[0] > 320 && p[0] < mapW - 260 && p[1] > 250 && p[1] < 650) return { x: p[0], y: p[1] };
  }
  return null;
});
if (onLine) {
  await page.evaluate(() => { const w = window.__wp10; w.view.formation = false; w.view.real = false; w.applyLayers(); });
  await page.mouse.click(onLine.x, onLine.y);
  await page.waitForTimeout(600);
  const sel = await page.evaluate(() => window.__wp10.selection);
  console.log('boundary click:', JSON.stringify(sel));
  await shot('boundaries-rate-040Ma-click');
}
await page.evaluate(() => { const w = window.__wp10; w.view.convergentOnly = true; w.view.boundaryColour = 'label';
  w.view.formation = true; w.applyLayers(); });
await page.waitForTimeout(500);
await shot('boundaries-type-040Ma-closing-only');
await page.evaluate(() => { const w = window.__wp10; w.view.convergentOnly = false; w.view.simulated = false;
  w.view.real = true; w.view.formation = false; w.view.states = true; w.select(null); w.applyLayers(); });

// The other walk setting, rung 1b, with the charts' age axis from 150 Ma.
await page.evaluate(() => { window.__wp10.view.formationColour = 'rate'; window.__wp10.applyLayers(); });
await setControl('Walk setting', 'our 5 Myr fit', 'select');
await setControl('Where they form (rung)', '1b', 'select');
await setControl('Age axis from', '150 Ma', 'select');
await setAge(30);
await shot('rung1b-5Myr-030Ma-axis150');
await setControl('Age axis from', '541 Ma', 'select');

await setProjection('globe');
await shot('globe-rung1b-5Myr-030Ma');

console.log('\nerrors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
