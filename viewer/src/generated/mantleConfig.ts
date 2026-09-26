/** A camera position: looking at (lon, lat) from `dist` globe radii. */
export interface CameraView {
  lon: number;
  lat: number;
  dist: number;
}

/**
 * One View Preset (CONTEXT.md): a way of showing whatever Model is loaded,
 * naming no Model. The geography is overridable, since "cut open under the
 * Atlantic" suits one Model's story and "under the Americas" another's.
 */
export type ViewPresetConfig =
  | { kind: 'isosurfaces'; camera?: CameraView }
  | {
    kind: 'cutaway';
    /** lon/lat vertices of the cut; default a square over the Atlantic. */
    polygon?: [number, number][];
    /** Where the cut is, for the menu label: "under <region>". */
    region?: string;
    depthKm?: number;
    camera?: CameraView;
  }
  | {
    kind: 'sinking-slice';
    /** Age the slider starts at, in Ma; default 50. */
    startAge?: number;
    camera?: CameraView;
  };

export interface MantleConfig {
  title: string;
  /** Models offered, in dropdown order; absent means every Model in the
   *  Archive. */
  models?: string[];
  /** The Model the first globe boots on. */
  defaultModel: string;
  /** Absent keeps the viewer's own starting view. */
  defaultCamera?: CameraView;
  /** View Presets offered, in menu order; absent means all three with
   *  their default geography. */
  viewPresets?: ViewPresetConfig[];
  /** Offer Comparison Presets at all. Each is still listed only when every
   *  Model it needs is offered. Default true. */
  comparisonPresets?: boolean;
}

/**
 * The file generator/scaffoldRepo.mjs overwrites with a recipe's own values
 * for a 'mantle-globe' site. Checked in with this repo's own mantle viewer
 * (viewer/index.html) settings, so `npm run dev` and `check:render` boot
 * without running the generator.
 */
export const MANTLE_CONFIG: MantleConfig = {
  title: 'Geode',
  defaultModel: 'reveal',
};
