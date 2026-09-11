/**
 * Drive climate.html and valdes.html headlessly to exercise Tracked
 * Particle end-to-end (seed -> tick -> render), the piece
 * check_tracked_particles.mjs's pure-logic checks can't cover -- same
 * chromium/window.__climate/__valdes approach as check_climate_regression.mjs
 * and shoot_valdes.mjs.
 *
 *   node scripts/check_tracked_particles_browser.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots-tracked-particles';
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function runClimate() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:5173/climate.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__climate?.ready === true, { timeout: 60000 });

  // Li et al. (the default climate model) has a Wind field -- seed at a
  // point with a known strong, steady zonal wind component so the particle
  // visibly moves within a short, deterministic wait.
  check('starts with zero tracked particles', await page.evaluate(() => window.__climate.trackedParticleCount()) === 0);

  await page.evaluate(() => window.__climate.setCamera({ lon: 0, lat: 0, dist: 2.6 }));
  await page.evaluate(() => window.__climate.addTrackedParticle(0, 0));
  check('addTrackedParticle() seeds one particle', await page.evaluate(() => window.__climate.trackedParticleCount()) === 1);

  await page.waitForTimeout(1500); // several tick(dt) frames of real advection
  await page.screenshot({ path: `${OUT}/climate-tracked-particle.png` });

  await page.evaluate(() => window.__climate.clearTrackedParticles());
  check('clearTrackedParticles() empties the count', await page.evaluate(() => window.__climate.trackedParticleCount()) === 0);

  console.log('  climate.html console/page errors:', errors.length ? errors : 'none');
  if (errors.length) failures += errors.length;
  await page.close();
}

async function runValdes() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:5173/valdes.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__valdes?.ready === true, { timeout: 60000 });

  // Monthly's default Vector Field (Wind) should already be active per
  // ValdesInstance.boot()'s own "first available field" default.
  const vectorFieldId = await page.evaluate(() => window.__valdes.stats().vectorFieldId);
  check('valdes boots with a Vector Field already active', !!vectorFieldId);

  await page.evaluate(() => window.__valdes.addTrackedParticle(0, 0));
  check('addTrackedParticle() seeds one particle', await page.evaluate(() => window.__valdes.trackedParticleCount()) === 1);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/valdes-tracked-particle.png` });

  await page.evaluate(() => window.__valdes.clearTrackedParticles());
  check('clearTrackedParticles() empties the count', await page.evaluate(() => window.__valdes.trackedParticleCount()) === 0);

  console.log('  valdes.html console/page errors:', errors.length ? errors : 'none');
  if (errors.length) failures += errors.length;
  await page.close();
}

console.log('climate.html:');
await runClimate();
console.log('valdes.html:');
await runValdes();

await browser.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s)/error(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
