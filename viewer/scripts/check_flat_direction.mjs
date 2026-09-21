/*
 * Does a physical (east, north) tangent land on the map pointing the right way
 * in each flat Projection?
 *
 * Plate Carrée's answer is trivially (u, v) -- its meridians are parallel. The
 * case that matters is Robinson, whose meridians converge toward the central
 * one, so "north" tilts by an amount that depends on longitude and reverses
 * sign across the map. Getting this wrong points every wind arrow wrong away
 * from the centre, and it is invisible in a screenshot unless you know the
 * expected angle.
 *
 * Runs the REAL core/projection.ts through Vite's module server rather than a
 * reimplementation of it, so this cannot pass against a copy that has drifted.
 * Needs `npm run dev` up; pass its port if not 5173.
 */
import { chromium } from 'playwright';

const PORT = process.argv[2] ?? '5173';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/climate.html`, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(async () => {
  const { flatDirection } = await import('/src/core/projection.ts');
  const at = [
    { lon: 0, lat: 45 }, { lon: -150, lat: 45 }, { lon: 150, lat: 45 },
    { lon: -150, lat: -60 }, { lon: 90, lat: 10 },
  ];
  const out = [];
  for (const p of at) {
    for (const mode of ['plateCarree', 'robinson']) {
      // Pure north, and pure east, as unit physical tangents.
      const n = flatDirection(mode, p.lon, p.lat, 0, 1);
      const e = flatDirection(mode, p.lon, p.lat, 1, 0);
      const deg = (d) => (Math.atan2(d[0], d[1]) * 180) / Math.PI; // 0 = up, +ve = tilted right
      out.push({
        lon: p.lon, lat: p.lat, mode,
        northTiltDeg: +deg(n).toFixed(2),
        eastTiltDeg: +(((Math.atan2(e[1], e[0]) * 180) / Math.PI)).toFixed(2),
      });
    }
  }
  return out;
});

let bad = 0;
const check = (cond, msg) => { if (!cond) { bad++; console.log(`  FAIL ${msg}`); } };

console.log('lon    lat   mode          north tilt   east tilt (0 = +x)');
for (const r of rows) {
  console.log(`${String(r.lon).padStart(5)} ${String(r.lat).padStart(5)}   ${r.mode.padEnd(12)} `
    + `${String(r.northTiltDeg).padStart(8)}째   ${String(r.eastTiltDeg).padStart(8)}째`);
}
console.log();

for (const r of rows) {
  // East is +x on BOTH flat projections: Plate Carrée trivially, Robinson
  // because its parallels are straight and horizontal.
  check(Math.abs(r.eastTiltDeg) < 0.5, `${r.mode} @${r.lon},${r.lat}: east should be +x`);

  if (r.mode === 'plateCarree') {
    check(Math.abs(r.northTiltDeg) < 0.5, `plateCarree @${r.lon},${r.lat}: north should be +y`);
  } else if (r.lon === 0) {
    check(Math.abs(r.northTiltDeg) < 0.5, `robinson @0: north is +y on the central meridian`);
  } else {
    // Robinson's meridians lean toward the central one as |lat| grows, so a
    // step north tilts toward lon 0 in the northern hemisphere -- and AWAY
    // from it in the southern, where north is a step toward the equator and
    // the meridian is fanning back out. Both factors matter: an expectation
    // written from the northern hemisphere alone looks right on half the map
    // and is exactly backwards on the other half.
    const expect = (r.lon < 0 ? 1 : -1) * (r.lat > 0 ? 1 : -1);
    check(Math.sign(r.northTiltDeg) === expect && Math.abs(r.northTiltDeg) > 0.5,
      `robinson @${r.lon},${r.lat}: north should tilt toward the central meridian when `
      + `poleward and away from it when equatorward (expected sign ${expect}, got ${r.northTiltDeg})`);
  }
}

// ---- the map's edge ---------------------------------------------------------
//
// Boundary Frames were Globe-only until the projector could say where its own
// seam is. Checked here through the real FlatProjector, in both flat modes and
// with a non-identity Reference Plate, because the seam is at +-180 in the
// DISPLAY frame and a rotation moves that away from +-180 in the true frame --
// the one case where "it works with no Reference Plate" proves nothing.
console.log();
const seam = await page.evaluate(async () => {
  const { FlatProjector } = await import('/src/core/flatProjector.ts');
  const geo = (lon, lat) => {
    const la = (lat * Math.PI) / 180; const lo = (lon * Math.PI) / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const out = [];
  for (const mode of ['plateCarree', 'robinson']) {
    for (const qRef of [[0, 0, 0, 1], [0, 0.2588, 0, 0.9659]]) {   // identity, then 30 deg
      const p = new FlatProjector({ matrixWorldInverse: null, projectionMatrix: null });
      p.setFlatMode(mode);
      p.setReferenceRotation(qRef);
      const rotated = qRef[3] !== 1;
      out.push({
        mode,
        rotated,
        ordinary: p.seamSplit(geo(10, 0), geo(20, 0)) === null,
        // With a 30 deg reference rotation the DISPLAY seam is no longer at true
        // +-180, so this pair straddles it only in the unrotated case.
        acrossTrue180: p.seamSplit(geo(179, 5), geo(-179, 5)) !== null,
      });
    }
  }
  return out;
});

for (const r of seam) {
  console.log(`${r.mode.padEnd(12)} refPlate=${r.rotated ? '30deg' : 'none '} `
    + `ordinary-segment-ignored=${r.ordinary}  crosses-true-180=${r.acrossTrue180}`);
  check(r.ordinary, `${r.mode}: an ordinary segment must not be split`);
  if (!r.rotated) {
    check(r.acrossTrue180, `${r.mode}: a segment across 180 must split`);
  } else {
    check(!r.acrossTrue180,
      `${r.mode}: with the map rotated 30deg, true 180 is mid-map and must NOT split`);
  }
}

console.log();
console.log(bad === 0 ? 'OK -- every direction and seam as expected' : `${bad} FAILURES`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
