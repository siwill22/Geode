import type { ProjectionMode } from '../core/projection';

/** One value's distribution over the deposits, precomputed by RiftsClimate's
 *  `prep/geode_export.py`: counts on one shared set of bins, for all deposits
 *  and for each deposit class. */
export interface FieldDistribution {
  edges: number[];
  all: number[];
  n: number;
  missing: number;
  by_class: Record<string, number[]>;
  n_class: Record<string, number>;
}

/** A deposit class's own summary for one rank value, from RiftsClimate's
 *  per-class random-place test (`prep/wp5_rift_test.csv`). */
export interface ClassTest {
  deposits_compared?: number | null;
  deposit_median_km?: number | null;
  random_median_km?: number | null;
  mean_rank?: number | null;
  expected_mean_rank?: number | null;
  z?: number | null;
  p_closer?: number | null;
  [key: string]: number | null | undefined;
}

/** One value the analysis holds for every deposit. */
export interface FieldDef {
  key: string;
  label: string;
  /** Panel section. */
  group: string;
  /** Optional heading inside a section (rift values: source and plate model). */
  subgroup?: string;
  /** A value drawn as a detail line under another (a rank under its distance). */
  parent?: string;
  unit: string;
  about: string;
  kind: 'num' | 'bool';
  dist: FieldDistribution;
  class_test?: Record<string, ClassTest>;
}

export interface DepositClass { id: string; label: string; n: number }

export interface FieldCatalogue {
  meta: Record<string, unknown>;
  sections: string[];
  classes: DepositClass[];
  fields: FieldDef[];
}

/** values.json: every deposit's values, column by column, in `ids` order. */
export interface DepositValues {
  ids: string[];
  /** Each deposit's class, in `ids` order. */
  classes: string[];
  columns: Record<string, Array<number | null>>;
}

export interface DrawCounts {
  deposits: number;
  drawable_at_own_age: number;
  unassigned: number;
  older_than_their_plate: number;
  no_rotation_at_own_age: number;
  plate_polygon_ends_before_present: number;
  placed_by_analysis: number;
  disagree_with_analysis: number;
}

export interface RiftPhase {
  id: string;
  label: string;
  colour: string;
  geometry: string;
  rotations: string;
}

/**
 * One plate model and everything drawn under it. The whole entry is swapped
 * together by the plate-model selector: no layer of one model is ever drawn
 * under another's plates (ADR-0004, ADR-0034, ADR-0057).
 */
export interface RiftsModel {
  id: string;
  label: string;
  gprm: string;
  age_min: number;
  age_max: number;
  /** petrify points.json (gzipped), deposits on the plates the analysis gave them. */
  points: string;
  coastlines: {
    /** The archive's own reconstruction files, read in place. */
    geometry: string;
    rotations: string;
    /** 540-1000 Ma rotations for the same plates, appended in the browser. */
    rotations_extension: string;
    age_min: number;
    age_max: number;
    name: string;
    citation: string;
    plates_fixed_540_1000: number;
  };
  counts: DrawCounts;
  /** Archive path of a climate Model's manifest, or null: climate exists only
   *  in the Scotese frame. */
  climate_model: string | null;
  climate_age_max: number | null;
  rifts: RiftPhase[] | null;
  deformation: { base: string; path: string; id: string; frames: number } | null;
}

export interface RiftsIndex {
  title: string;
  fields: string;
  values: string;
  classes: DepositClass[];
  built_from: Record<string, unknown>;
  models: RiftsModel[];
}

/** A deposit as carried in points.json. */
export interface DepositPoint {
  lon: number;
  lat: number;
  age: number | null;
  plate_id: number;
  plate_begin_age: number | null;
  type: string;
  deposit_id: string;
  name: string;
  age_uncertainty_ma: number | null;
}

export type ClimateLayer = 'none' | 'P' | 'T';
export type DeformationLayer = 'none' | 'horizontal_divergence' | 'deformation_style';

export interface RiftsViewState {
  model: string;
  age: number;
  projection: ProjectionMode;
  coastlines: boolean;
  graticule: boolean;
  climate: ClimateLayer;
  deformation: DeformationLayer;
  rifts: Record<string, boolean>;
  /** 'class', or a field key to colour the deposits by. */
  colourBy: string;
  /** 'since': every deposit formed by this age; 'window': only those forming
   *  within `window` Myr of it. */
  lifespan: 'since' | 'window';
  window: number;
  classes: Record<string, boolean>;
}
