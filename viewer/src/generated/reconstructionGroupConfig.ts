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
 * for `model-group-globe`). Checked in with the Torsvik & Cocks 2017 /
 * Scotese / Merdith 2021 comparison -- the three Reconstruction Models the
 * Paleomagnetic poles toggle (docs/plans/paleomagnetic-poles.md) is exported
 * for -- so this monorepo's own `npm run dev`/`typecheck` have something
 * concrete to boot reconstructionGroup/main.ts against without running the
 * generator first. Only Merdith 2021 has Boundary Frames (ADR-0019); the
 * other two never will (no dynamic polygons in either source model).
 */
export const RECONSTRUCTION_GROUP_CONFIG: ReconstructionGroupConfig = {
  title: 'Paleomagnetic Poles',
  reconstructionIds: ['torsvikcocks2017', 'scotese', 'merdith2021'],
  multiGlobe: { syncAge: false },
};
