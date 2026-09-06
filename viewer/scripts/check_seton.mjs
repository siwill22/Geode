import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5173/reconstructionGroup.html';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => errors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__reconstructionGroup?.ready === true, { timeout: 60000 });

const initial = await page.evaluate(() => window.__reconstructionGroup.stats());
console.log('initial:', JSON.stringify(initial));

await page.evaluate(() => window.__reconstructionGroup.setReconstruction('seton2012'));
await page.waitForTimeout(500);
const afterSwitch = await page.evaluate(() => window.__reconstructionGroup.stats());
console.log('after switch to seton2012:', JSON.stringify(afterSwitch));

await page.evaluate(() => window.__reconstructionGroup.setAge(100));
await page.waitForTimeout(500);
const at100 = await page.evaluate(() => window.__reconstructionGroup.stats());
console.log('at 100 Ma:', JSON.stringify(at100));

await page.screenshot({ path: '/private/tmp/claude-503/-Users-simon-GIT-Geode/571ae3ce-cc04-4cd2-bac3-c13605bff5a4/scratchpad/seton-100ma.png' });

if (errors.length) {
  console.log('\nerrors:');
  for (const e of errors) console.log('  ' + e);
}

await browser.close();

const ok = afterSwitch.reconstruction === 'seton2012' && afterSwitch.hasBoundaries === true
  && at100.age === 100 && errors.length === 0;
console.log(ok ? '\nPASS' : '\nFAIL');
if (!ok) process.exitCode = 1;
