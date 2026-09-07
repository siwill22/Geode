/**
 * Exercise core/staticPolygons.ts and the plateFrame* additions to
 * core/queryPoint.ts against synthetic fixture data -- no browser, same
 * bundle-and-run-under-node approach as check_query_point.mjs.
 *
 *   node scripts/check_static_polygons.mjs
 */
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: `
      export { assignPlate, createPlateFramePoint, positionAt } from './src/core/staticPolygons.ts';
      export { rotationAt, rotateVector } from './src/core/rotation.ts';
      export { plateFrameAgeSeries, plateFrameMonthProfile } from './src/core/queryPoint.ts';
      export { FrameByteCache } from './src/core/frameByteCache.ts';
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
  assignPlate, createPlateFramePoint, positionAt, rotationAt, rotateVector,
  plateFrameAgeSeries, plateFrameMonthProfile, FrameByteCache,
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
function close(a, b, eps = 1e-6) {
  return Number.isNaN(a) && Number.isNaN(b) ? true : Math.abs(a - b) < eps;
}
function closeAngle(a, b, eps = 1e-4) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d < eps;
}

// Geographic-frame conversions, matching core/staticPolygons.ts's own
// (private) convention -- duplicated here only for fixture construction,
// never imported: a test should not trust the same private helper it is
// indirectly exercising.
function llToXyz(lon, lat) {
  const lo = (lon * Math.PI) / 180, la = (lat * Math.PI) / 180;
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}
function xyzToLl([x, y, z]) {
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: (Math.asin(Math.max(-1, Math.min(1, z / r))) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}
function squareRing(lonMin, lonMax, latMin, latMax) {
  const corners = [
    [lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax],
  ];
  const out = new Float32Array(corners.length * 3);
  corners.forEach(([lon, lat], i) => {
    const [x, y, z] = llToXyz(lon, lat);
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  });
  return out;
}

const IDENTITY_TABLE = (plateIds, ages = [0, 50, 100]) => ({
  ages,
  anchor: 0,
  plates: Object.fromEntries(plateIds.map((id) => [String(id), ages.map(() => [0, 0, 0, 1])])),
});

// ---------------------------------------------------------------------------
// assignPlate: basic containment, no-coverage, and the age-window cutoff.
// ---------------------------------------------------------------------------
{
  const polyA = {
    plateId: 10, continental: true, beginAge: 50, endAge: -1e9,
    points: squareRing(-5, 5, -5, 5),
  };
  const table = IDENTITY_TABLE([10]);

  const inside = assignPlate([polyA], table, { lon: 0, lat: 0 }, 0);
  check('assignPlate finds the covering polygon', inside?.plateId === 10);
  check('assignPlate carries the continental flag', inside?.continental === true);
  check('assignPlate carries the polygon\'s own begin age', inside?.beginAge === 50);

  const outside = assignPlate([polyA], table, { lon: 60, lat: 60 }, 0);
  check('assignPlate returns null outside any polygon (real outcome, not an error)', outside === null);

  const tooOld = assignPlate([polyA], table, { lon: 0, lat: 0 }, 60);
  check('assignPlate returns null when referenceAge exceeds the polygon\'s own begin age',
    tooOld === null);

  const atBegin = assignPlate([polyA], table, { lon: 0, lat: 0 }, 50);
  check('assignPlate still matches exactly at the polygon\'s own begin age', atBegin?.plateId === 10);
}

// ---------------------------------------------------------------------------
// assignPlate: overlap tie-break favours the LARGER polygon (docs/adr/0025).
// ---------------------------------------------------------------------------
{
  const small = {
    plateId: 1, continental: false, beginAge: 100, endAge: -1e9,
    points: squareRing(-2, 2, -2, 2),
  };
  const large = {
    plateId: 2, continental: false, beginAge: 100, endAge: -1e9,
    points: squareRing(-20, 20, -20, 20),
  };
  const table = IDENTITY_TABLE([1, 2]);

  const bothOrder = assignPlate([small, large], table, { lon: 0, lat: 0 }, 0);
  check('assignPlate picks the larger of two overlapping polygons (small, large order)',
    bothOrder?.plateId === 2);
  const reversedOrder = assignPlate([large, small], table, { lon: 0, lat: 0 }, 0);
  check('assignPlate\'s tie-break does not depend on candidate order',
    reversedOrder?.plateId === 2);
}

// ---------------------------------------------------------------------------
// createPlateFramePoint / positionAt: round-trip against the SAME rotation
// primitives coastlines.ts already trusts (rotationAt/rotateVector) -- this
// checks assignPlate + createPlateFramePoint + positionAt correctly USE
// those primitives and correctly apply the begin-age cutoff, not that the
// rotation math itself is geologically correct (that's ADR-0001's own
// mechanism, unmodified here -- see docs/adr/0025).
// ---------------------------------------------------------------------------
{
  const PLATE = 30;
  const ages = [0, 10, 20, 30];
  // A rotation about the geographic pole (Z axis) by 3 degrees per Ma --
  // arbitrary but simple, chosen only so positions actually move.
  const table = {
    ages,
    anchor: 0,
    plates: {
      [String(PLATE)]: ages.map((age) => {
        const theta = ((age * 3 * Math.PI) / 180) / 2;
        return [0, 0, Math.sin(theta), Math.cos(theta)];
      }),
    },
  };

  const presentDayXYZ = llToXyz(20, 10);
  const referenceAge = 10;
  const qRef = rotationAt(table, PLATE, referenceAge);
  const clickXYZ = rotateVector(qRef, ...presentDayXYZ);
  const clickLonLat = xyzToLl(clickXYZ);

  // The polygon must cover the CLICK position once rotated to referenceAge;
  // equivalently (and this is exactly what assignPlate itself computes) its
  // present-day ring must contain the click rotated back to present day --
  // which is presentDayXYZ by construction.
  const poly = {
    plateId: PLATE, continental: true, beginAge: 1e9, endAge: -1e9,
    points: squareRing(10, 30, 0, 20),
  };

  const assignment = assignPlate([poly], table, clickLonLat, referenceAge);
  check('assignPlate recovers the plate id for a rotated click', assignment?.plateId === PLATE);

  const point = createPlateFramePoint(assignment, table, clickLonLat, referenceAge);
  check('createPlateFramePoint reconstructs the present-day position',
    close(point.presentDayXYZ[0], presentDayXYZ[0], 1e-4)
    && close(point.presentDayXYZ[1], presentDayXYZ[1], 1e-4)
    && close(point.presentDayXYZ[2], presentDayXYZ[2], 1e-4));

  const at0 = positionAt(point, table, 0);
  const expected0 = xyzToLl(presentDayXYZ);
  check('positionAt(0) matches the present-day LonLat',
    closeAngle(at0.lon, expected0.lon) && closeAngle(at0.lat, expected0.lat));

  const at20 = positionAt(point, table, 20);
  const q20 = rotationAt(table, PLATE, 20);
  const expected20 = xyzToLl(rotateVector(q20, ...presentDayXYZ));
  check('positionAt(20) matches independently-computed rotation to age 20',
    closeAngle(at20.lon, expected20.lon) && closeAngle(at20.lat, expected20.lat));

  // Separate, short-lived polygon (its own PlateFramePoint) just for the
  // begin-age cutoff, kept apart from the round-trip checks above so that
  // an intentionally-null result here can't be mistaken for a broken
  // rotation round-trip there.
  const shortLived = { plateId: PLATE, continental: true, beginAge: 15, endAge: -1e9, points: poly.points };
  const shortAssignment = assignPlate([shortLived], table, clickLonLat, referenceAge);
  const shortPoint = createPlateFramePoint(shortAssignment, table, clickLonLat, referenceAge);
  check('positionAt is null past the assigned polygon\'s own begin age (16 > 15)',
    positionAt(shortPoint, table, 16) === null);
  check('positionAt still answers exactly at the begin age (15)',
    positionAt(shortPoint, table, 15) !== null);
}

// ---------------------------------------------------------------------------
// plateFrameAgeSeries / plateFrameMonthProfile: same fixture technique as
// check_query_point.mjs, using an IDENTITY rotation (the point never moves)
// so the per-Frame trajectory math above doesn't need re-verifying here --
// this only checks the begin-age Frame filtering and the Month Profile
// pass-through, both new in this file.
// ---------------------------------------------------------------------------
{
  const nlon = 4, nlat = 3, ndepth = 1, plane = nlon * nlat;
  const QUERY = { lon: -45, lat: 0 };
  const QUERY_IDX = 5; // matches check_query_point.mjs's own fixture geometry

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
    variables: [{ id: 'v', encode_min: 0, encode_max: 255 }],
  };

  function frameBytes(annual) {
    const buf = new Uint8Array(plane * ndepth);
    buf[QUERY_IDX] = annual;
    return buf;
  }
  const FIXTURES = new Map([
    ['v/r1/f0.bin', frameBytes(10)],
    ['v/r1/f1.bin', frameBytes(20)],
    ['v/r1/f2.bin', frameBytes(30)],
    ['v/r1/f3.bin', frameBytes(40)],
  ]);
  globalThis.fetch = async (path) => {
    const key = path.replace(/^\/models\/m1\//, '');
    const bytes = FIXTURES.get(key);
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => bytes.slice().buffer };
  };

  const table = IDENTITY_TABLE([99], [0, 10, 20, 30]);
  const point = { plateId: 99, continental: true, beginAge: 15, presentDayXYZ: llToXyz(QUERY.lon, QUERY.lat) };

  const cache = new FrameByteCache('');
  const series = await plateFrameAgeSeries(cache, manifest, manifest.variables[0], point, table);
  check('plateFrameAgeSeries stops at the point\'s own begin age (2 of 4 Frames)',
    series.length === 2);
  check('plateFrameAgeSeries carries the right ages', series.map((s) => s.age).join(',') === '0,10');
  check('plateFrameAgeSeries reads the correct values', close(series[0].value, 10) && close(series[1].value, 20));

  const tex = { image: { data: frameBytes(77) } };
  const res = manifest.resolutions[0];
  const withinRange = plateFrameMonthProfile(tex, res, manifest.variables[0], point, table, 10);
  check('plateFrameMonthProfile answers within the begin-age window',
    withinRange !== null && close(withinRange[0].value, 77));

  const beyondRange = plateFrameMonthProfile(tex, res, manifest.variables[0], point, table, 25);
  check('plateFrameMonthProfile returns null past the begin age', beyondRange === null);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
