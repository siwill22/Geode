import { Vector3, type Camera, type PerspectiveCamera } from 'three';
import { PolygonLayer, tracePolyline } from '../../vendor/petrify/js/index.js';

import { R_SURFACE } from '../core/constants';
import { ThreeProjector } from '../core/boundaries';
import { FlatProjector } from '../core/flatProjector';
import type { ProjectionMode } from '../core/projection';
import type { Quaternion } from '../core/rotation';
import type { Rect } from '../core/layout';
import { MOUNTAIN_ASPECT, mountainGlyph } from './mountainGlyph';
import type { MountainSeries } from './mountains';
import { VOLCANO_ASPECT, volcanoCone, volcanoSmoke } from './volcanoGlyph';
import type { VolcanoSeries } from './volcanoes';

/**
 * Every mark on the map: the graded coastal wash, the nested offshore rings, the
 * coastline pen line, and the hachured mountain glyphs. One 2D canvas over the
 * WebGL one, the same technique `core/boundaries.ts` established.
 *
 * ---- Everything here is measured in KILOMETRES ---------------------------
 *
 * The wash reaches 400 km inland; the rings sit at 100/200/350/550/800/1200 km
 * offshore. Those are the reference notebook's own numbers, and they are ground
 * distances, so **zooming in makes the bands wider on screen**, exactly as it
 * makes the continents wider. A map does not change when you look at it more
 * closely.
 *
 * An earlier version fixed the band widths in screen pixels instead, which kept
 * them the same size at every zoom and therefore quietly changed what the map
 * said as you scrolled. See docs/adr/0037, which recorded that decision and now
 * records its reversal.
 *
 * The conversion is ONE scale for the whole map, taken from the projection's own
 * geometry at the current zoom:
 *
 *   - flat: the map's full width in pixels spans 360 deg at the equator, i.e.
 *     one Earth circumference;
 *   - globe: the silhouette's radius in pixels is one Earth radius.
 *
 * So the bands track zoom exactly, and do NOT track the distortion a projection
 * introduces across its own map -- a band at high latitude in Plate Carree is
 * the same width on screen as one at the equator, though the ground distance it
 * represents is smaller. Correcting that needs a local scale per pixel, which is
 * a real cost for an effect that is decoration. Stated here rather than hidden;
 * the mountains, which are the part that makes a claim, are unaffected -- their
 * positions come from prep_oldmap.py's true great-circle rule.
 *
 * ---- How the bands are made ---------------------------------------------
 *
 * One distance field per frame, from the land silhouette rasterized at the
 * tile's resolution: for every pixel, how far it is from the coastline. The wash
 * reads it on the land side, the rings on the ocean side. Two details matter:
 *
 * - **The transform is exact Euclidean** (Felzenszwalb), not a chamfer. A ring
 *   is a level set of this field, so the field's metric IS the ring's shape: a
 *   chamfer's octagonal error made them visibly faceted no matter the
 *   resolution, which no amount of smoothing hid.
 * - **The mask is morphologically closed first.** Merdith2021's continent
 *   polygons are overlapping terranes, and adjacent ones leave sub-pixel gaps
 *   between their boundaries. Unclosed, those gaps rasterize as slivers of ocean
 *   inside the landmass, each growing its own wash and rings, and they blink in
 *   and out as the geometry shifts under them -- which is the flicker this
 *   viewer showed for two rounds.
 *
 * The obvious alternative -- stroking the coastline repeatedly at growing
 * `lineWidth` -- was the first implementation and ran at SECONDS per frame: 26
 * strokes of a ~32,000-vertex path at up to 96 px with round joins. Distance
 * field cost scales with pixels; stroking scales with vertices AND width.
 */

const EARTH_RADIUS_KM = 6371.0;
const EARTH_CIRCUMFERENCE_KM = 2 * Math.PI * EARTH_RADIUS_KM;

