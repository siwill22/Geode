import {
  FrontSide, Mesh, MeshBasicMaterial, Scene,
  type Camera, type Material, type PerspectiveCamera, type WebGLRenderer,
} from 'three';

import { BoundaryOverlay } from '../core/boundaries';
import type { ResolvedTheme } from '../core/theme';

import { PointOverlay, type PointStyleHook, type PointsPayload } from '../core/pointOverlay';
import { Coastlines, LAND_R_UNDER_SURFACE, fetchCoastlineData } from '../core/coastlines';
import { createMaskTexture } from '../core/mask';
import { Graticule } from '../core/graticule';
import { lonLatFromGeoVec, rotateVector, type Quaternion } from '../core/rotation';
import { PROJECTION_UNIFORM, createSurfaceGeometry, isFlat, type ProjectionMode } from '../core/projection';
import { createFlatBackdropMaterial, passthroughColor } from '../core/material';
import { hideSamplePopup, showInfoPopup, type PopupLine } from '../core/samplePopup';
import type { ColormapData } from '../core/types';
import type { Rect } from '../core/layout';
import { fetchModelCoastlines } from '../riftsclimate/riftsclimateInstance';
import { RiftLines } from '../riftsclimate/riftLines';
import type { RiftsIndex, RiftsModel } from '../riftsclimate/types';
import { BoundaryLines, CONV_MAX, LABEL_GROUPS } from '../wp10porphyry/boundaryLines';
import { Boxes } from '../wp10porphyry/data';
import type { BoundariesFile } from '../wp10porphyry/types';
import { clamp01, diverge, fmtLonLat, fmtN, ramp, rampCss } from '../wp10porphyry/wp10Instance';
import type { LegendBlock } from '../wp10porphyry/wp10Ui';

import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';
import { ComboPanel } from './combos';
import { MolchanPanel, type DiagramPoint } from './diagram';
import { MolchanUI } from './molchanUi';
import type {
  ComboEntry, ComboMap, ComboMapFile, ComboRankedFile, MolchanBoxesFile, MolchanDepositsFile, MolchanFactor,
  MolchanIndex, MolchanViewState,
} from './types';

const LAND_FILL_COLOR = 0x5f5a52;
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);
const BACKDROP_COLOR = 0x16202b;
const COAST_MIN_AGE = 0.001;
const RING = { highlightRadius: 6, highlightWidth: 2.2, highlight: 'rgba(255, 255, 255, 1)' };
const BOX_SIZE = 2.4;
const DEP_SIZE = 4.4;
/** Ground with no such feature at the time (a distance that cannot be measured). */
const NO_VALUE = 'rgba(150, 156, 164, 0.35)';
const MARGINS = ['post_rift', 'syn_rift', 'collision', 'after_collision'] as const;
/** The continent polygons the analysis places its ground in (begin ages as it uses them). */
const POLYGON_SETS = ['unchanged', 'extended'];
const POLYGON_COLOUR = '#c8ced6';

/** Each column in words, and where its colour scale saturates when coloured by value: a
 *  distance colour scale is most use near the features, so it stops at a few thousand km. */
const COLUMN: Record<string, { label: string; top: number }> = {
  post_rift_km: { label: 'Distance to a passive (post-rift) margin', top: 3000 },
  syn_rift_km: { label: 'Distance to an active (syn-rift) axis', top: 3000 },
  line_any_stage_km: { label: 'Distance to a margin line in any stage', top: 3000 },
  craton_edge_km: { label: 'Distance to the craton edge (present-day map)', top: 1500 },
  subduction_km: { label: 'Distance to a subduction zone', top: 4000 },
  abs_lat_Merdith2021: { label: 'Palaeolatitude, degrees from the equator', top: 90 },
  collision_km: { label: 'Distance to a margin in collision', top: 3000 },
  line_post_collision_km: { label: 'Distance to a margin line after its collision', top: 3000 },
};

type Kind = 'box' | 'deposit';
/** A combination map as drawn: shares (0 = best rated), null where there is none. */
interface ComboShares { id: string; boxes: Array<number | null>; deposits: Array<number | null> }
interface Selection { kind: Kind; id: number }

export interface MolchanDeps {
  archiveBase: string;
  colormaps: ColormapData;
  index: MolchanIndex;
  rifts: RiftsIndex;
  boxes: MolchanBoxesFile;
  deposits: MolchanDepositsFile;
  /** Merdith 2021's plate boundaries per time slice (whole Myr), or null. */
  boundaries: BoundariesFile | null;
  rebuildCamera(mode: ProjectionMode): Camera;
  /** The diagram panel opened or closed: the map must be resized. */
  onLayout(): void;
}

/**
 * The inputs of RiftsClimate's one-factor Molchan test (step 1 of its factor-combination
 * ladder), in Merdith 2021: the ground the test rates (each lattice place, about 290 km apart,
 * in each time slice 0-1000 Ma, where it was then), coloured by one factor's value or by its
 * share of ground rated higher; the deposits at their own age; the margin lines and continent
 * polygons the values were measured from; and the Molchan diagram the skill comes from.
 *
 * Built from the WP10 porphyry viewer's parts: its place-and-time Boxes lookup and
 * static-payload PointOverlay layers, the deposit viewer's RiftLines for the margins and
 * polygon outlines, and the archive's Merdith 2021 coastlines with their 540-1000 Ma
 * extension. Coastlines, margins and polygons are drawn at the time slice's own age (the age
 * the box values were measured at), so lines and squares agree.
 */
export class MolchanInstance {
  readonly scene = new Scene();
  readonly ui: MolchanUI;
  readonly panel: MolchanPanel;
  readonly view: MolchanViewState;

