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
await page.evaluate(() => { window.__wp10.view.simColour = 'depth'; window.__wp10.applyLayers(); });

await setControl('Only those found today', true, 'bool');
await setAge(0);
await shot('rung1a-000Ma-only-found-lines');
await setControl('Only those found today', false, 'bool');

await page.evaluate(() => { window.__wp10.view.findsColour = 'difference'; window.__wp10.applyLayers(); });
await page.waitForTimeout(500);
await shot('rung1a-000Ma-finds-difference');
await page.evaluate(() => { window.__wp10.view.findsColour = 'predicted'; window.__wp10.applyLayers(); });

await setAge(50);
await page.evaluate(() => { window.__wp10.view.formationColour = 'rate_found'; window.__wp10.applyLayers(); });
await page.waitForTimeout(500);
await shot('rung1a-050Ma-forming-and-found');

await setControl('Where they form (rung)', '1c', 'select');
await shot('rung1c-050Ma-forming-and-found');
await page.evaluate(() => { window.__wp10.view.formationColour = 'rate'; window.__wp10.applyLayers(); });
await shot('rung1c-050Ma-rate');
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
