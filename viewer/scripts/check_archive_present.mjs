/**
 * prebuild: fail fast, and say why, when there is no archive to build against.
 *
 * public/archive is a tracked symlink to ../../archive, which does not exist
 * on a fresh clone. `vite dev` tolerates the dangling link; `vite build` dies
 * copying it with a long bundler stack trace that never mentions the archive.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const index = join(VIEWER, 'public', 'archive', 'archive.json');

if (!existsSync(index)) {
  // The data release this commit deploys against -- read, not hardcoded, so
  // the hint cannot drift from the workflow.
  let tag = '<DATA_RELEASE from .github/workflows/deploy.yml>';
  try {
    const yml = readFileSync(join(VIEWER, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
    tag = yml.match(/DATA_RELEASE:\s*(\S+)/)?.[1] ?? tag;
  } catch { /* keep the placeholder */ }

  console.error(`No archive found (${index} does not resolve).

Either download the packed archive the deployed site uses, from the repo root:

  mkdir -p archive && curl -L \\
    https://github.com/siwill22/Geode/releases/download/${tag}/archive-deploy.tar.gz \\
    | tar -xz -C archive

or build one with the prep pipeline -- see "Regenerating the archive" in the README.`);
  process.exit(1);
}
