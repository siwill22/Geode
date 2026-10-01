/**
 * RiftsClimate WP5 spot-check: Geode's own Plate-Frame Point reads for a list of
 * deposits, so RiftsClimate can compare them with its covariate tables
 * (RiftsClimate docs/spec/wp5-covariates.md, "Spot-check against Geode").
 *
 *   node scripts/riftsclimate_spotcheck.mjs <in.json> <out.json> [archiveDir]
 *
 * in.json:  [{ id, lon, lat, ages: [Ma, ...], climate: { <manifest id>: <frame age> } }]
 * out.json: per deposit, per reconstruction model: plate id, begin age and the
 *           position at each of `ages` (null if older than the plate's begin age;
 *           the whole entry null if no static polygon covers the point today).
 *           NB rotationAt() clamps beyond the rotation table's last age (540 Ma
 *           for every model in the archive today), so positions there are the
 *           540 Ma position, not an error; table_max_age is returned so the
 *           caller can tell. Per climate model: T and P
 *           (annual layer, physical units as the manifest gives them) at the
 *           requested frame, read by plateFrameAgeSeries with the Scotese point.
 *
 * Same bundle-and-run-under-node approach as check_static_polygons.mjs, except
 * against the real archive on disk (fetch is pointed at local files).
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [inPath, outPath, archiveArg] = process.argv.slice(2);
const ARCHIVE = resolve(archiveArg ?? '../archive');

globalThis.fetch = async (url) => {
  const path = String(url);
  try {
    const buf = await readFile(path);
    return {
      ok: true, status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
    };
  } catch {
    return { ok: false, status: 404 };
  }
};

const result = await build({
  stdin: {
    contents: `
      export { assignPlate, createPlateFramePoint, positionAt, fetchStaticPolygonData } from './src/core/staticPolygons.ts';
      export { loadReconstructionManifest, reconstructionAssetPath } from './src/core/reconstructions.ts';
      export { plateFrameAgeSeries } from './src/core/queryPoint.ts';
      export { FrameByteCache } from './src/core/frameByteCache.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const {
  assignPlate, createPlateFramePoint, positionAt, fetchStaticPolygonData,
  loadReconstructionManifest, reconstructionAssetPath, plateFrameAgeSeries, FrameByteCache,
} = mod;

const archive = JSON.parse(await readFile(`${ARCHIVE}/archive.json`, 'utf8'));

async function staticData(id) {
  const entry = archive.reconstruction_models.find((r) => r.id === id);
  const rm = await loadReconstructionManifest(ARCHIVE, entry.path);
  return fetchStaticPolygonData(
    ARCHIVE,
    reconstructionAssetPath(rm, rm.static_polygons.geometry),
    reconstructionAssetPath(rm, rm.static_polygons.rotations),
  );
}

const plates = { scotese: await staticData('scotese'), merdith2021: await staticData('merdith2021') };
const cache = new FrameByteCache(ARCHIVE);
const manifests = {};
async function manifestFor(id) {
  if (!manifests[id]) {
    const entry = archive.models.find((m) => m.id === id);
    manifests[id] = JSON.parse(await readFile(`${ARCHIVE}/${entry.path}`, 'utf8'));
  }
  return manifests[id];
}

const deposits = JSON.parse(await readFile(inPath, 'utf8'));
const out = [];
for (const d of deposits) {
  const row = { id: d.id, reconstruction: {}, climate: {} };
  const points = {};
  for (const [id, data] of Object.entries(plates)) {
    const at = { lon: d.lon, lat: d.lat };
    const a = assignPlate(data.polygons, data.table, at, 0);
    if (!a) { row.reconstruction[id] = null; continue; }
    const p = createPlateFramePoint(a, data.table, at, 0);
    points[id] = p;
    const positions = d.ages.map((age) => positionAt(p, data.table, age));
    row.reconstruction[id] = {
      plate_id: a.plateId, begin_age: a.beginAge, positions,
      table_max_age: data.table.ages[data.table.ages.length - 1],
    };
  }
  for (const [mid, frameAge] of Object.entries(d.climate ?? {})) {
    if (!points.scotese) { row.climate[mid] = null; continue; }
    const m = await manifestFor(mid);
    const vals = {};
    for (const vid of ['T', 'P']) {
      const v = m.variables.find((x) => x.id === vid);
      const series = await plateFrameAgeSeries(cache, m, v, points.scotese, plates.scotese.table);
      const hit = series.find((s) => s.age === frameAge);
      vals[vid] = hit ? { value: Number.isNaN(hit.value) ? null : hit.value, cell: hit.cell, units: v.units } : null;
    }
    row.climate[mid] = vals;
  }
  out.push(row);
}
await writeFile(outPath, JSON.stringify(out, null, 1));
console.log(`${out.length} deposits read from ${ARCHIVE}`);
