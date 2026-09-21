import type { GlobeTool, MultiGlobeConfig } from '../core/tools';

export interface GroupGlobeConfig {
  title: string;
  tools: GlobeTool[];
  multiGlobe?: MultiGlobeConfig;
  /** Dropdown label for the reconstruction_model axis. */
  axisALabel: string;
  /** Dropdown label for the comparison_role axis. */
  axisBLabel: string;
  /** axisA value -> axisB value -> modelId. A complete grid -- see
   *  generator/validateRecipe.mjs's resolveModelGroup(). */
  grid: Record<string, Record<string, string>>;
  defaultAxisA: string;
  defaultAxisB: string;
}

/**
 * The one file generator/scaffoldRepo.mjs overwrites for a `model-group-globe`
 * recipe (see viewer/src/generated/config.ts's identical role for
 * `single-model-globe`). Normally checked in with a real, working default so
 * this monorepo's own `npm run dev`/`typecheck`/`check:render` have something
 * concrete to boot groupGlobe/main.ts against without running the generator
 * first -- but the comparison family that used to serve that role (a
 * Cao2024/Muller2019 deformation comparison) has been pulled out of this
 * repo's own archive into a separate private one, and it was the ONLY
 * comparison family in the catalog. Deliberately left with no working
 * default rather than fabricating a fake comparison family out of unrelated
 * Models: `npm run dev`/`groupGlobe.html` will throw
 * (groupGlobeInstance.ts's loadCell(): "no model in archive with id ...")
 * until a real one exists. Tracked in issue #26.
 */
export const GROUP_GLOBE_CONFIG: GroupGlobeConfig = {
  title: 'Model Comparison',
  tools: ['legend', 'age-slider', 'no-data-toggle', 'query-point'],
  axisALabel: 'reconstruction',
  axisBLabel: 'role',
  grid: {},
  defaultAxisA: '',
  defaultAxisB: '',
  multiGlobe: { syncAge: false },
};
