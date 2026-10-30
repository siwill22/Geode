/**
 * Drive molchan.html in a real browser and shoot the states that matter: SEDEX with the
 * passive margin at 400 Ma (by share, by value; at 395 Ma as the test sees it), a deposit
 * picked in the Molchan diagram and found on the map, MVT with collision, Cu-sed with the
 * evaporite hump at 255 Ma (the Kupferschiefer's age), and the globe. The
 * legend text is printed beside each shot so the counts can be read against the picture.
 *
 * Then the combinations (step 3): the best-of-all choice's held-out map for Cu-sed, the panel
 * blocks below the diagram (fake worlds, factor gains, the ranked list) and a map picked from
 * the list.
 *
 * Also checks, without a picture:
 *  - for every combination map of every type, the skill the diagram shows equals RiftsClimate's
 *    and the dots reproduce it;
 *  - for every deposit type and factor, the skill the diagram shows equals RiftsClimate's
 *    (index.json), and the dots (each deposit's share) give the same skill;
 *  - "as the test sees it", the older slice of a pair shows the younger slice's boxes;
 *  - a deposit picked in the diagram is drawn on the map, highlighted, where RiftsClimate
 *    placed it at the time slice's age (slice_lon, slice_lat);
 *  - a deposit moves with its plate: in two time slices it is drawn at RiftsClimate's position
 *    for each, and the two differ.
 *
 * Needs the dev server up:  npx vite --port 5183 &  node scripts/check_molchan.mjs [outdir] [url]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots-molchan';
const URL = process.argv[3] || 'http://localhost:5183/molchan.html';
mkdirSync(OUT, { recursive: true });

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
if (errBox) {
  console.log('PAGE ERROR BOX:\n' + (await errBox.innerText()));
  await browser.close();
  process.exit(1);
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

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
  await page.waitForTimeout(500);
}

async function setAge(age) {
  await page.evaluate((a) => window.__molchan.applyAge(a), age);
  await page.waitForTimeout(500);
}

async function shoot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const legend = await page.$eval('.legend', (e) => e.innerText.replace(/\n+/g, ' | '));
  const skill = await page.$eval('.molchan-skill', (e) => e.innerText);
  console.log(`${name}.png  [${skill}]  ${legend}`);
}

// --- skills: diagram vs RiftsClimate, every type and factor -----------------------------
const plan = await page.evaluate(() => {
  const ix = window.__molchan.deps.index;
  return ix.types.map((t) => ({ type: t.label, factors: ix.factors.filter((f) => f.types.includes(t.id)).map((f) => f.id),
    skills: ix.curves[t.id] }));
});
for (const t of plan) {
  await setControl('Deposit type', t.type, 'select');
  for (const f of t.factors) {
    await setControl('Factor', f, 'select');
    const shown = await page.$eval('.molchan-skill', (e) => e.innerText);
    const want = t.skills[f].skill;
    const m = shown.match(/Skill ([+−])(\d\.\d+)/);
    const got = m ? (m[1] === '−' ? -1 : 1) * Number(m[2]) : NaN;
    if (!(Math.abs(got - want) < 6e-4) || /does not match/.test(shown)) fail(`${t.type} / ${f}: diagram "${shown}", RiftsClimate ${want}`);
  }
}
console.log(`skills checked: ${plan.reduce((a, t) => a + t.factors.length, 0)} type x factor pairs`);

// --- SEDEX, passive margin, 400 Ma ------------------------------------------------------
await setControl('Deposit type', 'SEDEX', 'select');
await setControl('Factor', 'passive margin', 'select');
await setAge(400);
await shoot('01-sedex-passive-400-share');
// "As the test sees it": at 395 Ma (slice 393-397.5 Ma, the older of its pair, weight 0 in the
// test) every place must show the box of the younger slice it is merged into, 388-393 Ma.
const boxKeys = () => page.evaluate(() => window.__molchan.boxLayer.payload().points
  .map((p) => `${p.lon},${p.lat},${p.share}`).sort().join(';'));
await setAge(390);
const younger = await boxKeys();
await setControl('as the test sees it (slices in pairs)', true, 'bool');
await setAge(395);
if ((await boxKeys()) !== younger) fail('at 395 Ma "as the test sees it" does not show the 388-393 Ma boxes');
else console.log('395 Ma as the test sees it = the 388-393 Ma boxes: ok');
await shoot('02-sedex-passive-395-as-the-test-sees-it');
await setControl('as the test sees it (slices in pairs)', false, 'bool');
await setAge(400);
await setControl('coloured by', 'Value', 'select');
await shoot('03-sedex-passive-400-value');
await setControl('coloured by', 'Share', 'select');

// --- a deposit picked in the diagram ----------------------------------------------------
const picked = await page.evaluate(() => {
  const m = window.__molchan;
  const d = m.deps.deposits;
  // The deposit with the highest share (worst-rated ground), to see where it misses.
  let best = -1;
  for (let i = 0; i < d.deposit_id.length; i++) {
    const s = d.shares['passive margin'][i];
    if (d.type[i] === 'PbZn-CD' && s != null && (best < 0 || s > d.shares['passive margin'][best])) best = i;
  }
  m.panel.cb.onPickDeposit(best);
  const k = m.depIdx.indexOf(best);
  const pt = k >= 0 ? m.depLayer.payload().points[k] : null;
  const S = m.deps.boxes.snapshots.snapshot_ma.length;
  return { i: best, name: d.name[best], age: d.age_ma[best], share: d.shares['passive margin'][best],
    onMap: k >= 0, lon: pt?.lon, lat: pt?.lat, want_lon: d.slice_lon[best * S + m.slice] ?? d.m_lon[best],
    want_lat: d.slice_lat[best * S + m.slice] ?? d.m_lat[best], viewAge: m.view.age };
});
if (!picked.onMap) fail(`picked deposit ${picked.name} is not on the map at ${picked.viewAge} Ma`);
if (picked.lon !== picked.want_lon || picked.lat !== picked.want_lat) fail(`picked deposit drawn at ${picked.lon},${picked.lat}, not ${picked.want_lon},${picked.want_lat}`);
console.log(`picked ${picked.name} (${picked.age} Ma, share ${picked.share}): map at ${picked.viewAge} Ma`);
await shoot('04-sedex-picked-worst-deposit');

// --- deposits move with their plates ------------------------------------------------------
const where = async (age, i) => { await setAge(age); return page.evaluate((i) => {
  const m = window.__molchan; const d = m.deps.deposits; const S = m.deps.boxes.snapshots.snapshot_ma.length;
  const k = m.depIdx.indexOf(i); const pt = k >= 0 ? m.depLayer.payload().points[k] : null;
  return { slice: m.slice, lon: pt?.lon, lat: pt?.lat, want_lon: d.slice_lon[i * S + m.slice], want_lat: d.slice_lat[i * S + m.slice] };
}, i); };
{
  await page.evaluate(() => window.__molchan.select(null));
  const i = await page.evaluate(() => { const d = window.__molchan.deps.deposits;
    return d.deposit_id.findIndex((_, j) => d.type[j] === 'PbZn-CD' && Math.abs(d.age_ma[j] - 400) <= 5); });
  const age = await page.evaluate((i) => window.__molchan.deps.deposits.age_ma[i], i);
  const a = await where(Math.round(age) - 15, i);
  const b = await where(Math.round(age) + 15, i);
  for (const [n, p] of [['young', a], ['old', b]]) {
    if (p.lon == null || p.lon !== p.want_lon || p.lat !== p.want_lat) fail(`deposit ${i} (${n}) drawn at ${p.lon},${p.lat}, not ${p.want_lon},${p.want_lat}`);
  }
  if (a.slice === b.slice || (a.lon === b.lon && a.lat === b.lat)) fail(`deposit ${i} did not move between slices ${a.slice} and ${b.slice}`);
  console.log(`deposit ${i} (${age} Ma): ${a.lon},${a.lat} at ${Math.round(age) - 15} Ma -> ${b.lon},${b.lat} at ${Math.round(age) + 15} Ma: moves with its plate`);
}

// --- MVT, collision; the globe ----------------------------------------------------------
await page.evaluate(() => window.__molchan.select(null));
await setControl('Deposit type', 'MVT', 'select');
await setControl('Factor', 'collision', 'select');
await setControl('Collision margins', true, 'bool');
await setAge(300);
await shoot('05-mvt-collision-300');
await setControl('Collision margins', false, 'bool');
await setControl('Deposit type', 'Cu-sed', 'select');
await setControl('Factor', 'evaporite', 'select');
await setAge(255);
await shoot('07-cused-evaporite-255');
await setControl('Factor', 'margin line after', 'select');
await setControl('Margin lines after collision', true, 'bool');
await shoot('08-cused-after-collision-255');
await setControl('Margin lines after collision', false, 'bool');
await setControl('Deposit type', 'SEDEX', 'select');
await setControl('Factor', 'passive margin', 'select');
await page.evaluate(() => { window.__molchan.setProjection('globe'); dispatchEvent(new Event('resize')); });
await setAge(150);
await shoot('06-sedex-passive-150-globe');

// --- combinations (step 3): every map's skill, then the best-of-all choice and the panel ----
await page.evaluate(() => { window.__molchan.setProjection('robinson'); dispatchEvent(new Event('resize')); });
const combos = await page.evaluate(() => {
  const ix = window.__molchan.deps.index;
  return Object.entries(ix.combos).map(([type, e]) => ({ type, maps: e.maps.map((m) => ({ id: m.id, skill: m.skill, label: m.label })) }));
});
let nMaps = 0;
for (const t of combos) {
  for (const m of t.maps) {
    const shown = await page.evaluate(async ([type, id]) => {
      const inst = window.__molchan;
      // a key "<type>|screened" is that type's run with screened new factors
      inst.view.type = type.split('|')[0]; inst.view.comboSet = type.endsWith('|screened') ? 'screened' : 'main';
      inst.view.show = 'combination'; inst.view.combo = id;
      await inst.applySetting();
      const el = document.querySelector('.molchan-skill');
      return { text: el.innerText, bad: el.classList.contains('molchan-skill-bad') };
    }, [t.type, m.id]);
    const mm = shown.text.match(/Skill ([+−])(\d\.\d+)/);
    const got = mm ? (mm[1] === '−' ? -1 : 1) * Number(mm[2]) : NaN;
    if (shown.bad || !(Math.abs(got - m.skill) < 6e-4)) fail(`${t.type} / ${m.label}: diagram "${shown.text}", RiftsClimate ${m.skill}`);
    nMaps++;
  }
}
console.log(`combination maps checked: ${nMaps}`);
await page.evaluate(() => { const i = window.__molchan; i.view.show = 'factor'; i.view.type = 'PbZn-CD'; i.view.comboSet = 'main'; });
await setControl('Deposit type', 'Cu-sed', 'select');
await setControl('Show', 'Combination', 'select');
await setControl('Combination', 'Held-out test', 'select');
await setAge(255);
await shoot('09-cused-best-of-all-255');
// The panel blocks below the diagram, and a ranked row picked from the list.
await page.waitForFunction(() => document.querySelectorAll('.combo-row').length > 0, null, { timeout: 30000 });
await page.evaluate(() => { document.querySelector('.charts-panel').scrollTop = 560; });
await shoot('10-cused-panel-worlds-gains');
await page.evaluate(() => { document.querySelector('.charts-panel').scrollTop = 99999; });
await shoot('11-cused-panel-ranked');
const picked2 = await page.evaluate(async () => {
  const row = document.querySelector('.combo-row-map');
  row.click();
  await new Promise((r) => setTimeout(r, 1500));
  return { combo: window.__molchan.view.combo, name: row.querySelector('.combo-name').textContent,
    label: window.__molchan.deps.index.combos['Cu-sed'].maps.find((m) => m.id === window.__molchan.view.combo)?.combination };
});
if (picked2.name !== picked2.label) fail(`ranked row "${picked2.name}" showed map ${picked2.combo} (${picked2.label})`);
await page.evaluate(() => { document.querySelector('.charts-panel').scrollTop = 0; });
await shoot('12-cused-best-1-255');

// --- plate boundaries: VMS, the passive margin, 400 Ma; then by convergence --------------
await setControl('Show', 'One factor', 'select');
await setControl('Deposit type', 'VMS', 'select');
await setControl('Factor', 'passive margin', 'select');
await setAge(400);
const pl = await page.evaluate(() => { const i = window.__molchan; return { on: i.plateLines.visible, snap: i.plateSnap,
  n: (i.deps.boundaries?.snapshots[String(i.plateSnap)] ?? []).length }; });
if (!pl.on || pl.snap == null || !pl.n) fail(`plate boundaries not drawn at 400 Ma (${JSON.stringify(pl)})`);
console.log(`plate boundaries at ${pl.snap} Ma: ${pl.n} boundaries`);
await shoot('13-vms-boundaries-400');
await setControl('boundaries coloured by', 'Convergence', 'select');
await shoot('14-vms-boundaries-convergence-400');
await setControl('boundaries coloured by', 'Type', 'select');
const teeth = await page.evaluate(() => window.__molchan.teeth.visible);
if (!teeth) fail('subduction teeth not drawn at 400 Ma');
await setAge(800);
const teeth800 = await page.evaluate(() => window.__molchan.teeth.visible);
if (!teeth800) fail('subduction teeth not drawn at 800 Ma');
await shoot('15-vms-boundaries-800');

// --- kimberlites (not ore deposits, run as one more type): the best-of-all map, 120 Ma ------
await setControl('Deposit type', 'Kimberlites', 'select');
await setControl('Show', 'Combination', 'select');
await setControl('Combination', 'Held-out test', 'select');
await setAge(120);
await shoot('16-kimberlite-best-of-all-120');
// the run with screened new factors (RiftsClimate's COMBO_STUDY=screened), where written
if (await page.evaluate(() => !!window.__molchan.deps.index.combos['Kimberlite|screened'])) {
  await setControl('candidates', 'With screened new factors', 'select');
  await setControl('Combination', 'Held-out test', 'select');
  await shoot('16b-kimberlite-screened-best-of-all-120');
  // slots are named by what filled them (or "varies by region"), never "@new idea"
  await setControl('Combination', 'Best 1', 'select');
  await page.waitForFunction(() => document.querySelectorAll('.combo-row').length > 0, null, { timeout: 30000 });
  const raw = await page.evaluate(() => document.body.innerText.split('\n').filter((l) => l.includes('@new idea')));
  if (raw.length) fail(`slot names left unnamed on screen: ${raw.slice(0, 3).join(' | ')}`);
  await shoot('16c-kimberlite-screened-best-1-120');
  // the combination to use (fitted on all regions), with what to expect on new ground
  await setControl('Combination', 'Combination to use', 'select');
  const useText = await page.$eval('.molchan-skill', (e) => e.innerText);
  if (!/not a test\. Expected on new ground .*: [+−]?\d\.\d{3}/.test(useText)) fail(`combination to use: "${useText}"`);
  await shoot('16d-kimberlite-screened-use-120');
  // the held-out test lists how many regions' picks hold each factor
  await setControl('Combination', 'Held-out test', 'select');
  const tallyText = await page.evaluate(() => document.body.innerText.includes("In the regions' picks (of "));
  if (!tallyText) fail('no tally of the regions\' picks under the held-out test');
  // the legend and the caption fold away, and come back
  await page.click('.legend-toggle');
  const legendHidden = await page.$eval('.legend-body', (e) => getComputedStyle(e).display === 'none');
  await page.click('.caption-toggle');
  const captionShort = await page.$$eval('.caption-counts', (els) => els.every((e) => getComputedStyle(e).display === 'none'));
  if (!legendHidden || !captionShort) fail(`folding: legend hidden ${legendHidden}, caption folded ${captionShort}`);
  await shoot('16e-kimberlite-screened-folded-120');
  await page.click('.legend-toggle');
  await page.click('.caption-toggle');
  await setControl('candidates', 'Main candidates', 'select');
}

// --- the new candidate factors (steps 1-2 only): kimberlites at 120 Ma -----------------------
await setControl('Show', 'One factor', 'select');
await setControl('Factor', 'tectonothermal age (TC1)', 'select');
await setControl('coloured by', 'Value', 'select');
const within = await page.$eval('.molchan-skill', (e) => e.innerText);
if (!/Within period [+−]\d\.\d{3}/.test(within)) fail(`no within-period skill for a new factor: "${within}"`);
await shoot('17-kimberlite-tc1-120-value');
await setControl('coloured by', 'Share', 'select');
await setControl('Factor', 'LIP within 10 Myr', 'select');
await setAge(800);
// no LIP record for ages older than 660 Ma: every square grey, out of the factor's test
const lipShares = await page.evaluate(() => { const b = window.__molchan.deps.boxes;
  const n = b.snapshots.snapshot_ma.length;
  const s = b.snapshots.snapshot_ma.findIndex((x, k) => b.snapshots.from_ma[k] <= 800 && 800 < b.snapshots.to_ma[k]);
  return b.shares['LIP within 10 Myr'].filter((v, k) => k % n === s && v != null).length; });
if (lipShares) fail(`LIP within 10 Myr has ${lipShares} shares at 800 Ma (no record there)`);
await shoot('18-kimberlite-lip-800-none');

if (errors.length) { failures += errors.length; console.log('ERRORS:\n' + errors.join('\n')); }
console.log(failures ? `${failures} problem(s)` : 'all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
