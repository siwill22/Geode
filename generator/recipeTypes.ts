/**
 * The Viewer Recipe: what a Claude Code Skill (skills/geode-globe-viewer/)
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
import type { GlobeTool } from '../viewer/src/globe/globeUi';

export interface ViewerRecipe {
  recipeVersion: 1;
  site: {
    /** Becomes the GitHub repo name and, via VITE_BASE, the Pages base path. */
    repoName: string;
    title: string;
    description?: string;
  };
  /** v1 supports exactly one wrapper type -- see the plan doc's Phase 1 scope. */
  wrapperType: 'single-model-globe';
  /**
   * Array-shaped for future multi-dataset support; validateRecipe.mjs
   * enforces length === 1 in v1. Always uses that Model's own
   * default_variable/default_resolution -- no per-recipe override in v1,
   * so there is nothing here that could disagree with the Model's own
   * declared defaults.
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

/** Which coastline set (if any) resolveCoastlineSet() would pick for this
 *  recipe's Model, computed by validateRecipe.mjs purely for the generated
 *  README's attribution text and as an early warning -- GlobeInstance
 *  itself re-derives this live in the browser at boot (see
 *  core/coastlines.ts), so this is informational, never load-bearing. */
export interface ResolvedCoastlines {
  reconstructionModel: string | null;
  source: 'native_coastlines' | 'scotese_coastlines' | 'coastlines' | 'none';
}

export interface ResolvedRecipe {
  modelId: string;
  modelName: string;
  modelSource: string;
  defaultVariable: string;
  coastlines: ResolvedCoastlines;
}

export interface ValidationOk {
  ok: true;
  resolved: ResolvedRecipe;
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
