import {
  FrontSide, Mesh, MeshBasicMaterial, Scene,
  type Camera, type Material, type WebGLRenderer,
} from 'three';

import { PointOverlay, type PointStyleHook, type PointsPayload } from '../core/pointOverlay';
import { Coastlines, LAND_R_UNDER_SURFACE } from '../core/coastlines';
import { createMaskTexture } from '../core/mask';
import { Graticule } from '../core/graticule';
import { lonLatFromGeoVec, rotateVector, type Quaternion } from '../core/rotation';
import { PROJECTION_UNIFORM, createSurfaceGeometry, isFlat, type ProjectionMode } from '../core/projection';
import { createFlatBackdropMaterial, passthroughColor } from '../core/material';
import { hideSamplePopup, showInfoPopup, type PopupLine } from '../core/samplePopup';
import type { ColormapData } from '../core/types';
import type { Rect } from '../core/layout';
import { fetchModelCoastlines } from '../riftsclimate/riftsclimateInstance';
import type { RiftsIndex } from '../riftsclimate/types';

import { ChartsPanel, fmtDepth } from './charts';
import { BURIED, Boxes, ERODED, FATE_COLOUR, FATE_LABEL, FOUND, Walkers } from './data';
import { Wp10UI, type LegendBlock } from './wp10Ui';
import type { BoxesFile, FindsFile, WalkersFile, Wp10Index, Wp10ViewState } from './types';

const LAND_FILL_COLOR = 0x5f5a52;
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);
const BACKDROP_COLOR = 0x16202b;
const SEP = ' | ';
/** Depth colours: blue deepens to this depth (km below the surface), then holds. */
const DEEP_KM = 6;
/** "Forming now and found today" spans this many factors of ten below its maximum. */
const DECADES = 3;
const COAST_MIN_AGE = 0.001;
/** The selection ring: larger than petrify's default, to be found on a busy map. */
const RING = { highlightRadius: 6, highlightWidth: 2.2, highlight: 'rgba(255, 255, 255, 1)' };
/** The part of plasma the formation squares use. */
const RATE_LO = 0.1;
const RATE_HI = 0.8;
const NO_FORMATION = 'rgba(150, 156, 164, 0.35)';
const REAL_FILL = '#ffffff';

type Kind = 'box' | 'sim' | 'real' | 'place';
interface Selection { kind: Kind; id: number | string }

export interface Wp10Deps {
  archiveBase: string;
  colormaps: ColormapData;
  index: Wp10Index;
  rifts: RiftsIndex;
  boxes: BoxesFile;
  walkers: WalkersFile;
  finds: FindsFile;
  /** The deposit viewer's points for this plate model (every class); read, filtered to
   *  the porphyries the WP10 analysis used. */
  points: PointsPayload;
  rebuildCamera(mode: ProjectionMode): Camera;
  /** The charts panel opened, closed or changed width: the map must be resized. */
  onLayout(): void;
}

/**
 * The WP10 porphyry Cu viewer: where porphyries form at each age (per rung), the
 * simulated porphyries that exist at that age with their depth, the real porphyries,
 * and today's predicted finds per place against the real counts -- all in Merdith 2021.
 *
 * Built from the same parts as the RiftsClimate deposit viewer (riftsclimateInstance.ts):
 * PointOverlay layers on 2D canvases over the WebGL globe or flat map, the archive's
 * Merdith 2021 coastlines with the deposit viewer's 540-1000 Ma extension, the Map
 * Orientation turn for flat maps (ADR-0058), and the real porphyries reconstructed on
 * the plates the analysis gave them (the deposit viewer's points.json).
 *
 * Simulated porphyries and the formation boxes carry no plate: they are drawn at the
 * reconstructed position RiftsClimate gives their place in the box covering each age,
 * so their point sets are rebuilt at every age (a few thousand points; cheap).
 */
export class Wp10Instance {
  readonly scene = new Scene();
  readonly ui: Wp10UI;
  readonly charts: ChartsPanel;
  readonly view: Wp10ViewState;

  private readonly backdrop: Mesh;
  private readonly graticule = new Graticule();
  private qOrient: Quaternion = [0, 0, 0, 1];
  private coastlines: Coastlines | null = null;

  // Drawing order: boxes, finds, simulated, real (each canvas above the last).
  private readonly formationLayer: PointOverlay;
  private readonly findsLayer: PointOverlay;
  private readonly simLayer: PointOverlay;
  private readonly realLayer: PointOverlay;

