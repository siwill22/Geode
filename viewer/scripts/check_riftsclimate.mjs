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

await setControl('Age (Ma)', 200, 'number');
await setControl('Climate', 'Annual rainfall (BRIDGE)', 'select');
await page.waitForTimeout(1500);
await shot('03-scotese-200Ma-rainfall');

await setControl('Climate', 'None', 'select');
await setControl('Plate model', 'Merdith 2021', 'select');
await page.waitForTimeout(2500);
await setControl('Age (Ma)', 400, 'number');
await setControl('Deformation', 'Stretching (+) / squeezing (−)', 'select');
await setControl('Post-rift margins', true, 'bool');
await setControl('Collision margins', true, 'bool');
await page.waitForTimeout(1500);
await shot('04-merdith-400Ma-rifts-deformation');

await setControl('Deformation', 'Deformation style', 'select');
await setControl('Projection', 'Robinson', 'select');
await page.waitForTimeout(2000);
await shot('05-merdith-400Ma-robinson-style');

await setControl('Plate model', 'Scotese', 'select');
await setControl('Age (Ma)', 800, 'number');
await shot('06-scotese-800Ma-robinson');

await setControl('Projection', 'Globe', 'select');
await setControl('Age (Ma)', 250, 'number');
await setControl('Show', 'Forming near this age', 'select');
await setControl('Colour by', 'BRIDGE: rainfall, own cell', 'select');
await page.fill('.dp-search', 'rainfall');
await page.waitForTimeout(1500);
await shot('07-scotese-250Ma-coloured-by-rainfall-panel-search');
console.log('panel rows matching "rainfall":', await page.evaluate(() => document.querySelectorAll('.dp-row').length));

console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
await browser.close();
