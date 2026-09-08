/**
 * Build the deployable archive from the generated one.
 *
 *   node prep/pack_deploy.mjs [--keep-fixtures] [--exclude=id,id,...] [--out DIR]
 *
 * archive/ is what the prep scripts produce and what dev serves: every model,
 * volumes as raw uint8. archive-deploy/ is what ships. Two differences, both
 * about the 1 GB GitHub Pages site cap and the 100 GB/month bandwidth budget:
 *
 *   - The fixture models are dropped. They exist for check:render and are 157
 *     of the 374 MB. --keep-fixtures overrides this, which is what makes the
 *     packed archive verifiable against the same screenshots (see README).
 *   - Volumes are gzipped to .bin.gz and path_template is rewritten to match.
 *     A CDN will not compress application/octet-stream, so doing it ahead of
 *     time is the difference between 12.5 MB and 6.2 MB per frame. The viewer
 *     decompresses in the browser; see fetchVolumeBytes in viewer/src/core/volume.ts.
 *
 * --exclude drops specific model ids on top of the fixture check -- for a
 * model that exists locally (in-progress work, or anything else not meant to
 * ship yet) without needing this script to know why. Deliberately just an id
 * list, not a name/pattern baked in here: what's excluded on any given run is
 * an operational choice made at the call site, not a fact about the archive.
 *
 * The coastline/boundary vector data (rotations.json, geometry.bin, and each
 * Reconstruction Model's per-age boundary geojson frames) is ALSO gzipped,
 * for the same reason as volumes: it's served as a static file, and nothing
 * decides to compress application/octet-stream or an unrecognised extension
 * on the wire for us. This is a different case from the ordinary JSON left
 * alone below -- those are small, single-fetch files a CDN's own on-the-wire
 * compression already handles; the point here is the STORED size against
 * GitHub Pages' 1 GB cap, which on-the-wire compression never touches. Both
 * core/coastlines.ts and the vendored deep-time-map library decompress these
 * transparently (see fetchVolumeBytes in core/volume.ts and
 * vendor/deep-time-map/js/gzipFetch.js) by sniffing the gzip magic number,
 * not by trusting the extension, so this script only has to gzip the file
 * and rewrite the manifest field that names it.
 *
 * Everything else -- ordinary small JSON like colormaps.json -- is copied
 * verbatim, left alone deliberately: a CDN does compress application/json on
 * the wire, so pre-compressing it would buy nothing and cost a second decode
 * path.
 */
import { gzipSync } from 'node:zlib';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'archive');

const argv = process.argv.slice(2);
const keepFixtures = argv.includes('--keep-fixtures');
const outIdx = argv.indexOf('--out');
const OUT = join(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'archive-deploy');
const excludeArg = argv.find((a) => a.startsWith('--exclude='));
const excludeIds = new Set(excludeArg ? excludeArg.slice('--exclude='.length).split(',').filter(Boolean) : []);

const isFixture = (id) => id.startsWith('fixture-');
const isExcluded = (id) => excludeIds.has(id);

// --- reset ------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- index --------------------------------------------------------------
//
// Written LAST (see bottom of file), once the coastline/boundary gzipping
// below has decided which manifest fields need a `.gz` suffix.

const index = JSON.parse(readFileSync(join(SRC, 'archive.json'), 'utf8'));
const dropped = index.models.filter((m) => (!keepFixtures && isFixture(m.id)) || isExcluded(m.id));
index.models = index.models.filter((m) => (keepFixtures || !isFixture(m.id)) && !isExcluded(m.id));

// --- everything that is not a model, verbatim -------------------------------
//
// --exclude also applies here, not just to index.models: a top-level entry
// (e.g. a per-run coastline directory) can exist on disk and be excluded by
// name without ever being listed as a model in archive.json, and this loop
// copies by directory listing, not by following archive.json's references --
// so an id excluded only from index.models above would still ship verbatim
// through here.

for (const name of readdirSync(SRC)) {
  if (name === 'models' || name === 'archive.json' || isExcluded(name)) continue;
  cpSync(join(SRC, name), join(OUT, name), { recursive: true, dereference: true });
}

// --- coastline/boundary vector data -----------------------------------------

let auxRawBytes = 0;
let auxPackedBytes = 0;

/** Gzip `${OUT}/relPath` to `${relPath}.gz` in place, deleting the original.
 *  Returns whether it did anything -- a set's rotations/boundaries are
 *  sometimes absent, and a no-op here is the caller's signal to leave the
 *  manifest field pointing at the original name. */
function gzipInPlace(relPath) {
  const absPath = join(OUT, relPath);
  if (!existsSync(absPath)) return false;
  const buf = readFileSync(absPath);
  const gz = gzipSync(buf, { level: 9 });
  writeFileSync(`${absPath}.gz`, gz);
  rmSync(absPath);
  auxRawBytes += buf.length;
  auxPackedBytes += gz.length;
  return true;
}

