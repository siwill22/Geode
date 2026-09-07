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
 * `single-model-globe`). Checked in with the real Cao2024/Muller2019
 * deformation comparison so this monorepo's own `npm run dev`/`typecheck`/
 * `check:render` have something concrete to boot groupGlobe/main.ts
 * against without running the generator first.
 */
export const GROUP_GLOBE_CONFIG: GroupGlobeConfig = {
  title: 'Crustal Deformation Comparison',
  tools: ['legend', 'age-slider', 'no-data-toggle', 'query-point'],
  axisALabel: 'reconstruction',
  axisBLabel: 'role',
  grid: {
    Cao2024: {
      Deformation: 'cao2024-deformation',
      'Age & Heat Flux': 'cao2024-age-heatflux',
    },
    Muller2019: {
      Deformation: 'muller2019-deformation',
      'Age & Heat Flux': 'muller2019-age-heatflux',
    },
  },
  defaultAxisA: 'Cao2024',
  defaultAxisB: 'Deformation',
  multiGlobe: { syncAge: false },
};