/** Offsets of the six rings, in KM -- the notebook's own values. */
const RING_OFFSETS_KM = [100, 200, 350, 550, 800, 1200];
/** Half-width of a ring, in screen px. A pen weight is a property of the pen,
 *  not of the ground, so this one really does stay fixed under zoom. */
const RING_WEIGHT_PX = 1.1;
/** How far inland the wash reaches, in KM -- the notebook's `dist_max`. */
const WASH_REACH_KM = 400;

/** Pen weight of the coastline, in px -- see drawCoastline() on why the stroke
 *  is laid down at twice this. */
const COAST_WEIGHT = 1.3;

/** Ground width of a mountain glyph, in KM. Scaled like everything else so the
 *  map is the same map at every zoom, but clamped: a symbol has to stay legible
 *  when zoomed out and must not swamp the map when zoomed in. */
const MOUNTAIN_WIDTH_KM = 620;
const MOUNTAIN_PX_RANGE: [number, number] = [7, 64];

/**
 * Ground width of each volcano population, in KM, with its own pixel clamp --
 * same scale-with-the-map-but-stay-legible treatment the mountains get.
 *
 * The three sizes ARE the encoding: ridge volcanoes are many and incidental,
 * plumes are few and named, and a LIP is a once-in-an-era event that should
 * read at a glance. Nothing else distinguishes them, so the ratios matter more
 * than the absolute numbers.
 *
 * Smoke is drawn only above SMOKE_MIN_PX. Below that a curl is a smudge, and a
 * ridge crowded with smudges reads as a dirty plate rather than as volcanoes.
 */
const VOLCANO_WIDTH_KM = { ridge: 190, plume: 340, lip: 760 };
const VOLCANO_PX_RANGE: Record<string, [number, number]> = {
  ridge: [4, 20], plume: [7, 34], lip: [14, 72],
};
const SMOKE_MIN_PX = 13;
const VOLCANO_INK: [number, number, number] = [74, 38, 22];

/** Radius, in px, of the morphological closing that removes sub-pixel gaps
 *  between abutting terranes. 2 is enough for the slivers actually seen. */
const CLOSE_RADIUS = 2;

/** Sepia ink, so marks sit on the paper rather than on white. */
const INK = 'rgba(62, 44, 24, 0.82)';
const RING_INK: [number, number, number] = [86, 66, 40];
const WASH_NEAR: [number, number, number] = [206, 120, 44];
const WASH_FAR: [number, number, number] = [246, 232, 202];
const MOUNTAIN_INK: [number, number, number] = [58, 42, 24];
const WASH_ALPHA = 0.55;
const RING_ALPHA = 0.40;

