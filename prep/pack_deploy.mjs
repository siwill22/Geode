/**
 * Build the deployable archive from the generated one.
 *
 *   node prep/pack_deploy.mjs [--keep-fixtures] [--out DIR]
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
 * Everything else is copied verbatim. The JSON (rotations, velocities,
 * boundary frames) is left alone deliberately -- a CDN does compress
 * application/json on the wire, so pre-compressing it would buy nothing and
 * cost a second decode path.
 */
import { gzipSync } from 'node:zlib';
import {
  cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'archive');

const argv = process.argv.slice(2);
const keepFixtures = argv.includes('--keep-fixtures');
const outIdx = argv.indexOf('--out');
const OUT = join(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'archive-deploy');

const isFixture = (id) => id.startsWith('fixture-');

// --- reset ------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- index ------------------------------------------------------------------

const index = JSON.parse(readFileSync(join(SRC, 'archive.json'), 'utf8'));
const dropped = keepFixtures ? [] : index.models.filter((m) => isFixture(m.id));
index.models = index.models.filter((m) => keepFixtures || !isFixture(m.id));
writeFileSync(join(OUT, 'archive.json'), JSON.stringify(index, null, 2));

// --- everything that is not a model, verbatim -------------------------------

for (const name of readdirSync(SRC)) {
  if (name === 'models' || name === 'archive.json') continue;
  cpSync(join(SRC, name), join(OUT, name), { recursive: true, dereference: true });
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
console.log(`  archive: ${mb(total(SRC))} -> ${mb(total(OUT))}`);
