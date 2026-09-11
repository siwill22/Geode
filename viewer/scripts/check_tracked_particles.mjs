/**
 * Exercise core/trackedParticles.ts's advection/compaction/stall logic
 * against synthetic (u, v) planes -- no browser, same bundle-and-run-under-
 * node approach as check_query_point.mjs.
 *
 *   node scripts/check_tracked_particles.mjs
 */
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: `export { TrackedParticles } from './src/core/trackedParticles.ts';`,
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
const { TrackedParticles } = mod;

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}
function close(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// A 4x3 grid (nlon, nlat), one texel per cell -- large enough that a single
// advection step doesn't cross into a neighbouring cell, so every particle
// samples the same (u, v) byte across the whole test.
const nlon = 4, nlat = 3;
const U_VAR = { id: 'u', encode_min: -50, encode_max: 50 };
const V_VAR = { id: 'v', encode_min: -50, encode_max: 50 };
const SENTINEL = 254;

function plane(fill) {
  return new Uint8Array(nlon * nlat).fill(fill);
}

// ---------------------------------------------------------------------------
// add(): seeds exactly one particle, one path point, visible group members.
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  check('starts with zero particles', tp.count === 0);
  tp.add({ lon: 0, lat: 0 });
  check('add() seeds one particle', tp.count === 1);
  check('seeded particle starts at the click lon/lat', tp.particles[0].lon === 0 && tp.particles[0].lat === 0);
  check('seeded particle has exactly one path point', tp.particles[0].count === 1);
  check('group gets a line + head per particle', tp.group.children.length === 2);
}

// ---------------------------------------------------------------------------
// update(): a pure-eastward (u > 0, v = 0) field at the equator increases
// longitude and leaves latitude ~unchanged; a pure-northward field increases
// latitude. Byte 191.5 decodes to encode_min + (191.5/255)*100 = ~25.1 m/s.
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  tp.add({ lon: 0, lat: 0 });
  const eastByte = 204; // decodes to +30 m/s
  const calmByte = 128; // decodes to ~0.2 m/s, effectively calm
  tp.update(1 / 60, plane(eastByte), plane(calmByte), nlon, nlat, U_VAR, V_VAR);
  const p = tp.particles[0];
  check('eastward wind increases longitude', p.lon > 0);
  check('eastward wind leaves latitude ~unchanged', close(p.lat, 0, 0.5));
  check('a second path point was recorded', p.count === 2);

  const tpNorth = new TrackedParticles();
  tpNorth.add({ lon: 0, lat: 0 });
  tpNorth.update(1 / 60, plane(calmByte), plane(204), nlon, nlat, U_VAR, V_VAR);
  check('northward wind increases latitude', tpNorth.particles[0].lat > 0);
}

// ---------------------------------------------------------------------------
// Sentinel: a particle sitting on a sentinel texel freezes permanently,
// never advances lon/lat or its path count again on later ticks.
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  tp.add({ lon: 0, lat: 0 });
  const uData = plane(SENTINEL);
  const vData = plane(128);
  tp.update(1 / 60, uData, vData, nlon, nlat, U_VAR, V_VAR, SENTINEL);
  const p = tp.particles[0];
  check('a particle on a sentinel texel stalls', p.stalled === true);
  check('a stalled particle does not record a new path point', p.count === 1);

  // Field changes (sentinel clears) on a later tick -- still must not resume,
  // since `stalled` is a one-way, permanent freeze once triggered.
  tp.update(1 / 60, plane(204), plane(128), nlon, nlat, U_VAR, V_VAR, SENTINEL);
  check('a stalled particle stays stalled even if the field later changes', p.count === 1 && p.stalled === true);
}

// ---------------------------------------------------------------------------
// clear(): empties the particle list and detaches every group child.
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  tp.add({ lon: 0, lat: 0 });
  tp.add({ lon: 10, lat: 10 });
  tp.clear();
  check('clear() empties the particle count', tp.count === 0);
  check('clear() detaches every group child', tp.group.children.length === 0);
}

// ---------------------------------------------------------------------------
// setProjection(): Plate Carree isn't supported yet -- switching to it
// clears whatever was tracked, same as clear().
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  tp.add({ lon: 0, lat: 0 });
  tp.setProjection('plateCarree');
  check('switching to plateCarree clears every particle', tp.count === 0);

  const tpGlobe = new TrackedParticles();
  tpGlobe.add({ lon: 0, lat: 0 });
  tpGlobe.setProjection('globe');
  check('staying on globe keeps particles', tpGlobe.count === 1);
}

// ---------------------------------------------------------------------------
// compact(): forcing a particle's path past MAX_PATH_POINTS halves its
// resolution rather than growing the buffer or dropping the particle.
// ---------------------------------------------------------------------------
{
  const tp = new TrackedParticles();
  tp.add({ lon: 0, lat: 0 });
  const eastByte = 204;
  const calmByte = 128;
  // A few thousand ticks of steady eastward flow -- enough to cross
  // MAX_PATH_POINTS (4000) at least once, forcing at least one compaction.
  for (let i = 0; i < 4500; i++) {
    tp.update(1 / 60, plane(eastByte), plane(calmByte), nlon, nlat, U_VAR, V_VAR);
  }
  const p = tp.particles[0];
  check('compaction keeps the path buffer bounded', p.count < 4500 && p.count > 0);
  check('the particle kept advancing after compaction (still moving east)', p.lon !== 0);
  check('geometry drawRange matches the compacted count', p.geometry.drawRange.count === p.count);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
