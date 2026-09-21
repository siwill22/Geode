import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots-robinson';
const PORT = process.argv[3] ?? '5174';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:${PORT}/climate.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__climate?.ready === true, { timeout: 90000 });

// Wind glyphs are the thing the tangent-basis fix changes; arrows, not streaks,
// because a static arrow shows its direction in one frame.
await page.evaluate(() => window.__climate.setShowWind(true));
await page.evaluate(() => window.__climate.setWindStyle('glyph'));
await page.evaluate(() => window.__climate.setWindScale?.(2.2));
await page.waitForTimeout(1200);

for (const mode of ['globe', 'robinson', 'plateCarree']) {
  await page.evaluate((m) => window.__climate.setProjection(m), mode);
  await page.waitForTimeout(1400);
  const got = await page.evaluate(() => window.__climate.getProjection());
  const tip = await page.getAttribute('#projection-toggle', 'title');
  console.log(`${mode.padEnd(12)} -> getProjection=${String(got).padEnd(12)} button="${tip}"`);
  await page.screenshot({ path: `${OUT}/climate-${mode}.png` });
}

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
