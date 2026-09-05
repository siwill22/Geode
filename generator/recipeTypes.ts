/**
 * The Viewer Recipe: what a Claude Code Skill (.claude/skills/geode-globe-viewer/)
 * produces from a user's freeform request, and what validateRecipe.mjs and
 * scaffoldRepo.mjs consume to build a standalone repo. See
 * docs/plans/consider-this-general-question-virtual-kay.md for the full
 * design.
 *
 * Not part of the build (generator/ scripts run directly under plain Node,
 * no bundler -- see validateRecipe.mjs) -- this file exists so the shape is
 * typed against the real catalog schema (../viewer/src/core/types.ts) for a
 * human reviewer, and so a future TS-based tool has a real type to import.
 * Hand-kept in sync with validateRecipe.mjs's actual (JS, duck-typed)
 * checks, the same relationship prep/prep_colormaps.py has with
 * viewer/src/core/types.ts's ColormapData.
 */
import type { GlobeTool } from '../viewer/src/core/tools';

export interface ViewerRecipe {
  recipeVersion: 1;
  site: {
    /** Becomes the GitHub repo name and, via VITE_BASE, the Pages base path. */
    repoName: string;
    title: string;
    description?: string;
  };
  /**
   * 'single-model-globe': exactly one dataset, no comparison controls --
   * see viewer/src/globe/.
   * 'model-group-globe': two or more datasets that vary along a declared
   * catalog axis (Manifest.reconstruction_model and/or
   * Manifest.comparison_role), switched between via dropdowns -- see
   * viewer/src/groupGlobe/ and resolveModelGroup() in validateRecipe.mjs.
   * "Dataset" in this recipe was originally cut at "one Model" (v1); v1.5
   * redefines it as "one comparison group," since most real requests for a
   * viewer are actually requests to compare several model runs, not view
   * one in isolation.
   */
  wrapperType: 'single-model-globe' | 'model-group-globe';
  /**
   * For 'single-model-globe': exactly 1 entry, using that Model's own
   * default_variable/default_resolution (no per-recipe override).
   * For 'model-group-globe': every Model in the intended comparison. Must
   * form a COMPLETE grid over whichever of reconstruction_model/
   * comparison_role actually varies across them -- see resolveModelGroup()
   * for the exact rule (rejects a partial grid rather than offering a
   * dropdown combination that 404s), and requires the same variable
   * vocabulary within each comparison_role across all reconstructions.
   */
  datasets: Array<{ modelId: string }>;
  ui: {
    /** Must be a subset of GlobeTool -- validateRecipe.mjs rejects anything
     *  else, with a near-match suggestion. */
    tools: GlobeTool[];
  };
  dataHost: {
    /** The shared, Geode-controlled archive base URL every generated site
     *  fetches from live -- see core/volume.ts's loadArchive(base) and
     *  VITE_ARCHIVE_BASE. Never a copy bundled into the generated repo. */
    archiveBase: string;
  };
}

/** Which coastline set (if any) resolveCoastlineSet() would pick for a
 *  given Model, computed by validateRecipe.mjs purely for the generated
 *  README's attribution text and as an early warning -- the wrapper
 *  itself re-derives this live in the browser at boot (see
 *  core/coastlines.ts), so this is informational, never load-bearing. */
export interface ResolvedCoastlines {
  reconstructionModel: string | null;
  source: 'native_coastlines' | 'scotese_coastlines' | 'coastlines' | 'none';
}

/** Resolved shape for a 'single-model-globe' recipe. */
export interface ResolvedSingleModel {
  modelId: string;
  modelName: string;
  modelSource: string;
  defaultVariable: string;
  coastlines: ResolvedCoastlines;
}

/** One grid cell in a 'model-group-globe' recipe's comparison. */
export interface ResolvedGridCell {
  modelId: string;
  modelName: string;
  defaultVariable: string;
  coastlines: ResolvedCoastlines;
}

/** Resolved shape for a 'model-group-globe' recipe, from resolveModelGroup()
 *  in validateRecipe.mjs. `axisA` is always keyed off `reconstruction_model`
 *  and `axisB` off `comparison_role` in v1.5 -- a fully generic N-axis
 *  system was deliberately not built; these are the two axes every real
 *  comparison family (so far) actually needs. */
export interface ResolvedModelGroup {
  axisA: { field: 'reconstruction_model'; values: string[] };
  axisB: { field: 'comparison_role'; values: string[] };
  defaultAxisA: string | null;
  defaultAxisB: string | null;
  modelSource: string;
  /** axisA value -> axisB value -> that combination's resolved cell. */
  grid: Record<string, Record<string, ResolvedGridCell>>;
}

export type Resolved = ResolvedSingleModel | ResolvedModelGroup;

export interface ValidationOk {
  ok: true;
  resolved: Resolved;
}

export interface ValidationError {
  message: string;
  /** Nearest catalog ids/names, when the bad value looks like a typo of a
   *  real one -- what lets a Skill self-correct in one turn instead of
   *  asking the user or retrying blind. */
  suggestions?: string[];
}

export interface ValidationFailed {
  ok: false;
  errors: (string | ValidationError)[];
}

export type ValidationResult = ValidationOk | ValidationFailed;
