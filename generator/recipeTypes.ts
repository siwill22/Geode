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
import type { GlobeTool, MultiGlobeConfig } from '../viewer/src/core/tools';
import type { CameraView, ViewPresetConfig } from '../viewer/src/generated/mantleConfig';

export interface ViewerRecipe {
  recipeVersion: 1;
  site: {
    /** Becomes the GitHub repo name and, via VITE_BASE, the Pages base path. */
    repoName: string;
    title: string;
    description?: string;
  };
  /**
   * 'single-model-globe': exactly one dataset (numerical Model), no
   * comparison controls -- see viewer/src/globe/.
   * 'model-group-globe': two or more datasets that vary along a declared
   * catalog axis (Manifest.reconstruction_model and/or
   * Manifest.comparison_role), switched between via dropdowns -- see
   * viewer/src/groupGlobe/ and resolveModelGroup() in validateRecipe.mjs.
   * "Dataset" in this recipe was originally cut at "one Model" (v1); v1.5
   * redefines it as "one comparison group," since most real requests for a
   * viewer are actually requests to compare several model runs, not view
   * one in isolation.
   * 'single-reconstruction-globe' / 'reconstruction-group-globe': compare
   * Reconstruction Models directly (their own coastlines and, where
   * present, Boundary Frames) -- no numerical Model, no painted field,
   * ever (see docs/adr/0020). Uses `reconstructionIds` below, never
   * `datasets`/`ui`. The comparison is ONE axis (which Reconstruction
   * Model), not model-group-globe's 2-D grid -- see
   * viewer/src/reconstruction/, viewer/src/reconstructionGroup/, and
   * docs/adr/0021 for the catalog section (`archive.reconstruction_models`)
   * this reads.
   * 'mantle-globe': the mantle viewer (viewer/index.html, src/tomography/)
   * -- cutaway, isosurfaces, depth slices through time, View Presets --
   * over one or more standalone tomography/convection Models from
   * `datasets`. Configured by `mantle`, not `ui`.
   */
  wrapperType: 'single-model-globe' | 'model-group-globe'
    | 'single-reconstruction-globe' | 'reconstruction-group-globe' | 'mantle-globe';
  /**
   * For 'single-model-globe': exactly 1 entry, using that Model's own
   * default_variable/default_resolution (no per-recipe override).
   * For 'model-group-globe': every Model in the intended comparison. Must
   * form a COMPLETE grid over whichever of reconstruction_model/
   * comparison_role actually varies across them -- see resolveModelGroup()
   * for the exact rule (rejects a partial grid rather than offering a
   * dropdown combination that 404s), and requires the same variable
   * vocabulary within each comparison_role across all reconstructions.
   * Absent (and ignored) for the two reconstruction-only wrapper types --
   * see `reconstructionIds`.
   */
  datasets?: Array<{ modelId: string }>;
  /**
   * For 'single-reconstruction-globe': exactly 1 id, from
   * `archive.reconstruction_models[].id`. For 'reconstruction-group-globe':
   * 2 or more, no duplicates -- any subset of the catalog is valid, no
   * completeness rule (unlike model-group-globe's grid) since there is no
   * second axis to complete. Absent (and ignored) for the two numerical-
   * Model wrapper types -- see `datasets`.
   */
  reconstructionIds?: string[];
  /** reconstruction-group-globe only: Reconstruction Model id -> the plate
   *  the viewer anchors that model on (default 0). The model's
   *  rotations.json must include that plate (prep_reconstruction.py
   *  --extra-rotation-plates). */
  anchorPlates?: Record<string, number>;
  /** Only meaningful for 'single-model-globe'/'model-group-globe' -- the
   *  two reconstruction-only wrapper types have no configurable tool menu
   *  (Reconstruction Age is always shown; a Boundary Frame toggle appears
   *  automatically when the selected Reconstruction Model has one -- see
   *  docs/adr/0020) and ignore this field if present. */
  ui?: {
    /** Must be a subset of GlobeTool -- validateRecipe.mjs rejects anything
     *  else, with a near-match suggestion. */
    tools: GlobeTool[];
  };
  /** Opt-in "+ Add globe" toolbar with a Reconstruction Age sync toggle,
   *  offered uniformly across all FOUR wrapper types (see docs/adr/0022) --
   *  unlike `ui.tools`, this is never scoped to just the Model-based types,
   *  since it's an orchestration-level capability (how many instances
   *  exist, whether age broadcasts between them) independent of what any
   *  one instance shows. `syncAge` sets the toggle's initial state, not
   *  whether it exists -- age is the only Synced Field a generated site
   *  offers today (see CONTEXT.md). Absent means a single, fixed instance,
   *  matching every recipe's behaviour before this existed. */
  multiGlobe?: MultiGlobeConfig;
  /** 'mantle-globe' only. `datasets` is the Model list, in dropdown order. */
  mantle?: {
    /** Default: the first of `datasets`. */
    defaultModel?: string;
    defaultCamera?: CameraView;
    /** View Presets (CONTEXT.md), in menu order. Default: all three with
     *  their default geography. A `cutaway` with its own polygon must name
     *  its region, for the menu label. */
    viewPresets?: ViewPresetConfig[];
    /** Default true; each is still listed only when its Models are offered. */
    comparisonPresets?: boolean;
  };
  /** Exactly one of the two. */
  dataHost: {
    /** A live archive base URL every page load fetches from -- see
     *  core/volume.ts's loadArchive(base) and VITE_ARCHIVE_BASE. */
    archiveBase?: string;
    /** A standalone Archive (docs/adr/0054) published as a release asset on
     *  the site's own repo, unpacked beside the app at deploy time. Not
     *  fetchable until published, so validation needs the local Archive
     *  directory. */
    release?: { tag: string; asset: string };
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

/** One `archive.reconstruction_models[]` entry as resolved for a recipe --
 *  see docs/adr/0021. */
export interface ResolvedReconstructionEntry {
  id: string;
  name: string;
  source: string;
  hasBoundaries: boolean;
}

/** Resolved shape for a 'single-reconstruction-globe' recipe. */
export interface ResolvedSingleReconstruction {
  reconstruction: ResolvedReconstructionEntry;
}

/** Resolved shape for a 'reconstruction-group-globe' recipe -- a flat list,
 *  not a grid: the comparison is one axis (which Reconstruction Model),
 *  see docs/adr/0020. */
export interface ResolvedReconstructionGroup {
  entries: ResolvedReconstructionEntry[];
}

/** Resolved shape for a 'mantle-globe' recipe. */
export interface ResolvedMantle {
  models: Array<{ id: string; name: string; type: string; source: string }>;
  defaultModel: string;
}

export type Resolved = ResolvedSingleModel | ResolvedModelGroup
  | ResolvedSingleReconstruction | ResolvedReconstructionGroup | ResolvedMantle;

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
