/**
 * The mountain-glyph series exported by `prep/prep_oldmap.py`.
 *
 * One small file carries the whole run (201 frames, ~63k glyphs, 1.4 MB), so it
 * is fetched once and indexed by age rather than streamed per frame.
 *
 * A glyph's `id` is a STABLE candidate identity, the same integer in every frame
 * it appears in, which is what lets `orogenAge` drive a fade rather than a
 * blink. See prep_oldmap.py's own note on why the reference notebook cannot do
 * this: it regenerates its point lattice per frame in present-day coordinates,
 * so its glyphs neither persist nor ride the plates.
 */

export interface MountainFrame {
  /** Stable candidate ids, one per glyph. */
  id: number[];
  /** Reconstructed positions at this age, [lon, lat, lon, lat, ...]. */
  lonlat: number[];
  /** Myr since this candidate last satisfied the orogen rule. 0 = active. */
  orogenAge: number[];
}

interface MountainPayload {
  model: string;
  time_step: number;
  age_min: number;
  age_max: number;
  decay_myr: number;
  min_inland_m: number;
  max_trench_m: number;
  /**
   * Whether the export applied the overriding-side condition.
   *
   * Recorded because a glyph set built without it looks entirely plausible: the
   * count barely changes, and what differs is which SIDE of each trench the
   * mountains sit on. An export predating the rule has no such field, which is
   * why this is optional rather than required.
   */
  overriding_side_only?: boolean;
  candidate_count: number;
  count: number;
  frames: Record<string, MountainFrame>;
}

export class MountainSeries {
  private constructor(private readonly data: MountainPayload) {}

  static async load(url: string): Promise<MountainSeries> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new MountainSeries(await res.json() as MountainPayload);
  }

  get model(): string { return this.data.model; }
  get ageMin(): number { return this.data.age_min; }
  get ageMax(): number { return this.data.age_max; }
  get decayMyr(): number { return this.data.decay_myr; }
  get timeStep(): number { return this.data.time_step; }

  /** False for exports predating the overriding-side rule -- see the field's
   *  own note. Surfaced so a viewer or check can say which rule it is showing
   *  rather than assume the current one. */
  get overridingSideOnly(): boolean { return this.data.overriding_side_only === true; }

  /**
   * The frame nearest `age`, or null outside the exported range.
   *
   * Nearest, not interpolated, and that is the right call rather than a
   * shortcut: consecutive frames do not share a glyph LIST -- candidates enter
   * and leave as the rule starts and stops holding -- so there is no vertex
   * correspondence to interpolate along. The coastline underneath does slerp
   * continuously (PolygonLayer.setTime), so at a 1 Myr step the glyphs step
   * while the coast glides; at this glyph size that is not visible, and the
   * alternative is matching by id and tweening, which buys nothing at 1 Myr.
   */
  frameAt(age: number): MountainFrame | null {
    const step = this.data.time_step || 1;
    const snapped = Math.round(age / step) * step;
    const clamped = Math.max(this.data.age_min, Math.min(this.data.age_max, snapped));
    return this.data.frames[String(clamped)] ?? null;
  }

  /** Glyphs in the frame nearest `age` -- for the status line and tests. */
  countAt(age: number): number {
    return this.frameAt(age)?.orogenAge.length ?? 0;
  }
}
