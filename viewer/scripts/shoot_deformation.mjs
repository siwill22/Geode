import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots-deform';
const URL = 'http://localhost:5173/deformation.html';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__deformation?.ready === true, { timeout: 60000 });

async function shot(name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

const bootStats = await page.evaluate(() => window.__deformation.stats());
console.log('stats @ boot:', bootStats);
// Which reconstruction boots first is just archive.json's discovery order
// (see main.ts's boot()) -- not asserted here, since asserting one specific
// id would reintroduce exactly the kind of hardcoded assumption this
// metadata-driven scheme exists to avoid. Explicit setReconstruction() calls
// below cover the behaviour that matters.
if (!['muller2019', 'cao2024'].includes(bootStats.reconstruction)) {
  console.log(`FAIL: boot reconstruction is ${bootStats.reconstruction}, expected one of muller2019/cao2024`);
}
await shot('01-boot-horizontal-divergence-0Ma-with-land-fill');

await page.evaluate(() => window.__deformation.setAge(100));
await shot('02-age-100Ma');

await page.evaluate(() => window.__deformation.setVariable('deformation_style'));
await shot('03-deformation-style-categorical');

await page.evaluate(() => window.__deformation.setNoDataStyle('grey'));
await shot('04-nodata-grey');

await page.evaluate(() => window.__deformation.setNoDataStyle('white'));
await shot('05-nodata-white');
await page.evaluate(() => window.__deformation.setNoDataStyle('transparent'));

// effective_strain_rate spans ~4 orders of magnitude (99.5th-percentile clip
// can run 1e-17 to 1e-13 s^-1) -- the case the "log scale" clip option
// exists for. Confirm the variable dropdown stays in sync with a
// programmatic setVariable() call (regression check: this used to only
// update via a real dropdown click, see deformationInstance.ts's
// setVariable()) and that switching to it shows the log-scale checkbox.
await page.evaluate(() => window.__deformation.setVariable('effective_strain_rate'));
const dropdownText = await page.evaluate(() => [...document.querySelectorAll('.lil-controller.lil-option')]
  .find((c) => c.querySelector('.lil-name')?.textContent === 'variable')
  ?.querySelector('.lil-display')?.textContent);
if (dropdownText !== 'Effective Strain Rate') {
  console.log(`FAIL: variable dropdown reads "${dropdownText}", expected "Effective Strain Rate"`);
}
await shot('06-effective-strain-rate-wide-range');

// Age & Heat Flux is assumed present-day: switching to it must pin age to 0
// (both data and coastlines) and hide the age slider entirely; switching
// back must restore whatever age Deformation was previously showing.
await page.evaluate(() => window.__deformation.setAge(150));
await page.evaluate(() => window.__deformation.setLayer('ageHeatflux'));
await page.evaluate(() => window.__deformation.setVariable('composite_age'));
const pinnedStats = await page.evaluate(() => window.__deformation.stats());
if (pinnedStats.age !== 0) {
  console.log(`FAIL: Age & Heat Flux age is ${pinnedStats.age}, expected 0`);
}
await shot('07-age-heatflux-composite-age-grey-land-under-nodata');

await page.evaluate(() => window.__deformation.setLayer('deformation'));
const restoredStats = await page.evaluate(() => window.__deformation.stats());
if (restoredStats.age !== 150) {
  console.log(`FAIL: Deformation age after returning is ${restoredStats.age}, expected 150 (lastDeformationAge)`);
}

// Cao2024 spans 0-1000 Ma vs Muller2019's 0-240 Ma -- switching reconstruction
// while scrubbed to age 150 should keep 150 (in range for both), and the age
// slider's own min/max should widen to match Cao2024's own Frame span.
await page.evaluate(() => window.__deformation.setVariable('horizontal_divergence'));
await page.evaluate(() => window.__deformation.setAge(150));
await page.evaluate(() => window.__deformation.setReconstruction('cao2024'));
const cao2024Stats = await page.evaluate(() => window.__deformation.stats());
if (cao2024Stats.reconstruction !== 'cao2024') {
  console.log(`FAIL: reconstruction is ${cao2024Stats.reconstruction}, expected cao2024`);
}
if (cao2024Stats.age !== 150) {
  console.log(`FAIL: age after switching to cao2024 is ${cao2024Stats.age}, expected 150 (within its 0-1000 Ma range)`);
}
const cao2024AgeRange = await page.evaluate(() => {
  const c = window.__deformation.getGui().controllersRecursive()
    .find((ctrl) => ctrl._name === 'age (Ma)');
  return c ? { min: c._min, max: c._max } : null;
});
if (!cao2024AgeRange || cao2024AgeRange.max !== 1000) {
  console.log(`FAIL: age slider max after switching to cao2024 is ${cao2024AgeRange?.max}, expected 1000`);
}
// The core regression this whole reconstruction-switch feature exists for:
// the coastlines/credit shown must match what THIS model's own manifest
// says it was reconstructed against, never a hardcoded assumption.
const cao2024Credit = await page.evaluate(() => document.querySelector('.credit')?.textContent ?? '');
if (!cao2024Credit.includes('Cao') || cao2024Credit.includes('Muller')) {
  console.log(`FAIL: credit line on cao2024 reads "${cao2024Credit}", expected it to name Cao (not Muller)`);
}
await shot('08-cao2024-horizontal-divergence-150Ma');

// Switching to an age beyond Muller2019's 240 Ma range then back must clamp,
// not silently go out of range or throw.
await page.evaluate(() => window.__deformation.setAge(600));
await page.evaluate(() => window.__deformation.setReconstruction('muller2019'));
const backToMuller = await page.evaluate(() => window.__deformation.stats());
if (backToMuller.age > 240) {
  console.log(`FAIL: age after switching back to muller2019 is ${backToMuller.age}, expected <= 240 (clamped)`);
}
const mullerCredit = await page.evaluate(() => document.querySelector('.credit')?.textContent ?? '');
if (!mullerCredit.includes('Muller') || mullerCredit.includes('Cao')) {
  console.log(`FAIL: credit line on muller2019 reads "${mullerCredit}", expected it to name Muller (not Cao)`);
}
await shot('09-back-to-muller2019-clamped-age');

console.log('stats @ end:', restoredStats);

if (errors.length) {
  console.log('\nCONSOLE/PAGE ERRORS:');
  for (const e of errors) console.log(' ', e);
} else {
  console.log('\nno console/page errors');
}

await browser.close();
