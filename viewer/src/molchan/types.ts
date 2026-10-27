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
  /** 'ladder': a factor of steps 1-3; 'new': a new candidate factor for mantle-derived magmas,
   *  through steps 1-2 only (RiftsClimate's prep/combo_new_factors.py). */
  group?: 'ladder' | 'new';
}

/** One factor on one deposit type, as RiftsClimate's pipeline computed it. */
export interface MolchanCurve {
  /** 0.5 minus the mean share, against all the factor's ground (step 1). */
  skill: number;
  /** Every deposit's share, sorted. */
  shares: number[];
  /** New factors only: each deposit ranked against its own geological period's ground only. */
  within_period?: number;
  /** New factors only: each deposit ranked against its own region's ground only (step 2). */
  step2?: number | null;
  /** New factors only: the textbook 5% level, counting districts (1.645 / sqrt(12 n)). */
  ref95_districts?: number;
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
  curves: Record<string, Record<string, MolchanCurve>>;
  counts: { places: number; snapshots: number; boxes: number; boxes_in_test: number; deposits: Record<string, number> };
  /** boundaries: Merdith 2021's plate boundaries at every time slice (as the WP10 viewer's
   *  BoundariesFile), null if not built. */
  files: { boxes: string; deposits: string; boundaries: string | null };
  built_from: Record<string, string | null>;
  /** Geode's Boundary Frames of the same model (with subduction polarity), for the teeth. */
  teeth: { frames: string; age_max: number } | null;
  /** Step 3 of the ladder (combinations, equal weights, percentiles), per deposit type. */
  combos: Record<string, ComboEntry>;
  /** The region each place lies in today (as RiftsClimate's region_of), by place index. */
  place_region: string[];
}

/** One combination map: its held-out map (each region set aside rated by the map made
 *  without it; shares within that region's continental area). */
export interface ComboMap {
  id: string;
  /** 'best': the best-of-all choice (each region's own pick); 'top': among the 20 best by
   *  regional skill; 'published': a published idea or earlier pair; 'one factor'. */
  kind: 'best' | 'top' | 'published' | 'one factor';
  label: string;
  /** Null for the best-of-all choice, whose regions use different combinations. */
  combination: string | null;
  /** Regional skill (the best-of-all choice: the fully held-out skill). */
  skill: number;
  skill_by_region: Record<string, number>;
  deposits_by_region: Record<string, number>;
  /** Per region set aside: the combination behind its map and what was chosen for it
   *  without seeing it (directions, preferred distances). */
  regions: Record<string, { combination: string; chosen: string[] }>;
  file: string;
}

export interface ComboGain {
  group: string;
  factor: string;
  /** Average change in regional skill when the factor is added to a combination. */
  gain: number;
  worlds: number;
  median: number | null;
  highest: number | null;
  at_or_above: number | null;
  world_gains: Array<number | null>;
}

export interface ComboWorlds {
  /** The best-of-all choice's fully held-out skill, real and in each no-effect fake world. */
  real: number;
  real_nc: number;
  worlds: Array<number | null>;
  worlds_nc: Array<number | null>;
}

export interface ComboEntry {
  step: string;
  /** Which candidates: 'main candidates', or 'with screened new factors' (RiftsClimate's
   *  screened run: two slots filled per region set aside by step 1 on the other regions;
   *  index.json key "<type>|screened"). */
  set?: string;
  /** The regions set aside (enough deposits). */
  regions: string[];
  maps: ComboMap[];
  /** File with every combination ranked (ComboRankedFile). */
  ranked: string;
  count: number;
  /** 'regional' and, where run, 'global'. */
  gains: Record<string, ComboGain[]>;
  worlds: Record<string, ComboWorlds>;
}

/** One map's values: boxes place-major as MolchanBoxesFile, in thousandths of a share (null
 *  where the place has no box or its region is not set aside); deposits in the deposits
 *  file's order. */
export interface ComboMapFile {
  id: string;
  boxes: Array<number | null>;
  deposits: Array<number | null>;
}

export interface ComboRankedFile {
  combination: string[];
  skill: Array<number | null>;
  by_region: Record<string, Array<number | null>>;
  with_collision: boolean[];
  n_factors: number[];
  map: Array<string | null>;
}

/** The index.json key of the combination set on screen: "<type>" or "<type>|screened". */
export function comboKey(index: MolchanIndex, state: MolchanViewState): string {
  const screened = `${state.type}|screened`;
  return state.comboSet === 'screened' && index.combos?.[screened] ? screened : state.type;
}

/** A screened run names its slots ("@new idea 1"); each region set aside fills them by step 1
 *  on the other regions, the same for every combination. Name the factor where every region
 *  filled the slot the same way, otherwise say it varies. */
export function nameSlots(entry: ComboEntry | undefined, text: string): string {
  if (!entry || !text.includes('@new idea')) return text;
  return text.replace(/@new idea (\d)/g, (_slot, n) => {
    const fills = slotFills(entry, n);
    const names = [...new Set(Object.values(fills))];
    return names.length === 1 ? `${names[0]} [new idea ${n}]` : `new idea ${n} (varies by region)`;
  });
}

/** What filled slot n for each region set aside. */
export function slotFills(entry: ComboEntry, n: string): Record<string, string> {
  const tail = ` [new idea ${n}]`;
  const out: Record<string, string> = {};
  for (const m of entry.maps) {
    for (const [r, g] of Object.entries(m.regions)) {
      const hit = g.combination.split(/ \+ | \| both at once: | x /).find((t) => t.endsWith(tail));
      if (hit) out[r] = hit.slice(0, -tail.length);
    }
  }
  return out;
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

export type ShowMode = 'factor' | 'combination';

export interface MolchanViewState {
  type: string;
  /** One factor (step 1) or a combination's held-out map (step 3). */
  show: ShowMode;
  factor: string;
  /** The combination map on screen (ComboMap.id). */
  combo: string;
  /** Which combination set: the main candidates, or the run with screened new factors
   *  (where one exists for the type). */
  comboSet: 'main' | 'screened';
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
  /** Merdith 2021's plate boundaries at the time slice, coloured by type or by convergence. */
  boundaries: boolean;
  boundaryColour: 'label' | 'convergence';
  polygons: boolean;
  coastlines: boolean;
  graticule: boolean;
  diagram: boolean;
}
