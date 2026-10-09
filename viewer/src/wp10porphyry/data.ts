import type { BoxesFile, PackedWalkerSample, WalkerSample } from './types';

/** Unpack a stored sample's depth paths into km (exactly RiftsClimate's 2-decimal values). */
export function decodeSample(p: PackedWalkerSample): WalkerSample {
  const depth_km = p.steps.map((str, i) => {
    const out = new Array<number>(str.length + 1);
    let d = p.depth0_dam[i];
    out[0] = d / 100;
    for (let k = 0; k < str.length; k++) {
      d += p.step_dam[str.charCodeAt(k) - 35];
      out[k + 1] = d / 100;
    }
    return out;
  });
  return { place: p.place, age_ma: p.age_ma, fate: p.fate, depth_km, factor: p.factor };
}

/** Fate codes, in WalkersFile.fates order (prep_riftsclimate_wp10.py FATES). */
export const FOUND = 0;
export const BURIED = 1;
export const ERODED = 2;

/** Fate colours, shared by the map and the depth chart. Checked with the dataviz palette validator on the dark surface: colour-blind and
 *  normal-vision separation pass; found today is deliberately the brightest. */
export const FATE_COLOUR = ['#e0a100', '#4a8fe0', '#c8615a'];
export const FATE_LABEL = ['found today', 'still buried', 'eroded'];

/**
 * The place-and-time boxes, read as a lookup: which snapshot covers an age, and a
 * box's values. Nothing is computed here beyond finding the right entry.
 */
export class Boxes {
  readonly nPlaces: number;
  readonly nSnapshots: number;

  constructor(readonly file: BoxesFile) {
    this.nPlaces = file.places.id.length;
    this.nSnapshots = file.snapshots.snapshot_ma.length;
  }

  /** The snapshot whose interval [from_ma, to_ma) covers this age, or -1. */
  snapshotAt(age: number): number {
    const { from_ma: from, to_ma: to } = this.file.snapshots;
    let lo = 0;
    let hi = this.nSnapshots - 1;
    if (age < from[0] || age > to[hi]) return -1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (to[mid] > age) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  at(column: Array<number | null>, place: number, snapshot: number): number | null {
    if (snapshot < 0) return null;
    return column[place * this.nSnapshots + snapshot];
  }

  /** Where the place was during this snapshot (Merdith 2021), or null if it has no box. */
  position(place: number, snapshot: number): [number, number] | null {
    const lon = this.at(this.file.m_lon, place, snapshot);
    const lat = this.at(this.file.m_lat, place, snapshot);
    return lon == null || lat == null ? null : [lon, lat];
  }
}

/** A simulated porphyry's history, from its sample's columns. */
export class Walkers {
  readonly n: number;
  /** Age at which each was eroded through, or null if it survives to today. */
  readonly erodedAt: Array<number | null>;

  constructor(readonly s: WalkerSample) {
    this.n = s.age_ma.length;
    this.erodedAt = s.depth_km.map((d, i) => (s.fate[i] === ERODED ? s.age_ma[i] - (d.length - 1) : null));
  }

  /** Formed at or before this age and not yet eroded through. */
  exists(i: number, age: number): boolean {
    if (age > this.s.age_ma[i]) return false;
    const e = this.erodedAt[i];
    return e === null ? true : age > e;
  }

  /** Depth of the top below the surface at this age (km; negative = above the surface),
   *  read between the 1 Myr steps of the path as the chart draws it. */
  depthAt(i: number, age: number): number {
    const d = this.s.depth_km[i];
    const k = Math.max(0, Math.min(d.length - 1, this.s.age_ma[i] - age));
    const k0 = Math.floor(k);
    const k1 = Math.min(d.length - 1, k0 + 1);
    return d[k0] + (d[k1] - d[k0]) * (k - k0);
  }

  /** Depth today (the last entry), for those not eroded. */
  depthToday(i: number): number {
    const d = this.s.depth_km[i];
    return d[d.length - 1];
  }
}
