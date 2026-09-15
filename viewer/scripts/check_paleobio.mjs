/**
 * Drive paleobio.html in a real browser and shoot the states that matter.
 *
 * Not a unit test: the things that go wrong in this viewer are things a
 * screenshot shows and an assertion does not -- pie wedges in the wrong place,
 * a Grouping switch that recolours the legend but not the globe, an age with
 * nothing drawn because every point failed `plate_begin_age`. The legend text
 * is printed alongside each shot so the counts can be read against the picture.
 *
 * Needs the dev server up:  npm run dev &&  node scripts/check_paleobio.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots-paleobio';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:5173/paleobio.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const errBox = await page.$('#error');
if (errBox) console.log('PAGE ERROR BOX:\n' + (await errBox.innerText()));

// lil-gui controller helpers
// NOTE: this repo's lil-gui build prefixes every class -- `.lil-controller`,
// `.lil-name`, `.lil-widget` -- not the upstream `.controller`/`.name`. And a
// number controller's editable field is `input[type=text]` alongside a div
// slider, not `input[type=range]`. Both cost a debugging round when first
// written against the documented class names.
async function setSelect(labelText, optionLabel) {
  const ok = await page.evaluate(([label, v]) => {
    const rows = [...document.querySelectorAll('.lil-controller')];
    const row = rows.find((r) => r.querySelector('.lil-name')?.textContent?.trim() === label);
    if (!row) return `no controller "${label}"`;
    const sel = row.querySelector('select');
    if (!sel) return `controller "${label}" has no select`;
    const opt = [...sel.options].find((o) => o.textContent.trim() === v);
    if (!opt) return `controller "${label}" has no option "${v}" `
      + `(has ${[...sel.options].map((o) => o.textContent).join(', ')})`;
    sel.value = opt.value;
    // A real <select> change, not a test hook: lil-gui writes the bound property
    // in its own change handler, so anything that skips this path tests nothing.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }, [labelText, optionLabel]);
  if (ok) throw new Error(ok);
  await page.waitForTimeout(2500);
}

async function setSlider(labelText, value) {
  const ok = await page.evaluate(([label, v]) => {
    const rows = [...document.querySelectorAll('.lil-controller')];
    const row = rows.find((r) => r.querySelector('.lil-name')?.textContent?.trim() === label);
    if (!row) return `no controller "${label}"`;
    const inp = row.querySelector('input[type=text]') || row.querySelector('input');
    if (!inp) return `controller "${label}" has no input`;
    const setter = Object.getOwnPropertyDescriptor(inp.constructor.prototype, 'value').set;
    setter.call(inp, String(v));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }, [labelText, value]);
  if (ok) throw new Error(ok);
  await page.waitForTimeout(1800);
}

const legend = () => page.evaluate(() => document.querySelector('.legend')?.innerText ?? '(no legend)');

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`--- ${name} ---`);
  console.log(await legend());
}

/**
 * Do the two stacked panels actually share one age axis?
 *
 * Measured, not eyeballed: set an age, then find the brightest vertical line in
 * each canvas -- the latitude panel's time cursor and the time-series panel's
 * marker -- and compare their x in PAGE coordinates. Direction alone is not
 * enough; the two also have to inset their plots identically, and when they did
 * not the axes differed by up to 23 px, which reads as sloppy rendering rather
 * than as a different axis.
 */
async function checkAxisAlignment(ages) {
  for (const age of ages) {
    await setSlider('Age (Ma)', age);
    const r = await page.evaluate(() => {
      const brightestColumn = (canvas) => {
        const c = canvas.getContext('2d');
        const { width, height } = canvas;
        const d = c.getImageData(0, 0, width, height).data;
        let bestX = -1; let best = -1;
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            sum += d[i] + d[i + 1] + d[i + 2];
          }
          if (sum > best) { best = sum; bestX = x; }
        }
        const rect = canvas.getBoundingClientRect();
        return rect.left + (bestX / width) * rect.width;
      };
      const lat = document.querySelector('.lat-canvas');
      const ts = document.querySelector('.ts-canvas');
      if (!lat || !ts) return null;
      return { lat: brightestColumn(lat), ts: brightestColumn(ts) };
    });
    if (!r) { console.log(`  age ${age}: canvases not found`); continue; }
    const delta = Math.abs(r.lat - r.ts);
    console.log(`  age ${age} Ma: latitude cursor x=${r.lat.toFixed(1)}, `
      + `series marker x=${r.ts.toFixed(1)}, delta=${delta.toFixed(1)} px `
      + `${delta <= 2 ? 'ALIGNED' : 'MISALIGNED'}`);
  }
}

console.log('--- axis alignment ---');
await checkAxisAlignment([0, 135, 270, 405, 540]);
await setSlider('Age (Ma)', 0);

// 1. corals at present day
await shot('01-corals-0Ma');

// 2. corals in the Devonian -- rugose + tabulate should dominate
await setSlider('Age (Ma)', 380);
await shot('02-corals-380Ma');

// 3. corals in the Jurassic -- scleractinians only, after the end-Permian
await setSlider('Age (Ma)', 160);
await shot('03-corals-160Ma');

// 4. individual occurrences instead of summary cells
await setSelect('Show', 'Occurrences');
await shot('04-corals-occurrences-160Ma');
await setSelect('Show', 'Summary cells');

// 5. Panama
await setSelect('Dataset', 'The Panama gateway: a join and a split');
await shot('05-panama-0Ma');

// 6. Panama, basin grouping
await setSelect('Colour by', 'Marine: which side');
await shot('06-panama-basin');

await setSelect('Colour by', 'Realm');
await shot('07-panama-realm');

// Projections. Robinson's outline is a curve, so the corners of its plane must
// be discarded rather than clamped -- a screenshot is the only thing that shows
// whether that happened.
await setSelect('Dataset', 'Corals through the Phanerozoic');
await setSlider('Age (Ma)', 380);
for (const [label, name] of [['Robinson', '08-corals-robinson-380Ma'],
                             ['Plate Carrée', '09-corals-platecarree-380Ma'],
                             ['Globe', '10-corals-globe-380Ma']]) {
  await setSelect('Projection', label);
  await page.waitForTimeout(1200);
  await shot(name);
}
await setSelect('Projection', 'Robinson');
await setSelect('Dataset', 'The Panama gateway: a join and a split');
await shot('11-panama-robinson');

console.log('\n=== console errors ===');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();
