import { Vector3, type Camera, type PerspectiveCamera } from 'three';
import { PolygonLayer, tracePolyline } from '../../vendor/deep-time-map/js/index.js';

import { R_SURFACE } from '../core/constants';
import { ThreeProjector } from '../core/boundaries';
import { FlatProjector } from '../core/flatProjector';
import type { ProjectionMode } from '../core/projection';
import type { Quaternion } from '../core/rotation';
import type { Rect } from '../core/layout';
import { MOUNTAIN_ASPECT, mountainGlyph } from './mountainGlyph';
import type { MountainSeries } from './mountains';

/**
 * Every mark on the map: the graded coastal wash, the nested offshore rings, the
 * coastline pen line, and the hachured mountain glyphs. One 2D canvas over the
 * WebGL one, the same technique `core/boundaries.ts` established.
 *
 * ---- The one thing to know before reading this file ----------------------
 *
 * **The wash and the rings are drawn in SCREEN PIXELS, not in kilometres.** A
 * band is not 400 km wide, it is 18 px wide, and it stays 18 px wide near an
 * orthographic limb where 400 km would have compressed to nearly nothing. That
 * is deliberate and it is the opposite of how the rest of this repo behaves --
 * see docs/adr/0037, which exists because a reader finding pixel-width distance
 * bands in a codebase this careful about spherical geometry will reasonably
 * assume it is a bug.
 *
 * The short version: the wash and rings are decoration, the mountains are a
 * claim. Mountain POSITIONS come from `prep/prep_oldmap.py`, which measures true
 * great-circle distances; only their glyph size is in pixels, as any map
 * symbol's is. Nothing drawn by `drawWash` or `drawRings` may ever be cited as a
 * distance.
 *
 * ---- How the bands are made, and why not the obvious way ------------------
 *
 * Both come from ONE screen-space distance field, computed per frame from the
 * land silhouette at half resolution: a chamfer transform giving, for every
 * pixel, how far it is from the coastline in pixels. The wash reads that field
 * on the land side, the rings read it on the ocean side.
 *
 * The obvious implementation is to stroke the coastline path repeatedly at
 * growing `lineWidth` -- widest-first inside a land clip for the wash, and
 * stroke-then-`destination-out` for each ring. It is fewer lines and it was the
 * first version of this file. It is also unusable: 26 strokes of a ~32,000
 * vertex path at widths up to 96 px, with round joins, ran at SECONDS per frame
 * and starved the main thread badly enough that Playwright could not even take a
 * screenshot. The cost of stroking scales with vertices AND width; the cost of
 * the distance field scales with neither.
 *
 * The field runs at the tile's CSS resolution. It began at half that, which is
 * fine for the wash (a soft gradient) and not fine for the rings: a ring's shape
 * IS a level set of the field, so the field's resolution is the line quality,
 * and at half resolution they came out visibly angular. The chamfer's ~2%
 * anisotropy error stays acceptable for the same reason the pixel units are --
 * none of this is a measurement (ADR-0037).
 */

/** Resolution of the distance field, as a fraction of the tile's CSS pixels.
 *  At 0.5 the rings came out visibly angular -- their shape is the field's level
 *  set, so the field's resolution IS the line quality, and a soft wash tolerates
 *  what a thin ring does not. 1.0 quadruples the pixel work and is still far
 *  cheaper than the stroking approach it replaced. */
const FIELD_SCALE = 1.0;

/** Offsets of the six rings, in CSS px, and half the pen weight they are drawn
 *  with. The notebook's km values (100/200/350/550/800/1200) are the starting
 *  RATIO, not a conversion -- see ADR-0037. */
const RING_OFFSETS = [5, 10, 17, 26, 37, 50];
/** Half-width of a ring, in CSS px. Not arbitrarily thin: the field is
 *  quantised (chamfer steps of 1 and √2 field pixels), so a band narrower than
 *  about one field pixel catches a broken, dashed set of pixels rather than a
 *  line -- which is exactly how the first version of this looked. */