/** Gzip a CoastlineSet's geometry.bin and rotations.json (paths relative to
 *  `relDir`, matching the manifest's own convention) and return the set
 *  updated to point at whichever ones actually got gzipped. */
function packCoastlineSet(relDir, set) {
  const geometry = gzipInPlace(join(relDir, set.geometry)) ? `${set.geometry}.gz` : set.geometry;
  const rotations = gzipInPlace(join(relDir, set.rotations)) ? `${set.rotations}.gz` : set.rotations;
  return { ...set, geometry, rotations };
}

/**
 * Gzip a deep-time-map BoundarySeries manifest's per-age geojson frames, and
 * the manifest itself, rewriting `frames[].file` to match -- those paths are
 * resolved by the vendored library relative to the manifest's OWN directory
 * (see BoundarySeries.load in vendor/deep-time-map/js/boundaries.js), which
 * is `relDir` + dirname(relPath), not `relDir` alone.
 */
function packBoundaries(relDir, relPath) {
  const manifestRel = join(relDir, relPath);
  const manifestAbs = join(OUT, manifestRel);
  if (!existsSync(manifestAbs)) return relPath;

  const manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'));
  const frameDir = join(relDir, dirname(relPath));
  for (const frame of manifest.frames) {
    if (gzipInPlace(join(frameDir, frame.file))) frame.file += '.gz';
  }
  writeFileSync(manifestAbs, JSON.stringify(manifest));

  return gzipInPlace(manifestRel) ? `${relPath}.gz` : relPath;
}

index.coastlines = packCoastlineSet('', index.coastlines);
if (index.scotese_coastlines) {
  index.scotese_coastlines = packCoastlineSet('', index.scotese_coastlines);
}
if (index.native_coastlines) {
  for (const key of Object.keys(index.native_coastlines)) {
    index.native_coastlines[key] = packCoastlineSet('', index.native_coastlines[key]);
  }
}
if (index.boundaries) {
  index.boundaries = packBoundaries('', index.boundaries);
}

for (const entry of index.reconstruction_models ?? []) {
  const manifestAbs = join(OUT, entry.path);
  const manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'));
  const relDir = dirname(entry.path);
  manifest.coastlines = packCoastlineSet(relDir, manifest.coastlines);
  if (manifest.boundaries) manifest.boundaries = packBoundaries(relDir, manifest.boundaries);
  if (manifest.static_polygons) {
    const { geometry } = manifest.static_polygons;
    manifest.static_polygons = {
      ...manifest.static_polygons,
      geometry: gzipInPlace(join(relDir, geometry)) ? `${geometry}.gz` : geometry,
      // Shares its rotation file with `manifest.coastlines` above (same file
      // on disk -- see core/staticPolygons.ts's own doc comment), which
      // packCoastlineSet() already gzipped in place a line up; point at
      // whatever that rewrote it to rather than gzipping a second time (the
      // original no longer exists to gzip again).
      rotations: manifest.coastlines.rotations,
    };
  }
  writeFileSync(manifestAbs, JSON.stringify(manifest));
}

// --- models -----------------------------------------------------------------

let rawBytes = 0;
let packedBytes = 0;

/** Copy a model's tree, gzipping .bin volumes as it goes. */
function packDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) {
      packDir(src, join(to, name));
    } else if (name.endsWith('.bin')) {
      const buf = readFileSync(src);
      const gz = gzipSync(buf, { level: 9 });
      writeFileSync(join(to, `${name}.gz`), gz);
      rawBytes += buf.length;
      packedBytes += gz.length;
    } else {
      cpSync(src, join(to, name));
      packedBytes += statSync(src).size;
      rawBytes += statSync(src).size;
    }
  }
}

for (const model of index.models) {
  const from = join(SRC, 'models', model.id);
  const to = join(OUT, 'models', model.id);
  packDir(from, to);

  // The manifest names the frame files. Rewrite it to match what we just
  // wrote, so resolvePath() in the viewer picks up the .gz with no flag.
  const manifestPath = join(OUT, relative(SRC, join(SRC, model.path)));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.path_template.endsWith('.bin')) {
    manifest.path_template += '.gz';
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

writeFileSync(join(OUT, 'archive.json'), JSON.stringify(index, null, 2));

// --- report -----------------------------------------------------------------

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const total = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .reduce((n, e) => n + statSync(join(e.parentPath ?? e.path, e.name)).size, 0);

console.log(`packed ${index.models.length} models -> ${relative(ROOT, OUT)}`);
if (dropped.length) {
  console.log(`  dropped: ${dropped.map((m) => m.id).join(', ')}`);
}
console.log(`  volumes: ${mb(rawBytes)} -> ${mb(packedBytes)}`);
console.log(`  coastlines/boundaries: ${mb(auxRawBytes)} -> ${mb(auxPackedBytes)}`);
console.log(`  archive: ${mb(total(SRC))} -> ${mb(total(OUT))}`);
