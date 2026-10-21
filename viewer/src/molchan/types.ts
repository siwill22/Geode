import type { ProjectionMode } from '../core/projection';

/**
 * The Molchan viewer's files, written by prep/prep_riftsclimate_molchan.py from RiftsClimate's
 * `data/geode/molchan/` (its prep/geode_molchan_export.py). Geode only draws them: every
 * number below is RiftsClimate's.
 *
 * A "share" is the share of the test's ground (every place and time slice, weighted by area x
 * duration) that a factor rates higher than a box or a deposit, ground rated the same counting
 * half (RiftsClimate's wp9_fit.tau). 0 = the best-rated ground.
 */

export interface MolchanFactor {
  /** The factor's name in RiftsClimate, e.g. "passive margin". */
  id: string;
  /** The box/deposit column it is measured from (several factors can share one). */
  column: string;
  unit: string;
  /** How it rates the ground, in words. */
  rating: string;
  /** The deposit types it is tested on. */
  types: string[];
}

export interface MolchanIndex {
  title: string;
  /** Shape of the packed files (prep_riftsclimate_molchan.py FORMAT); see MOLCHAN_FORMAT. */
  format: number;
  /** The plate model's id in archive/riftsclimate/index.json: coastlines, margin lines and
   *  continent polygons are read from there. */
  plate_model: string;
  age_max: number;
  types: Array<{ id: string; label: string }>;
  factors: MolchanFactor[];
  /** curves[type][factor]: the skill (0.5 minus the mean share) and every deposit's share,
   *  sorted, as RiftsClimate's pipeline computed them. */
  curves: Record<string, Record<string, { skill: number; shares: number[] }>>;
  counts: { places: number; snapshots: number; boxes: number; boxes_in_test: number; deposits: Record<string, number> };
  files: { boxes: string; deposits: string };
  built_from: Record<string, string | null>;
}

/** Every place and time slice, place-major: value[place * nSnapshots + snapshot], null where
 *  the place has no box. */
export interface MolchanBoxesFile {
  places: { id: number[] };
  /** from_ma is the young end of each slice, to_ma the old end; values were measured at
   *  snapshot_ma. */
  snapshots: { snapshot_ma: number[]; from_ma: number[]; to_ma: number[] };
  m_lon: Array<number | null>;
  m_lat: Array<number | null>;
  /** Area x duration, million km² x Myr. */
  weight: Array<number | null>;
  /** The test merges each place's time slices in pairs: the younger slice of a pair carries
   *  both weights, the older one 0. */
  weight_in_test: Array<number | null>;
  /** Per column (MolchanFactor.column), the raw value; null where there is no such feature. */
  values: Record<string, Array<number | null>>;
  /** Per factor (MolchanFactor.id), the share of the test's ground rated higher. */
  shares: Record<string, Array<number | null>>;
}

/** The deposits the test uses, column by column. */
export interface MolchanDepositsFile {
  deposit_id: string[];
  name: string[];
  type: string[];
  age_ma: number[];
  /** Today. */
  lon: number[];
  lat: number[];
  /** Where it formed, at its own age (Merdith 2021). */
  m_lon: Array<number | null>;
  m_lat: Array<number | null>;
  /** Where it was at each time slice's own age (snapshot_ma), on its plate: deposit-major,
   *  value[deposit * nSnapshots + snapshot], null where it cannot be placed. */
  slice_lon: Array<number | null>;
  slice_lat: Array<number | null>;
  region: string[];
  values: Record<string, Array<number | null>>;
  /** Null for a factor not tested on the deposit's type. */
  shares: Record<string, Array<number | null>>;
}

export type ColourBy = 'share' | 'value';
/** Which deposits are on the map: those formed in this time slice, or within N Myr of the age. */
export type DepositWindow = 'slice' | '10' | '25' | '50';

export interface MolchanViewState {
  type: string;
  factor: string;
  age: number;
  projection: ProjectionMode;
  boxes: boolean;
  colourBy: ColourBy;
  /** The boxes as the test uses them: each place's time slices merged in pairs, the younger
   *  slice's position and values standing for both. */
  testOnly: boolean;
  deposits: boolean;
  window: DepositWindow;
  syn_rift: boolean;
  post_rift: boolean;
  collision: boolean;
  /** The margin lines from the end of their collision to today. */
  after_collision: boolean;
  polygons: boolean;
  coastlines: boolean;
  graticule: boolean;
  diagram: boolean;
}
