/**
 * core/shSynthesis.ts computeField and core/shSynthesisClient.ts, with an
 * in-process fake worker -- no browser.
 *
 *   node scripts/check_sh_client.mjs
 *
 * Checks: a difference of linear components equals the difference of the two
 * maps; |B| and TMI differences are taken map-minus-map (not |A - B|); the
 * common band is reported; per-slot coalescing drops superseded requests and
 * never delivers a stale map; the cache serves repeats without a worker trip.
 */
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: `
      export * from './src/core/shSynthesis.ts';
      export { ShSynthesisClient, fieldSpecKey } from './src/core/shSynthesisClient.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
});
const sh = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  else { console.error(`  FAIL ${name}${detail ? '  ' + detail : ''}`); failures++; }
}

// Two random models with different lmax and r0, plus a dipole-ish main field.
function randomModel(lmax, r0, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const c = sh.emptyCoeffs(lmax, r0);
  for (let l = 1; l <= lmax; l++) for (let m = 0; m <= l; m++) {
    c.g[sh.shIndex(l, m)] = rnd() * 20 / Math.sqrt(l);
    if (m) c.h[sh.shIndex(l, m)] = rnd() * 20 / Math.sqrt(l);
  }
  return c;
}
const A = randomModel(60, 6371.2e3, 1);
const B = randomModel(40, 6371.0e3, 2);
const MAIN = sh.emptyCoeffs(1, 6371.2e3);
MAIN.g[sh.shIndex(1, 0)] = -29404.8; MAIN.g[sh.shIndex(1, 1)] = -1450.9; MAIN.h[sh.shIndex(1, 1)] = 4652.5;
const store = new Map([['A', A], ['B', B], ['igrf', MAIN]]);
const models = { get: (id) => store.get(id), mainFieldId: 'igrf' };
const grid = { nlon: 48, nlat: 25 };
const base = { r: 6371.2e3 + 100e3, window: { lmin: 16, lmax: 300 }, grid };

console.log('computeField');
for (const component of ['br', 'btheta', 'bphi', 'intensity', 'tmi']) {
  const d = sh.computeField({ ...base, model: ['A', 'B'], component }, models);
  const band = sh.commonBand(A, B, base.window);
  const a = sh.computeField({ ...base, window: band, model: 'A', component }, models);
  const b = sh.computeField({ ...base, window: band, model: 'B', component }, models);
  let err = 0, scale = 0;
  for (let i = 0; i < d.values.length; i++) {
    err = Math.max(err, Math.abs(d.values[i] - (a.values[i] - b.values[i])));
    scale = Math.max(scale, Math.abs(a.values[i] - b.values[i]));
  }
  check(`${component}: A - B = map(A) - map(B) over the common band`, err < 1e-5 * scale,
    `band ${d.band.lmin}-${d.band.lmax}, max |d| ${err.toExponential(1)}`);
}
{
  // |B| of the difference is not the difference of |B| -- guard against a
  // refactor that routes intensity through subtractCoeffs.
  const d = sh.computeField({ ...base, model: ['A', 'B'], component: 'intensity' }, models);
  const band = sh.commonBand(A, B, base.window);
  const wrong = sh.computeField({ ...base, window: band, model: 'D', component: 'intensity' },
    { get: (id) => (id === 'D' ? sh.subtractCoeffs(A, B) : store.get(id)), mainFieldId: 'igrf' });
  let diff = 0;
  for (let i = 0; i < d.values.length; i++) diff = Math.max(diff, Math.abs(d.values[i] - wrong.values[i]));
  check('intensity difference is |A| - |B|, not |A - B|', diff > 1, `they differ by up to ${diff.toFixed(1)} nT`);
  check('single model band is clamped to its lmax',
    sh.computeField({ ...base, model: 'B', component: 'br' }, models).band.lmax === 40);
}

console.log('\nShSynthesisClient');
// Fake worker: runs computeField on a later tick, like a real one would.
let synthCalls = 0;
function fakeWorker() {
  const local = new Map();
  const lookup = { get: (id) => local.get(id), mainFieldId: '' };
  const w = {
    onmessage: null,
    postMessage(msg) {
      if (msg.type === 'register') local.set(msg.id, msg.coeffs);
      else if (msg.type === 'main') lookup.mainFieldId = msg.id;
      else if (msg.type === 'synth') {
        synthCalls++;
        setTimeout(() => {
          const result = sh.computeField(msg.spec, lookup);
          w.onmessage({ data: { type: 'done', reqId: msg.reqId, result } });
        }, 5);
      }
    },
  };
  return w;
}
const client = new sh.ShSynthesisClient({ workers: 1, cacheEntries: 4, createWorker: fakeWorker });
for (const [id, c] of store) client.register(id, c);
client.setMainField('igrf');

const spec = (lmax) => ({ ...base, model: 'A', component: 'br', window: { lmin: 16, lmax } });
{
  // A drag: 5 requests in a row on one slot. The first starts at once (the
  // worker is idle), 2-4 are superseded while queued, 5 is the one that counts.
  synthCalls = 0;
  const ps = [20, 25, 30, 35, 40].map((l) => client.request('tile0', spec(l)));
  const rs = await Promise.all(ps);
  check('queued superseded requests resolve to null', rs.slice(1, 4).every((r) => r === null));
  check('the running request finishes but is not delivered (slot moved on)', rs[0] === null);
  check('the latest request is delivered', rs[4] && rs[4].band.lmax === 40);
  check('only 2 syntheses ran for 5 requests', synthCalls === 2, `ran ${synthCalls}`);
  check('the superseded-but-finished map was still cached', !!client.cached(spec(20)));
}
{
  synthCalls = 0;
  const r = await client.request('tile0', spec(40));
  check('a repeat is served from the cache', r && synthCalls === 0);
  const [x, y] = await Promise.all([
    client.request('tile0', spec(50)),
    client.request('tile1', { ...spec(50), model: 'B' }),
  ]);
  check('two slots do not supersede each other', x && y && x.band.lmax === 50 && y.band.lmax === 40);
}
{
  for (const l of [21, 22, 23, 24, 26]) await client.request('tile2', spec(l));
  check('cache evicts least recently used past its size', !client.cached(spec(20)) && !!client.cached(spec(26)));
}

{
  // Re-registering while a synthesis runs: the old-coefficient map must not
  // be cached or delivered; the re-request gets the new coefficients.
  const p = client.request('tile3', spec(33));
  client.register('A', B);
  const stale = await p;
  check('a map computed before re-registration is dropped', stale === null && !client.cached(spec(33)));
  const fresh = await client.request('tile3', spec(33));
  check('the re-request uses the new coefficients', fresh && fresh.band.lmax === 33 &&
    Math.abs(fresh.values[100] - sh.computeField({ ...spec(33), model: 'B' }, models).values[100]) < 1e-6);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
