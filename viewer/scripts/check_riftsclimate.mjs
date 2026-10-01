/**
 * Drive riftsclimate.html in a real browser and shoot the states that matter:
 * present day, a clicked deposit's panel, Scotese at 200 Ma with BRIDGE
 * rainfall, Merdith 2021 at 400 Ma with rifts and deformation, and the same in
 * Robinson. The legend and caption text are printed beside each shot so the
 * counts can be read against the picture.
 *
 * Needs the dev server up:  npm run dev &&  node scripts/check_riftsclimate.mjs [outdir] [url]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots-riftsclimate';
const URL = process.argv[3] || 'http://localhost:5173/riftsclimate.html';
mkdirSync(OUT, { recursive: true });

// The full Chromium build, not Playwright's default headless shell: the shell's
// compositor left the WebGL canvas unrepainted under the lil-gui column (a
// screenshot-only artifact; the full build and a real browser draw it).
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"], #error', { timeout: 60000 });
await page.waitForTimeout(2000);
const errBox = await page.$('#error');
if (errBox) console.log('PAGE ERROR BOX:\n' + (await errBox.innerText()));

// lil-gui in this repo prefixes its classes (.lil-controller, .lil-name) --
// see check_paleobio.mjs.
async function setControl(label, value, kind) {
  const err = await page.evaluate(([label, v, kind]) => {
    const rows = [...document.querySelectorAll('.lil-controller')];
    const row = rows.find((r) => r.querySelector('.lil-name')?.textContent?.trim() === label);
    if (!row) return `no controller "${label}"`;
    if (kind === 'select') {
      const sel = row.querySelector('select');
      const opt = [...sel.options].find((o) => o.textContent.trim() === v);
      if (!opt) return `"${label}" has no option "${v}"`;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (kind === 'bool') {
      const box = row.querySelector('input[type=checkbox]');
      if (box.checked !== v) box.click();
    } else {
      const inp = row.querySelector('input[type=text]') || row.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(inp.constructor.prototype, 'value').set;
      setter.call(inp, String(v));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return null;
  }, [label, value, kind]);
  if (err) throw new Error(err);
  await page.waitForTimeout(2500);
}

// Age is the bottom-bar range input now, not a lil-gui controller.
async function setAge(age) {
  await page.evaluate((a) => {
    const el = document.querySelector('.age-slider');
    el.value = String(a);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, age);
  await page.waitForTimeout(2500);
}

// Projection is the round #projection-toggle button: click until it is `mode`.
async function setProjection(mode) {
  for (let i = 0; i < 3; i++) {
    if (await page.evaluate(() => window.__rifts.view.projection) === mode) break;
    await page.click('#projection-toggle');
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(1500);
}

// Click deposit `want` (or the first lone deposit drawn) where it is drawn now,
// and report whether the panel opened on that same deposit.
async function clickDeposit(want) {
  const t = await page.evaluate((want) => {
    const layer = window.__rifts.points.layer;
    for (let i = 0; i < layer.points.length; i++) {
      const s = layer._screen[i];
      if (!s) continue;
      if (want ? layer.points[i].deposit_id !== want : layer.points[i].type !== 'PbZn-CD') continue;
      if (s[0] > 1050 || s[1] > 760 || layer.clusterSizeAt(s[0], s[1]) > 1) continue;
      return { x: s[0], y: s[1], id: layer.points[i].deposit_id, name: layer.points[i].name };
    }
    return null;
  }, want ?? null);
  if (!t) { console.log('no clickable deposit', want); return null; }
  await page.mouse.move(t.x, t.y);
  await page.waitForTimeout(300);
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(1200);
  const shown = await page.evaluate(() => document.querySelector('.dp-header .dp-line.dp-dim:last-child')?.textContent);
  console.log(`clicked ${t.name} (${t.id}) at ${t.x.toFixed(0)},${t.y.toFixed(0)}; panel shows ${shown}:`,
    shown === t.id ? 'MATCH' : 'MISMATCH');
  return t;
}

const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`--- ${name} ---`);
  console.log((await text('.legend')).trim());
  console.log('caption:', (await text('.caption')).replace(/\n/g, ' | '));
}

await shot('01-present-day-scotese');

// Click the first PbZn-CD deposit that is drawn on its own (not in a pile).
const target = await page.evaluate(() => {
  const inst = window.__rifts;
  const layer = inst.points.layer;
  for (let i = 0; i < layer.points.length; i++) {
    const s = layer._screen[i];
    if (!s || layer.points[i].type !== 'PbZn-CD') continue;
    if (layer.clusterSizeAt(s[0], s[1]) > 1) continue;
    return { x: s[0], y: s[1], name: layer.points[i].name };
  }
  return null;
});
console.log('clicking', target);
if (target) {
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(400);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1500);
}
await shot('02-deposit-panel');
console.log('panel header:', (await text('.dp-header')).replace(/\n/g, ' | '));
const firstRows = await page.evaluate(() => [...document.querySelectorAll('.dp-row')].slice(0, 6)
  .map((r) => r.innerText.replace(/\n/g, ' | ')));
console.log('first rows:\n  ' + firstRows.join('\n  '));

await setAge(200);
await setControl('Climate', 'Annual rainfall (BRIDGE)', 'select');
await page.waitForTimeout(1500);
await shot('03-scotese-200Ma-rainfall');

await setControl('Climate', 'None', 'select');
await setControl('Plate model', 'Merdith 2021', 'select');
await page.waitForTimeout(2500);
await setAge(400);
await setControl('Deformation', 'Stretching (+) / squeezing (−)', 'select');
await setControl('Post-rift margins', true, 'bool');
await setControl('Collision margins', true, 'bool');
await page.waitForTimeout(1500);
await shot('04-merdith-400Ma-rifts-deformation');

await setControl('Deformation', 'Deformation style', 'select');
await setProjection('robinson');
await page.waitForTimeout(2000);
await shot('05-merdith-400Ma-robinson-style');

await setControl('Plate model', 'Scotese', 'select');
await setAge(800);
await shot('06-scotese-800Ma-robinson');

await setProjection('globe');
await setAge(250);
await setControl('Show', 'Forming near this age', 'select');
await setControl('Colour by', 'BRIDGE: rainfall, own cell', 'select');
await page.fill('.dp-search', 'rainfall');
await page.waitForTimeout(1500);
await shot('07-scotese-250Ma-coloured-by-rainfall-panel-search');
console.log('panel rows matching "rainfall":', await page.evaluate(() => document.querySelectorAll('.dp-row').length));

// The readout's number can be typed into, as the old panel number box allowed.
await page.fill('.age-input', '333');
await page.press('.age-input', 'Enter');
await page.waitForTimeout(800);
console.log('typed age 333 ->', await page.evaluate(() => [window.__rifts.view.age,
  document.querySelector('.age-slider').value]));

// Robinson, Scotese, 150 Ma, BRIDGE rainfall; then turn the map to ~150E by
// dragging sideways, as a reader would.
await page.fill('.dp-search', '');
await setControl('Colour by', 'Deposit class', 'select');
await setControl('Show', 'Formed by this age', 'select');
await setControl('Deformation', 'None', 'select');
await setAge(150);
await setControl('Climate', 'Annual rainfall (BRIDGE)', 'select');
await setProjection('robinson');
await shot('08-robinson-centre-0E-rainfall');
const before = await page.evaluate(() => window.__rifts.centreLongitude);
// Grab the map at the middle and pull it 300 px left: what was to the east
// comes to the centre.
await page.mouse.move(700, 450);
await page.mouse.down();
for (let k = 1; k <= 15; k++) { await page.mouse.move(700 - 20 * k, 452); await page.waitForTimeout(20); }
await page.mouse.up();
await page.waitForTimeout(500);
const afterDrag = await page.evaluate(() => window.__rifts.centreLongitude);
console.log(`drag: centre longitude ${before.toFixed(1)} -> ${afterDrag.toFixed(1)}`);
// Sideways trackpad scroll moves it too, and must not zoom.
const zoom0 = await page.evaluate(() => window.__rifts.camera.zoom);
await page.mouse.move(700, 450);
await page.mouse.wheel(120, 0);
await page.waitForTimeout(500);
const afterWheel = await page.evaluate(() => window.__rifts.centreLongitude);
const zoom1 = await page.evaluate(() => window.__rifts.camera.zoom);
console.log(`sideways scroll: centre longitude ${afterDrag.toFixed(1)} -> ${afterWheel.toFixed(1)}; zoom ${zoom0} -> ${zoom1}`);
await page.evaluate(() => window.__rifts.setCentreLongitude(150));
await page.waitForTimeout(1500);
console.log('map hint:', await text('.map-hint'));
await shot('09-robinson-centre-150E-rainfall');
await clickDeposit(null);
await page.waitForTimeout(800);
await shot('10-robinson-150E-clicked-deposit');

// The same turned map under Merdith 2021: margins and deformation must turn
// with the continents.
await setControl('Plate model', 'Merdith 2021', 'select');
await setAge(400);
await setControl('Deformation', 'Stretching (+) / squeezing (−)', 'select');
await shot('11-merdith-400Ma-robinson-150E-rifts-deformation');
// Back to the globe: the turn is a flat-map setting and must not reach it.
await setProjection('globe');
await shot('12-merdith-400Ma-globe-after-turn');
await clickDeposit(null);

console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
await browser.close();
