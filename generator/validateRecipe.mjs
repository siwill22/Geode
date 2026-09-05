#!/usr/bin/env node
/**
 * Validate a Viewer Recipe (see recipeTypes.ts) against the catalog its OWN
 * dataHost.archiveBase actually serves -- the gate a Claude Code Skill runs
 * before ever calling scaffoldRepo.mjs, which re-runs this itself rather
 * than trusting a caller already did. See
 * docs/plans/consider-this-general-question-virtual-kay.md.
 *
 *   node generator/validateRecipe.mjs recipe.json [archiveSource]
 *
 * `archiveSource` is only for this repo's own pre-release testing (a local
 * archive/ directory); omit it to validate against the recipe's real
 * dataHost, which is what a Skill should always do.
 *
 * Prints a JSON ValidationResult and exits 0 on success, 1 on failure --
 * structured so a Skill can react to a specific error (e.g. swap in a
 * suggested near-match) rather than parsing prose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ARCHIVE_DIR = path.join(HERE, '..', 'archive');

export const TOOL_ALLOWLIST = ['legend', 'age-slider', 'no-data-toggle', 'query-point'];
export const WRAPPER_TYPES = ['single-model-globe', 'model-group-globe'];

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * A recipe's dataHost.archiveBase is the catalog that will ACTUALLY serve a
 * generated site -- validating against the local dev archive instead (as
 * an earlier version of this script did) can pass while the real deployed
 * site 404s, if the local archive has a model the shared host hasn't
 * received yet (exactly what happened when this was first tested against
 * a model still local-only ahead of its next data release). So by default
 * this fetches the recipe's own dataHost live; `source` is only a local
 * directory path for this repo's own pre-release testing (see the CLI's
 * optional third argument).
 */
async function loadArchiveFrom(source) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(`${source}/archive.json`);
    if (!r.ok) throw new Error(`${source}/archive.json: ${r.status}`);
    return r.json();
  }
  return loadJson(path.join(source, 'archive.json'));
}

async function loadManifestFrom(source, relPath) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(`${source}/${relPath}`);
    if (!r.ok) throw new Error(`${source}/${relPath}: ${r.status}`);
    return r.json();
  }
  return loadJson(path.join(source, relPath));
}

/** Levenshtein distance, for "did you mean" suggestions on a bad id. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function nearestMatches(id, candidates, n = 3) {
  return candidates
    .map((c) => ({ c, d: levenshtein((id ?? '').toLowerCase(), c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Mirrors core/coastlines.ts's resolveCoastlineSet() exactly -- see that
 * function's doc comment for the ADR-0004 reasoning behind each branch.
 * Duplicated rather than imported: this script runs standalone under plain
 * Node with no bundler (matching prep/pack_deploy.mjs's own no-deps
 * style), and the function is small, pure, and driven only by archive.json
 * + manifest.json's own declared fields -- never by guessing from an id or
 * name -- so the two implementations are cheap to keep in sync by
 * inspection. GlobeInstance re-derives this live in the browser regardless
 * (see globe/main.ts), so this copy is informational (README attribution,
 * early warning), never load-bearing for what a deployed site actually
 * shows.
 */
function resolveCoastlines(archive, manifest) {
  if (manifest.reconstruction_model) {
    const key = manifest.reconstruction_model.toLowerCase();
    const source = archive.native_coastlines?.[key] ? 'native_coastlines' : 'none';
    return { reconstructionModel: manifest.reconstruction_model, source };
  }
  const climateTypes = ['climate', 'climate-monthly', 'climate-ocean-depth', 'paleogeography'];
  if (climateTypes.includes(manifest.type) && archive.scotese_coastlines) {
    return { reconstructionModel: null, source: 'scotese_coastlines' };
  }
  if (['tomography', 'convection'].includes(manifest.type) && archive.coastlines) {
    return { reconstructionModel: null, source: 'coastlines' };
  }
  return { reconstructionModel: null, source: 'none' };
}

/**
 * Group a recipe's `datasets` (model ids) into a comparison grid for the
 * `model-group-globe` wrapper, driven entirely by each Model's own declared
 * `reconstruction_model` and `comparison_role` fields -- never inferred
 * from an id-naming convention (that was the original deformation viewer's
 * approach, now retired in favour of this). See
 * docs/plans/consider-this-general-question-virtual-kay.md.
 *
 * Requires the given models to form a COMPLETE grid: every combination of
 * the distinct axis values actually present must have exactly one model.
 * A partial grid (e.g. a reconstruction missing one of its two roles) is
 * rejected up front rather than silently offering a dropdown combination
 * that would 404 at runtime.
 */
