import type { ProjectionMode } from '../core/projection';

/** One Grouping a dataset declares -- several exist, exactly one is active. */
export interface PaleobioGrouping {
  id: string;
  label: string;
  /**
   * Whether the categories are INFERRED by a rule rather than read from the
   * data. Carried into the UI, not just recorded: a derived category that looks
   * like an observed one is how a viewer ends up asserting what it cannot
   * support (see CONTEXT.md, Observed vs Derived Grouping). The legend shows
   * `rule` verbatim whenever this is true.
   */
  derived: boolean;
  rule: string;
}

/** One paleobiology dataset -- see `prep/prep_pbdb.py`. */
export interface PaleobioDataset {
  id: string;
  name: string;
  caption: string;
  citation: string;
  path: string;

  /**
   * The Reconstruction Model this dataset was reconstructed under, ALWAYS
   * explicit. Not optional and never inferred from a manifest `type` the way
   * `core/staticPolygons.ts`'s `resolveStaticPolygonReconstructionId()` falls
   * back to 'scotese' -- that inference is harmless only because every
   * cataloged climate/paleogeography Model happens to be Scotese-based today,
   * and the moment one isn't it would draw fossils under the wrong plates with
   * nothing on screen to show it. The two datasets here already disagree
   * (corals: scotese, panama: muller2019), so the pairing is load-bearing.
   */
  reconstruction_model: string;

  /** Raster Model id to paint under the occurrences, or null for coastlines
   *  only. Null wherever no raster exists under the dataset's OWN
   *  Reconstruction Model -- showing a Scotese PaleoDEM beneath Müller 2019
   *  coastlines would be exactly the ADR-0004 misplacement. */
  base_model: string | null;
  /** Optional surface-temperature Model, same pairing rule. */
  climate_model: string | null;

  age_min: number;
  age_max: number;

  /** [lon, lat] the camera opens looking at, and how far out. A regional dataset
   *  that opened on a whole-globe view would make the reader hunt for its own
   *  data before seeing anything. */
  view_centre: [number, number];
  view_distance: number;

  occurrences: number;
  /** Points assigned no static polygon at all (plate 0). */
  unassigned: number;
  /** Points `PointLayer.isLive()` will never draw at their own age. Surfaced in
   *  the UI rather than left in a prep log: it is 0.1% for panama and 11.6% for
   *  corals, and a reader comparing the two deserves to know. */
  never_drawable: number;
  /** Records resolving to exactly one ICS stage, and those that do not. */
  stage_records: number;
  stage_dropped: number;

  default_grouping: string;
  groupings: PaleobioGrouping[];
  files: {
    points: string;
    aggregates: string;
    latitude: string;
    diversity: string;
  };
}

export interface PaleobioIndex {
  datasets: PaleobioDataset[];
}

export type PaleobioView = 'aggregate' | 'occurrences';

export interface PaleobioViewState {
  dataset: string;
  grouping: string;
  view: PaleobioView;
  age: number;
  showTemperature: boolean;
  sizeBy: 'total' | 'richness';
  projection: ProjectionMode;
}
