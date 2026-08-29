/**
 * Run the TypeScript spherical scanline over a set of deliberately awkward
 * polygons and dump sampled inside/outside verdicts as JSON.
 *
 * test-data/check_mask.py then cross-checks every sample against
 * pygplates.PolygonOnSphere.is_point_in_polygon, which is the reference
 * implementation for this. pygplates cannot serve the mask at runtime -- the
 * polygon is drawn in the browser -- but it can hold the scanline to account
 * offline, which is what this pair of scripts does.
 *
 *   node scripts/dump_masks.mjs <out.json>
 */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT = process.argv[2] ?? 'masks.json';

// Bundle the scanline (and its three.js import) into something node can load.
const result = await build({
  entryPoints: ['src/mask.ts'],
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
const { rasteriseMask, MASK_W, MASK_H } = mod;

const DEG = Math.PI / 180;

/** Great-circle densification, mirroring constants.ts. */
function densify(verts, maxSpacingDeg = 0.5) {
  const toVec = ({ lon, lat }) => {
    const cl = Math.cos(lat * DEG);
    return [cl * Math.cos(lon * DEG), Math.sin(lat * DEG), cl * Math.sin(lon * DEG)];
  };
  const toLL = ([x, y, z]) => ({
    lat: Math.asin(Math.max(-1, Math.min(1, y))) / DEG,
    lon: Math.atan2(z, x) / DEG,
  });
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const va = toVec(verts[i]);
    const vb = toVec(verts[(i + 1) % verts.length]);
    const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
    const omega = Math.acos(dot);
    if (omega < 1e-9) { out.push(verts[i]); continue; }
    const n = Math.max(1, Math.ceil(omega / DEG / maxSpacingDeg));
    const s = Math.sin(omega);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const w0 = Math.sin((1 - t) * omega) / s;
      const w1 = Math.sin(t * omega) / s;
      out.push(toLL([
        w0 * va[0] + w1 * vb[0],
        w0 * va[1] + w1 * vb[1],
        w0 * va[2] + w1 * vb[2],
      ]));
    }
  }
  return out;
}

const CASES = {
  simple_equatorial: [[-30, 20], [30, 20], [30, -20], [-30, -20]],
  antimeridian: [[160, 30], [-160, 30], [-160, -30], [160, -30]],
  north_pole: [[0, 60], [90, 60], [180, 60], [-90, 60]],
  south_pole: [[0, -60], [-90, -60], [180, -60], [90, -60]],
  // Both poles: a lune spanning the full latitude range.
  both_poles: [[-10, 85], [10, 85], [10, -85], [-10, -85]],
  // Larger than a hemisphere once closed.
  greater_than_hemisphere: [[-170, 80], [-60, 80], [60, 80], [170, 80],
                            [170, -80], [60, -80], [-60, -80], [-170, -80]],
  high_latitude_band: [[-120, 70], [0, 75], [120, 70], [120, 40], [0, 45], [-120, 40]],
  narrow_sliver: [[-1, 40], [1, 40], [1, -40], [-1, -40]],
};

// Deterministic quasi-random sample points, area-weighted over the sphere.
function samplePoints(n) {
  const pts = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    pts.push({
      lon: rnd() * 360 - 180,
      lat: Math.asin(rnd() * 2 - 1) / DEG,
    });
  }
  return pts;
}

const samples = samplePoints(3000);
const out = { mask_w: MASK_W, mask_h: MASK_H, cases: {} };

for (const [name, verts] of Object.entries(CASES)) {
  const poly = verts.map(([lon, lat]) => ({ lon, lat }));
  const boundary = densify(poly);
  // inverted=false: the scanline marks the SMALLER region as removed.
  const mask = rasteriseMask(boundary, false);

  const verdicts = samples.map(({ lon, lat }) => {
    const i = Math.min(MASK_W - 1, Math.max(0,
      Math.floor(((lon + 180) / 360) * MASK_W)));
    const j = Math.min(MASK_H - 1, Math.max(0,
      Math.floor(((lat + 90) / 180) * MASK_H)));
    return mask[j * MASK_W + i] > 127 ? 1 : 0;
  });

  let filled = 0, total = 0;
  for (let j = 0; j < MASK_H; j++) {
    const lat = -90 + ((j + 0.5) * 180) / MASK_H;
    const w = Math.cos(lat * DEG);
    total += w * MASK_W;
    for (let i = 0; i < MASK_W; i++) if (mask[j * MASK_W + i]) filled += w;
  }

  out.cases[name] = {
    vertices: verts,
    marked_area_fraction: +(filled / total).toFixed(5),
    verdicts,
  };
  console.log(`  ${name.padEnd(26)} marked ${(100 * filled / total).toFixed(1)}% of sphere`);
}

out.samples = samples.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);
writeFileSync(OUT, JSON.stringify(out));
console.log(`\nwrote ${OUT}`);