async function resolveModelGroup(archive, source, datasets, tools, errors) {
  const modelIds = archive.models.map((m) => m.id);
  const entries = [];
  for (const ds of datasets) {
    const entry = archive.models.find((m) => m.id === ds.modelId);
    if (!entry) {
      errors.push({
        message: `no model '${ds.modelId}' in archive.json`,
        suggestions: nearestMatches(ds.modelId, modelIds),
      });
      continue;
    }
    entries.push({ modelId: ds.modelId, entry, manifest: await loadManifestFrom(source, entry.path) });
  }
  if (errors.length > 0) return null;

  if (tools.includes('age-slider') && !entries.some((e) => e.manifest.frames.length > 1)) {
    errors.push("'age-slider' was requested but no dataset in this group has more than 1 "
      + 'frame -- nothing to scrub in any combination');
  }

  const axisAValues = [...new Set(entries.map((e) => e.manifest.reconstruction_model).filter(Boolean))];
  const axisBValues = [...new Set(entries.map((e) => e.manifest.comparison_role).filter(Boolean))];

  if (axisAValues.length <= 1 && axisBValues.length <= 1) {
    errors.push("model-group-globe needs datasets that vary along a declared axis "
      + "(reconstruction_model or comparison_role) -- these don't vary along either. Use "
      + "wrapperType 'single-model-globe' for a single, non-comparison dataset.");
    return null;
  }

  const aKeys = axisAValues.length ? axisAValues : [null];
  const bKeys = axisBValues.length ? axisBValues : [null];
  const expected = aKeys.length * bKeys.length;
  if (entries.length !== expected) {
    errors.push(`datasets must form a COMPLETE grid: ${aKeys.length} reconstruction(s) x `
      + `${bKeys.length} role(s) = ${expected} expected, got ${entries.length}. A partial `
      + 'grid is rejected rather than offering a dropdown combination that 404s.');
    return null;
  }

  const grid = {};
  for (const e of entries) {
    const a = e.manifest.reconstruction_model ?? null;
    const b = e.manifest.comparison_role ?? null;
    grid[a ?? ''] ??= {};
    if (grid[a ?? ''][b ?? '']) {
      errors.push(`duplicate dataset for (reconstruction=${a}, role=${b}): `
        + `both '${grid[a ?? ''][b ?? ''].modelId}' and '${e.modelId}'`);
      continue;
    }
    grid[a ?? ''][b ?? ''] = e;
  }
  for (const a of aKeys) {
    for (const b of bKeys) {
      if (!grid[a ?? '']?.[b ?? '']) {
        errors.push(`missing dataset for combination (reconstruction=${a ?? 'n/a'}, role=${b ?? 'n/a'})`);
      }
    }
  }
  if (errors.length > 0) return null;

  // Within one role, every reconstruction must offer the same variable
  // vocabulary -- switching reconstruction keeps the same Variable
  // selected, so a role whose Models disagree on which variables exist
  // would leave that selection dangling for some reconstructions.
  for (const b of bKeys) {
    const varSets = aKeys.map((a) => [...new Set(grid[a ?? ''][b ?? ''].manifest.variables.map((v) => v.id))].sort());
    const first = varSets[0].join(',');
    for (let i = 1; i < varSets.length; i++) {
      if (varSets[i].join(',') !== first) {
        errors.push(`role '${b ?? 'n/a'}' has different variables across reconstructions -- `
          + `'${grid[aKeys[0] ?? ''][b ?? ''].modelId}' has [${first}], `
          + `'${grid[aKeys[i] ?? ''][b ?? ''].modelId}' has [${varSets[i].join(',')}]`);
      }
    }
  }
  if (errors.length > 0) return null;

  const gridResolved = {};
  for (const a of aKeys) {
    gridResolved[a ?? ''] = {};
    for (const b of bKeys) {
      const e = grid[a ?? ''][b ?? ''];
      gridResolved[a ?? ''][b ?? ''] = {
        modelId: e.modelId,
        modelName: e.entry.name,
        defaultVariable: e.manifest.default_variable,
        coastlines: resolveCoastlines(archive, e.manifest),
      };
    }
  }

  return {
    axisA: { field: 'reconstruction_model', values: axisAValues },
    axisB: { field: 'comparison_role', values: axisBValues },
    defaultAxisA: entries[0].manifest.reconstruction_model ?? null,
    defaultAxisB: entries[0].manifest.comparison_role ?? null,
    modelSource: entries[0].manifest.source ?? '',
    grid: gridResolved,
  };
}

