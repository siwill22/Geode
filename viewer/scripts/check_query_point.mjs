/**
 * Exercise core/queryPoint.ts and core/frameByteCache.ts against synthetic
 * fixture bytes -- no browser, no three.js renderer, same
 * bundle-and-run-under-node approach as check_mask.py's companion
 * dump_masks.mjs uses for the mask scanline.
 *
 *   node scripts/check_query_point.mjs
 */
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: `
      export { monthProfile, ageSeries } from './src/core/queryPoint.ts';
      export { computeTimeSeries } from './src/core/timeSeries.ts';
      export { FrameByteCache } from './src/core/frameByteCache.ts';
      export { texelIndex, cellCenter } from './src/core/volume.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const code = result.outputFiles[0].text;
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
const {
  monthProfile, ageSeries, computeTimeSeries, FrameByteCache, texelIndex, cellCenter,
} = mod;

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}
function close(a, b, eps = 1e-9) {
  return Number.isNaN(a) && Number.isNaN(b) ? true : Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// texelIndex / cellCenter: antimeridian wrap and pole clamp.
// ---------------------------------------------------------------------------
{
  const nlon = 4, nlat = 3;
  check('texelIndex wraps lon=180 to column 0', texelIndex(nlon, nlat, 180, 0) % nlon === 0);
  check('texelIndex wraps lon=-180 to column 0', texelIndex(nlon, nlat, -180, 0) % nlon === 0);
  check('texelIndex clamps lat=200 to the last row',
    Math.floor(texelIndex(nlon, nlat, 0, 200) / nlon) === nlat - 1);
  check('texelIndex clamps lat=-200 to row 0',
    Math.floor(texelIndex(nlon, nlat, 0, -200) / nlon) === 0);

  const idx = texelIndex(nlon, nlat, -45, 0);
  const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));
  check('cellCenter round-trips an exact grid point', close(cell.lon, -45) && close(cell.lat, 0));
}

// ---------------------------------------------------------------------------
// Fixture: a 4x3 grid, 3 depth layers (2 "months" + Annual), 4 Frames.
// Query point (-45, 0) resolves to idx 5 (iLon=1, jLat=1) -- see the
// texelIndex check above.
// ---------------------------------------------------------------------------
const nlon = 4, nlat = 3, ndepth = 3, plane = nlon * nlat;
const QUERY = { lon: -45, lat: 0 };
const QUERY_IDX = 5;
const SENTINEL = 254;

function frameBytes({ month0 = 0, month1 = 0, annual = 0 } = {}) {
  const buf = new Uint8Array(plane * ndepth);
  buf[0 * plane + QUERY_IDX] = month0;
  buf[1 * plane + QUERY_IDX] = month1;
  buf[2 * plane + QUERY_IDX] = annual;
  return buf;
}
function maskBytes(validAtQuery) {
  const buf = new Uint8Array(plane * ndepth).fill(255); // valid everywhere else
  buf[QUERY_IDX] = validAtQuery ? 255 : 0; // read at layer 0 (broadcast), see loadMask2D
  buf[plane + QUERY_IDX] = validAtQuery ? 255 : 0;
  buf[2 * plane + QUERY_IDX] = validAtQuery ? 255 : 0;
  return buf;
}

const manifest = {
  id: 'm1',
  default_resolution: 'r1',
  resolutions: [{ id: 'r1', nlon, nlat, ndepth }],
  frames: [
    { id: 'f0', age_ma: 0 },
    { id: 'f1', age_ma: 10 },
    { id: 'f2', age_ma: 20 },
    { id: 'f3', age_ma: 30 },
  ],
  path_template: '{variable}/{resolution}/{frame}.bin',
  default_variable: 'v',
  variables: [
    { id: 'v', encode_min: 0, encode_max: 255 },
    { id: 'cat', encode_min: 0, encode_max: 255, categorical: true, class_names: ['a', 'b'] },
  ],
  mask_variable: 'mask',
  no_data_sentinel: SENTINEL,
};

const FIXTURES = new Map([
  ['v/r1/f0.bin', frameBytes({ month0: 10, month1: 50, annual: 90 })],
  ['v/r1/f1.bin', frameBytes({ annual: 200 })],
  ['v/r1/f2.bin', frameBytes({ annual: 123 })], // masked at f2 -- value irrelevant
  ['v/r1/f3.bin', frameBytes({ annual: SENTINEL })], // sentinel at f3
  ['cat/r1/f0.bin', frameBytes({ month0: 1, month1: 0, annual: 1 })],
  ['cat/r1/f1.bin', frameBytes({ annual: 1 })],
  ['cat/r1/f2.bin', frameBytes({ annual: 1 })],
  ['cat/r1/f3.bin', frameBytes({ annual: 1 })],
  ['mask/r1/f0.bin', maskBytes(true)],
  ['mask/r1/f1.bin', maskBytes(true)],
  ['mask/r1/f2.bin', maskBytes(false)],
  ['mask/r1/f3.bin', maskBytes(true)],
]);
const fetchCounts = new Map();
globalThis.fetch = async (path) => {
  const key = path.replace(/^\/models\/m1\//, '');
  fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
  const bytes = FIXTURES.get(key);
  if (!bytes) return { ok: false, status: 404 };
  return { ok: true, arrayBuffer: async () => bytes.slice().buffer };
};

// ---------------------------------------------------------------------------
// Month Profile: synchronous, reads a stand-in "already-loaded texture".
// ---------------------------------------------------------------------------
{
  const res = manifest.resolutions[0];
  const variable = manifest.variables[0]; // 'v'
  const tex = { image: { data: frameBytes({ month0: 10, month1: 50, annual: 90 }) } };

  const profile = monthProfile(tex, res, variable, QUERY);
  check('monthProfile returns one sample per depth layer', profile.length === ndepth);
  check('monthProfile reads month 0 correctly', close(profile[0].value, 10));
  check('monthProfile reads month 1 correctly', close(profile[1].value, 50));
  check('monthProfile reads Annual correctly', close(profile[2].value, 90));
  check('monthProfile reports the sampled cell centre, not the raw click',
    close(profile[0].cell.lon, -45) && close(profile[0].cell.lat, 0));

  const masked = monthProfile(tex, res, variable, QUERY, { maskBytes: maskBytes(false) });
  check('monthProfile reports NaN for a masked cell', masked.every((s) => Number.isNaN(s.value)));

  const sentinelTex = { image: { data: frameBytes({ annual: SENTINEL }) } };
  const bySentinel = monthProfile(sentinelTex, res, variable, QUERY, { sentinel: SENTINEL });
  check('monthProfile reports NaN for a sentinel byte', Number.isNaN(bySentinel[2].value));

  const catProfile = monthProfile(
    tex, res, manifest.variables[1], QUERY,
  );
  check('monthProfile does not exclude a categorical variable', catProfile.length === ndepth
    && !catProfile.some((s) => Number.isNaN(s.value)));
}

// ---------------------------------------------------------------------------
// Age Series: fetches through FrameByteCache.
// ---------------------------------------------------------------------------
{
  const cache = new FrameByteCache('');
  const variable = manifest.variables[0]; // 'v'
  const series = await ageSeries(cache, manifest, variable, QUERY);

  check('ageSeries returns one point per Frame', series.length === manifest.frames.length);
  check('ageSeries f0 (Annual=90, valid)', close(series[0].value, 90));
  check('ageSeries f1 (Annual=200, valid)', close(series[1].value, 200));
  check('ageSeries f2 is NaN (masked at the query cell)', Number.isNaN(series[2].value));
  check('ageSeries f3 is NaN (sentinel byte at the query cell)', Number.isNaN(series[3].value));
  check('ageSeries carries each Frame\'s age', series.map((s) => s.age).join(',') === '0,10,20,30');

  const catCache = new FrameByteCache('');
  const catSeries = await ageSeries(catCache, manifest, manifest.variables[1], QUERY);
  check('ageSeries does not exclude a categorical variable', !Number.isNaN(catSeries[0].value));
}

// ---------------------------------------------------------------------------
// Cache sharing: computeTimeSeries and ageSeries against the same cache
// must not fetch any (variable, frame) pair twice -- see ADR-0011.
// ---------------------------------------------------------------------------
{
  fetchCounts.clear();
  const cache = new FrameByteCache('');
  const variable = manifest.variables[0]; // 'v'

  await computeTimeSeries(cache, manifest, variable);
  await ageSeries(cache, manifest, variable, QUERY);

  const overFetched = [...fetchCounts.entries()].filter(([, n]) => n > 1);
  check(
    'computeTimeSeries + ageSeries share one fetch per Frame, not two',
    overFetched.length === 0,
  );
  if (overFetched.length) console.error('    over-fetched:', overFetched);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
