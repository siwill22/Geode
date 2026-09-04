import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots-climate-regression';
const URL = 'http://localhost:5173/climate.html';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__climate?.ready === true, { timeout: 60000 });

console.log('climateModelIds (should be Li/Pohl only, no bridge-valdes ids):',
  await page.evaluate(() => window.__climate.climateModelIds()));
console.log('stats @ boot:', await page.evaluate(() => window.__climate.stats()));

await page.evaluate(() => window.__climate.setClimateModel('climate-pohl2022'));
console.log('stats after switching to Pohl:', await page.evaluate(() => window.__climate.stats()));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/pohl.png` });

await page.evaluate(() => window.__climate.setLayer('paleogeography'));
console.log('stats after paleogeography:', await page.evaluate(() => window.__climate.stats()));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/paleogeography.png` });

console.log('\nconsole/page errors:', errors.length ? errors : 'none');
await browser.close();
