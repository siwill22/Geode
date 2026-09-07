import type { MultiGlobeConfig } from '../core/tools';

export interface ReconstructionConfig {
  reconstructionId: string;
  title: string;
  multiGlobe?: MultiGlobeConfig;
}

/**
 * The one file generator/scaffoldRepo.mjs overwrites for a
 * `single-reconstruction-globe` recipe (see config.ts's identical role for
 * `single-model-globe`). Checked in with a real, working default so this
 * monorepo's own `npm run dev`/`typecheck` have something concrete to boot
 * reconstruction/main.ts against without running the generator first.
 */
export const RECONSTRUCTION_CONFIG: ReconstructionConfig = {
  reconstructionId: 'muller2019',
  title: 'Müller et al. 2019',
  multiGlobe: { syncAge: false },
};
