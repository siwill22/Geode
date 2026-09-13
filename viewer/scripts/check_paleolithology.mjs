/**
 * Drive climate.html headlessly to exercise the "Boucot paleolithology"
 * toggle end-to-end -- same chromium/window.__climate approach as
 * check_climate_regression.mjs/check_tracked_particles_browser.mjs. Clicks
 * the REAL lil-gui checkbox (not a test-hook bypass) per the project's own
 * "test real <select>/<input> clicks" lesson.
 *
 *   node scripts/check_paleolithology.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots-paleolithology';
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

const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:5173/climate.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__climate?.ready === true, { timeout: 60000 });

await page.evaluate(() => window.__climate.setCamera({ lon: 20, lat: 10, dist: 2.6 }));
await page.screenshot({ path: `${OUT}/01-off.png` });

// Click the REAL lil-gui checkbox by its label, not a test hook -- catches
// binding bugs a programmatic call would skip past (see
// feedback_lilgui_bound_state_guards). lil-gui renders a boolean controller
// as <label class="lil-controller lil-boolean"><div class="lil-name">...
// </div><div class="lil-widget"><input type=checkbox></div></label>.
const row = page.locator('label.lil-boolean', { has: page.locator('.lil-name', { hasText: 'Boucot paleolithology' }) });
check('the "Boucot paleolithology" checkbox exists', await row.count() > 0);
const checkbox = row.locator('input[type=checkbox]');
await checkbox.click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/02-on-age0.png` });

await page.evaluate(() => window.__climate.setAge(100));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/03-on-age100.png` });

await page.evaluate(() => window.__climate.setAge(300));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/04-on-age300.png` });

// Hover a point in the dense cluster visible in 04-on-age300.png and confirm
// a real tooltip appears -- reads the SAME DOM tooltip ClimateUI's Time
// Series hover uses (core/pointOverlay.ts's pick()/highlight() + ClimateUI's
// showPointTooltip()), not a test hook.
await page.mouse.move(500, 555);
await page.waitForTimeout(200);
const tooltipText = await page.evaluate(() => {
  const el = document.querySelector('.timeseries-tooltip');
  return el && getComputedStyle(el).display !== 'none' ? el.textContent : null;
});
check('hovering a point shows a tooltip with its metadata', !!tooltipText);
console.log('  tooltip text:', tooltipText);
await page.screenshot({ path: `${OUT}/04b-hover-tooltip.png` });

await page.evaluate(() => window.__climate.setAge(500));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/05-on-age500.png` });

// Plate Carrée: click the real projection-toggle button -- the overlay
// should now REPROJECT onto the flat map, not hide (core/pointOverlay.ts's
// FlatProjector), then switch back to Globe.
await page.click('#projection-toggle');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/06-platecarree.png` });
await page.click('#projection-toggle');
await page.waitForTimeout(300);
await page.evaluate(() => window.__climate.setAge(300));
await page.screenshot({ path: `${OUT}/07-back-to-globe.png` });

// Multi-globe: the "+ Add globe" button lives inside #globe-menu, which
// starts collapsed (see climate/main.ts's own doc comment) -- open it first.
await page.click('#globe-menu-toggle');
await page.click('#add-globe');
await page.waitForTimeout(500);
check('a second globe was added', await page.evaluate(() => window.__climate.globeCount()) === 2);
await page.screenshot({ path: `${OUT}/08-two-globes.png` });
await page.evaluate(() => window.__climate.removeGlobe(1));
await page.waitForTimeout(300);
check('the second globe was removed', await page.evaluate(() => window.__climate.globeCount()) === 1);

console.log('console/page errors:', errors.length ? errors : 'none');
if (errors.length) failures += errors.length;

await browser.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s)/error(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
