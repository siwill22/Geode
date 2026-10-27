/**
 * Drive skillwindow.html in a real browser. Checks, for every deposit type written and every
 * factor, in every window RiftsClimate computed (its prep/geode_window_export.py,
 * expected_<type>.json): the page's skill equals RiftsClimate's (to 1e-4: the page reads the
 * cells' areas and time slices as 32-bit numbers), and the deposits and districts counted are
 * the same. Then shoots: the whole record; 0-200 Ma with tectonothermal age chosen; the list by
 * skill; a factor reversed; a window dragged on the age chart.
 *
 * Needs the dev server up:  npx vite --port 5183 &  node scripts/check_skillwindow.mjs [outdir] [url]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots-skillwindow';
const URL = process.argv[3] || 'http://localhost:5183/skillwindow.html';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"], #error', { timeout: 90000 });
const errBox = await page.$('#error');
if (errBox) {
  console.log('PAGE ERROR BOX:\n' + (await errBox.innerText()));
  await browser.close();
  process.exit(1);
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const shoot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${name}.png`);
};

// --- the page's numbers against RiftsClimate's -------------------------------------------------
const report = await page.evaluate(async () => {
  const sw = window.__skillwindow;
  const { fetchMaybeGzippedJSON } = await import('/vendor/petrify/js/gzipFetch.js');
  const base = new URL('archive/riftsclimate/window/', location.href).href;
  const out = [];
  for (const [t, info] of Object.entries(sw.index.types)) {
    await sw.setType(t);
    const expected = await fetchMaybeGzippedJSON(base + info.expected_file);
    sw.index.windows.forEach(([a, b], i) => {
      const got = sw.compute(a, b);
      for (const [id, rows] of Object.entries(expected)) {
        const want = rows[i];
        const g = got[id];
        out.push({ type: t, window: `${a}-${b}`, factor: id, want, got: g });
      }
    });
  }
  return out;
});
let worst = 0;
for (const r of report) {
  const { want, got } = r;
  if (!got) { fail(`${r.type} ${r.window} ${r.factor}: not computed by the page`); continue; }
  if (want.deposits !== got.deposits || want.districts !== got.districts) {
    fail(`${r.type} ${r.window} ${r.factor}: deposits/districts ${got.deposits}/${got.districts}, RiftsClimate ${want.deposits}/${want.districts}`);
  }
  if ((want.skill == null) !== (got.skill == null)) { fail(`${r.type} ${r.window} ${r.factor}: skill ${got.skill}, RiftsClimate ${want.skill}`); continue; }
  if (want.skill != null) {
    const d = Math.abs(want.skill - got.skill);
    worst = Math.max(worst, d);
    if (d > 1e-4) fail(`${r.type} ${r.window} ${r.factor}: skill ${got.skill.toFixed(5)}, RiftsClimate ${want.skill.toFixed(5)}`);
  }
}
console.log(`${report.length} factor x window tests against RiftsClimate; largest skill difference ${worst.toExponential(2)}`);

// --- what a reader sees --------------------------------------------------------------------------
await page.evaluate(() => window.__skillwindow.setType('Kimberlite'));
await shoot('01-kimberlite-0-1000');

await page.click('#presets .btn:nth-child(3)');          // 0-200 Ma
await page.click('.factor:has-text("tectonothermal age (TC1)")');
const detail = await page.$eval('#detail-skill', (e) => e.textContent);
if (!/^Skill [+−]\d\.\d{3} in 0-200 Ma/.test(detail)) fail(`detail line: "${detail}"`);
console.log(`  ${detail}`);
await shoot('02-kimberlite-0-200-tc1');

await page.click('#sort-skill');
const order = await page.$$eval('.factor .factor-skill', (els) => els.map((e) => parseFloat(e.textContent.replace('−', '-'))));
const finite = order.filter(Number.isFinite);
if (finite.some((v, i) => i && v > finite[i - 1] + 1e-12)) fail(`list by skill is not in order: ${finite.join(', ')}`);
await shoot('03-kimberlite-0-200-by-skill');

const before = await page.$eval('.factor-on .factor-skill', (e) => e.textContent);
await page.click('#reverse');
const after = await page.$eval('.factor-on .factor-skill', (e) => e.textContent);
if (before.slice(1) !== after.slice(1) || before[0] === after[0]) fail(`reversing changed more than the sign: ${before} -> ${after}`);
await shoot('04-kimberlite-0-200-tc1-reversed');
await page.click('#reverse');

// drag a new window on the age chart: 300 to 600 Ma
const box = await (await page.$('#ages')).boundingBox();
const x = (age) => box.x + 40 + age / 1000 * (box.width - 50);
await page.mouse.move(x(300), box.y + 40);
await page.mouse.down();
await page.mouse.move(x(600), box.y + 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const win = await page.evaluate(() => [Number(document.getElementById('young').value), Number(document.getElementById('old').value)]);
if (Math.abs(win[0] - 300) > 3 || Math.abs(win[1] - 600) > 3) fail(`dragged window is ${win[0]}-${win[1]} Ma, not about 300-600`);
await shoot('05-kimberlite-dragged-300-600');

if (errors.length) { for (const e of errors) fail(`browser: ${e}`); }
await browser.close();
console.log(failures ? `${failures} checks failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