const RING_WEIGHT = 1.9;
/** Pen weight of the coastline, in CSS px -- see drawCoastline() on why the
 *  stroke is laid down at twice this. Not thinner: the erase that trims the
 *  inner half is antialiased, so it eats into whatever is left, and at 0.75 the
 *  line came out so faint it read as absent. */
const COAST_WEIGHT = 1.3;

/** How far inland the wash reaches, in CSS px. */
const WASH_REACH = 26;
const WASH_ALPHA = 0.55;
const RING_ALPHA = 0.40;

/** Sepia ink, so marks sit on the paper rather than on white. */
const INK = 'rgba(62, 44, 24, 0.82)';
const RING_INK: [number, number, number] = [86, 66, 40];
const WASH_NEAR: [number, number, number] = [206, 120, 44];
const WASH_FAR: [number, number, number] = [246, 232, 202];
const MOUNTAIN_INK: [number, number, number] = [58, 42, 24];

/** Glyph width in px. Fixed, like any map symbol -- see the note above. */
const MOUNTAIN_SIZE = 17;

export class OldMapOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globeProjector: ThreeProjector;
  private readonly flatProjector: FlatProjector;
  private mode: ProjectionMode = 'globe';
  private coast: PolygonLayer | null = null;
  private mountains: MountainSeries | null = null;
  private age = 0;

  showWash = true;
  showRings = true;
  showMountains = true;
  visible = true;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  /** Scratch for the distance field, reused across frames and reallocated only
   *  when the tile resizes -- see buildField(). */
  private field: HTMLCanvasElement | null = null;
  private fieldCtx: CanvasRenderingContext2D | null = null;
  private dist: Float32Array | null = null;
  private inside: Uint8Array | null = null;
  private fieldImage: ImageData | null = null;
  private hasOcean = false;
  /** Full-resolution scratch the coastline is composited through -- see
   *  drawCoastline() on why it cannot be drawn straight onto the ink canvas. */
  private pen: HTMLCanvasElement | null = null;
  private penCtx: CanvasRenderingContext2D | null = null;

  private camera: Camera;

  constructor(camera: Camera) {
    this.camera = camera;
    this.globeProjector = new ThreeProjector(camera as PerspectiveCamera);
    this.flatProjector = new FlatProjector(camera);

    const c = document.createElement('canvas');
    c.className = 'oldmap-ink';
    Object.assign(c.style, { position: 'fixed', pointerEvents: 'none' });
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d')!;
    this.applyRect();
  }

  private get projector(): ThreeProjector | FlatProjector {
    return this.mode === 'globe' ? this.globeProjector : this.flatProjector;
  }

  async loadCoastlines(url: string): Promise<void> {
    // Outlines only and no fill of its own: this layer is never drawn by
    // PolygonLayer.draw() here, only traced via projectRings(). The options
    // still matter for anyone who calls draw() on it in a debug session.
    this.coast = await PolygonLayer.load(url, { outline: true, stroke: INK, lineWidth: 0.8 });
  }

  setMountains(series: MountainSeries | null): void {
    this.mountains = series;
  }

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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    this.camera = camera;
    this.globeProjector.setCamera(camera as PerspectiveCamera);
    this.flatProjector.setCamera(camera);
    if (mode !== 'globe') this.flatProjector.setFlatMode(mode);
  }

  setReferenceRotation(q: Quaternion): void {
    this.globeProjector.setReferenceRotation(q);
    this.flatProjector.setReferenceRotation(q);
  }

  setAge(age: number): void {
    this.age = age;
    this.coast?.setTime(age);
  }

  dispose(): void {
    this.canvas.remove();
  }

  draw(): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!this.visible || !this.coast) return;

    const projector = this.projector;
    projector.update(this.rect.width, this.rect.height);

    const { fillable, seam } = this.coast.projectRings(projector);
    if (!fillable.length && !seam.length) return;

    // One path for every ring that may be closed, used three ways: as the clip
    // for the wash (inside), as the clip for the rings (outside), and as the
    // coastline itself.
    const land = new Path2D();
    for (const buf of fillable) {
      land.moveTo(buf[0], buf[1]);
      for (let i = 2; i < buf.length; i += 2) land.lineTo(buf[i], buf[i + 1]);
    }

    // Everything is confined to the Earth's own outline. Without this the
    // distance field treats "off the map" as ocean and the rings spread across
    // the paper, off the globe's limb or out past Robinson's curved boundary.
    const outline = this.mapOutline();
    ctx.save();
    if (outline) ctx.clip(outline);

    const haveField = this.buildField(land);
    if (haveField && (this.showWash || this.showRings)) this.paintBands();
    this.drawCoastline(land, seam, projector);
    ctx.restore();

    // Mountains are drawn OUTSIDE the clip: a glyph is a symbol standing at a
    // point, not a patch of map, and clipping one that happens to sit near the
    // limb would slice it in half.
    if (this.showMountains && haveField) this.drawMountains(projector);
  }

  /**
   * Debug/test: of the glyphs in the current frame that project to somewhere on
   * screen, how many were rejected by the on-land test?
   *
   * Reads the field left by the last `draw()`, so it reports exactly what that
   * frame did rather than recomputing it. `drawn` should always be well above
   * zero; `culled` is the count prep could not prevent, since a glyph outlives
   * the age at which the rule last held and can be carried offshore meanwhile.
   */
  auditMountains(): { visible: number; drawn: number; culled: number } {
    const series = this.mountains;
    const frame = series?.frameAt(this.age);
    if (!frame || !this.inside) return { visible: 0, drawn: 0, culled: 0 };
    const projector = this.projector;
    let visible = 0;
    let drawn = 0;
    for (let i = 0; i < frame.orogenAge.length; i++) {
      const p = projector.project(geoVec(frame.lonlat[i * 2], frame.lonlat[i * 2 + 1]));
      if (!p) continue;
      visible++;
      if (this.isOverLand(p[0], p[1])) drawn++;
    }
    return { visible, drawn, culled: visible - drawn };
  }

  /** Is this screen position over land, per the rasterized silhouette? */
  private isOverLand(x: number, y: number): boolean {
    const f = this.field;
    if (!f || !this.inside) return false;
    const ix = Math.round((x / this.rect.width) * f.width);
    const iy = Math.round((y / this.rect.height) * f.height);
    if (ix < 0 || iy < 0 || ix >= f.width || iy >= f.height) return false;
    return this.inside[iy * f.width + ix] === 1;
  }

  /**
   * The Earth's outline on screen: the globe's silhouette, or the flat map's
   * own boundary. Null if it cannot be determined, in which case the caller
   * simply does not clip.
   *
   * The globe case relies on this wrapper's camera being ORTHOGRAPHIC (see
   * oldmap/main.ts): the silhouette is then a circle of the sphere's radius,
   * centred on the projected origin, at any orientation. Under perspective it
   * would be a smaller circle offset toward the viewer, and this would be
   * subtly wrong rather than obviously so.
   */
  private mapOutline(): Path2D | null {
    const path = new Path2D();
    if (this.mode === 'globe') {
      const c = this.projectWorld(0, 0, 0);
      // Any point on the sphere PERPENDICULAR to the view gives the radius.
      // Not camera.up: OrbitControls keeps that as world up, which is nearly
      // parallel to the view direction when the camera is over a pole, and the
      // silhouette would collapse exactly where the map is most polar.
      const view = this.camera.position.clone().normalize();
      const aid = Math.abs(view.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      const perp = aid.cross(view).normalize().multiplyScalar(R_SURFACE);
      const e = this.projectWorld(perp.x, perp.y, perp.z);
      if (!c || !e) return null;
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (!(r > 0)) return null;
      path.arc(c[0], c[1], r, 0, Math.PI * 2);
      return path;
    }
    const pts = this.flatProjector.mapOutline();
    if (!pts.length) return null;
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    return path;
  }

  /** World-space xyz -> screen px, through the live camera. */
  private projectWorld(x: number, y: number, z: number): [number, number] | null {
    const v = new Vector3(x, y, z).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.rect.width, (-v.y * 0.5 + 0.5) * this.rect.height];
  }

  /**
   * Rasterize the land silhouette and run the distance transform over it.
   *
   * Always run, even with both bands switched off, because the mountain glyphs
   * are tested against `inside` -- this raster is the only thing on the client
   * that knows where land actually is, the coastline being a pile of overlapping
   * terrane rings rather than an outline.
   *
   * Returns false if no land is on screen, which is a normal state while a globe
   * is dragged rather than an error.
   */
  private buildField(land: Path2D): boolean {
    const { width, height } = this.rect;
    const w = Math.max(1, Math.round(width * FIELD_SCALE));
    const h = Math.max(1, Math.round(height * FIELD_SCALE));

    // The scratch canvas is reused across frames and resized only when the tile
    // does -- reallocating two megabyte-scale buffers per frame is exactly the
    // kind of garbage that shows up as scrub stutter.
    if (!this.field || this.field.width !== w || this.field.height !== h) {
      this.field = document.createElement('canvas');
      this.field.width = w;
      this.field.height = h;
      this.fieldCtx = this.field.getContext('2d', { willReadFrequently: true })!;
      this.dist = new Float32Array(w * h);
      this.inside = new Uint8Array(w * h);
    }
    const fctx = this.fieldCtx!;

    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, w, h);
    fctx.save();
    fctx.scale(FIELD_SCALE, FIELD_SCALE);
    fctx.fillStyle = '#fff';
    fctx.fill(land, 'nonzero');
    fctx.restore();

    const img = fctx.getImageData(0, 0, w, h);
    const px = img.data;
    const inside = this.inside!;
    let anyLand = false;
    let anyOcean = false;
    for (let i = 0, j = 3; i < inside.length; i++, j += 4) {
      const on = px[j] > 127 ? 1 : 0;
      inside[i] = on;
      if (on) anyLand = true; else anyOcean = true;
    }
    this.hasOcean = anyOcean;
    this.fieldImage = img;
    if (!anyLand) return false;

    chamferDistance(inside, this.dist!, w, h);
    return true;
  }

  /** Paint the wash and the rings from the field `buildField()` left behind. */
  private paintBands(): void {
    const { width, height } = this.rect;
    const w = this.field!.width;
    const h = this.field!.height;
    const fctx = this.fieldCtx!;
    const img = this.fieldImage!;
    const px = img.data;
    const inside = this.inside!;
    const anyOcean = this.hasOcean;

    // Thresholds are declared in CSS px; the field is at FIELD_SCALE of that.
    const washReach = WASH_REACH * FIELD_SCALE;
    const ringPx = RING_OFFSETS.map((d) => d * FIELD_SCALE);
    const ringHalf = Math.max(0.5, RING_WEIGHT * FIELD_SCALE);

    for (let i = 0, j = 0; i < inside.length; i++, j += 4) {
      const d = this.dist![i];
      if (inside[i]) {
        // --- wash: orange at the coast, fading inland -------------------
        if (!this.showWash || d >= washReach) { px[j + 3] = 0; continue; }
        const t = d / washReach;
        px[j] = WASH_NEAR[0] + (WASH_FAR[0] - WASH_NEAR[0]) * t;
        px[j + 1] = WASH_NEAR[1] + (WASH_FAR[1] - WASH_NEAR[1]) * t;
        px[j + 2] = WASH_NEAR[2] + (WASH_FAR[2] - WASH_NEAR[2]) * t;
        // Fade the wash out as well as ramping its colour, so it meets the
        // paper rather than ending on a visible edge.
        px[j + 3] = 255 * WASH_ALPHA * (1 - t) ** 0.7;
      } else if (anyOcean && this.showRings) {
        // --- rings: a thin line at each offset --------------------------
        let hit = 0;
        for (let r = 0; r < ringPx.length; r++) {
          const e = Math.abs(d - ringPx[r]);
          if (e < ringHalf) { hit = 1 - e / ringHalf; break; }
        }
        if (hit <= 0) { px[j + 3] = 0; continue; }
        px[j] = RING_INK[0];
        px[j + 1] = RING_INK[1];
        px[j + 2] = RING_INK[2];
        px[j + 3] = 255 * RING_ALPHA * hit;
      } else {
        px[j + 3] = 0;
      }
    }
    fctx.putImageData(img, 0, 0);

    // Up to the ink canvas. Smoothing is what turns the half-res field back
    // into a soft wash and an antialiased ring rather than a stair-stepped one.
    const { ctx } = this;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.field!, 0, 0, width, height);
    ctx.restore();
  }

  /**
   * The pen line itself, including the rings that could not be closed.
   *
   * Only the OUTER edge of the landmass is wanted. Merdith2021's continent
   * polygons are a mosaic of overlapping terranes, not a coastline: stroked
   * plainly, every internal block boundary is drawn too and the continents come
   * out full of lines no chart would have.
   *
   * So the whole pile is stroked and then the land is erased out from under it
   * with `destination-out`, leaving only the half of each stroke that fell on
   * the ocean side. Interior boundaries lie wholly inside the landmass and
   * vanish. Hence the doubled `lineWidth`: half is always erased.
   *
   * ---- Why a scratch canvas, and why not a clip ---------------------------
   *
   * The first version clipped to an even-odd path of "viewport minus land",
   * which is wrong and was visible as flicker: under even-odd, a region covered
   * by TWO overlapping terranes has even winding and counts as OUTSIDE. Every
   * overlap between neighbouring polygons therefore read as ocean, so interior
   * boundaries reappeared there as slivers that popped in and out as the
   * geometry shifted under them. Land is a `nonzero` union -- that is what makes
   * abutting terranes one landmass -- and canvas allows only one fill rule per
   * path, so the complement cannot be expressed as a clip at all.
   *
   * `destination-out` respects nonzero, so it can. It also erases whatever is
   * already on the canvas, which is why this composites through its own layer
   * rather than drawing straight onto the ink: the wash is drawn first and sits
   * inside the land, exactly where the erase would fall.
   */
  private drawCoastline(
    land: Path2D, seam: { offset: number; count: number }[],
    projector: ThreeProjector | FlatProjector,
  ): void {
    const { width, height } = this.rect;
    const dpr = Math.min(devicePixelRatio, 2);
    const cw = Math.round(width * dpr);
    const ch = Math.round(height * dpr);
    if (!this.pen || this.pen.width !== cw || this.pen.height !== ch) {
      this.pen = document.createElement('canvas');
      this.pen.width = cw;
      this.pen.height = ch;
      this.penCtx = this.pen.getContext('2d')!;
    }
    const ctx = this.penCtx!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = COAST_WEIGHT * 2;
    ctx.stroke(land);

    // Seam-straddling rings can only be stroked, never closed -- see
    // PolygonLayer.projectRings(). Broken properly at the seam by the library.
    if (seam.length && 'seamSplit' in projector) {
      const fp = projector as FlatProjector;
      ctx.beginPath();
      for (const r of seam) {
        tracePolyline(ctx, (w: ArrayLike<number>) => projector.project(w),
          this.coast!.xyz, r.offset, r.count,
          { closed: true, seam: (a: ArrayLike<number>, b: ArrayLike<number>) => fp.seamSplit(a, b) });
      }
      ctx.stroke();
    }
    ctx.restore();

    // Erase the land out from under the pen, leaving only the outer edge.
    // nonzero, so overlapping terranes are one landmass -- the whole point.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(land, 'nonzero');
    ctx.restore();

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.pen!, 0, 0);
    this.ctx.restore();
  }

  /**
   * The hachured ranges.
   *
   * Positions are read straight from the frame -- they were computed in prep
   * against true great-circle distances and reconstructed onto their own plate,
   * so a glyph rides the crust rather than sitting on a fixed global lattice
   * (which is the notebook bug this viewer must not reproduce; see
   * prep/prep_oldmap.py).
   */
  private drawMountains(projector: ThreeProjector | FlatProjector): void {
    const series = this.mountains;
    if (!series) return;
    const frame = series.frameAt(this.age);
    if (!frame) return;

    const { ctx } = this;
    const glyph = mountainGlyph();
    const decay = series.decayMyr;
    ctx.save();
    for (let i = 0; i < frame.orogenAge.length; i++) {
      const lon = frame.lonlat[i * 2];
      const lat = frame.lonlat[i * 2 + 1];
      const p = projector.project(geoVec(lon, lat));
      if (!p) continue;                       // behind the limb

      // On land only. Prep guarantees >300 km inland at the age the rule LAST
      // held, but a glyph persists for up to `decay` Myr after that, and in
      // that time its plate can carry it under water or the margin can retreat
      // past it. Tested against the same silhouette the wash is clipped to, so
      // a glyph can never appear in the ocean the viewer is drawing.
      if (!this.isOverLand(p[0], p[1])) continue;

      // Fade with age since the rule last held. Floored well above zero: a
      // range that has faded to nothing is better dropped by prep's own decay
      // cutoff than drawn as an invisible smudge.
      const fade = decay > 0 ? 1 - frame.orogenAge[i] / decay : 1;
      const alpha = 0.30 + 0.62 * Math.max(0, Math.min(1, fade));

      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.scale(MOUNTAIN_SIZE, MOUNTAIN_SIZE);
      // The glyph is normalised to unit width with its baseline at y = 0, so it
      // stands ON the point. Nudge up by a third of its height so the range
      // straddles the position rather than hanging below it.
      ctx.translate(0, MOUNTAIN_ASPECT / 3);
      ctx.fillStyle = `rgba(${MOUNTAIN_INK[0]}, ${MOUNTAIN_INK[1]}, ${MOUNTAIN_INK[2]}, ${alpha.toFixed(3)})`;
      ctx.fill(glyph);
      ctx.restore();
    }
    ctx.restore();
  }
}

