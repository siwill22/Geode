import type { MultiGlobeConfig } from '../core/tools';

export interface ReconstructionGroupConfig {
  title: string;
  multiGlobe?: MultiGlobeConfig;
  /** reconstruction_models[].id values to offer in the dropdown, in order.
   *  Unlike model-group-globe's grid, this is a flat list along ONE axis
   *  (see docs/adr/0020) -- no completeness rule to satisfy, any subset of
   *  the catalog's reconstruction_models is valid. */
  reconstructionIds: string[];
}

/**
 * The one file generator/scaffoldRepo.mjs overwrites for a
 * `reconstruction-group-globe` recipe (see groupConfig.ts's identical role
 * for `model-group-globe`). Checked in with the real Müller 2019 / Seton
 * 2012 comparison so this monorepo's own `npm run dev`/`typecheck` have
 * something concrete to boot reconstructionGroup/main.ts against without
 * running the generator first.
 */
export const RECONSTRUCTION_GROUP_CONFIG: ReconstructionGroupConfig = {
  title: 'Reconstruction Comparison',
  reconstructionIds: ['muller2019', 'seton2012'],
  multiGlobe: { syncAge: false },
};