export class OldMapOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globeProjector: ThreeProjector;
  private readonly flatProjector: FlatProjector;
  private camera: Camera;
  private mode: ProjectionMode = 'globe';
  private coastLayer: PolygonLayer | null = null;
  private mountains: MountainSeries | null = null;
  private volcanoes: VolcanoSeries | null = null;
  private age = 0;

  showWash = true;
  showRings = true;
  showMountains = true;
  showVolcanoes = true;
  visible = true;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  /** Distance-field scratch, reallocated only when the tile resizes. */
  private field: HTMLCanvasElement | null = null;
  private fieldCtx: CanvasRenderingContext2D | null = null;
  private fieldImage: ImageData | null = null;
  private inside: Uint8Array | null = null;
  private dist: Float32Array | null = null;
  private edtScratch: EdtScratch | null = null;
  private hasOcean = false;

  /** The coastline is composited through its own layer -- see drawCoastline(). */
  private pen: HTMLCanvasElement | null = null;
  private penCtx: CanvasRenderingContext2D | null = null;

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
    this.coastLayer = await PolygonLayer.load(url, { outline: true, stroke: INK, lineWidth: 0.8 });
  }

  setMountains(series: MountainSeries | null): void { this.mountains = series; }
  setVolcanoes(series: VolcanoSeries | null): void { this.volcanoes = series; }
  setReferenceRotation(q: Quaternion): void {
    this.globeProjector.setReferenceRotation(q);
    this.flatProjector.setReferenceRotation(q);
  }

  setAge(age: number): void {
    this.age = age;
    this.coastLayer?.setTime(age);
  }

  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    this.camera = camera;
    this.globeProjector.setCamera(camera as PerspectiveCamera);
    this.flatProjector.setCamera(camera);
    if (mode !== 'globe') this.flatProjector.setFlatMode(mode);
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

  dispose(): void { this.canvas.remove(); }

  // --- scale ---------------------------------------------------------------

  /**
   * Screen pixels per kilometre of ground, at the current zoom.
   *
   * One number for the whole map -- see the class comment on what that does and
   * does not buy. Zero if it cannot be determined, which disables the bands
   * rather than drawing them at some arbitrary size.
   */
  private pixelsPerKm(): number {
    if (this.mode === 'globe') {
      const r = this.globeRadiusPx();
      return r > 0 ? r / EARTH_RADIUS_KM : 0;
    }
    // mapHalfWidth spans 180 deg of longitude, so twice it is one equatorial
    // circumference.
    const half = this.flatProjector.mapHalfWidth;
    return half > 0 ? (2 * half) / EARTH_CIRCUMFERENCE_KM : 0;
  }

  /** Radius of the globe's silhouette in px, or 0. Orthographic only, which is
   *  what this wrapper uses -- see oldmap/main.ts. */
  private globeRadiusPx(): number {
    const c = this.projectWorld(0, 0, 0);
    // A point on the sphere PERPENDICULAR to the view. Not camera.up:
    // OrbitControls keeps that as world up, nearly parallel to the view over a
    // pole, and the silhouette would collapse exactly where the map is polar.
    const view = this.camera.position.clone().normalize();
    const aid = Math.abs(view.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const perp = aid.cross(view).normalize().multiplyScalar(R_SURFACE);
    const e = this.projectWorld(perp.x, perp.y, perp.z);
    return Math.hypot(e[0] - c[0], e[1] - c[1]);
  }

  private projectWorld(x: number, y: number, z: number): [number, number] {
    const v = new Vector3(x, y, z).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.rect.width, (-v.y * 0.5 + 0.5) * this.rect.height];
  }

  // --- draw ----------------------------------------------------------------

  draw(): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!this.visible || !this.coastLayer) return;

    const projector = this.projector;
    projector.update(this.rect.width, this.rect.height);

    const { fillable, seam } = this.coastLayer.projectRings(projector);
    if (!fillable.length && !seam.length) return;

    // One path for every ring that may be closed, used three ways: to rasterize
    // the land, to trim the pen line, and as the coastline itself.
    const land = new Path2D();
    for (const buf of fillable) {
      land.moveTo(buf[0], buf[1]);
      for (let i = 2; i < buf.length; i += 2) land.lineTo(buf[i], buf[i + 1]);
    }

    // Confined to the Earth's own outline: without it the distance field treats
    // "off the map" as ocean and the rings spread across the paper, off the
    // globe's limb or past Robinson's curved boundary.
    ctx.save();
    ctx.clip(this.mapOutline());

    const haveField = this.buildField(land);
    if (haveField && (this.showWash || this.showRings)) this.paintBands();
    this.drawCoastline(land, seam, projector);
    ctx.restore();

    // Outside the clip: a glyph is a symbol standing at a point, not a patch of
    // map, and clipping one near the limb would slice it in half.
    if (this.showMountains && haveField) this.drawMountains(projector);
    // Outside the clip for the same reason as the mountains, and NOT gated on
    // haveField: a volcano is not tested against the land raster the way a
    // mountain is. Ridge and plume symbols are in the ocean by construction and
    // a LIP site is drawn wherever its province was, so an all-ocean view with
    // no land on screen must still show them.
    if (this.showVolcanoes) this.drawVolcanoes(projector);
  }

  /**
   * Rasterize the land silhouette, close it, and run the distance transform.
   *
   * Always run, even with both bands switched off, because the mountain glyphs
   * are tested against `inside` -- this raster is the only thing on the client
   * that knows where land is, the coastline being a pile of overlapping terrane
   * rings rather than an outline. False if no land is on screen, which is normal
   * while a globe is dragged.
   */
  private buildField(land: Path2D): boolean {
    const { width, height } = this.rect;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));

    if (!this.field || this.field.width !== w || this.field.height !== h) {
      this.field = document.createElement('canvas');
      this.field.width = w;
      this.field.height = h;
      this.fieldCtx = this.field.getContext('2d', { willReadFrequently: true })!;
      this.inside = new Uint8Array(w * h);
      this.dist = new Float32Array(w * h);
      this.edtScratch = makeEdtScratch(Math.max(w, h));
    }
    const fctx = this.fieldCtx!;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, w, h);
    fctx.fillStyle = '#fff';
    fctx.fill(land, 'nonzero');

    const img = fctx.getImageData(0, 0, w, h);
    const px = img.data;
    const inside = this.inside!;
    for (let i = 0, j = 3; i < inside.length; i++, j += 4) inside[i] = px[j] > 127 ? 1 : 0;

    closeMask(inside, w, h, CLOSE_RADIUS);

    let anyLand = false;
    let anyOcean = false;
    for (let i = 0; i < inside.length; i++) {
      if (inside[i]) anyLand = true; else anyOcean = true;
      if (anyLand && anyOcean) break;
    }
    this.hasOcean = anyOcean;
    this.fieldImage = img;
    if (!anyLand) return false;

    euclideanDistanceToBoundary(inside, this.dist!, w, h, this.edtScratch!);
    return true;
  }

  /** Colour-map the field into the wash and the rings. */
  private paintBands(): void {
    const ppk = this.pixelsPerKm();
    if (ppk <= 0) return;

    const img = this.fieldImage!;
    const px = img.data;
    const inside = this.inside!;
    const dist = this.dist!;
    const washReach = WASH_REACH_KM * ppk;
    const rings = RING_OFFSETS_KM.map((km) => km * ppk);
    const half = RING_WEIGHT_PX;

    for (let i = 0, j = 0; i < inside.length; i++, j += 4) {
      const d = dist[i];
      if (inside[i]) {
        if (!this.showWash || d >= washReach) { px[j + 3] = 0; continue; }
        const t = d / washReach;            // 0 at the coast, 1 farthest inland
        px[j] = WASH_NEAR[0] + (WASH_FAR[0] - WASH_NEAR[0]) * t;
        px[j + 1] = WASH_NEAR[1] + (WASH_FAR[1] - WASH_NEAR[1]) * t;
        px[j + 2] = WASH_NEAR[2] + (WASH_FAR[2] - WASH_NEAR[2]) * t;
        // Fade as well as ramp, so the wash meets the paper rather than ending
        // on a visible edge.
        px[j + 3] = 255 * WASH_ALPHA * (1 - t) ** 0.7;
      } else if (this.showRings && this.hasOcean) {
        let hit = 0;
        for (let r = 0; r < rings.length; r++) {
          const e = Math.abs(d - rings[r]);
          if (e < half) { hit = 1 - e / half; break; }
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
    this.fieldCtx!.putImageData(img, 0, 0);
    this.ctx.drawImage(this.field!, 0, 0, this.rect.width, this.rect.height);
  }

  /**
   * The pen line, including the rings that could not be closed.
   *
   * Only the OUTER edge of the landmass is wanted. Merdith2021's continent
   * polygons are a mosaic of overlapping terranes, not a coastline: stroked
   * plainly, every internal block boundary is drawn too. So the whole pile is
   * stroked and the land then erased out from under it with `destination-out`,
   * leaving only the half of each stroke that fell on the ocean side -- hence
   * the doubled `lineWidth`.
   *
   * A clip cannot do this. "Viewport minus land" needs the even-odd rule, under
   * which a region covered by TWO overlapping terranes has even winding and
   * counts as outside; every overlap then read as ocean and interior boundaries
   * reappeared there. Land is a `nonzero` union -- that is what makes abutting
   * terranes one landmass -- and canvas allows one fill rule per path.
   * `destination-out` respects nonzero, so it can; it also erases whatever is
   * already on the canvas, hence the separate layer.
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
    // PolygonLayer.projectRings(). Broken at the seam by the library.
    if (seam.length && 'seamSplit' in projector) {
      const fp = projector as FlatProjector;
      ctx.beginPath();
      for (const r of seam) {
        tracePolyline(ctx, (v: ArrayLike<number>) => projector.project(v),
          this.coastLayer!.xyz, r.offset, r.count,
          { closed: true, seam: (a: ArrayLike<number>, b: ArrayLike<number>) => fp.seamSplit(a, b) });
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(land, 'nonzero');
    ctx.restore();

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.pen, 0, 0);
    this.ctx.restore();
  }

  /**
   * The hachured ranges.
   *
   * Positions come from prep, which measured true great-circle distances and
   * reconstructed each candidate onto its own plate, so a glyph rides the crust
   * rather than sitting on a fixed global lattice.
   */
  private drawMountains(projector: ThreeProjector | FlatProjector): void {
    const series = this.mountains;
    const frame = series?.frameAt(this.age);
    if (!series || !frame) return;

    const ppk = this.pixelsPerKm();
    const size = Math.max(MOUNTAIN_PX_RANGE[0],
      Math.min(MOUNTAIN_PX_RANGE[1], MOUNTAIN_WIDTH_KM * ppk));
    const { ctx } = this;
    const glyph = mountainGlyph();
    const decay = series.decayMyr;

    ctx.save();
    for (let i = 0; i < frame.orogenAge.length; i++) {
      const p = projector.project(geoVec(frame.lonlat[i * 2], frame.lonlat[i * 2 + 1]));
      if (!p) continue;                                  // behind the limb
      // On land only. Prep guarantees >300 km inland at the age the rule LAST
      // held, but a glyph persists for up to `decay` Myr after that, and its
      // plate can carry it offshore meanwhile.
      if (!this.isOverLand(p[0], p[1])) continue;

      const fade = decay > 0 ? 1 - frame.orogenAge[i] / decay : 1;
      const alpha = 0.30 + 0.62 * Math.max(0, Math.min(1, fade));

      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.scale(size, size);
      // Normalised to unit width with its baseline at y = 0, so it stands ON the
      // point; nudged up so the range straddles it rather than hanging below.
      ctx.translate(0, MOUNTAIN_ASPECT / 3);
      ctx.fillStyle = `rgba(${MOUNTAIN_INK[0]}, ${MOUNTAIN_INK[1]}, ${MOUNTAIN_INK[2]}, ${alpha.toFixed(3)})`;
      ctx.fill(glyph);
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * The three volcano populations.
   *
   * Drawn largest-first so a LIP's big cone sits UNDER the small ridge symbols
   * rather than blotting them out where a province erupted near a spreading
   * centre -- which is most of them.
   */
  private drawVolcanoes(projector: ThreeProjector | FlatProjector): void {
    const frame = this.volcanoes?.frameAt(this.age);
    if (!frame) return;
    const ppk = this.pixelsPerKm();
    for (const kind of ['lip', 'plume', 'ridge'] as const) {
      const lonlat = kind === 'ridge' ? frame.ridge : frame[kind].lonlat;
      if (!lonlat.length) continue;
      const [lo, hi] = VOLCANO_PX_RANGE[kind];
      const size = Math.max(lo, Math.min(hi, VOLCANO_WIDTH_KM[kind] * ppk));
      this.drawVolcanoGroup(projector, lonlat, size, kind === 'lip' ? 0.88 : 0.72);
    }
  }

  private drawVolcanoGroup(
    projector: ThreeProjector | FlatProjector,
    lonlat: number[], size: number, alpha: number,
  ): void {
    const { ctx } = this;
    const cone = volcanoCone();
    const smoke = volcanoSmoke();
    const withSmoke = size >= SMOKE_MIN_PX;
    const [r, g, b] = VOLCANO_INK;

    ctx.save();
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(alpha * 0.7).toFixed(3)})`;
    for (let i = 0; i < lonlat.length; i += 2) {
      const p = projector.project(geoVec(lonlat[i], lonlat[i + 1]));
      if (!p) continue;                                  // behind the limb
      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.scale(size, size);
      // Stand ON the point, nudged up so the cone straddles it -- the same
      // treatment drawMountains() gives the hachured ranges.
      ctx.translate(0, VOLCANO_ASPECT / 3);
      ctx.fill(cone);
      if (withSmoke) {
        // Line width is in the SCALED space, so it must be divided back out or
        // a 70 px LIP cone gets a 70 px-wide wisp.
        ctx.lineWidth = 1.1 / size;
        ctx.stroke(smoke);
      }
      ctx.restore();
    }
    ctx.restore();
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
   * Debug/test: of the glyphs in the current frame that project onto the screen,
   * how many did the on-land test reject? Reads the field left by the last
   * draw(), so it reports what that frame actually did.
   */
  auditMountains(): { visible: number; drawn: number; culled: number } {
    const frame = this.mountains?.frameAt(this.age);
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

  /** Test hook: the live scale, so a check can assert it tracks zoom. */
  get scalePixelsPerKm(): number { return this.pixelsPerKm(); }

  /**
   * Debug/test: how many enclosed bodies of ocean the land raster contains, with
   * and without the morphological closing.
   *
   * This measures the flicker's cause directly. Adjacent terranes in
   * Merdith2021 overlap by tiny amounts, and where their boundaries nearly
   * coincide the rasterized land is left with hairline gaps. Each such gap is an
   * enclosed "sea" that grows its own wash and its own rings, and each one
   * appears and disappears as sub-pixel geometry shifts beneath it -- which is
   * what was on screen. Closing the mask should collapse the count to the few
   * genuine inland seas.
   *
   * Re-rasterizes rather than reading the live field, so it can report the
   * before case too; only ever called from checks.
   */
  auditSlivers(): { open: number; closed: number; openPixels: number; closedPixels: number } | null {
    if (!this.coastLayer || !this.field) return null;
    const projector = this.projector;
    projector.update(this.rect.width, this.rect.height);
    const { fillable } = this.coastLayer.projectRings(projector);
    if (!fillable.length) return null;

    const path = new Path2D();
    for (const buf of fillable) {
      path.moveTo(buf[0], buf[1]);
      for (let i = 2; i < buf.length; i += 2) path.lineTo(buf[i], buf[i + 1]);
    }
    const w = this.field.width;
    const h = this.field.height;
    const fctx = this.fieldCtx!;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, w, h);
    fctx.fillStyle = '#fff';
    fctx.fill(path, 'nonzero');
    const px = fctx.getImageData(0, 0, w, h).data;

    const raw = new Uint8Array(w * h);
    for (let i = 0, j = 3; i < raw.length; i++, j += 4) raw[i] = px[j] > 127 ? 1 : 0;
    const open = countEnclosedOcean(raw, w, h);
    closeMask(raw, w, h, CLOSE_RADIUS);
    const closed = countEnclosedOcean(raw, w, h);
    return {
      open: open.bodies, closed: closed.bodies,
      openPixels: open.pixels, closedPixels: closed.pixels,
    };
  }

  /**
   * The Earth's outline on screen: the globe's silhouette, or the flat map's own
   * boundary. Robinson's is a curve, so a rectangle covering the map necessarily
   * includes corners that are not on the planet.
   */
  private mapOutline(): Path2D {
    const path = new Path2D();
    if (this.mode === 'globe') {
      const c = this.projectWorld(0, 0, 0);
      const r = this.globeRadiusPx();
      if (r > 0) path.arc(c[0], c[1], r, 0, Math.PI * 2);
      return path;
    }
    const pts = this.flatProjector.mapOutline();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    return path;
  }
}

// --- geometry helpers ------------------------------------------------------

/** petrify's geographic frame: z through the north pole. */
function geoVec(lon: number, lat: number): [number, number, number] {
  const la = lat * (Math.PI / 180);
  const lo = lon * (Math.PI / 180);
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

/**
 * Morphological closing: dilate by `r`, then erode by `r`.
 *
 * Fills gaps narrower than 2r without moving the coastline anywhere else, which
 * is exactly what abutting terranes need. Two separable passes per operation, so
 * the cost is linear in pixels and independent of r.
 */
function closeMask(mask: Uint8Array, w: number, h: number, r: number): void {
  if (r <= 0) return;
  const tmp = new Uint8Array(w * h);
  morph(mask, tmp, w, h, r, 1);   // dilate
  morph(tmp, mask, w, h, r, 0);   // erode
}

/** One separable morphological pass. `target` 1 dilates, 0 erodes. */
function morph(src: Uint8Array, dst: Uint8Array, w: number, h: number,
  r: number, target: number): void {
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = 1 - target;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        if (src[o + xx] === target) { v = target; break; }
      }
      row[o + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 1 - target;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        if (row[yy * w + x] === target) { v = target; break; }
      }
      dst[y * w + x] = v;
    }
  }
}

/**
 * Ocean that is not connected to the edge of the raster, i.e. enclosed by land.
 *
 * Flood-fills ocean inward from the border; whatever ocean it cannot reach is
 * enclosed. Returns the number of distinct enclosed bodies and their total area,
 * because the two say different things: many tiny bodies is the terrane-gap
 * artefact, while a few large ones are real inland seas.
 */
function countEnclosedOcean(mask: Uint8Array, w: number, h: number):
{ bodies: number; pixels: number } {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const pushIfOcean = (i: number): void => {
    if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { pushIfOcean(x); pushIfOcean((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushIfOcean(y * w); pushIfOcean(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) pushIfOcean(i - 1);
    if (x < w - 1) pushIfOcean(i + 1);
    if (i >= w) pushIfOcean(i - w);
    if (i < (h - 1) * w) pushIfOcean(i + w);
  }

  let bodies = 0;
  let pixels = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    bodies++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      pixels++;
      const x = i % w;
      if (x > 0) pushIfOcean(i - 1);
      if (x < w - 1) pushIfOcean(i + 1);
      if (i >= w) pushIfOcean(i - w);
      if (i < (h - 1) * w) pushIfOcean(i + w);
    }
  }
  return { bodies, pixels };
}

interface EdtScratch { f: Float64Array; d: Float64Array; v: Int32Array; z: Float64Array }

function makeEdtScratch(n: number): EdtScratch {
  return {
    f: new Float64Array(n), d: new Float64Array(n),
    v: new Int32Array(n + 1), z: new Float64Array(n + 2),
  };
}

/**
 * Exact Euclidean distance from every pixel to the nearest boundary pixel.
 *
 * Felzenszwalb & Huttenlocher's lower-envelope transform: two passes of an exact
 * 1-D squared-distance transform, columns then rows, in O(n). Exact matters
 * here because a ring is a level set of this field, so the metric IS the ring's
 * shape -- a chamfer approximation draws visibly octagonal "circles" at any
 * resolution, which is what made these lines look faceted.
 */
function euclideanDistanceToBoundary(
  inside: Uint8Array, out: Float32Array, w: number, h: number, s: EdtScratch,
): void {
  const INF = 1e20;
  // Seed: a pixel with a 4-neighbour of the other class is on the coastline.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = inside[i];
      const edge = (x > 0 && inside[i - 1] !== v)
        || (x < w - 1 && inside[i + 1] !== v)
        || (y > 0 && inside[i - w] !== v)
        || (y < h - 1 && inside[i + w] !== v);
      out[i] = edge ? 0 : INF;
    }
  }

  const { f, d, v, z } = s;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = out[o + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[o + x] = Math.sqrt(d[x]);
  }
}

/** Exact 1-D squared distance transform of a sampled function. */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array,
  n: number): void {
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
