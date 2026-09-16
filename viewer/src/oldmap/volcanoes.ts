/**
 * The volcano-symbol series exported by `prep/prep_oldmap_volcanoes.py`.
 *
 * Three independent populations per frame, and the independence is the point:
 *
 *   ridge  evenly spaced along resolved mid-ocean ridges
 *   plume  deep hotspots (Whittaker's PlumeType), in the ocean, mantle frame
 *   lip    Large Igneous Province eruption sites, for a window around each
 *          province's own age
 *
 * None of them references the others. An earlier version made a LIP's symbol
 * depend on being matched to a plume, which found an age for 1 of 16 provinces
 * -- a way of losing LIPs rather than of placing them. A LIP compilation already
 * records where a province is and how old it is.
 *
 * Unlike `MountainSeries`, no glyph here has an identity across frames or a
 * decay: ridge points are re-resolved from the plate topology every frame, and
 * a LIP site is simply present or absent. So there is no id array and nothing
 * to fade.
 */

export interface VolcanoGroup {
  /** Present for plume and lip, empty for ridge -- ridge points are anonymous. */
  name: string[];
  /** [lon, lat, lon, lat, ...] at this age. */
  lonlat: number[];
}

export interface VolcanoFrame {
  /** [lon, lat, ...]; no names, these are just points along the ridge. */
  ridge: number[];
  plume: VolcanoGroup;
  lip: VolcanoGroup;
}

interface VolcanoPayload {
  model: string;
  time_step: number;
  age_min: number;
  age_max: number;
  ridge_spacing_km: number;
  lip_window_myr: number;
  lip_compilation: string;
  lip_source: string;
  plume_source: string;
  plume_track_max_ma: number;
  deep_types: string[] | null;
  frames: Record<string, VolcanoFrame>;
}

export class VolcanoSeries {
  private constructor(private readonly data: VolcanoPayload) {}

  static async load(url: string): Promise<VolcanoSeries> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new VolcanoSeries(await res.json() as VolcanoPayload);
  }

  get model(): string { return this.data.model; }
  get lipWindowMyr(): number { return this.data.lip_window_myr; }
  /** Oldest age any hotspot track reaches. Plumes simply stop existing beyond
   *  it -- they are not held at a last known position, which would draw a
   *  stationary hotspot through history the model does not cover. */
  get plumeTrackMaxMa(): number { return this.data.plume_track_max_ma; }

  /** Nearest frame, same rule as MountainSeries -- consecutive frames share no
   *  point list, so there is nothing to interpolate along. */
  frameAt(age: number): VolcanoFrame | null {
    const step = this.data.time_step || 1;
    const snapped = Math.round(age / step) * step;
    const clamped = Math.max(this.data.age_min, Math.min(this.data.age_max, snapped));
    return this.data.frames[String(clamped)] ?? null;
  }

  /** Per-population counts at this age -- for the status line and tests. */
  countsAt(age: number): { ridge: number; plume: number; lip: number } {
    const f = this.frameAt(age);
    return {
      ridge: (f?.ridge.length ?? 0) / 2,
      plume: (f?.plume.lonlat.length ?? 0) / 2,
      lip: (f?.lip.lonlat.length ?? 0) / 2,
    };
  }
}
