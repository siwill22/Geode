import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots-valdes';
const URL = 'http://localhost:5173/valdes.html';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__valdes?.ready === true, { timeout: 60000 });

async function shot(name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

console.log('stats @ boot:', await page.evaluate(() => window.__valdes.stats()));
await shot('01-boot-monthly-T');

await page.evaluate(() => window.__valdes.setAge(200));
await shot('02-monthly-age-200Ma');

await page.evaluate(() => window.__valdes.setVariable('SST'));
console.log('stats after SST:', await page.evaluate(() => window.__valdes.stats()));
await shot('03-monthly-sst');

await page.evaluate(() => window.__valdes.setVectorField('ocean_current'));
console.log('stats after ocean_current vector:', await page.evaluate(() => window.__valdes.stats()));
await shot('04-monthly-sst-ocean-current-glyphs');

await page.evaluate(() => window.__valdes.setVectorStyle('streak'));
await page.waitForTimeout(2000); // let streaks build up a trail
await shot('05-monthly-sst-ocean-current-streaks');

await page.evaluate(() => window.__valdes.setLayer('ocean_depth'));
console.log('stats after ocean_depth layer:', await page.evaluate(() => window.__valdes.stats()));
await shot('06-ocean-depth-otemp-surface');

await page.evaluate(() => window.__valdes.setLayerIndex(15));
console.log('stats after depth index 15:', await page.evaluate(() => window.__valdes.stats()));
await shot('07-ocean-depth-otemp-deep');

await page.evaluate(() => window.__valdes.setVariable('OVEL'));
await page.evaluate(() => window.__valdes.setVectorField('ocean_current'));
await shot('08-ocean-depth-ovel-with-current');

await page.evaluate(() => window.__valdes.setLayerIndex(19)); // deepest -- OVEL should be all NO_DATA here
await shot('09-ocean-depth-ovel-deepest-level');

console.log('\nconsole/page errors:', errors.length ? errors : 'none');
await browser.close();
