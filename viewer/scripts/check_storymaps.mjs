import { chromium } from 'playwright';
const PORT = 8901;
const SHOTS = new URL('../shots-storymaps/', import.meta.url).pathname;
const pages = [
  ['lips', 'robinson'], ['detrital-zircons', 'robinson'],
  ['plate-boundaries', 'orthographic'], ['zircons', 'orthographic'],
  ['tectonic-co2', 'orthographic'],
];
// spilhaus-viewer is deliberately absent: it imports nothing from shared/, and it
// is broken independently of anything here -- simple-map.js:128 reads an
// undefined `path`, and it fetches ../data/coastlines.json, which does not exist.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let bad = 0;
for (const [name, kind] of pages) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/${name}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  const canvases = await page.evaluate(() => {
    // A canvas that drew nothing is the failure mode a load event won't catch.
    return [...document.querySelectorAll('canvas')].map((c) => c.width * c.height).filter((a) => a > 0).length;
  });
  const real = errs.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  console.log(`${name.padEnd(18)} ${kind.padEnd(13)} canvases=${canvases} errors=${real.length}`);
  if (real.length) { bad++; real.slice(0, 3).forEach((e) => console.log(`    ${e.slice(0, 150)}`)); }
  if (canvases === 0) { bad++; console.log('    NO CANVAS DREW'); }
  await page.screenshot({ path: `${SHOTS}/${name}.png` });

  // Robinson is behind a toggle, and it is the projection shared/js/geo.js
  // actually changed -- a default-view screenshot would pass while it was
  // broken. Switch, then re-check for errors raised by the switch itself.
  if (kind === 'robinson') {
    const before = errs.length;
    const toggle = page.getByText(/Robinson view/i).first();
    if (await toggle.count() === 0) {
      bad++; console.log('    no Robinson toggle found -- check the selector');
    } else {
      await toggle.click();
      await page.waitForTimeout(6000);   // the projection swap animates the camera
      const after = errs.filter((e) => !/favicon|404 \(Not Found\)/i.test(e)).length;
      const drew = await page.evaluate(() => [...document.querySelectorAll('canvas')]
        .some((c) => c.width * c.height > 0));
      console.log(`${''.padEnd(18)} -> robinson    drew=${drew} newErrors=${after - before}`);
      if (!drew || after > before) { bad++; }
      await page.screenshot({ path: `${SHOTS}/${name}-robinson.png` });
    }
  }
  await page.close();
}
console.log(bad === 0 ? '\nOK -- every page loaded and drew' : `\n${bad} PAGE(S) FAILED`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
