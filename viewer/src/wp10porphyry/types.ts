import type { ProjectionMode } from '../core/projection';

/**
 * The WP10 porphyry Cu viewer's files, written by prep/prep_riftsclimate_wp10.py from
 * RiftsClimate's `data/geode/wp10/` (its prep/wp10_porphyry_ladder.py). Geode only draws
 * them: every number below is RiftsClimate's.
 *
 * Keys of per-setting tables are "<walk> | <rung>", as in RiftsClimate's walkers.json.
 */

export interface WalkSetting {
  id: string;
  label: string;
  /** How far the ground above a deposit moves in one step (one step per Myr). */
  step_m_per_myr: number;
  /** Chance per Myr of moving up (towards the surface) and down. */
  up: number;
  down: number;
}

export interface Rung {
  id: string;
  label: string;
  /** Per walk setting, the fitted formation parameters of a fitted rung: [b] for 1c
   *  (rate ~ (distance + 10 km)^b), five band rates for 1d (0-250, 250-500, 500-1000,
   *  1000-2000, over 2000 km), [b1, b2] for 1e (exp(b1 x + b2 x^2), x = log(distance +
   *  10 km)); null for rungs with nothing fitted. */
  parameters: Record<string, number[] | null>;
}

export interface Wp10Index {
  title: string;
  /** The plate model's id in archive/riftsclimate/index.json: coastlines and the
   *  real porphyries' plates are read from there. */
  plate_model: string;
  age_max: number;
  walks: WalkSetting[];
  rungs: Rung[];
  formation_depth_km: number;
  formation_depth_sd_km: number;
  /** Vertical extent of the body: eroded once its top is this far above the surface. */
  extent_km: number;
  bin_myr: number;
  bins_start_ma: number[];
  /** Ages of porphyries found today, per bin: predicted (scaled to the number of real
   *  porphyries) and observed. */
  curves: Record<string, { predicted: Array<number | null>; observed: Array<number | null> }>;
  /** How far from a subduction zone porphyries formed, per distance band: share of ground
   *  (weighted by the chance of being found), predicted share of finds, real share. */
  shares: Record<string, SharesByBand>;
  counts: Record<string, number>;
  files: { boxes: string; walkers: string; finds: string };
  built_from: Record<string, string | null>;
}

export interface SharesByBand {
  bands: string[];
  ground: Array<number | null>;
  predicted: Array<number | null>;
  real: Array<number | null>;
}

/** Places (present-day) and their place-and-time boxes, place-major:
 *  value[place * nSnapshots + snapshot], null where the place has no box. */
export interface BoxesFile {
  places: { id: number[]; lon: number[]; lat: number[]; area_km2: number[]; region: string[] };
  /** from_ma is the young end of each snapshot's interval, to_ma the old end. */
  snapshots: { snapshot_ma: number[]; from_ma: number[]; to_ma: number[] };
  m_lon: Array<number | null>;
  m_lat: Array<number | null>;
  subduction_km: Array<number | null>;
  /** Chance that a porphyry formed in this box is found today, per walk setting. */
  found_chance: Record<string, Array<number | null>>;
  /** Relative formation rate per area, per rung, under the first walk setting (relative
   *  to the highest box: max 1). */
  formation_rate: Record<string, Array<number | null>>;
  /** "<walk> | <rung>": the rate under that walk, for rungs fitted with the walk included
   *  (1c, 1d, 1e). Use this where it exists. */
  formation_rate_by_walk: Record<string, Array<number | null>>;
}

/** One rung and walk's sample of simulated porphyries, column by column. */
export interface WalkerSample {
  /** Index into BoxesFile.places. */
  place: number[];
  age_ma: number[];
  /** Index into WalkersFile.fates. */
  fate: number[];
  /** Depth of the top of the body below the surface, km, every 1 Myr from formation:
   *  entry k is at age_ma - k Ma. Negative = above the surface (being eroded). The list
   *  stops when the body is eroded through. */
  depth_km: number[][];
  /** Later rungs: the factor tilting the walk at each 1 Myr step (index into
   *  WalkersFile.factors), one per depth step. Absent at rungs 0-1. */
  factor?: number[][];
}

export interface WalkFactor { id: string; label: string; colour: string }

export interface WalkersFile {
  fates: string[];
  factors: WalkFactor[];
  samples: Record<string, WalkerSample>;
}

export interface FindsFile {
  porphyries: {
    deposit_id: string[];
    name: string[];
    age_ma: number[];
    lon: number[];
    lat: number[];
    m_lon: Array<number | null>;
    m_lat: Array<number | null>;
    subduction_km: Array<number | null>;
    /** Index into BoxesFile.places: the place nearest the porphyry today. */
    place: number[];
  };
  predicted_found: Record<string, { place: number[]; predicted: number[]; real: number[] }>;
}

export type FormationColour = 'rate' | 'rate_found';
export type SimColour = 'depth' | 'fate';
export type FindsColour = 'predicted' | 'difference';
export type LineColour = 'fate' | 'factor';

export interface Wp10ViewState {
  rung: string;
  walk: string;
  age: number;
  projection: ProjectionMode;
  formation: boolean;
  formationColour: FormationColour;
  simulated: boolean;
  simColour: SimColour;
  real: boolean;
  finds: boolean;
  findsColour: FindsColour;
  coastlines: boolean;
  graticule: boolean;
  charts: boolean;
  /** How many simulated porphyries the depth chart draws. */
  lines: number;
  onlyFound: boolean;
  lineColour: LineColour;
  /** The charts' age axis runs from this age (left) to today (right). */
  chartSpan: number;
}