/**
 * @param {object} recipe
 * @param {string} [source] Local archive directory or an http(s) archive
 *   base URL -- defaults to the recipe's OWN dataHost.archiveBase (the
 *   catalog that will actually serve the generated site), not this repo's
 *   local dev archive. Pass a local directory explicitly only for this
 *   repo's own pre-release testing of a model not yet on the shared host.
 * @returns {Promise<{ok: true, resolved: object} | {ok: false, errors: Array}>}
 */
export async function validateRecipe(recipe, source = recipe?.dataHost?.archiveBase ?? DEFAULT_ARCHIVE_DIR) {
  const errors = [];
  let archive;
  try {
    archive = await loadArchiveFrom(source);
  } catch (e) {
    return { ok: false, errors: [`could not load archive.json from '${source}': ${e.message}`] };
  }

  if (recipe.recipeVersion !== 1) {
    errors.push(`recipeVersion must be 1, got ${JSON.stringify(recipe.recipeVersion)}`);
  }
  if (!WRAPPER_TYPES.includes(recipe.wrapperType)) {
    errors.push(`wrapperType must be one of ${WRAPPER_TYPES.join(', ')}, `
      + `got ${JSON.stringify(recipe.wrapperType)}`);
  }
  if (!recipe.site?.repoName || !/^[\w.-]+$/.test(recipe.site.repoName)) {
    errors.push(`site.repoName ${JSON.stringify(recipe.site?.repoName)} is missing or has `
      + 'characters GitHub repo names don\'t allow (letters, digits, "-", "_", ".")');
  }
  if (!recipe.site?.title) errors.push('site.title is required');
  if (!recipe.dataHost?.archiveBase) errors.push('dataHost.archiveBase is required');

  const tools = recipe.ui?.tools ?? [];
  for (const t of tools) {
    if (!TOOL_ALLOWLIST.includes(t)) {
      errors.push({
        message: `'${t}' is not a supported UI tool (v1 menu: ${TOOL_ALLOWLIST.join(', ')})`,
        suggestions: nearestMatches(t, TOOL_ALLOWLIST),
      });
    }
  }

  if (!Array.isArray(recipe.datasets) || recipe.datasets.length === 0) {
    errors.push('datasets must be a non-empty array');
    return { ok: false, errors };
  }

  let resolved = null;
  if (recipe.wrapperType === 'single-model-globe') {
    if (recipe.datasets.length !== 1) {
      errors.push(`'single-model-globe' takes exactly 1 dataset -- got ${recipe.datasets.length}. `
        + "Use wrapperType 'model-group-globe' to compare several.");
    }
    const ds = recipe.datasets[0];
    if (ds) {
      const modelIds = archive.models.map((m) => m.id);
      const entry = archive.models.find((m) => m.id === ds.modelId);
      if (!entry) {
        errors.push({
          message: `no model '${ds.modelId}' in archive.json`,
          suggestions: nearestMatches(ds.modelId, modelIds),
        });
      } else {
        const manifest = await loadManifestFrom(source, entry.path);
        if (tools.includes('age-slider') && manifest.frames.length <= 1) {
          errors.push(`'age-slider' was requested but '${ds.modelId}' has only `
            + `${manifest.frames.length} frame(s) -- nothing to scrub`);
        }
        if (errors.length === 0) {
          resolved = {
            modelId: ds.modelId,
            modelName: entry.name,
            modelSource: manifest.source ?? '',
            defaultVariable: manifest.default_variable,
            coastlines: resolveCoastlines(archive, manifest),
          };
        }
      }
    }
  } else if (recipe.wrapperType === 'model-group-globe') {
    resolved = await resolveModelGroup(archive, source, recipe.datasets, tools, errors);
  }

  return errors.length === 0 ? { ok: true, resolved } : { ok: false, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const recipePath = process.argv[2];
  if (!recipePath) {
    console.error('usage: node generator/validateRecipe.mjs recipe.json [archiveSource]');
    process.exit(2);
  }
  const recipe = loadJson(path.resolve(recipePath));
  const source = process.argv[3]
    ? (/^https?:\/\//.test(process.argv[3]) ? process.argv[3] : path.resolve(process.argv[3]))
    : undefined;
  const result = await validateRecipe(recipe, source);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