  private readonly backdrop: Mesh;
  private readonly graticule = new Graticule();
  private qOrient: Quaternion = [0, 0, 0, 1];
  private coastlines: Coastlines | null = null;
  private model!: RiftsModel;
  private readonly outlines: RiftLines;
  private readonly margins: RiftLines;
  /** Plate boundaries at the time slice on screen; the slice they belong to (whole Myr). */
  private readonly plateLines: BoundaryLines;
  /** Subduction teeth on the overriding plate's side, from Geode's Boundary Frames. */
  private readonly teeth: BoundaryOverlay;
  private plateSnap: number | null = null;
  private readonly boxLayer: PointOverlay;
  private readonly depLayer: PointOverlay;

  private readonly boxes: Boxes;
  private readonly comboPanel: ComboPanel;
  /** The combination map on screen, once fetched; files fetched so far (by path). */
  private comboData: ComboShares | null = null;
  private readonly comboFiles = new Map<string, Promise<ComboShares>>();
  private readonly rankedFiles = new Map<string, Promise<ComboRankedFile>>();
  private boxIdx: number[] = [];
  private depIdx: number[] = [];
  /** The time slice on screen (index into the box snapshots), or -1. */
  private slice = -1;
  private selection: Selection | null = null;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(private camera: Camera, private readonly deps: MolchanDeps, private readonly onNeedsRender: () => void) {
    const ix = deps.index;
    this.boxes = new Boxes(deps.boxes);
    this.view = {
      type: ix.types[0].id,
      show: 'factor',
      factor: ix.factors[0].id,
      combo: ix.combos?.[ix.types[0].id]?.maps[0]?.id ?? '',
      age: 400,
      projection: 'globe',
      boxes: true,
      colourBy: 'share',
      testOnly: false,
      deposits: true,
      window: '25',
      post_rift: true,
      syn_rift: true,
      collision: false,
      after_collision: false,
      boundaries: !!deps.boundaries,
      boundaryColour: 'label',
      polygons: false,
      coastlines: true,
      graticule: true,
      diagram: true,
    };

    this.backdrop = new Mesh(createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR }));
    this.scene.add(this.backdrop, this.graticule.lines);

    // Drawing order: polygon outlines, ground boxes, plate boundaries, margins, deposits.
    this.outlines = new RiftLines(camera, 1.1);
    this.boxLayer = new PointOverlay(camera);
    this.teeth = new BoundaryOverlay(camera as PerspectiveCamera);
    this.plateLines = new BoundaryLines(camera, deps.boundaries?.convergent_cm_yr ?? 0.5,
      (sgn) => diverge(deps.colormaps.RdBu.colors, sgn));
    this.margins = new RiftLines(camera);
    this.depLayer = new PointOverlay(camera);

    this.ui = new MolchanUI(this.view, {
      onSetting: () => this.applySetting(),
      onAge: (a) => this.applyAge(a),
      onLayers: () => this.applyLayers(),
      onDiagram: () => { this.panel.setVisible(this.view.diagram); this.deps.onLayout(); },
    }, ix);

    this.panel = new MolchanPanel({
      onPickDeposit: (d) => {
        this.select({ kind: 'deposit', id: d });
        this.applyAge(Math.round(this.deps.deposits.age_ma[d]));
      },
      onPickFactor: (id) => {
        this.view.factor = id;
        this.ui.refreshDisplay();
        this.applySetting();
      },
    });
    this.comboPanel = new ComboPanel({
      onPickMap: (id) => {
        this.view.show = 'combination';
        this.view.combo = id;
        this.ui.refreshDisplay();
        this.ui.enableControls();
        this.applySetting();
      },
      loadRanked: (type) => {
        const path = this.deps.index.combos[type].ranked;
        if (!this.rankedFiles.has(path)) {
          this.rankedFiles.set(path, fetchMaybeGzippedJSON(`${this.deps.archiveBase}/${path}`) as Promise<ComboRankedFile>);
        }
        return this.rankedFiles.get(path)!;
      },
    });
    this.panel.appendBlocks(this.comboPanel.blocks);
  }

  // --- combinations (step 3) ---------------------------------------------------------------

  private get comboMode(): boolean { return this.view.show === 'combination' && !!this.comboEntry; }

  private get comboEntry(): ComboEntry | undefined { return this.deps.index.combos?.[this.view.type]; }

  private get comboMap(): ComboMap | undefined {
    return this.comboEntry?.maps.find((m) => m.id === this.view.combo);
  }

  /** Fetch the map on screen (once per file); shares are stored in thousandths. */
  private async loadCombo(): Promise<void> {
    const m = this.comboMap;
    if (!m) { this.comboData = null; return; }
    if (this.comboData?.id === `${this.view.type}/${m.id}`) return;
    if (!this.comboFiles.has(m.file)) {
      const id = `${this.view.type}/${m.id}`;
      this.comboFiles.set(m.file, (fetchMaybeGzippedJSON(`${this.deps.archiveBase}/${m.file}`) as Promise<ComboMapFile>)
        .then((f) => ({ id, boxes: f.boxes.map((v) => (v == null ? null : v / 1000)), deposits: f.deposits })));
    }
    this.ui.setStatus('loading the map ...');
    const data = await this.comboFiles.get(m.file)!;
    this.ui.setStatus('');
    // Another map may have been picked while this one loaded.
    if (this.comboMap?.file === m.file) this.comboData = data;
  }

  /** Each box's share of ground rated higher by what is on screen (a factor or a combination). */
  private get boxShares(): Array<number | null> {
    return this.comboMode ? this.comboData?.boxes ?? [] : this.deps.boxes.shares[this.factor.id];
  }

  private get depShares(): Array<number | null> {
    return this.comboMode ? this.comboData?.deposits ?? [] : this.deps.deposits.shares[this.factor.id];
  }

  /** A combination has no single value to show, only shares. */
  private get colourBy(): 'share' | 'value' { return this.comboMode ? 'share' : this.view.colourBy; }

  private get factor(): MolchanFactor {
    return this.deps.index.factors.find((f) => f.id === this.view.factor)!;
  }

  private get typeLabel(): string {
    return this.deps.index.types.find((t) => t.id === this.view.type)?.label ?? this.view.type;
  }

  /** "SEDEX", "MVT": the type's label up to its first space. */
  private get typeShort(): string { return this.typeLabel.split(' ')[0]; }

  async boot(): Promise<void> {
    this.ui.setStatus('loading continents and margins ...');
    const m = this.deps.rifts.models.find((x) => x.id === this.deps.index.plate_model);
    if (!m) throw new Error(`plate model ${this.deps.index.plate_model} is not in riftsclimate/index.json`);
    this.model = m;
    const base = this.deps.archiveBase;
    const [coast, margins, polygons] = await Promise.all([
      fetchModelCoastlines(base, m),
      Promise.all((m.rifts ?? []).filter((p) => (MARGINS as readonly string[]).includes(p.id))
        .map(async (p) => ({ p, data: await fetchCoastlineData(base, p.geometry, p.rotations) }))),
      Promise.all((m.polygons ?? []).filter((p) => POLYGON_SETS.includes(p.id))
        .map(async (p) => ({ p, data: await fetchCoastlineData(base, p.geometry, p.rotations) }))),
    ]);
    this.coastlines = new Coastlines(coast.lines, coast.table, createMaskTexture(), LAND_R_UNDER_SURFACE, LAND_FILL_COLOR);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.setLineColor(0x9aa5b1);
    this.coastlines.setProjection(this.view.projection);
    this.coastlines.setOrientation(this.qOrient);
    this.scene.add(this.coastlines.lines, this.coastlines.land);
    for (const { p, data } of margins) {
      this.margins.addPhase(p.id, p.colour, data.lines, data.table, this.view[p.id as typeof MARGINS[number]]);
    }
    for (const { p, data } of polygons) {
      this.outlines.addPhase(p.id, POLYGON_COLOUR, data.lines, data.table, this.view.polygons);
    }
    if (this.deps.index.teeth) {
      // Subduction zones only: the other types are drawn by BoundaryLines, so their stroke
      // here is transparent (as the WP10 viewer).
      const clear = { stroke: 'rgba(0,0,0,0)', width: 1, label: '' };
      await this.teeth.load(`${base}/${this.deps.index.teeth.frames}`, {
        subduction: { stroke: LABEL_GROUPS[0].colour, width: 1.2, label: 'Subduction zone' },
        ridge: clear, transform: clear, other: clear,
      });
      this.plateSnap = null;
    }
    this.ui.setStatus('');
    this.setCaption();
    this.applyAge(this.view.age);
  }

  // --- type and factor -------------------------------------------------------------------

  private async applySetting(): Promise<void> {
    if (this.selection?.kind === 'deposit' && this.deps.deposits.type[this.selection.id] !== this.view.type) this.select(null);
    if (this.comboMode) {
      if (!this.comboMap) this.view.combo = this.comboEntry!.maps[0]?.id ?? '';
      await this.loadCombo();
    }
    this.rebuildBoxes();
    this.rebuildDeposits();
    this.setCaption();
    this.afterChange();
  }

  // --- time ------------------------------------------------------------------------------

  applyAge(age: number): void {
    this.view.age = age;
    this.ui.setAge(age);
    this.slice = this.boxes.snapshotAt(age);
    const sn = this.deps.boxes.snapshots;
    // Lines and continents at the slice's own age, where the box values were measured.
    const at = this.slice < 0 ? age : sn.snapshot_ma[this.slice];
    this.coastlines?.setAge(Math.max(at, COAST_MIN_AGE));
    this.margins.setAge(at);
    this.outlines.setAge(at);
    this.rebuildPlateLines();
    this.ui.setSlice(this.slice < 0 ? 'no time slice here'
      : `time slice ${sn.from_ma[this.slice]}-${sn.to_ma[this.slice]} Ma, measured at ${at} Ma`);
    this.rebuildBoxes();
    this.rebuildDeposits();
    this.afterChange();
  }

  private applyLayers(): void {
    if (this.coastlines) this.coastlines.lines.visible = this.coastlines.land.visible = this.view.coastlines;
    this.graticule.lines.visible = this.view.graticule;
    for (const id of MARGINS) this.margins.setVisible(id, this.view[id]);
    for (const id of POLYGON_SETS) this.outlines.setVisible(id, this.view.polygons);
    this.rebuildPlateLines();
    this.rebuildBoxes();
    this.rebuildDeposits();
    this.afterChange();
  }

  private afterChange(): void {
    this.boxLayer.visible = this.view.boxes;
    this.depLayer.visible = this.view.deposits;
    this.refreshHighlight();
    this.refreshPopup();
    this.refreshLegend();
    this.refreshDiagram();
    this.onNeedsRender();
  }

  // --- plate boundaries ------------------------------------------------------------------

  /** Merdith 2021's boundaries at the time slice on screen (its own age, whole Myr), the
   *  boundaries RiftsClimate measured the subduction and ridge distances from. */
  private rebuildPlateLines(): void {
    const bf = this.deps.boundaries;
    this.plateLines.visible = this.view.boundaries && !!bf;
    if (!bf) return;
    const snap = this.slice < 0 ? null : Math.round(this.deps.boxes.snapshots.snapshot_ma[this.slice]);
    if (snap !== this.plateSnap) {
      this.plateSnap = snap;
      this.plateLines.setFeatures(snap === null ? [] : bf.snapshots[String(snap)] ?? [], bf.labels);
      const t = this.deps.index.teeth;
      if (t && snap !== null && snap <= t.age_max) void this.teeth.setAge(snap, () => this.onNeedsRender());
    }
    this.plateLines.restyle(this.view.boundaryColour, false);
    this.styleTeeth();
  }

  /** Teeth in the subduction colour by type, pale by convergence (as the WP10 viewer). */
  private styleTeeth(): void {
    const t = this.deps.index.teeth;
    this.teeth.visible = !!t && this.view.boundaries && this.plateSnap !== null && this.plateSnap <= t.age_max;
    const stroke = this.view.boundaryColour === 'label' ? LABEL_GROUPS[0].colour : 'rgba(230, 235, 240, 0.85)';
    this.teeth.applyTheme({
      boundaryStyle: { subduction: { stroke, width: 1.2, label: 'Subduction zone' } },
      boundaryDecoration: { triangleGap: 16, triangleSize: 6 },
    } as unknown as ResolvedTheme);
  }

  /** A boundary under the pointer: its type and convergence rate there. */
  private boundaryAt(x: number, y: number): string[] | null {
    const bf = this.deps.boundaries;
    if (!bf || !this.plateLines.visible || this.plateSnap === null) return null;
    const hit = this.plateLines.pick(x, y);
    if (!hit) return null;
    const f = (bf.snapshots[String(this.plateSnap)] ?? [])[hit.feature];
    if (!f) return null;
    const label = bf.labels[f[0]];
    const c = f[3][hit.vertex];
    return [BoundaryLines.groupOf(label).id === 'other' ? label : BoundaryLines.groupOf(label).label,
      `${label}, Merdith 2021 at ${this.plateSnap} Ma`,
      c == null ? 'convergence: unknown (plate on one side only)'
        : `${c >= 0 ? 'closing' : 'opening'} at ${Math.abs(c).toFixed(1)} cm/yr across it`];
  }

  // --- colours ---------------------------------------------------------------------------

  /** One colour scale for boxes and deposits, so a deposit can be read against the ground
   *  around it. Share: viridis, bright = the best-rated ground (share 0). Value: cividis, bright
   *  at 0 and dark at the column's `top` (held beyond it), so that for the distances and the
   *  palaeolatitude bright is again the end the factor rates higher. */
  private colourOf(share: number | null, value: number | null): string {
    if (this.colourBy === 'share') {
      return share == null ? NO_VALUE : ramp(this.deps.colormaps.viridis.colors, 1 - share);
    }
    if (value == null) return NO_VALUE;
    return ramp(this.deps.colormaps.cividis.colors, 1 - clamp01(value / (COLUMN[this.factor.column]?.top ?? 1)));
  }

  // --- the point sets --------------------------------------------------------------------

  /** A petrify points.json for points already placed at this age: the 'trajectory'
   *  transport with the same positions at both ends (as wp10Instance.ts). */
  private staticPayload(points: Array<Record<string, unknown>>): PointsPayload {
    const lon = points.map((p) => p.lon as number);
    const lat = points.map((p) => p.lat as number);
    return { transport: 'trajectory', times: [0, 1], frames: { 0: [lon, lat], 1: [lon, lat] }, points };
  }

  private load(layer: PointOverlay, points: Array<Record<string, unknown>>, style: PointStyleHook, size: number,
    keyline: string): void {
    layer.loadData(this.staticPayload(points), { lifespan: 'always', keyline, size, ...RING });
    layer.setTime(0);
    layer.setStyle(style);
  }

  /** The time slice whose box stands for this place now. Normally the slice covering the age;
   *  "as the test sees it", the younger slice of the pair the test merged it into (the test
   *  keeps that slice's position and values for both). -1 where the place has no box. */
  private boxSlice(place: number): number {
    const b = this.boxes;
    let s = this.slice;
    if (s < 0 || !b.position(place, s)) return -1;
    if (!this.view.testOnly) return s;
    while (s >= 0 && !((b.at(this.deps.boxes.weight_in_test, place, s) ?? 0) > 0)) s--;
    return s;
  }

  /** The ground in this time slice, one square per place where it was then. Worst-rated
   *  first, so the best-rated ground is drawn on top. */
  private rebuildBoxes(): void {
    const b = this.boxes;
    const shares = this.boxShares;
    const values = this.comboMode ? [] : this.deps.boxes.values[this.factor.column];
    const rows: Array<{ p: number; s: number }> = [];
    for (let p = 0; p < b.nPlaces; p++) {
      const s = this.boxSlice(p);
      if (s >= 0) rows.push({ p, s });
    }
    rows.sort((x, y) => (b.at(shares, y.p, y.s) ?? 1) - (b.at(shares, x.p, x.s) ?? 1));
    this.boxIdx = rows.map((r) => r.p);
    const pts = rows.map(({ p, s }) => {
      const [lon, lat] = b.position(p, s)!;
      return { lon, lat, share: b.at(shares, p, s) ?? null, value: b.at(values, p, s) ?? null, slice: s };
    });
    this.load(this.boxLayer, pts, (p) => ({
      symbol: 'square', size: BOX_SIZE,
      fill: this.colourOf(p.share as number | null, p.value as number | null),
    }), BOX_SIZE, 'rgba(8, 10, 14, 0.6)');
  }

  /** Where this deposit is drawn: where it was at the time slice's own age, on its plate, so it
   *  moves with the continents and lines (all drawn at that age). In its own time slice, if
   *  RiftsClimate could not place it at the slice's age, where it formed; otherwise null. */
  private depositPosition(i: number): [number, number] | null {
    const d = this.deps.deposits;
    if (this.slice < 0) return null;
    const k = i * this.deps.boxes.snapshots.snapshot_ma.length + this.slice;
    const lon = d.slice_lon[k];
    const lat = d.slice_lat[k];
    if (lon != null && lat != null) return [lon, lat];
    if (this.boxes.snapshotAt(d.age_ma[i]) === this.slice && d.m_lon[i] != null && d.m_lat[i] != null) {
      return [d.m_lon[i] as number, d.m_lat[i] as number];
    }
    return null;
  }

  /** Is this deposit on the map at the current age? */
  private depositShown(i: number): boolean {
    const d = this.deps.deposits;
    if (d.type[i] !== this.view.type || this.depositPosition(i) == null) return false;
    if (this.view.window === 'slice') return this.boxes.snapshotAt(d.age_ma[i]) === this.slice;
    return Math.abs(d.age_ma[i] - this.view.age) <= Number(this.view.window);
  }

  /** The deposits of this type formed near this age, each where it was at the time slice's age. */
  private rebuildDeposits(): void {
    const d = this.deps.deposits;
    const shares = this.depShares;
    const values = this.comboMode ? [] : d.values[this.factor.column];
    this.depIdx = [];
    for (let i = 0; i < d.deposit_id.length; i++) if (this.depositShown(i)) this.depIdx.push(i);
    const pts = this.depIdx.map((i) => {
      const [lon, lat] = this.depositPosition(i)!;
      return { lon, lat, share: shares[i] ?? null, value: values[i] ?? null };
    });
    this.load(this.depLayer, pts, (p) => ({
      symbol: 'diamond', size: DEP_SIZE,
      fill: this.colourOf(p.share as number | null, p.value as number | null),
    }), DEP_SIZE, 'rgba(255, 255, 255, 0.95)');
  }

  // --- legend, caption, diagram ----------------------------------------------------------

  private refreshLegend(): void {
    const v = this.view;
    const f = this.factor;
    const blocks: LegendBlock[] = [];
    const sn = this.deps.boxes.snapshots;
    const sliceText = this.slice < 0 ? `${v.age} Ma` : `${sn.from_ma[this.slice]}-${sn.to_ma[this.slice]} Ma`;
    const pts = this.boxLayer.payload()?.points ?? [];

    if (v.boxes) {
      const merged = pts.filter((p) => p.slice !== this.slice).length;
      const counted = !v.testOnly ? 'each in the time slice covering this age'
        : merged ? `as the test sees them: this slice is merged into the younger one of its pair, so these are `
          + `that slice's boxes (${merged} of ${pts.length})` : 'as the test sees them: this slice is the younger one of '
          + 'its pair, and its boxes carry the weight of both';
      const cm = this.comboMap;
      if (this.comboMode && cm) {
        const e = this.comboEntry!;
        const none = pts.filter((p) => p.share == null).length;
        blocks.push({
          title: `Held-out map, ${sliceText}: ${cm.combination ?? 'best-of-all choice'}`,
          ramp: { css: rampCss(this.deps.colormaps.viridis.colors, 1, 0), lo: '0 (best rated)', hi: '1 (worst rated)' },
          rows: none ? [{ label: 'region not set aside (too few deposits)', fill: NO_VALUE, count: String(none) }] : [],
          note: `Each region set aside (${e.regions.join(', ')}) is coloured by the map made without it: a square's `
            + 'share of that region\'s continental area (every place and time slice, weighted by area x duration) '
            + `rated higher, the same rated counting half. ${pts.length} places shown, ${counted}.`
            + (cm.kind === 'best' ? ' Each region uses the combination picked for it on the other regions.' : ''),
        });
      } else if (v.colourBy === 'share') {
        blocks.push({
          title: `Ground, ${sliceText}: share rated higher by "${f.id}"`,
          ramp: { css: rampCss(this.deps.colormaps.viridis.colors, 1, 0), lo: '0 (best rated)', hi: '1 (worst rated)' },
          note: `Share of all the test's ground (every place and time slice, weighted by area x duration) rated `
            + `higher than this box, the same rated counting half. ${pts.length} places shown, ${counted}. `
            + 'A square is a place (about 290 km apart) where it was then.',
        });
      } else {
        const col = COLUMN[f.column] ?? { label: f.column, top: 1 };
        const none = pts.filter((p) => p.value == null).length;
        blocks.push({
          title: `Ground, ${sliceText}: ${col.label.toLowerCase()}`,
          ramp: { css: rampCss(this.deps.colormaps.cividis.colors, 1, 0), lo: `0 ${f.unit}`, hi: `${fmtN(col.top)} ${f.unit}${col.top < 90 ? ' or more' : ''}` },
          rows: none ? [{ label: 'none at this time (cannot be measured)', fill: NO_VALUE, count: String(none) }] : [],
          note: `${pts.length} places shown, ${counted}. Distances are along the Earth's surface.`,
        });
      }
    }

    if (v.deposits) {
      const all = this.deps.deposits.type.filter((t) => t === v.type).length;
      const when = v.window === 'slice' ? `formed in this time slice` : `formed within ${v.window} Myr of ${v.age} Ma`;
      blocks.push({
        title: `${this.typeShort} deposits ${when}`,
        rows: [{ label: this.typeLabel, fill: '#ffffff', count: `${this.depIdx.length} of ${all}` }],
        note: 'Each drawn where it was at the time slice\'s age, moving with its plate (where it formed is in '
          + 'its popup), and coloured on the same scale as the ground by its '
          + 'own value or share.',
      });
    }

    if (this.plateLines.visible) {
      blocks.push(v.boundaryColour === 'label'
        ? { title: `Plate boundaries, Merdith 2021, ${this.plateSnap ?? '-'} Ma`,
          rows: LABEL_GROUPS.map((g) => ({ label: g.label, fill: g.colour })),
          note: 'The lines the subduction and ridge distances are measured to; teeth on the overriding plate. '
            + 'Hover one for its rate.' }
        : { title: `Plate boundaries, Merdith 2021, ${this.plateSnap ?? '-'} Ma: convergence`,
          ramp: { css: `linear-gradient(to right, ${[...Array(9).keys()].map((i) => `${diverge(this.deps.colormaps.RdBu.colors, i / 4 - 1)} ${i * 12.5}%`).join(', ')})`,
            lo: `opening ${CONV_MAX} cm/yr`, mid: '0', hi: `closing ${CONV_MAX}` },
          note: 'The rate the two plates close (+) or open (-) across the boundary, from their motions; '
            + 'grey where a plate lies on one side only.' });
    }

    const lines = (this.model?.rifts ?? []).filter((p) => (MARGINS as readonly string[]).includes(p.id)
      && v[p.id as typeof MARGINS[number]]);
    const rows = lines.map((p) => ({ label: p.label, fill: p.colour }));
    if (v.polygons) rows.push({ label: 'Continent polygons (as the analysis uses them)', fill: POLYGON_COLOUR });
    if (rows.length) {
      blocks.push({ title: 'Lines, at the time slice\'s own age', rows,
        note: 'Each margin is drawn only while it is in that phase (Jackson & MacDonald); after collision: '
          + 'from the end of its collision to today.' });
    }
    this.ui.setLegend(blocks);
  }

  private setCaption(): void {
    const b = this.deps.index.built_from;
    const cm = this.comboMap;
    if (this.comboMode && cm) {
      this.ui.setCaption([
        `${this.typeShort}, ${cm.kind === 'best' ? 'the best-of-all choice' : `"${cm.combination}"`}: step 3 of the `
          + `ladder (equal weights, percentiles). ${cm.kind === 'best' ? 'Fully held-out skill' : 'Regional skill'} `
          + `${cm.skill.toFixed(3)}. Merdith 2021 plate model. Click anything for its values.`,
        'Squares: the ground, where each place was in the time slice covering this age, coloured by its held-out '
          + 'map. Diamonds: deposits, where each was at that time slice\'s age, moving with its plate.',
        `Values from RiftsClimate ${b.riftsclimate_commit ?? '?'} (prep/geode_combo_export.py).`,
      ]);
      return;
    }
    const skill = this.deps.index.curves[this.view.type]?.[this.factor.id]?.skill;
    this.ui.setCaption([
      `${this.typeShort}, "${this.factor.id}": ${this.factor.rating}. Skill ${skill == null ? '-' : skill.toFixed(3)}. `
        + 'Merdith 2021 plate model. Click anything for its values.',
      'Squares: the ground, where each place was in the time slice covering this age. Diamonds: deposits, '
        + 'where each was at that time slice\'s age, moving with its plate.',
      `Values from RiftsClimate ${b.riftsclimate_commit ?? '?'} (${b.script}, ${b.script_state}), written ${b.data_written}.`,
    ]);
  }

  private refreshDiagram(): void {
    const e = this.comboEntry;
    this.comboPanel.setVisible(this.comboMode);
    if (this.comboMode && e) this.comboPanel.setData(this.view.type, e, this.view.combo);
    if (this.comboMode) { this.refreshComboDiagram(); return; }
    const d = this.deps.deposits;
    const shares = d.shares[this.factor.id];
    const values = d.values[this.factor.column];
    const shown = new Set(this.depIdx);
    const points: DiagramPoint[] = [];
    for (let i = 0; i < d.deposit_id.length; i++) {
      const s = shares[i];
      if (d.type[i] !== this.view.type || s == null) continue;
      points.push({ dep: i, share: s, name: d.name[i], age: d.age_ma[i], shown: shown.has(i) && this.view.deposits,
        fill: this.colourOf(s, values[i]) });
    }
    points.sort((a, c) => a.share - c.share);
    const curves = this.deps.index.curves[this.view.type] ?? {};
    this.panel.setData({
      title: `Molchan diagram: ${this.typeShort}, "${this.factor.id}"`,
      rating: this.factor.rating,
      skill: curves[this.factor.id]?.skill ?? NaN,
      points,
      selected: this.selection?.kind === 'deposit' ? this.selection.id : null,
      factors: this.deps.index.factors.filter((f) => f.types.includes(this.view.type))
        .map((f) => ({ id: f.id, skill: curves[f.id]?.skill ?? NaN, current: f.id === this.factor.id })),
    });
  }

  /** The Molchan diagram of a combination's held-out map, and its skill in each region. */
  private refreshComboDiagram(): void {
    const d = this.deps.deposits;
    const cm = this.comboMap!;
    const shares = this.depShares;
    const shown = new Set(this.depIdx);
    const points: DiagramPoint[] = [];
    for (let i = 0; i < d.deposit_id.length; i++) {
      const s = shares[i];
      if (d.type[i] !== this.view.type || s == null) continue;
      points.push({ dep: i, share: s, name: d.name[i], age: d.age_ma[i], shown: shown.has(i) && this.view.deposits,
        fill: this.colourOf(s, null) });
    }
    points.sort((a, c) => a.share - c.share);
    const best = cm.kind === 'best';
    this.panel.setData({
      title: `Molchan diagram: ${this.typeShort}, ${best ? 'the best-of-all choice' : `"${cm.combination}"`}`,
      rating: '',
      skill: cm.skill,
      points: this.comboData ? points : [],
      selected: this.selection?.kind === 'deposit' ? this.selection.id : null,
      factors: Object.entries(cm.skill_by_region).map(([r, sk]) => ({
        id: r, skill: sk, current: false, pickable: false,
        label: `${r} (${cm.deposits_by_region[r]})${best ? `: ${cm.regions[r].combination}` : ''}`,
        tip: `Made without ${r}: ${cm.regions[r].combination}\n${cm.regions[r].chosen.join('\n')}`,
      })),
      listTitle: best ? 'Each region set aside: the combination picked for it, and its skill there'
        : 'Each region set aside: skill there',
      listNote: 'In brackets, the region\'s deposits. Hover a row for what was chosen without that region '
        + '(directions, preferred distances). The skill above pools the regions, each deposit counting once.',
      note: 'Each deposit\'s share of its own region\'s continental area rated higher, by the map made without '
        + 'that region (a held-out map). Up: the share of deposits that would be missed if only ground rated '
        + 'higher than that were searched. Dashed: deposits placed at random. Skill is the shaded area, 0.5 minus '
        + `the mean share${best ? ': here the fully held-out skill, nothing about a region having helped choose '
          + 'or make its map' : ': the regional skill of the tables'}. Filled dots: deposits on the map now; click one `
        + 'to go to it.',
    });
  }

  // --- picking ---------------------------------------------------------------------------

  private pickable(): Array<{ kind: Kind; layer: PointOverlay; fan: boolean }> {
    const out: Array<{ kind: Kind; layer: PointOverlay; fan: boolean }> = [];
    if (this.depLayer.visible) out.push({ kind: 'deposit', layer: this.depLayer, fan: true });
    if (this.boxLayer.visible) out.push({ kind: 'box', layer: this.boxLayer, fan: false });
    return out;
  }

  private idOf(kind: Kind, index: number): number {
    return kind === 'deposit' ? this.depIdx[index] : this.boxIdx[index];
  }

  clickAt(x: number, y: number): void {
    for (const { kind, layer, fan } of this.pickable()) {
      const picked = layer.pick(x, y);
      if (!picked) continue;
      const onFan = !!layer.spiderfied?.includes(picked.index);
      if (fan && !onFan && layer.clusterSizeAt(x, y) >= 2) {
        for (const o of this.pickable()) if (o.layer !== layer) o.layer.unspiderfy();
        layer.spiderfy(x, y);
        this.onNeedsRender();
        return;
      }
      this.ui.hideTooltip();
      this.select({ kind, id: this.idOf(kind, picked.index) });
      this.afterChange();
      return;
    }
    for (const o of this.pickable()) o.layer.unspiderfy();
    this.select(null);
    this.afterChange();
  }

  hoverAt(x: number, y: number): void {
    // Deposits first, then a plate boundary, then the ground under it.
    const onDeposit = this.depLayer.visible && this.depLayer.pick(x, y);
    const b = onDeposit ? null : this.boundaryAt(x, y);
    if (b) { this.ui.showTooltip(x, y, b); return; }
    for (const { kind, layer } of this.pickable()) {
      const picked = layer.pick(x, y);
      if (!picked) continue;
      const sel = { kind, id: this.idOf(kind, picked.index) };
      const lines = this.describe(sel).slice(0, 3).map((l) => (typeof l === 'string' ? l : l.text));
      const pile = layer.clusterSizeAt(x, y);
      if (pile >= 2 && kind === 'deposit') lines.push(`${pile} here: click to spread them out`);
      this.ui.showTooltip(x, y, [this.titleOf(sel), ...lines]);
      return;
    }
    this.ui.hideTooltip();
  }

  hoverOut(): void { this.ui.hideTooltip(); }

  private select(sel: Selection | null): void {
    this.selection = sel;
    if (!sel) hideSamplePopup();
  }

  private refreshHighlight(): void {
    const s = this.selection;
    const find = (arr: number[]) => {
      const k = s ? arr.indexOf(s.id) : -1;
      return k >= 0 ? k : null;
    };
    this.boxLayer.highlight(s?.kind === 'box' ? find(this.boxIdx) : null);
    this.depLayer.highlight(s?.kind === 'deposit' ? find(this.depIdx) : null);
  }

  private refreshPopup(): void {
    const s = this.selection;
    if (!s) return;
    showInfoPopup(this.titleOf(s), this.describe(s), () => {
      this.select(null);
      this.refreshHighlight();
      this.refreshDiagram();
      this.onNeedsRender();
    });
  }

  private titleOf(s: Selection): string {
    if (s.kind === 'deposit') return this.deps.deposits.name[s.id] || this.deps.deposits.deposit_id[s.id];
    return `Place ${this.deps.boxes.places.id[s.id]}, ${Math.round(this.view.age)} Ma`;
  }

  /** Every factor tested on this type: its value and share, the chosen factor first. */
  private factorLines(value: (col: string) => number | null, share: (f: string) => number | null): PopupLine[] {
    const fs = this.deps.index.factors.filter((f) => f.types.includes(this.view.type));
    fs.sort((a, c) => Number(c.id === this.view.factor) - Number(a.id === this.view.factor));
    return fs.map((f) => {
      const val = value(f.column);
      const sh = share(f.id);
      const current = f.id === this.view.factor;
      return {
        text: `${f.id}: ${val == null ? 'none at this time' : `${fmtValue(val, f.unit)}`}; `
          + `${sh == null ? '-' : `${(sh * 100).toFixed(1)}%`} of ground rated higher`,
        color: current ? '#e6ebf0' : undefined,
        swatch: current ? this.colourOf(sh, val) : undefined,
      };
    });
  }

  /** In combination mode: the share by the held-out map and the map it comes from. */
  private comboLines(region: string, share: number | null): PopupLine[] {
    const cm = this.comboMap;
    if (!this.comboMode || !cm) return [];
    const r = cm.regions[region];
    if (!r) return [{ text: `${region || 'No region'}: not set aside (too few deposits), no held-out map`, color: '#9aa2ab' }];
    return [
      { text: `${share == null ? '-' : `${(share * 100).toFixed(1)}%`} of ${region}'s continental area rated higher`,
        color: '#e6ebf0', swatch: this.colourOf(share, null) },
      { text: `by the map made without ${region}: ${r.combination}`, color: '#b9c3cc' },
      ...r.chosen.map((c) => ({ text: `  ${c}`, color: '#8a929b' })),
    ];
  }

  /** The popup's lines: values only, as RiftsClimate wrote them. */
  private describe(s: Selection): Array<string | PopupLine> {
    if (s.kind === 'deposit') {
      const d = this.deps.deposits;
      const i = s.id;
      return [
        `${this.typeLabel}, ${d.age_ma[i]} Ma`,
        ...this.comboLines(d.region[i], this.depShares[i] ?? null),
        ...this.factorLines((c) => d.values[c]?.[i] ?? null, (f) => d.shares[f]?.[i] ?? null),
        `Where it formed: ${fmtLonLat(d.m_lon[i] ?? NaN, d.m_lat[i] ?? NaN)} (Merdith 2021, at ${d.age_ma[i]} Ma)`,
        ...(() => {
          const pos = this.depositPosition(i);
          const sn = this.deps.boxes.snapshots.snapshot_ma;
          return pos && this.slice >= 0 ? [`On the map: ${fmtLonLat(pos[0], pos[1])} (at ${sn[this.slice]} Ma, on its plate)`] : [];
        })(),
        `Today: ${fmtLonLat(d.lon[i], d.lat[i])}${d.region[i] ? `, ${d.region[i]}` : ''}`,
        { text: d.deposit_id[i], color: '#8a929b' },
      ];
    }
    const b = this.boxes;
    const bf = this.deps.boxes;
    const p = s.id;
    const sn = this.boxSlice(p);
    const pos = sn < 0 ? null : b.position(p, sn);
    if (!pos) return [{ text: `No box for this place at ${Math.round(this.view.age)} Ma`, color: '#9aa2ab' }];
    const w = b.at(bf.weight, p, sn);
    const wt = b.at(bf.weight_in_test, p, sn) ?? 0;
    return [
      ...this.comboLines(this.deps.index.place_region?.[p] ?? '', b.at(this.boxShares, p, sn) ?? null),
      ...this.factorLines((c) => b.at(bf.values[c] ?? [], p, sn), (f) => b.at(bf.shares[f] ?? [], p, sn)),
      `Time slice ${bf.snapshots.from_ma[sn]}-${bf.snapshots.to_ma[sn]} Ma, measured at ${bf.snapshots.snapshot_ma[sn]} Ma`,
      `Where it was: ${fmtLonLat(pos[0], pos[1])} (Merdith 2021)`,
      `Weight (area x duration): ${w == null ? '-' : fmtN(w)} million km² x Myr`,
      wt > 0 ? `In the test with weight ${fmtN(wt)} (this slice and the next older one, merged)`
        : 'In the test merged into the next younger slice of this place (weight 0 here); '
          + 'switch on "as the test sees it" to see that box',
    ];
  }

  // --- projection and frame ----------------------------------------------------------------

  private get overlays(): PointOverlay[] { return [this.boxLayer, this.depLayer]; }

  setProjection(mode: ProjectionMode): void {
    this.view.projection = mode;
    const camera = this.deps.rebuildCamera(mode);
    this.camera = camera;
    this.margins.setCamera(camera, mode);
    this.outlines.setCamera(camera, mode);
    this.plateLines.setCamera(camera, mode);
    this.teeth.setCamera(camera, mode);
    const oldGeom = this.backdrop.geometry;
    const oldMat = this.backdrop.material as Material;
    this.backdrop.geometry = createSurfaceGeometry(mode, BACKDROP_R);
    if (isFlat(mode)) {
      const mat = createFlatBackdropMaterial(BACKDROP_COLOR);
      mat.uniforms.uProjectionMode.value = PROJECTION_UNIFORM[mode];
      mat.uniforms.uColor.value = passthroughColor(BACKDROP_COLOR);
      this.backdrop.material = mat;
    } else {
      this.backdrop.material = new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR });
    }
    oldGeom.dispose();
    oldMat.dispose();
    this.coastlines?.setProjection(mode);
    this.graticule.setProjection(mode);
    for (const o of this.overlays) o.setCamera(camera, mode);
    this.applyOrientation();
    this.onNeedsRender();
  }

  get orientation(): Quaternion { return this.qOrient; }

  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    this.applyOrientation();
    this.onNeedsRender();
  }

  get centreLongitude(): number {
    const [x, y, z, w] = this.qOrient;
    return lonLatFromGeoVec(rotateVector([-x, -y, -z, w], 1, 0, 0)).lon;
  }

  private applyOrientation(): void {
    const flat = isFlat(this.view.projection);
    const q: Quaternion = flat ? this.qOrient : [0, 0, 0, 1];
    this.coastlines?.setOrientation(this.qOrient);
    this.graticule.setOrientation(this.qOrient);
    for (const o of this.overlays) o.setReferenceRotation(q);
    this.margins.setOrientation(q);
    this.outlines.setOrientation(q);
    this.plateLines.setOrientation(q);
    this.teeth.setReferenceRotation(q);
    const lon = this.centreLongitude;
    this.ui.setMapHint(flat ? `Map centred on ${Math.abs(lon).toFixed(0)}°${lon < 0 ? 'W' : 'E'} · drag sideways to turn it` : '');
  }

  setCameraAspect(camera: Camera): void {
    this.camera = camera;
    for (const o of this.overlays) o.setCamera(camera, this.view.projection);
    this.margins.setCamera(camera, this.view.projection);
    this.outlines.setCamera(camera, this.view.projection);
    this.plateLines.setCamera(camera, this.view.projection);
    this.teeth.setCamera(camera, this.view.projection);
  }

  /** The map's rectangle: the window left of the diagram panel. */
  resize(rect: Rect): void {
    this.rect = rect;
    for (const o of this.overlays) o.setRect(rect);
    this.margins.setRect(rect);
    this.outlines.setRect(rect);
    this.plateLines.setRect(rect);
    this.teeth.setRect(rect);
    this.ui.setRightInset(innerWidth - rect.width);
    this.panel.redraw();
  }

  get mapRect(): Rect { return this.rect; }

  get animating(): boolean {
    return this.overlays.some((o) => o.isAnimating());
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.outlines.draw();
    this.boxLayer.draw();
    if (this.plateLines.visible) this.plateLines.draw();
    if (this.teeth.visible) this.teeth.draw();
    this.margins.draw();
    this.depLayer.draw();
  }
}

function fmtValue(v: number, unit: string): string {
  return unit === 'km' ? `${Math.round(v).toLocaleString()} km` : `${v.toFixed(1)}${unit}`;
}
