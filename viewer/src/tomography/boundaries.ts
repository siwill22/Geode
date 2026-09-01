import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { BoundarySeries, DEFAULT_STYLE } from '../../vendor/deep-time-map/js/index.js';

import { R_SURFACE } from '../core/constants';
import { maskAt } from '../core/mask';
import type { Rect } from './layout';

/**
 * Plate boundaries, drawn by the vendored deep-time-map library onto a 2D canvas
 * over the WebGL globe.
 *
 * That library talks to its host through exactly one method:
 *
 *     project(vec3) -> [x, y, depth] | null
 *
 * so meeting it costs a projector and nothing else. Everything difficult stays
 * on their side: the subduction-polarity triangles, the pixel-spaced decoration
 * walk, the pen-lift at the horizon. Reimplementing the polarity logic against
 * three.js line geometry would mean re-deriving -- and re-verifying -- the one
 * part their README singles out as invisibly wrong when mirrored.
 *
 * ---- Two frames, and why mixing them is safe ------------------------------
 *
 * deep-time-map works in the geographic frame, (cos.lat cos.lon, cos.lat
 * sin.lon, sin.lat), with Z through the north pole. Geode works in three.js's
 * Y-up frame, where the same point is (cos.lat cos.lon, sin.lat, -cos.lat
 * sin.lon). The map between them, (gx, gy, gz) -> (gx, gz, -gy), is a
 * permutation with determinant +1: a rotation, not a mirror.
 *
 * That matters because the library resolves which side of a trench the
 * triangles go on with a cross product, `a x tangent`, taken on the sphere in
 * ITS frame and only then projected. A rotation preserves cross products, so
 * the polarity survives untouched. (A reflection would not -- and would silently
 * mirror every subduction zone.) The conversion happens here, in one place, and
 * the vendored code is not modified.
 */

type Projected = [number, number, number] | null;

export class ThreeProjector {
  private camDir = new Vector3();
  private p = new Vector3();
  private horizon = 0;
  private w = 0;
  private h = 0;

  /** Current cutaway raster, or null when nothing is cut. */
  mask: Uint8Array | null = null;

  constructor(private camera: PerspectiveCamera) {}

  /** Refresh the per-frame camera terms. Call once before drawing. */
  update(cssWidth: number, cssHeight: number): void {
    this.w = cssWidth;
    this.h = cssHeight;
    const d = this.camera.position.length();
    this.camDir.copy(this.camera.position).divideScalar(d || 1);
    // The visible cap of a sphere of radius R seen from distance d is where
    // dot(v, camDir) > R/d -- NOT dot > 0, which is the orthographic answer.
    // At the default d = 2.6 R the two differ by 23 degrees of arc, a band of
    // the far side that would be drawn over the limb.
    this.horizon = R_SURFACE / (d || 1);
  }

  project(v: ArrayLike<number>): Projected {
    // Geographic -> three.js. See the note above on why this is orientation-safe.
    const x = v[0];
    const y = v[2];
    const z = -v[1];

    const depth = x * this.camDir.x + y * this.camDir.y + z * this.camDir.z;
    if (depth <= this.horizon) return null;

    if (this.mask) {
      // lon/lat from the GEOGRAPHIC vector -- constants.vec3ToLonLat expects a
      // three.js one and would silently swap two axes if used here.
      const lon = Math.atan2(v[1], v[0]) * (180 / Math.PI);
      const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI);
      // The overlay has no depth buffer, so where the cutaway has removed the
      // ground the line has to be culled explicitly. Returning null makes
      // tracePolyline lift the pen, exactly as it does at the horizon.
      if (maskAt(this.mask, lon, lat)) return null;
    }

    this.p.set(x, y, z).project(this.camera);
    return [
      (this.p.x * 0.5 + 0.5) * this.w,
      (-this.p.y * 0.5 + 0.5) * this.h,
      depth,
    ];
  }
}

export interface BoundaryFrameInfo {
  time: number;
  file: string;
  features: number;
  subduction: number;
}

export class BoundaryOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly projector: ThreeProjector;
  private series: BoundarySeries | null = null;
  /** Time of the frame actually on screen, which need not be the slider's age. */
  frameTime: number | null = null;
  visible = true;
  /** CSS-pixel tile this overlay covers. Defaults to the full window. */
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(camera: PerspectiveCamera) {
    this.projector = new ThreeProjector(camera);

    const c = document.createElement('canvas');
    Object.assign(c.style, {
      position: 'fixed',
      // The overlay must never eat clicks: polygon drawing and OrbitControls
      // both live on the WebGL canvas underneath it.
      pointerEvents: 'none',
    });
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d')!;
    this.applyRect();
  }

  /**
   * Move/resize this overlay to a new tile, in CSS pixels. Called once at
   * boot with the full window and again whenever the globe grid is
   * relaid out -- adding, removing, or resizing changes every tile's rect.
   */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    Object.assign(this.canvas.style, {
      left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
    });
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // Draw in CSS pixels so the library's pixel-spaced decorations keep the
    // size they were tuned at, whatever the display density.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async load(url: string): Promise<void> {
    // The library's own default renders subduction zones (and their polarity
    // triangles, which share this colour -- see boundaries.js) in a pale
    // peach; Geode wants them black. Spreading DEFAULT_STYLE.subduction
    // rather than passing just { stroke } because the library's merge is
    // shallow (BoundaryLayer's constructor replaces the whole `subduction`
    // entry, not just the field given), so width/label would otherwise be
    // dropped.
    this.series = await BoundarySeries.load(url, {
      style: { subduction: { ...DEFAULT_STYLE.subduction, stroke: '#000000' } },
    });
  }

  get timeRange(): [number, number] | null {
    return this.series ? (this.series.timeRange as [number, number]) : null;
  }

  /**
   * Point the series at an age. Resolves once the frame is on screen; the
   * previous frame stays up in the meantime rather than flashing an empty globe.
   */
  async setAge(age: number, onFrame?: (f: BoundaryFrameInfo) => void): Promise<void> {
    if (!this.series) return;
    await this.series.setTime(age, (f: BoundaryFrameInfo) => {
      this.frameTime = f.time;
      onFrame?.(f);
    });
  }

  setMask(mask: Uint8Array | null): void {
    this.projector.mask = mask;
  }

  /** Detach the overlay canvas. Called when a globe instance is removed. */
  dispose(): void {
    this.canvas.remove();
  }

  draw(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    if (!this.visible || !this.series) return;
    this.projector.update(this.rect.width, this.rect.height);
    this.series.draw(this.ctx, this.projector);
  }
}
