import type { Camera, PerspectiveCamera } from 'three';

import { ThreeProjector } from '../core/boundaries';
import { FlatProjector } from '../core/flatProjector';
import { lonLatToVec3 } from '../../vendor/petrify/js/sphere.js';
import { tracePolyline } from '../../vendor/petrify/js/polyline.js';
import type { ProjectionMode } from '../core/projection';
import { toRenderFrameRotation, type Quaternion } from '../core/rotation';
import type { Rect } from '../core/layout';

/** One boundary as packed by prep_riftsclimate_wp10.py: label index, lon[], lat[],
 *  convergence (cm/yr per point, + = the two plates close, null = unknown). */
export type PackedBoundary = [number, number[], number[], Array<number | null>];

export interface BoundaryStyleGroup { id: string; label: string; colour: string; width: number; members: string[] }

/** Label colours: subduction zones stand out (and carry teeth); the boundaries that can
 *  also be convergent under another name (orogenic belts) get the next warm colour.
 *  Checked with the dataviz palette validator on the dark surface (colour-blind and
 *  normal-vision separation pass). */
export const LABEL_GROUPS: BoundaryStyleGroup[] = [
  { id: 'subduction', label: 'Subduction zone', colour: '#ff4d6d', width: 2.2, members: ['SubductionZone'] },
  { id: 'orogenic', label: 'Orogenic belt', colour: '#f39a3c', width: 1.8, members: ['OrogenicBelt'] },
  { id: 'ridge', label: 'Mid-ocean ridge', colour: '#38c9b0', width: 1.6, members: ['MidOceanRidge'] },
  { id: 'transform', label: 'Transform', colour: '#b48cff', width: 1.3, members: ['Transform'] },
  { id: 'inferred', label: 'Inferred palaeo-boundary', colour: '#d9c27a', width: 1.3, members: ['InferredPaleoBoundary'] },
  { id: 'other', label: 'Other (rift, fault, fracture zone, terrane boundary, ...)', colour: '#8e9aa6', width: 1.0, members: [] },
];

/** Convergence colour scale: +/- this many cm/yr saturate. */
export const CONV_MAX = 5;
const CONV_STEPS = 10;
export const UNKNOWN_COLOUR = 'rgba(160, 168, 178, 0.7)';

export type BoundaryColouring = 'label' | 'convergence';

interface Run { offset: number; count: number }
interface Bucket { colour: string; width: number; dashed: boolean; runs: Run[] }

/**
 * RiftsClimate's plate boundaries at one snapshot, drawn as lines on a 2D canvas over the
 * map, like the deposit viewer's margins (riftLines.ts): petrify's tracePolyline does the
 * horizon and map-edge breaks. Coloured by label (one colour per feature) or by the
 * convergence rate along it (each stretch of the line in the colour of its rate), and
 * optionally only where the two plates close fast enough.
 *
 * The positions are already reconstructed to the snapshot age; nothing is rotated here.
 * Picking reads the positions of the last draw, so it hits what is on screen.
 */
export class BoundaryLines {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globe: ThreeProjector;
  private readonly flat: FlatProjector;
  private mode: ProjectionMode = 'globe';
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  visible = true;

  private features: PackedBoundary[] = [];
  private labels: string[] = [];
  private xyz = new Float64Array(0);
  private offsets: number[] = [];
  private buckets: Bucket[] = [];
  /** Screen positions of each drawn run's vertices, from the last draw, for picking. */
  private drawn: Array<{ feature: number; offset: number; pts: Array<number[] | null> }> = [];

