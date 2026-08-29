import type { LonLat } from './constants';

export interface VariableInfo {
  id: string;
  name: string;
  source_var: string;
  units: string;
  diverging: boolean;
  /**
   * What a HIGH value means physically, which fixes the colour polarity.
   * 'fast' -> cold material at the high end (velocity anomaly);
   * 'hot'  -> warm material at the high end (temperature anomaly).
   * A slab is positive in one and negative in the other, so this cannot be
   * inferred from the model. Absent means 'fast': every model ingested before
   * the convection series was a velocity anomaly.
   */
  high_means?: 'fast' | 'hot';
  /** Range the uint8 quantisation spans. Fixed at ingest; clip cannot exceed it. */
  encode_min: number;
  encode_max: number;
  /** True physical extremes in the source. Metadata only, never used for display. */
  value_min: number;
  value_max: number;
  /** Where the colour ramp starts and ends when first shown. Draggable at runtime. */
  default_clip_min: number;
  default_clip_max: number;
  default_colormap: string;
}

export interface ResolutionInfo {
  id: string;
  nlon: number;
  nlat: number;
  ndepth: number;
}

export interface FrameInfo {
  id: string;
  age_ma: number;
}

export interface Manifest {
  id: string;
  name: string;
  type: 'tomography' | 'convection';
  source: string;
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
  /** The MODEL's valid depth range, not the mantle's. Never use R_CMB for this. */
  depth_min_km: number;
  depth_max_km: number;
  dtype: string;
  default_resolution: string;
  resolutions: ResolutionInfo[];
  frames: FrameInfo[];
  path_template: string;
  default_variable: string;
  variables: VariableInfo[];
}

export interface ArchiveIndex {
  models: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    path: string;
    variables: Array<{ id: string; name: string }>;
    depth_min_km: number;
    depth_max_km: number;
  }>;
  colormaps: string;
  coastlines: {
    geometry: string;
    rotations: string;
    age_min: number;
    age_max: number;
  };
  /** deep-time-map series manifest, absent if the boundaries were not exported. */
  boundaries?: string;
}

export interface ColormapData {
  [name: string]: {
    diverging: boolean;
    /** Which end of the ramp is warm; null for sequential maps. */
    high_end?: 'warm' | 'cool' | null;
    colors: [number, number, number][];
  };
}

/**
 * The cutaway polygon plus how deep it cuts and which side is removed.
 * Every consumer (mask, walls, floor, UI) derives from this and rebuilds on change.
 */
export interface CutawayState {
  vertices: LonLat[];
  closed: boolean;
  depthKm: number;
  /**
   * Which of the two regions is removed. A closed curve on a sphere divides it
   * into two and neither is intrinsically the interior. Seeded on close so the
   * SMALLER region is removed, then sticky: never recomputed on vertex drag.
   */
  inverted: boolean;
}

/** One coastline polyline in present-day coordinates, with its lifespan. */
export interface CoastlineLine {
  plateId: number;
  /** Larger Ma value: when the feature comes into existence. */
  appearAge: number;
  /** Smaller Ma value: when it ceases to exist. */
  disappearAge: number;
  /** Unit vectors in the geographic frame, rotated before frame conversion. */
  points: Float32Array;
  /**
   * Vertices for the filled interior: the boundary plus interior sample points.
   * Separate from `points` because a fill triangulated only on the boundary
   * produces triangles that chord beneath the sphere on continent scales.
   */
  landPoints: Float32Array | null;
  /** Triangle indices into `landPoints`, or null for open polylines. */
  triangles: Uint32Array | null;
}

export interface RotationTable {
  ages: number[];
  anchor: number;
  plates: Record<string, [number, number, number, number][]>;
}
