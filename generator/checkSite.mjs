/**
 * Serve a generated site's built dist/ and confirm it actually loads its data.
 *
 *   node generator/checkSite.mjs <siteDir>
 *
 * `npm run build` succeeding proves the code compiles, not that the site
 * works: a site that cannot reach its archive builds fine and then shows an
 * error, or worse a plausible empty globe. This is the gate that catches that.
 * It serves <siteDir>/dist on a local port, opens it headlessly, and passes
 * only if
 *
 *   - the wrapper's own test hook (window.__globe, __groupGlobe,
 *     __reconstruction or __reconstructionGroup) reaches ready === true, and
 *   - no request to the archive failed (HTTP >= 400 or a network error), and
 *   - the page threw no uncaught error.
 *
 * Needs network access to the recipe's dataHost.archiveBase, and Playwright,
 * which is resolved from this monorepo's viewer/node_modules so a generated
 * repo does not have to depend on it.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = {
  'single-model-globe': '__globe',
  'model-group-globe': '__groupGlobe',
  'single-reconstruction-globe': '__reconstruction',
  'reconstruction-group-globe': '__reconstructionGroup',
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

const siteDir = process.argv[2];
if (!siteDir) {
  console.error('usage: node generator/checkSite.mjs <siteDir>');
  process.exit(2);
}
const dist = path.resolve(siteDir, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`${dist}/index.html not found -- run \`npm run build\` in ${siteDir} first`);
  process.exit(2);
}
const recipe = JSON.parse(readFileSync(path.join(siteDir, 'recipe.json'), 'utf8'));
const hook = HOOK[recipe.wrapperType];
const archiveBase = recipe.dataHost.archiveBase.replace(/\/$/, '');

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'package.json'));
const { chromium } = require('playwright');

// A strict static server: a missing file is a real 404, not an index.html fallback.
const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(dist, rel);
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();

const failedRequests = [];
const pageErrors = [];
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`));
page.on('pageerror', (e) => pageErrors.push(String(e)));

let ready = false;
try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction((h) => window[h]?.ready === true, hook, { timeout: 120000 });
  ready = true;
} catch {
  const shown = await page.locator('#error').textContent().catch(() => null);
  if (shown) pageErrors.push(`on page: ${shown}`);
}
// Let the first frame's follow-up fetches (neighbour prefetch etc.) settle.
if (ready) await page.waitForTimeout(3000);

await browser.close();
server.close();

const archiveFailures = failedRequests.filter((r) => r.includes(archiveBase));
const otherFailures = failedRequests.filter((r) => !r.includes(archiveBase));

console.log(`  site          ${url}`);
console.log(`  archive       ${archiveBase}`);
console.log(`  ${hook}.ready  ${ready ? 'yes' : 'NO'}`);
console.log(`  archive requests failed: ${archiveFailures.length}`);
for (const r of archiveFailures.slice(0, 10)) console.log(`      ${r}`);
for (const r of otherFailures.slice(0, 10)) console.log(`  other request failed: ${r}`);
for (const e of pageErrors) console.log(`  page error: ${e}`);

const ok = ready && archiveFailures.length === 0 && pageErrors.length === 0;
console.log(ok ? '\nok: site loads its data' : '\nFAIL: site does not load cleanly');
process.exit(ok ? 0 : 1);