  constructor(camera: Camera, private readonly convergentCmYr: number, private readonly convColour: (s: number) => string) {
    this.globe = new ThreeProjector(camera as PerspectiveCamera);
    this.flat = new FlatProjector(camera);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'boundary-lines';
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

  /** Map Orientation, geographic frame; the flat projector wants the render frame. */
  setOrientation(q: Quaternion): void {
    this.flat.setReferenceRotation(toRenderFrameRotation(q));
  }

  /** The boundaries of one snapshot. */
  setFeatures(features: PackedBoundary[], labels: string[]): void {
    this.features = features;
    this.labels = labels;
    const n = features.reduce((a, f) => a + f[1].length, 0);
    this.xyz = new Float64Array(n * 3);
    this.offsets = [];
    const v = [0, 0, 0];
    let o = 0;
    for (const f of features) {
      this.offsets.push(o);
      for (let i = 0; i < f[1].length; i++) {
        lonLatToVec3(f[1][i], f[2][i], v);
        this.xyz[3 * (o + i)] = v[0];
        this.xyz[3 * (o + i) + 1] = v[1];
        this.xyz[3 * (o + i) + 2] = v[2];
      }
      o += f[1].length;
    }
  }

  labelOf(feature: number): string { return this.labels[this.features[feature][0]]; }
  feature(i: number): PackedBoundary { return this.features[i]; }

  static groupOf(label: string): BoundaryStyleGroup {
    return LABEL_GROUPS.find((g) => g.members.includes(label)) ?? LABEL_GROUPS[LABEL_GROUPS.length - 1];
  }

  /** Rebuild the colour buckets: which stretches of which boundary get which stroke. */
  restyle(colouring: BoundaryColouring, convergentOnly: boolean): void {
    const buckets = new Map<string, Bucket>();
    const bucket = (key: string, colour: string, width: number, dashed = false) => {
      let b = buckets.get(key);
      if (!b) { b = { colour, width, dashed, runs: [] }; buckets.set(key, b); }
      return b;
    };
    this.features.forEach((f, fi) => {
      const group = BoundaryLines.groupOf(this.labels[f[0]]);
      const conv = f[3];
      const off = this.offsets[fi];
      // A stretch is the run of segments sharing one key; a segment's rate is the mean of
      // its two ends (unknown if either end is).
      let start = -1;
      let key = '';
      let style: [string, number, boolean] = ['', 0, false];
      const flush = (end: number) => {
        if (start >= 0 && end > start) bucket(key, ...style).runs.push({ offset: off + start, count: end - start + 1 });
        start = -1;
      };
      for (let k = 0; k + 1 < f[1].length; k++) {
        const a = conv[k];
        const b = conv[k + 1];
        const c = a == null || b == null ? null : (a + b) / 2;
        if (convergentOnly && (c == null || c < this.convergentCmYr)) { flush(k); continue; }
        let kk: string;
        let st: [string, number, boolean];
        if (colouring === 'label') {
          kk = group.id;
          st = [group.colour, group.width, false];
        } else if (c == null) {
          kk = 'unknown';
          st = [UNKNOWN_COLOUR, 1.1, true];
        } else {
          // Closing is warm: s = -rate / CONV_MAX on the red (negative) side of diverge().
          const q = Math.max(-CONV_STEPS, Math.min(CONV_STEPS, Math.round((c / CONV_MAX) * CONV_STEPS)));
          const sz = group.id === 'subduction';
          kk = `c${q}${sz ? 's' : ''}`;   // width is part of the bucket
          st = [this.convColour(-q / CONV_STEPS), sz ? 2.4 : 1.9, false];
        }
        if (kk !== key || start < 0) { flush(k); start = k; key = kk; style = st; }
      }
      flush(f[1].length - 1);
    });
    // Draw order: unknown and other first, subduction last (on top).
    const order = (b: Bucket) => (b.dashed ? 0 : b.width);
    this.buckets = [...buckets.values()].sort((a, b) => order(a) - order(b));
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    this.drawn = [];
    if (!this.visible) return;
    const flat = this.mode !== 'globe';
    const projector = flat ? this.flat : this.globe;
    projector.update(this.rect.width, this.rect.height);
    const project = (v: ArrayLike<number>) => projector.project(v) as number[] | null;
    const seam = flat ? (a: ArrayLike<number>, b: ArrayLike<number>) => this.flat.seamSplit(a, b) : null;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const b of this.buckets) {
      ctx.beginPath();
      for (const r of b.runs) {
        const pts: Array<number[] | null> = [];
        tracePolyline(ctx, project, this.xyz, r.offset, r.count, { seam, projected: pts });
        this.drawn.push({ feature: this.featureAt(r.offset), offset: r.offset, pts });
      }
      ctx.setLineDash(b.dashed ? [3, 3] : []);
      // A dark casing first, so a line reads over land, ocean and squares alike.
      ctx.strokeStyle = 'rgba(5, 8, 12, 0.75)';
      ctx.lineWidth = b.width + 1.6;
      ctx.stroke();
      ctx.strokeStyle = b.colour;
      ctx.lineWidth = b.width;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private featureAt(offset: number): number {
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** The boundary drawn nearest (x, y), within `radius` px: feature and vertex index. */
  pick(x: number, y: number, radius = 5): { feature: number; vertex: number } | null {
    if (!this.visible) return null;
    let best: { feature: number; vertex: number } | null = null;
    let bestD = radius * radius;
    for (const d of this.drawn) {
      const p = d.pts;
      for (let k = 0; k + 1 < p.length; k++) {
        const a = p[k];
        const b = p[k + 1];
        if (!a || !b) continue;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        // Seam-split runs can jump across the map between two projected points; skip.
        if (l2 > 200 * 200) continue;
        let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = a[0] + t * dx - x;
        const ey = a[1] + t * dy - y;
        const dd = ex * ex + ey * ey;
        if (dd <= bestD) {
          bestD = dd;
          const local = d.offset - this.offsets[d.feature] + (t < 0.5 ? k : k + 1);
          best = { feature: d.feature, vertex: Math.min(local, this.features[d.feature][1].length - 1) };
        }
      }
    }
    return best;
  }
}
