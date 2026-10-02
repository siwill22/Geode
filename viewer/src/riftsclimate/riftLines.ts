import type { Camera, PerspectiveCamera } from 'three';

import { ThreeProjector } from '../core/boundaries';
import { FlatProjector } from '../core/flatProjector';
import type { ProjectionMode } from '../core/projection';
import { rotateVector, rotationAt, toRenderFrameRotation, type Quaternion } from '../core/rotation';
import type { Rect } from '../core/layout';
import type { CoastlineLine, RotationTable } from '../core/types';
import { tracePolyline } from '../../vendor/petrify/js/polyline.js';

interface PhaseLines {
  colour: string;
  visible: boolean;
  lines: CoastlineLine[];
  table: RotationTable;
  /** Rotated vertices of the lines live at the current age, flat xyz. */
  xyz: Float64Array;
  runs: Array<[number, number]>;
}

/**
 * Jackson & MacDonald margins, one colour per phase, drawn as 2-px lines on a
 * 2D canvas over the globe.
 *
 * The geometry is prep_coastlines.py's geometry.bin (present-day unit vectors,
 * a plate id and an appear/disappear age per line) and the rotations are the
 * same kind of table the coastlines use, so each margin moves exactly like the
 * continent it sits on and exists only while it is in that phase. They are
 * drawn here rather than as a second `Coastlines` because WebGL lines are one
 * pixel wide, which made a margin barely visible against the continent edges;
 * petrify's `tracePolyline` does the horizon and map-edge breaks, the same as
 * for every other vector layer on a 2D canvas (`core/boundaries.ts`).
 */
export class RiftLines {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globe: ThreeProjector;
  private readonly flat: FlatProjector;
  private mode: ProjectionMode = 'globe';
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  private phases = new Map<string, PhaseLines>();
  private age = 0;

  /** `width` is the coloured line in px (margins 2.2; polygon outlines thinner). */
  constructor(camera: Camera, private readonly width = 2.2) {
    this.globe = new ThreeProjector(camera as PerspectiveCamera);
    this.flat = new FlatProjector(camera);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rift-lines';
    Object.assign(this.canvas.style, { position: 'fixed', pointerEvents: 'none' });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.setRect(this.rect);
  }

  setRect(rect: Rect): void {
    this.rect = rect;
    Object.assign(this.canvas.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    this.globe.setCamera(camera as PerspectiveCamera);
    this.flat.setCamera(camera);
    if (mode !== 'globe') this.flat.setFlatMode(mode);
  }

  /** Map Orientation, geographic frame -- used by the flat projector only (the
   *  caller passes identity on the globe). FlatProjector wants it in the
   *  render frame, as PointOverlay.setReferenceRotation() converts it. */
  setOrientation(q: Quaternion): void {
    this.flat.setReferenceRotation(toRenderFrameRotation(q));
  }

  clear(): void {
    this.phases.clear();
  }

  addPhase(id: string, colour: string, lines: CoastlineLine[], table: RotationTable, visible: boolean): void {
    this.phases.set(id, { colour, visible, lines, table, xyz: new Float64Array(0), runs: [] });
    this.rebuild(this.phases.get(id)!);
  }

  setVisible(id: string, visible: boolean): void {
    const p = this.phases.get(id);
    if (p) p.visible = visible;
  }

  setAge(age: number): void {
    this.age = age;
    for (const p of this.phases.values()) this.rebuild(p);
  }

  private rebuild(p: PhaseLines): void {
    const live = p.lines.filter((l) => l.appearAge >= this.age && l.disappearAge <= this.age);
    const n = live.reduce((a, l) => a + l.points.length / 3, 0);
    const xyz = new Float64Array(n * 3);
    const runs: Array<[number, number]> = [];
    let o = 0;
    for (const l of live) {
      const q = rotationAt(p.table, l.plateId, this.age);
      const count = l.points.length / 3;
      runs.push([o, count]);
      for (let i = 0; i < count; i++) {
        const [x, y, z] = rotateVector(q, l.points[3 * i], l.points[3 * i + 1], l.points[3 * i + 2]);
        xyz[3 * (o + i)] = x;
        xyz[3 * (o + i) + 1] = y;
        xyz[3 * (o + i) + 2] = z;
      }
      o += count;
    }
    p.xyz = xyz;
    p.runs = runs;
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const flat = this.mode !== 'globe';
    const projector = flat ? this.flat : this.globe;
    projector.update(this.rect.width, this.rect.height);
    const project = (v: ArrayLike<number>) => projector.project(v) as number[] | null;
    const seam = flat ? (a: ArrayLike<number>, b: ArrayLike<number>) => this.flat.seamSplit(a, b) : null;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const p of this.phases.values()) {
      if (!p.visible || !p.runs.length) continue;
      ctx.beginPath();
      for (const [offset, count] of p.runs) tracePolyline(ctx, project, p.xyz, offset, count, { seam });
      // A dark casing first, so a margin reads against land and ocean alike.
      ctx.strokeStyle = 'rgba(5, 8, 12, 0.8)';
      ctx.lineWidth = this.width + 1.8;
      ctx.stroke();
      ctx.strokeStyle = p.colour;
      ctx.lineWidth = this.width;
      ctx.stroke();
    }
  }
}
