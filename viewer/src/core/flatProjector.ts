import type { Camera } from 'three';
import { Vector3 } from 'three';
import { meridianCrossing } from '../../vendor/deep-time-map/js/index.js';

import { lonLatToVec3, vec3ToLonLat } from './constants';
import { conjugateQuaternion, rotateVector, type Quaternion } from './rotation';
import { referencePlateProjectedPosition, type ProjectionMode } from './projection';

type Projected = [number, number, number] | null;

/** Reference Plate 0, the overwhelmingly common case -- worth short-circuiting
 *  the rotate/unrotate round trips it would otherwise make no difference to. */
function isIdentityQuat(q: Quaternion): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/**
 * Plate Carrée counterpart of `core/boundaries.ts`'s `ThreeProjector` --
 * turns a deep-time-map GEOGRAPHIC-frame unit vector into a screen position
 * on a flat map instead of the globe -- Plate Carrée or Robinson, via
 * setFlatMode(). `projection.ts`'s
 * `referencePlateFlatPosition()` already does the reanchor-then-reproject
 * work (see its own doc comment); this only adds the geographic xyz -> lon/
 * lat step deep-time-map's vector needs before that call, and the final
 * camera projection to screen pixels. No horizon/occlusion test -- a flat
 * map has no far side, unlike ThreeProjector's sphere.
 *
 * Exported so `core/aggregateOverlay.ts` can reuse it rather than keep a second
 * copy: both overlays face the identical problem (a deep-time-map geographic
 * vector -> a screen position on the flat map), and two copies of the
 * reanchor-then-reproject step would drift the moment one is fixed.
 */
export class FlatProjector {
  private p = new Vector3();
  private w = 0;
  private h = 0;
  private qRef: Quaternion = [0, 0, 0, 1];
  /** Which flat Projection to lay the reanchored point onto. Plate Carrée by
   *  default, so every existing caller is unchanged. */
  private flatMode: ProjectionMode = 'plateCarree';

  // Vector3.project() only needs a generic three.js Camera (it reads
  // .matrixWorldInverse/.projectionMatrix, present on any camera type) --
  // no OrthographicCamera-specific member is ever touched, so this stays
  // untyped-narrower than that on purpose.
  constructor(private camera: Camera) {}

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
  }

  setFlatMode(mode: ProjectionMode): void {
    this.flatMode = mode;
  }

  update(cssWidth: number, cssHeight: number): void {
    this.w = cssWidth;
    this.h = cssHeight;
  }

  project(v: ArrayLike<number>): Projected {
    const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI);
    const lon = Math.atan2(v[1], v[0]) * (180 / Math.PI);
    // Reanchor on the SPHERE, then lay the result down in the active flat
    // Projection -- the same order the raster shader and the coastline rebuild
    // use, and the reverse of it warps the map (ADR-0030).
    const [x, y, z] = referencePlateProjectedPosition(this.flatMode, lon, lat, this.qRef);
    this.p.set(x, y, z).project(this.camera);
    return [
      (this.p.x * 0.5 + 0.5) * this.w,
      (-this.p.y * 0.5 + 0.5) * this.h,
      1, // no occlusion on a flat map -- always "in front"
    ];
  }

  /**
   * Two frames meet in this method, and they do NOT share an up-axis. Mixing
   * them produces a plausible-looking but wrong map, so they are converted
   * explicitly rather than passed around as bare triples:
   *
   * - **geographic** (deep-time-map's): z is the pole. `geoVec`/`geoLonLat`.
   * - **render** (Geode's `constants.ts`): y is the pole, and the frame
   *   `Quaternion`s from `core/rotation.ts` are expressed in. `lonLatToVec3`.
   */
  private static geoVec(lon: number, lat: number): number[] {
    const la = lat * (Math.PI / 180);
    const lo = lon * (Math.PI / 180);
    const c = Math.cos(la);
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
  }

  private static geoLonLat(v: ArrayLike<number>): { lon: number; lat: number } {
    return {
      lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI),
      lon: Math.atan2(v[1], v[0]) * (180 / Math.PI),
    };
  }

  /** Reanchor a (lon, lat) by `q`, via the render frame the quaternion lives
   *  in -- the same round trip `referencePlateProjectedPosition` performs. */
  private static reanchor(lon: number, lat: number, q: Quaternion): { lon: number; lat: number } {
    const [x0, y0, z0] = lonLatToVec3(lon, lat, 1);
    const [x1, y1, z1] = rotateVector(q, x0, y0, z0);
    return vec3ToLonLat(x1, y1, z1);
  }

  /** Where a point sits in the DISPLAY frame -- after the Reference Plate
   *  rotation, which is the frame the map's own edges are fixed in. */
  private displayLonLat(v: ArrayLike<number>): { lon: number; lat: number } {
    const { lon, lat } = FlatProjector.geoLonLat(v);
    if (isIdentityQuat(this.qRef)) return { lon, lat };
    return FlatProjector.reanchor(lon, lat, this.qRef);
  }

  /**
   * Optional part of deep-time-map's projector contract (see its
   * `js/robinson.js`): where a segment crosses this map's edge, so a line layer
   * can break there instead of drawing straight back across the map.
   *
   * Both flat Projections here have their seam at ±180 in the DISPLAY frame,
   * which is not ±180 in the true frame once a Reference Plate rotation is
   * active (docs/plans/reference-plate.md). So the crossing is found in display
   * coordinates and the two edge points are rotated BACK before being handed
   * over -- `project()` rotates them forward again, and returning display-frame
   * vectors would apply that rotation twice.
   */
  seamSplit(a: ArrayLike<number>, b: ArrayLike<number>): [number[], number[]] | null {
    const da = this.displayLonLat(a);
    const db = this.displayLonLat(b);
    if (Math.abs(da.lon - db.lon) <= 180) return null;

    const hit = meridianCrossing(
      FlatProjector.geoVec(da.lon, da.lat), FlatProjector.geoVec(db.lon, db.lat), 180,
    ) as number[] | null;
    if (!hit) return null;
    const seamLat = FlatProjector.geoLonLat(hit).lat;

    const EPS = 1e-4;
    const atEdge = (displayLon: number): number[] => {
      if (isIdentityQuat(this.qRef)) return FlatProjector.geoVec(displayLon, seamLat);
      const t = FlatProjector.reanchor(displayLon, seamLat, conjugateQuaternion(this.qRef));
      return FlatProjector.geoVec(t.lon, t.lat);
    };
    // Leave by the edge the segment was already heading for.
    return da.lon > 0
      ? [atEdge(180 - EPS), atEdge(-180 + EPS)]
      : [atEdge(-180 + EPS), atEdge(180 - EPS)];
  }
}