/**
 * Distance, in field pixels, from every pixel to the nearest pixel of the OTHER
 * class -- so land pixels get their distance to the sea and sea pixels get their
 * distance to land, in one pass over one array.
 *
 * Two-pass chamfer (3, 4): initialise boundary pixels to zero, sweep forward
 * propagating from the up/left neighbours, sweep backward from down/right. Exact
 * Euclidean distance would need a Felzenszwalb-style transform; chamfer 3-4 is
 * off by up to ~2% in the diagonal direction, which is invisible in a wash and
 * sub-pixel on the rings at these radii. It is also the reason nothing here may
 * be quoted as a distance -- but ADR-0037 had already settled that.
 *
 * `dist` is written in place and must be w*h long.
 */
function chamferDistance(
  inside: Uint8Array, dist: Float32Array, w: number, h: number,
): void {
  const D1 = 1;
  const D2 = 1.41421356;
  const FAR = 1e9;

  // A pixel is a boundary pixel when any 4-neighbour is of the other class.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = inside[i];
      const edge = (x > 0 && inside[i - 1] !== v)
        || (x < w - 1 && inside[i + 1] !== v)
        || (y > 0 && inside[i - w] !== v)
        || (y < h - 1 && inside[i + w] !== v);
      dist[i] = edge ? 0 : FAR;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (y > 0) {
        if (dist[i - w] + D1 < d) d = dist[i - w] + D1;
        if (x > 0 && dist[i - w - 1] + D2 < d) d = dist[i - w - 1] + D2;
        if (x < w - 1 && dist[i - w + 1] + D2 < d) d = dist[i - w + 1] + D2;
      }
      if (x > 0 && dist[i - 1] + D1 < d) d = dist[i - 1] + D1;
      dist[i] = d;
    }
  }

  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (y < h - 1) {
        if (dist[i + w] + D1 < d) d = dist[i + w] + D1;
        if (x > 0 && dist[i + w - 1] + D2 < d) d = dist[i + w - 1] + D2;
        if (x < w - 1 && dist[i + w + 1] + D2 < d) d = dist[i + w + 1] + D2;
      }
      if (x < w - 1 && dist[i + 1] + D1 < d) d = dist[i + 1] + D1;
      dist[i] = d;
    }
  }
}

/** deep-time-map's geographic frame: z through the north pole. */
function geoVec(lon: number, lat: number): [number, number, number] {
  const la = lat * (Math.PI / 180);
  const lo = lon * (Math.PI / 180);
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