  private readonly boxes: Boxes;
  private walkers!: Walkers;
  /** Per drawn point: place index (boxes, finds) or walker index (sims). */
  private formationIdx: number[] = [];
  private findsIdx: number[] = [];
  private simIdx: number[] = [];
  private readonly realRow = new Map<string, number>();
  private realPayload: PointsPayload;
  private rateMax = 1;
  private rateFoundMax = 1;
  private findsMax = 1;
  private diffMax = 1;

  private selection: Selection | null = null;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(private camera: Camera, private readonly deps: Wp10Deps, private readonly onNeedsRender: () => void) {
    const ix = deps.index;
    this.boxes = new Boxes(deps.boxes);
    this.view = {
      rung: ix.rungs.find((r) => r.id.startsWith('1a'))?.id ?? ix.rungs[0].id,
      walk: ix.walks[0].id,
      age: 0,
      projection: 'globe',
      formation: true,
      formationColour: 'rate',
      simulated: true,
      simColour: 'depth',
      real: true,
      finds: true,
      findsColour: 'predicted',
      coastlines: true,
      graticule: true,
      charts: true,
      lines: 300,
      onlyFound: false,
      lineColour: 'fate',
      chartSpan: ix.age_max,
    };

    this.backdrop = new Mesh(createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR }));
    this.scene.add(this.backdrop, this.graticule.lines);

    this.formationLayer = new PointOverlay(camera);
    this.findsLayer = new PointOverlay(camera);
    this.simLayer = new PointOverlay(camera);
    this.realLayer = new PointOverlay(camera);

    // The real porphyries: the deposit viewer's own reconstruction of them (the plate
    // each was given by the analysis), only those the WP10 analysis used.
    const f = deps.finds.porphyries;
    f.deposit_id.forEach((id, i) => this.realRow.set(id, i));
    this.realPayload = { ...deps.points, points: deps.points.points.filter((p) => this.realRow.has(p.deposit_id as string)) };
    this.realLayer.loadData(this.realPayload, { lifespan: 'since', keyline: 'rgba(8, 10, 14, 0.9)', size: 3.6, ...RING });
    this.realLayer.setStyle(() => ({ symbol: 'diamond', fill: REAL_FILL, size: 3.8 }));

    this.ui = new Wp10UI(this.view, {
      onSetting: () => this.applySetting(),
      onAge: (a) => this.applyAge(a),
      onLayers: () => this.applyLayers(),
      onCharts: () => { this.charts.setVisible(this.view.charts); this.deps.onLayout(); },
      onChartOptions: () => this.charts.setOptions(this.chartOptions()),
    }, ix.rungs, ix.walks, ix.age_max);

    this.charts = new ChartsPanel({
      onPickWalker: (i, age) => {
        if (i === null) return;
        this.select({ kind: 'sim', id: i });
        if (!this.walkers.exists(i, this.view.age)) {
          const e = this.walkers.erodedAt[i];
          const lo = e === null ? 0 : Math.floor(e) + 1;
          this.applyAge(Math.max(lo, Math.min(Math.floor(this.walkers.s.age_ma[i]), Math.round(age))));
        } else {
          this.afterChange();
        }
      },
      onPickAge: (age) => this.applyAge(age),
    });
    this.charts.setOptions(this.chartOptions());
  }

  get key(): string { return `${this.view.walk}${SEP}${this.view.rung}`; }

  async boot(): Promise<void> {
    this.ui.setStatus('loading continents ...');
    const m = this.deps.rifts.models.find((x) => x.id === this.deps.index.plate_model);
    if (!m) throw new Error(`plate model ${this.deps.index.plate_model} is not in riftsclimate/index.json`);
    const coast = await fetchModelCoastlines(this.deps.archiveBase, m);
    this.coastlines = new Coastlines(coast.lines, coast.table, createMaskTexture(), LAND_R_UNDER_SURFACE, LAND_FILL_COLOR);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.setLineColor(0x9aa5b1);
    this.coastlines.setProjection(this.view.projection);
    this.coastlines.setOrientation(this.qOrient);
    this.scene.add(this.coastlines.lines, this.coastlines.land);
    this.ui.setStatus('');
    this.applySetting();
  }

  private chartOptions() {
    return { lines: this.view.lines, onlyFound: this.view.onlyFound, lineColour: this.view.lineColour,
      span: Number(this.view.chartSpan) };
  }

  // --- rung and walk -----------------------------------------------------------------

  private applySetting(): void {
    const sample = this.deps.walkers.samples[this.key];
    if (!sample) throw new Error(`no simulated porphyries for ${this.key}`);
    this.walkers = new Walkers(sample);
    if (this.selection?.kind === 'sim') this.select(null);

    // Colour-scale tops, over every box of this rung (and walk).
    const rate = this.deps.boxes.formation_rate[this.view.rung];
    const chance = this.deps.boxes.found_chance[this.view.walk];
    let r = 0;
    let rf = 0;
    for (let k = 0; k < rate.length; k++) {
      const v = rate[k];
      if (v == null) continue;
      if (v > r) r = v;
      const c = chance[k];
      if (c != null && v * c > rf) rf = v * c;
    }
    this.rateMax = r || 1;
    this.rateFoundMax = rf || 1;
    const pf = this.deps.finds.predicted_found[this.key];
    this.findsMax = pf ? Math.max(...pf.predicted, 0.01) : 1;
    // The difference scale saturates at the 95th percentile of |real - predicted|, so a
    // few very rich districts do not wash every other place out to the middle colour.
    if (pf) {
      const d = pf.predicted.map((p, i) => Math.abs(pf.real[i] - p)).sort((a, b) => a - b);
      this.diffMax = Math.max(1, d[Math.floor(0.95 * (d.length - 1))]);
    } else this.diffMax = 1;

    const ix = this.deps.index;
    this.charts.setData({
      walkers: this.walkers,
      factors: this.deps.walkers.factors,
      extentKm: ix.extent_km,
      formationDepthKm: ix.formation_depth_km,
      binsStart: ix.bins_start_ma,
      binMyr: ix.bin_myr,
      curve: ix.curves[this.key] ?? null,
      title: `rung ${this.view.rung}; ${this.view.walk}`,
    });
    this.rebuildFinds();
    this.applyAge(this.view.age);
    this.setCaption();
  }

  // --- time ----------------------------------------------------------------------------

  applyAge(age: number): void {
    this.view.age = age;
    this.ui.setAge(age);
    // At exactly 0 Ma the archive's Merdith 2021 coastlines include features whose
    // appear age is 0, and in a flat map their land fill smears into horizontal bands
    // (the deposit viewer shows the same). 0.001 Ma is the same map without them.
    this.coastlines?.setAge(Math.max(age, COAST_MIN_AGE));
    this.realLayer.setTime(age);
    this.rebuildFormation();
    this.rebuildSims();
    this.charts.setAge(age);
    this.afterChange();
  }

  private afterChange(): void {
    this.applyVisibility();
    this.refreshHighlight();
    this.refreshPopup();
    this.refreshLegend();
    this.onNeedsRender();
  }

  private applyLayers(): void {
    if (this.coastlines) this.coastlines.lines.visible = this.coastlines.land.visible = this.view.coastlines;
    this.graticule.lines.visible = this.view.graticule;
    this.rebuildFormation();
    this.rebuildSims();
    this.rebuildFinds();
    this.afterChange();
  }

  /** At 0 Ma the predicted finds, when on, take the place of the formation map: both
   *  sit on the same places. */
  private get findsShown(): boolean { return this.view.finds && this.view.age < 0.5; }

  private applyVisibility(): void {
    this.formationLayer.visible = this.view.formation && !this.findsShown;
    this.findsLayer.visible = this.findsShown;
    this.simLayer.visible = this.view.simulated;
    this.realLayer.visible = this.view.real;
  }

  // --- the point sets --------------------------------------------------------------------

  /** A petrify points.json for points already placed at this age: the 'trajectory'
   *  transport with the same positions at both ends, drawn whatever their age. */
  private staticPayload(points: Array<Record<string, unknown>>): PointsPayload {
    const lon = points.map((p) => p.lon as number);
    const lat = points.map((p) => p.lat as number);
    return { transport: 'trajectory', times: [0, 1], frames: { 0: [lon, lat], 1: [lon, lat] }, points };
  }

  private load(layer: PointOverlay, points: Array<Record<string, unknown>>, style: PointStyleHook, size = 3): void {
    layer.loadData(this.staticPayload(points), { lifespan: 'always', keyline: 'rgba(8, 10, 14, 0.85)', size, ...RING });
    layer.setTime(0);
    layer.setStyle(style);
  }

  private rebuildFormation(): void {
    const b = this.boxes;
    const s = b.snapshotAt(this.view.age);
    const pts: Array<Record<string, unknown>> = [];
    this.formationIdx = [];
    const rate = this.deps.boxes.formation_rate[this.view.rung];
    const chance = this.deps.boxes.found_chance[this.view.walk];
    if (s >= 0) {
      // Zero-rate boxes first, so the forming ones are drawn on top.
      const order: number[] = [];
      for (let p = 0; p < b.nPlaces; p++) if (b.position(p, s)) order.push(p);
      order.sort((p, q) => (b.at(rate, p, s) ?? 0) - (b.at(rate, q, s) ?? 0));
      for (const p of order) {
        const [lon, lat] = b.position(p, s)!;
        pts.push({ lon, lat, rate: b.at(rate, p, s), chance: b.at(chance, p, s) });
        this.formationIdx.push(p);
      }
    }
    const cm = this.deps.colormaps.plasma.colors;
    this.load(this.formationLayer, pts, (p) => {
      const r = (p.rate as number | null) ?? 0;
      const c = (p.chance as number | null) ?? 0;
      if (r <= 0) return { symbol: 'square', fill: NO_FORMATION, size: 1.6 };
      // Log scales: rung 1c's rate falls about tenfold per tenfold distance, and the
      // found chance falls steeply with age. Rungs 0-1a-1b are on/off, so this is 1 there.
      const t = this.view.formationColour === 'rate'
        ? 1 + Math.log10(Math.max(1e-12, r / this.rateMax)) / DECADES
        : 1 + Math.log10(Math.max(1e-12, (r * c) / this.rateFoundMax)) / DECADES;
      // Translucent, and stopping short of plasma's yellow, so the simulated and real
      // porphyries on top stay readable over a continent full of forming places.
      return { symbol: 'square', fill: ramp(cm, RATE_LO + (RATE_HI - RATE_LO) * clamp01(t), 0.75), size: 2.4 };
    }, 2.4);
  }

  private rebuildSims(): void {
    const w = this.walkers;
    const t = this.view.age;
    const b = this.boxes;
    const s = b.snapshotAt(t);
    const live: number[] = [];
    for (let i = 0; i < w.n; i++) if (w.exists(i, t) && b.position(w.s.place[i], s)) live.push(i);
    // Eroded-to-be under still-buried under found-today, so the rare finds show.
    const order = [ERODED, BURIED, FOUND];
    live.sort((a, c) => order.indexOf(w.s.fate[a]) - order.indexOf(w.s.fate[c]));
    this.simIdx = live;
    const pts = live.map((i) => {
      const [lon, lat] = b.position(w.s.place[i], s)!;
      return { lon, lat, w: i, depth: w.depthAt(i, t), fate: w.s.fate[i] };
    });
    const rd = this.deps.colormaps.RdBu.colors;
    const ext = this.deps.index.extent_km;
    this.load(this.simLayer, pts, (p) => {
      if (this.view.simColour === 'fate') return { symbol: 'circle', fill: FATE_COLOUR[p.fate as number], size: 3.2 };
      return { symbol: 'circle', fill: ramp(rd, depthT(p.depth as number, ext)), size: 3.2 };
    }, 3.2);
  }

  private rebuildFinds(): void {
    const pf = this.deps.finds.predicted_found[this.key];
    const places = this.deps.boxes.places;
    this.findsIdx = [];
    const pts: Array<Record<string, unknown>> = [];
    if (pf) {
      // Smallest first, so the places predicted to hold most are drawn on top.
      const order = pf.place.map((_, k) => k).sort((a, c) => pf.predicted[a] - pf.predicted[c]);
      for (const k of order) {
        const p = pf.place[k];
        pts.push({ lon: places.lon[p], lat: places.lat[p], predicted: pf.predicted[k], real: pf.real[k] });
        this.findsIdx.push(p);
      }
    }
    const vir = this.deps.colormaps.viridis.colors;
    const rd = this.deps.colormaps.RdBu.colors;
    this.load(this.findsLayer, pts, (p) => {
      const pr = p.predicted as number;
      const re = p.real as number;
      if (this.view.findsColour === 'difference') {
        // Red: fewer found than predicted; blue: more found than predicted.
        return { symbol: 'circle', fill: diverge(rd, clampSym((re - pr) / this.diffMax)), size: 3.4 };
      }
      const tt = 1 + Math.log10(Math.max(1e-6, pr / this.findsMax)) / DECADES;
      return { symbol: 'circle', fill: ramp(vir, clamp01(tt)), size: 3.4 };
    }, 3.4);
  }

  /** The lowest non-zero rate of this rung over every box (the rate ramp's low end). */
  private minPositiveRate(): number {
    let m = Infinity;
    for (const v of this.deps.boxes.formation_rate[this.view.rung]) if (v != null && v > 0 && v < m) m = v;
    return Number.isFinite(m) ? m : 0;
  }

  // --- legend and caption --------------------------------------------------------------

  private refreshLegend(): void {
    const v = this.view;
    const age = `${Math.round(v.age)} Ma`;
    const blocks: LegendBlock[] = [];
    const ix = this.deps.index;
    const ext = ix.extent_km;

    if (this.findsShown) {
      const pf = this.deps.finds.predicted_found[this.key];
      const totP = pf ? pf.predicted.reduce((a, b) => a + b, 0) : 0;
      const totR = pf ? pf.real.reduce((a, b) => a + b, 0) : 0;
      blocks.push(v.findsColour === 'predicted'
        ? {
          title: 'Porphyries predicted to be found today, per place',
          ramp: { css: rampCss(this.deps.colormaps.viridis.colors), lo: fmtN(this.findsMax / 10 ** DECADES), hi: fmtN(this.findsMax) },
          note: `Per place, scaled to the ${totR} real porphyries (sum ${fmtN(totP)}); log scale. Shown at 0 Ma in `
            + 'place of the formation map.',
        }
        : {
          title: 'Real minus predicted porphyries found today, per place',
          ramp: { css: divergeCss(this.deps.colormaps.RdBu.colors), lo: `${fmtN(-this.diffMax)} fewer`, mid: '0', hi: `${fmtN(this.diffMax)} more` },
          note: `Blue: more real porphyries than predicted; red: fewer; grey: as predicted. Saturates at ±${fmtN(this.diffMax)} (95% of places).`,
        });
    } else if (v.formation) {
      const n = this.formationIdx.length;
      const forming = (this.formationLayer.payload()?.points ?? []).filter((p) => ((p.rate as number) ?? 0) > 0).length;
      const graded = v.rung.startsWith('1c');
      blocks.push(v.formationColour === 'rate' && !graded
        ? {
          title: `Where porphyries form at ${age}`,
          rows: [
            { label: 'forming (the same rate everywhere it is allowed)', fill: ramp(this.deps.colormaps.plasma.colors, RATE_HI, 0.75), count: `${forming}` },
            ...(n > forming ? [{ label: 'none forming', fill: NO_FORMATION, count: `${n - forming}` }] : []),
          ],
          note: 'A square is a place (~290 km) where it was then.',
        }
        : v.formationColour === 'rate'
        ? {
          title: `Where porphyries form at ${age}: rate per area`,
          rows: n > forming ? [{ label: 'none forming', fill: NO_FORMATION, count: `${n - forming}` }] : [],
          ramp: { css: rampCss(this.deps.colormaps.plasma.colors, RATE_LO, RATE_HI), lo: `${fmtN(Math.max(this.minPositiveRate(), this.rateMax / 10 ** DECADES))} or less`, hi: `${fmtN(this.rateMax)}` },
          note: 'Relative to a place at a subduction zone (1); log scale. A square is a place (~290 km) '
            + 'where it was then.',
        }
        : {
          title: `Forming at ${age} and found today`,
          rows: n > forming ? [{ label: 'none forming', fill: NO_FORMATION, count: `${n - forming}` }] : [],
          ramp: { css: rampCss(this.deps.colormaps.plasma.colors, RATE_LO, RATE_HI), lo: fmtN(this.rateFoundMax / 10 ** DECADES), hi: fmtN(this.rateFoundMax) },
          note: 'Formation rate x chance of being found today. Log scale, fixed across ages.',
        });
    }

    if (v.simulated) {
      const w = this.walkers;
      const byFate = [0, 0, 0];
      for (const i of this.simIdx) byFate[w.s.fate[i]]++;
      const formed = this.simIdx.length;
      const total = w.n;
      const title = `Simulated porphyries present at ${age}: ${formed} of ${total}`;
      if (v.simColour === 'fate') {
        blocks.push({
          title, rows: [0, 1, 2].map((f) => ({ label: FATE_LABEL[f], fill: FATE_COLOUR[f], count: String(byFate[f]) })),
          note: 'Formed by now, not yet eroded through. Fate: what happens to each by today.',
        });
      } else {
        blocks.push({
          title,
          ramp: { css: depthRampCss(this.deps.colormaps.RdBu.colors, ext), lo: `${ext} km above`, mid: 'surface', hi: `${DEEP_KM}+ km deep` },
          note: `Depth of the top now. Red: above the surface, being eroded; blue: buried. Later: `
            + `${byFate[FOUND]} found, ${byFate[BURIED]} buried, ${byFate[ERODED]} eroded.`,
        });
      }
    }

    if (v.real) {
      let n = 0;
      const pts = this.realPayload.points;
      for (let i = 0; i < pts.length; i++) if (this.realLayer.isLive(i)) n++;
      blocks.push({
        title: `Real porphyries formed by ${age}`,
        rows: [{ label: 'porphyry Cu (Hoggard et al. 2020)', fill: REAL_FILL, count: `${n} / ${pts.length}` }],
      });
    }
    this.ui.setLegend(blocks);
  }

  private setCaption(): void {
    const ix = this.deps.index;
    const b = ix.built_from;
    const rung = ix.rungs.find((r) => r.id === this.view.rung);
    const lines = [
      `Rung ${this.view.rung}; walk: ${this.view.walk}. Merdith 2021 plate model. Click anything for its values.`,
      'Simulated porphyries and the formation squares sit where their place was in the box covering each age; '
        + 'real porphyries move with the plate the analysis gave them, as in the deposit viewer.',
    ];
    if (rung && this.view.rung.startsWith('1c')) {
      const bw = rung.b_per_log_km[this.view.walk];
      const from = ix.formation_rate_walk;
      lines.push(`Rung 1c rate falls with distance to a subduction zone as (distance + 10 km)^b, b = ${bw?.toFixed(2)} `
        + `for this walk.${from && from !== this.view.walk
          ? ` The squares use RiftsClimate's map, made with b from ${from} (${rung.b_per_log_km[from]?.toFixed(2)}).` : ''}`);
    }
    lines.push(`Values from RiftsClimate ${b.riftsclimate_commit ?? '?'} (${b.script}, ${b.script_state}), `
      + `written ${b.data_written}.`);
    this.ui.setCaption(lines);
  }

  // --- picking -------------------------------------------------------------------------

  /** Topmost first. */
  private pickable(): Array<{ kind: Kind; layer: PointOverlay; fan: boolean }> {
    const out: Array<{ kind: Kind; layer: PointOverlay; fan: boolean }> = [];
    if (this.realLayer.visible) out.push({ kind: 'real', layer: this.realLayer, fan: true });
    if (this.simLayer.visible) out.push({ kind: 'sim', layer: this.simLayer, fan: true });
    if (this.findsLayer.visible) out.push({ kind: 'place', layer: this.findsLayer, fan: false });
    if (this.formationLayer.visible) out.push({ kind: 'box', layer: this.formationLayer, fan: false });
    return out;
  }

  private idOf(kind: Kind, index: number): number | string {
    if (kind === 'sim') return this.simIdx[index];
    if (kind === 'box') return this.formationIdx[index];
    if (kind === 'place') return this.findsIdx[index];
    return this.realPayload.points[index].deposit_id as string;
  }

  clickAt(x: number, y: number): void {
    for (const { kind, layer, fan } of this.pickable()) {
      const picked = layer.pick(x, y);
      if (!picked) continue;
      const open = layer.spiderfied;
      const onFan = !!(open && open.includes(picked.index));
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
    for (const { kind, layer } of this.pickable()) {
      const picked = layer.pick(x, y);
      if (!picked) continue;
      const id = this.idOf(kind, picked.index);
      const lines = this.describe({ kind, id }).slice(0, 3)
        .map((l) => (typeof l === 'string' ? l : l.text));
      const pile = layer.clusterSizeAt(x, y);
      if (pile >= 2 && kind !== 'box' && kind !== 'place') lines.push(`${pile} here: click to spread them out`);
      this.ui.showTooltip(x, y, [this.titleOf({ kind, id }), ...lines]);
      return;
    }
    this.ui.hideTooltip();
  }

  hoverOut(): void { this.ui.hideTooltip(); }

  private select(sel: Selection | null): void {
    this.selection = sel;
    this.charts.setSelected(sel?.kind === 'sim' ? (sel.id as number) : null);
    if (!sel) hideSamplePopup();
  }

  private refreshHighlight(): void {
    const s = this.selection;
    const find = (arr: Array<number | string>, id: number | string | undefined) => {
      const k = id === undefined ? -1 : arr.indexOf(id);
      return k >= 0 ? k : null;
    };
    this.simLayer.highlight(s?.kind === 'sim' ? find(this.simIdx, s.id) : null);
    this.formationLayer.highlight(s?.kind === 'box' ? find(this.formationIdx, s.id) : null);
    this.findsLayer.highlight(s?.kind === 'place' ? find(this.findsIdx, s.id) : null);
    this.realLayer.highlight(s?.kind === 'real'
      ? find(this.realPayload.points.map((p) => p.deposit_id as string), s.id) : null);
  }

  private refreshPopup(): void {
    const s = this.selection;
    if (!s) return;
    showInfoPopup(this.titleOf(s), this.describe(s), () => {
      this.select(null);
      this.refreshHighlight();
      this.onNeedsRender();
    });
  }

  private titleOf(s: Selection): string {
    const places = this.deps.boxes.places;
    if (s.kind === 'sim') return `Simulated porphyry ${(s.id as number) + 1}`;
    if (s.kind === 'box') return `Place ${places.id[s.id as number]} (${places.region[s.id as number]}) at ${Math.round(this.view.age)} Ma`;
    if (s.kind === 'place') return `Place ${places.id[s.id as number]} (${places.region[s.id as number]}) today`;
    const row = this.realRow.get(s.id as string);
    const name = row !== undefined ? this.deps.finds.porphyries.name[row] : '';
    return name || (s.id as string);
  }

  /** The popup's lines: values only, as RiftsClimate wrote them. */
  private describe(s: Selection): Array<string | PopupLine> {
    const v = this.view;
    const t = v.age;
    const b = this.boxes;
    const places = this.deps.boxes.places;
    const ext = this.deps.index.extent_km;
    if (s.kind === 'sim') {
      const w = this.walkers;
      const i = s.id as number;
      const p = w.s.place[i];
      const fate = w.s.fate[i];
      const e = w.erodedAt[i];
      const out: Array<string | PopupLine> = [
        `Formed ${w.s.age_ma[i].toFixed(1)} Ma at place ${places.id[p]} (${places.region[p]})`,
        `Top of the body ${fmtDepth(w.s.depth_km[i][0])} when it formed`,
      ];
      if (w.exists(i, t)) {
        const d = w.depthAt(i, t);
        out.push({ text: `At ${Math.round(t)} Ma: top ${fmtDepth(d)}${d <= 0 ? ' (within reach, being eroded)' : ''}`, color: '#e6ebf0' });
      } else {
        out.push({ text: t > w.s.age_ma[i] ? `Not yet formed at ${Math.round(t)} Ma` : `Eroded through before ${Math.round(t)} Ma`, color: '#9aa2ab' });
      }
      out.push({
        text: fate === ERODED ? `Fate: eroded through at ${e!.toFixed(0)} Ma (top ${ext} km above the surface)`
          : fate === FOUND ? `Fate: found today (top ${fmtDepth(w.depthToday(i))})`
            : `Fate: still buried today (top ${fmtDepth(w.depthToday(i))})`,
        swatch: FATE_COLOUR[fate],
      });
      out.push({ text: `Rung ${v.rung}; ${v.walk}`, color: '#8a929b' });
      return out;
    }
    if (s.kind === 'box') {
      const p = s.id as number;
      const sn = b.snapshotAt(t);
      const pos = b.position(p, sn);
      if (!pos) return [{ text: `No box for this place at ${Math.round(t)} Ma`, color: '#9aa2ab' }];
      const sk = b.at(this.deps.boxes.subduction_km, p, sn);
      const r = b.at(this.deps.boxes.formation_rate[v.rung], p, sn);
      const c = b.at(this.deps.boxes.found_chance[v.walk], p, sn);
      const snaps = this.deps.boxes.snapshots;
      return [
        `Snapshot ${snaps.snapshot_ma[sn]} Ma (covers ${snaps.from_ma[sn]}-${snaps.to_ma[sn]} Ma)`,
        `Where it was: ${fmtLonLat(pos[0], pos[1])} (Merdith 2021)`,
        `Distance to a subduction zone: ${sk == null ? 'none known' : `${Math.round(sk).toLocaleString()} km`}`,
        { text: `Formation rate, rung ${v.rung}: ${r == null ? '-' : fmtN(r)}`, color: '#e6ebf0' },
        `Chance a porphyry formed here then is found today (${v.walk}): ${c == null ? '-' : `${(c * 100).toFixed(2)}%`}`,
        `Present-day position ${fmtLonLat(places.lon[p], places.lat[p])}`,
      ];
    }
    if (s.kind === 'place') {
      const p = s.id as number;
      const pf = this.deps.finds.predicted_found[this.key];
      const k = pf ? pf.place.indexOf(p) : -1;
      return [
        { text: `Predicted found today: ${k >= 0 ? fmtN(pf.predicted[k]) : '0'}`, color: '#e6ebf0' },
        `Real porphyries here: ${k >= 0 ? pf.real[k] : 0}`,
        `Position ${fmtLonLat(places.lon[p], places.lat[p])}`,
        { text: `Rung ${v.rung}; ${v.walk}`, color: '#8a929b' },
      ];
    }
    const row = this.realRow.get(s.id as string)!;
    const f = this.deps.finds.porphyries;
    const sk = f.subduction_km[row];
    const p = f.place[row];
    return [
      `Porphyry Cu, ${f.age_ma[row]} Ma`,
      `Distance to a subduction zone when it formed: ${sk == null ? 'none known' : `${Math.round(sk).toLocaleString()} km`}`,
      `Where it formed: ${fmtLonLat(f.m_lon[row] ?? NaN, f.m_lat[row] ?? NaN)} (Merdith 2021)`,
      `Today: ${fmtLonLat(f.lon[row], f.lat[row])}, nearest place ${places.id[p]} (${places.region[p]})`,
      { text: s.id as string, color: '#8a929b' },
    ];
  }

  // --- projection and frame --------------------------------------------------------------

  private get overlays(): PointOverlay[] {
    return [this.formationLayer, this.findsLayer, this.simLayer, this.realLayer];
  }

  setProjection(mode: ProjectionMode): void {
    this.view.projection = mode;
    const camera = this.deps.rebuildCamera(mode);
    this.camera = camera;
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
    const lon = this.centreLongitude;
    this.ui.setMapHint(flat ? `Map centred on ${Math.abs(lon).toFixed(0)}°${lon < 0 ? 'W' : 'E'} · drag sideways to turn it` : '');
  }

  setCameraAspect(camera: Camera): void {
    this.camera = camera;
    for (const o of this.overlays) o.setCamera(camera, this.view.projection);
  }

  /** The map's rectangle: the window left of the charts panel. */
  resize(rect: Rect): void {
    this.rect = rect;
    for (const o of this.overlays) o.setRect(rect);
    this.ui.setRightInset(innerWidth - rect.width);
    this.charts.redraw();
  }

  get mapRect(): Rect { return this.rect; }

  get animating(): boolean {
    return this.overlays.some((o) => o.isAnimating());
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    for (const o of this.overlays) o.draw();
  }
}

// --- colour helpers ------------------------------------------------------------------------

function clamp01(t: number): number { return Math.max(0, Math.min(1, t)); }
function clampSym(t: number): number { return Math.max(-1, Math.min(1, t)); }

function ramp(colors: [number, number, number][], t: number, alpha = 1): string {
  const [r, g, b] = colors[Math.round(clamp01(t) * (colors.length - 1))];
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

/** Depth to a position on RdBu: red half above the surface (to the erosion line), blue
 *  half below it (to DEEP_KM); the surface is the neutral middle. */
function depthT(d: number, extentKm: number): number {
  // A step at the surface (no near-white middle): a top at or above the surface is
  // always a clear red, a buried one always a clear blue.
  return d <= 0 ? 0.38 - 0.38 * clamp01(-d / extentKm) : 0.62 + 0.38 * clamp01(d / DEEP_KM);
}

/** Two-sided colour for a signed value s in [-1, 1]: neutral grey at 0, towards RdBu's
 *  red (negative) or blue (positive) ends. */
function diverge(colors: [number, number, number][], s: number): string {
  const g = [128, 136, 146];
  const end = s < 0 ? colors[Math.round(0.08 * (colors.length - 1))] : colors[Math.round(0.92 * (colors.length - 1))];
  const f = clamp01(Math.abs(s));
  const c = g.map((v, k) => Math.round(v + (end[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function divergeCss(colors: [number, number, number][]): string {
  const stops = [];
  for (let i = 0; i <= 8; i++) stops.push(`${diverge(colors, i / 4 - 1)} ${(i / 8) * 100}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function rampCss(colors: [number, number, number][], from = 0, to = 1): string {
  const stops = [];
  for (let i = 0; i <= 8; i++) {
    const t = from + (to - from) * (i / 8);
    stops.push(`${ramp(colors, t)} ${(i / 8) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** The depth legend: the surface sits in the middle of the bar, as on the map's scale. */
function depthRampCss(colors: [number, number, number][], extentKm: number): string {
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const d = i <= 5 ? -extentKm * (1 - i / 5) : DEEP_KM * ((i - 5) / 5);
    stops.push(`${ramp(colors, depthT(d, extentKm))} ${i * 10}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function fmtN(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toPrecision(2);
}

function fmtLonLat(lon: number, lat: number): string {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '-';
  return `${Math.abs(lat).toFixed(1)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}`;
}
