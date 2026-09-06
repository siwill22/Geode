import type { GlobeTool, MultiGlobeConfig } from '../core/tools';

export interface GlobeConfig {
  modelId: string;
  title: string;
  tools: GlobeTool[];
  multiGlobe?: MultiGlobeConfig;
}

/**
 * The one file generator/scaffoldRepo.mjs overwrites with a recipe's own
 * resolved values (see docs/plans/consider-this-general-question-virtual-kay.md).
 * Checked in with a real, working default so this monorepo's own
 * `npm run dev`/`typecheck`/`check:render` have something concrete to boot
 * viewer/globe/main.ts against without running the generator first.
 */
export const GLOBE_CONFIG: GlobeConfig = {
  modelId: 'cao2024-deformation',
  title: 'Geode Globe',
  tools: ['legend', 'age-slider', 'no-data-toggle', 'query-point'],
};
