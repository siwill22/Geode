/**
 * Parity check: core/shSynthesis.ts against pyshtools SHMagCoeffs.expand.
 *
 *   python test-data/make_sh_fixture.py /tmp/geode-sh-fixture.json
 *   node scripts/check_sh_synthesis.mjs [/tmp/geode-sh-fixture.json]
 *
 * Point evaluation is float64 end to end and must match to 1e-6 nT (the
 * spec's acceptance threshold; the worst case is ~2e-8 nT, at 89.99 degrees
 * where pyshtools' own derivative is least accurate). Grids are stored as
 * Float32 for the GPU, so they are held to float32 precision (~1e-6 of scale). Pole rows are checked against exact
 * point evaluation at the pole (pyshtools cannot take dP/dtheta there), plus
 * the physical requirement that Br and |B| take one value around a pole.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const fixturePath = process.argv[2] ?? '/tmp/geode-sh-fixture.json';
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));

const result = await build({
  stdin: {
    contents: `export * from './src/core/shSynthesis.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const sh = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  else {
    console.error(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
    failures++;
  }
}
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

const COMPS = ['br', 'btheta', 'bphi'];
const { nlon, nlat } = fx.grid;

for (const [name, m] of Object.entries(fx.models)) {
  console.log(`\n${name} (lmax ${m.lmax}, r0 ${m.r0})`);
  const coeffs = { lmax: m.lmax, r0: m.r0, g: Float64Array.from(m.g), h: Float64Array.from(m.h) };

  // Spectrum at r0.
  const spec = sh.lowesSpectrum(coeffs, coeffs.r0);
  const specErr = maxAbs(spec.map((v, l) => (v - m.spectrum_r0[l]) / (Math.abs(m.spectrum_r0[l]) || 1)));
  check('Lowes spectrum matches pyshtools total', specErr < 1e-12, `max rel err ${specErr.toExponential(2)}`);

  for (const cs of m.cases) {
    const win = { lmin: cs.lmin, lmax: cs.lmax };
    const tag = `h=${cs.altitude / 1e3} km, l=${cs.lmin}-${cs.lmax}`;

    // Points (float64).
    for (const comp of COMPS) {
      const ref = cs.points[comp];
      const scale = maxAbs(ref) || 1;
      let err = 0;
      for (let i = 0; i < ref.length; i++) {
        const v = sh.evaluatePoint(coeffs, cs.r, fx.points.lat[i], fx.points.lon[i], win)[comp];
        err = Math.max(err, Math.abs(v - ref[i]));
      }
      check(`${tag} points ${comp}`, err < 1e-6,
        `max |d| ${err.toExponential(2)} nT (scale ${scale.toFixed(1)})`);
    }

    // Total-field anomaly in IGRF-13 (2020.0), remit's definition.
    {
      const ig = fx.igrf;
      const igrf = { lmax: ig.lmax, r0: ig.r0, g: Float64Array.from(ig.g), h: Float64Array.from(ig.h) };
      const ref = cs.points.tmi;
      let err = 0;
      for (let i = 0; i < ref.length; i++) {
        const la = fx.points.lat[i], lo = fx.points.lon[i];
        const f = sh.evaluatePoint(igrf, cs.r, la, lo, { lmin: 1, lmax: igrf.lmax });
        const b = sh.evaluatePoint(coeffs, cs.r, la, lo, win);
        const t = sh.totalFieldAnomaly(f.br, f.btheta, f.bphi, b.br, b.btheta, b.bphi);
        err = Math.max(err, Math.abs(t - ref[i]));
      }
      // The reference subtracts two ~5e4 nT magnitudes in float64, so it
      // carries ~1e-11 nT of its own rounding; 1e-6 nT is the spec threshold.
      check(`${tag} points tmi (IGRF-13 2020)`, err < 1e-6, `max |d| ${err.toExponential(2)} nT`);

      const mainGrid = sh.synthesizeGrid(igrf, cs.r, { lmin: 1, lmax: igrf.lmax }, { nlon, nlat }, COMPS);
      const crustGrid = sh.synthesizeGrid(coeffs, cs.r, win, { nlon, nlat }, COMPS);
      const tg = sh.totalFieldAnomalyGrid(mainGrid, crustGrid);
      let gerr = 0, gscale = 0;
      for (let j = 1; j < nlat - 1; j++) {
        for (let i = 0; i < nlon; i++) {
          const k = j * nlon + i;
          const la = -90 + (180 * j) / (nlat - 1), lo = -180 + ((i + 0.5) * 360) / nlon;
          const f = sh.evaluatePoint(igrf, cs.r, la, lo, { lmin: 1, lmax: igrf.lmax });
          const b = sh.evaluatePoint(coeffs, cs.r, la, lo, win);
          const t = sh.totalFieldAnomaly(f.br, f.btheta, f.bphi, b.br, b.btheta, b.bphi);
          gerr = Math.max(gerr, Math.abs(tg[k] - t));
          gscale = Math.max(gscale, Math.abs(t));
        }
      }
      // Float32 main-field components (~5e4 nT) limit the grid to ~1e-7 of
      // |F| times the anomaly's relative size; hold it to 1e-5 of scale.
      check(`${tag} grid tmi = point tmi`, gerr < 1e-5 * gscale,
        `max |d| ${gerr.toExponential(2)} nT (scale ${gscale.toFixed(1)})`);
    }

    // Grid (float32), interior rows against pyshtools.
    const t0 = performance.now();
    const grid = sh.synthesizeGrid(coeffs, cs.r, win, { nlon, nlat }, COMPS);
    const ms = performance.now() - t0;
    for (const comp of COMPS) {
      const ref = cs.grid[comp];
      const scale = maxAbs(ref) || 1;
      let err = 0;
      for (let j = 1; j < nlat - 1; j++) {
        for (let i = 0; i < nlon; i++) {
          const k = j * nlon + i;
          err = Math.max(err, Math.abs(grid[comp][k] - ref[k]));
        }
      }
      check(`${tag} grid ${comp}`, err < 2e-6 * scale,
        `max |d| ${err.toExponential(2)} nT (${ms.toFixed(0)} ms for 3 components)`);
    }

    // Pole rows: exact point evaluation at the pole, and single-valued Br, |B|.
    for (const [j, lat] of [[0, -90], [nlat - 1, 90]]) {
      let err = 0, brSpread = 0, bSpread = 0;
      const b0 = Math.hypot(grid.br[j * nlon], grid.btheta[j * nlon], grid.bphi[j * nlon]);
      for (let i = 0; i < nlon; i++) {
        const k = j * nlon + i;
        const lon = -180 + ((i + 0.5) * 360) / nlon;
        const p = sh.evaluatePoint(coeffs, cs.r, lat, lon, win);
        for (const comp of COMPS) err = Math.max(err, Math.abs(grid[comp][k] - p[comp]));
        brSpread = Math.max(brSpread, Math.abs(grid.br[k] - grid.br[j * nlon]));
        bSpread = Math.max(bSpread, Math.abs(Math.hypot(grid.br[k], grid.btheta[k], grid.bphi[k]) - b0));
      }
      const scale = maxAbs(cs.grid.br) || 1;
      check(`${tag} pole ${lat}: grid = exact point, Br and |B| single-valued`,
        err < 2e-6 * scale && brSpread < 2e-6 * scale && bSpread < 2e-6 * scale,
        `|d| ${err.toExponential(1)}, Br spread ${brSpread.toExponential(1)}, |B| spread ${bSpread.toExponential(1)}`);
    }
  }
}

// Difference across reference radii: (a - b) synthesised must equal a - b
// synthesised separately, at a radius that is neither model's r0.
{
  console.log('\ndifference across reference radii');
  const ms = Object.values(fx.models);
  const toC = (m) => ({ lmax: m.lmax, r0: m.r0, g: Float64Array.from(m.g), h: Float64Array.from(m.h) });
  const a = toC(ms.find((m) => m.r0 === 6371.2e3) ?? ms[0]);
  const b = toC(ms.find((m) => m.r0 === 6371.0e3) ?? ms[0]);
  const win = sh.commonBand(a, b, { lmin: 16, lmax: 300 });
  const d = sh.subtractCoeffs(a, b);
  const r = 6371.2e3 + 50e3;
  let err = 0, scale = 0;
  for (let i = 0; i < 200; i++) {
    const lat = fx.points.lat[i], lon = fx.points.lon[i];
    const pa = sh.evaluatePoint(a, r, lat, lon, win).br;
    const pb = sh.evaluatePoint(b, r, lat, lon, win).br;
    const pd = sh.evaluatePoint(d, r, lat, lon, win).br;
    err = Math.max(err, Math.abs(pd - (pa - pb)));
    scale = Math.max(scale, Math.abs(pa - pb));
  }
  check(`r0 ${a.r0} minus r0 ${b.r0}, band ${win.lmin}-${win.lmax}`, err < 1e-9 * scale,
    `max |d| ${err.toExponential(2)}`);
  const self = sh.degreeCorrelation(a, a);
  check('degree correlation of a model with itself is 1', self.slice(16).every((v) => Math.abs(v - 1) < 1e-12));
}

// Timing at the production size: lmax 300 on 0.25 degrees, Br only.
{
  const m = fx.models.synthetic;
  const c = { lmax: m.lmax, r0: m.r0, g: Float64Array.from(m.g), h: Float64Array.from(m.h) };
  const t0 = performance.now();
  sh.synthesizeGrid(c, 6371.2e3, { lmin: 16, lmax: 300 }, { nlon: 1440, nlat: 721 }, ['br']);
  console.log(`\ntiming: Br, lmax 300, 1440 x 721 grid: ${(performance.now() - t0).toFixed(0)} ms`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
