import {
  Color, FrontSide, Mesh, MeshBasicMaterial, Scene, Vector3,
  type Camera, type Data3DTexture, type Material, type WebGLRenderer,
} from 'three';

import { PointOverlay, type PointStyleHook, type PointsPayload } from '../core/pointOverlay';
import { Coastlines, LAND_R_UNDER_SURFACE, fetchCoastlineData, parseGeometry } from '../core/coastlines';
import { R_SURFACE } from '../core/constants';
import { createMaskTexture } from '../core/mask';
import { DepthSlice } from '../core/depthSlice';
import { Graticule } from '../core/graticule';
import {
  lonLatFromGeoVec, orientationQuaternion, rotateVector, toRenderFrameRotation, type Quaternion,
} from '../core/rotation';
import {
  PROJECTION_UNIFORM, createSurfaceGeometry, isFlat, type ProjectionMode,
} from '../core/projection';
import {
  createFlatBackdropMaterial, passthroughColor, setMaskMode, setNoDataSentinel, setNoDataStyle,
} from '../core/material';
import {
  FrameCache, fetchVolumeBytes, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import type { ArchiveIndex, ColormapData, Manifest, RotationTable, VariableInfo } from '../core/types';
import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';

import { DepositPanel, fmt } from './depositPanel';
import { RiftLines } from './riftLines';
import { RiftsUI, type LegendRow } from './riftsclimateUi';
import type {
  DepositPoint, DepositValues, FieldCatalogue, FieldDef, RiftsIndex, RiftsModel, RiftsViewState,
} from './types';

const LAND_FILL_COLOR = 0x5f5a52;
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);
const BACKDROP_COLOR = 0x16202b;
/** The deformation layer sits just above a climate raster, like climate.html's
 *  shaded-relief overlay (same radius), so both can be on at once. */
const OVERLAY_R = R_SURFACE * 1.0006;
/** BRIDGE's Monthly layer index 12 is the model's own annual mean
 *  (prep_bridge.py ANNUAL_LAYER); depth_min 0 km, one km per layer. */
const ANNUAL_LAYER_KM = 12;

/** Deposit classes: fill, symbol and size. PbZn-CD, the project's primary
 *  target, is drawn slightly larger so it is findable among 1400 deposits. */
const CLASS_STYLE: Record<string, { fill: string; symbol: string; size: number }> = {
  'PbZn-CD': { fill: '#ff5a36', symbol: 'hexagon', size: 4.6 },
  'PbZn-MVT': { fill: '#f6c945', symbol: 'diamond', size: 3.8 },
  'Cu-sed': { fill: '#3fcf8e', symbol: 'square', size: 3.4 },
  'Magmatic Ni': { fill: '#c792ff', symbol: 'triangle', size: 4.2 },
  VMS: { fill: '#58a6ff', symbol: 'circle', size: 3.0 },
  'Cu-por': { fill: '#d9dde3', symbol: 'circle', size: 2.8 },
  IOCG: { fill: '#ff9ecf', symbol: 'triangle-down', size: 3.8 },
};
const NO_VALUE_FILL = 'rgba(120, 124, 130, 0.55)';

const SPIDERFY_DWELL_MS = 150;
const SPIDERFY_KEEP_PADDING = 26;

export interface RiftsDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  index: RiftsIndex;
  catalogue: FieldCatalogue;
  values: DepositValues;
  rebuildCamera(mode: ProjectionMode): Camera;
}

/**
 * One globe showing the RiftsClimate deposits and the model inputs behind
 * them, all in ONE plate model at a time.
 *
 * Switching plate model swaps the deposits' reconstruction, the coastlines,
 * the deformation grids, and which of climate (Scotese only) and the Jackson &
 * MacDonald margins (Merdith 2021 only) exist at all -- one decision, not five
 * (ADR-0057, building on ADR-0034's "the model follows the dataset").
 */
export class RiftsInstance {
  readonly scene = new Scene();
  readonly ui: RiftsUI;
  readonly panel: DepositPanel;

  private readonly climate = new DepthSlice();
  private readonly deformation = new DepthSlice(OVERLAY_R);
  private readonly backdrop: Mesh;
  private readonly graticule = new Graticule();
  /** Map Orientation (CONTEXT.md): in a flat Projection, which longitude sits
   *  in the middle of the map. A pure turn about the pole, so the equator
   *  never tilts; identity (0 deg E) by default. Geographic frame. */
  private qOrient: Quaternion = [0, 0, 0, 1];
  private coastlines: Coastlines | null = null;
  private readonly rifts: RiftLines;
  /** Continent polygon outlines, under the margins. */
  private readonly outlines: RiftLines;
  private readonly points: PointOverlay;
  private payload: PointsPayload | null = null;

  private readonly frames: FrameCache;
  private readonly defFrames: FrameCache;
  private climateManifest: Manifest | null = null;
  private deformationManifest: Manifest | null = null;
  private climateToken = 0;
  private deformationToken = 0;
  private loadToken = 0;
  private climateFrameAge: number | null = null;
  private deformationFrameAge: number | null = null;

  private selected: number | null = null;
  private hovered: number | null = null;
  private dwell: ReturnType<typeof setTimeout> | null = null;
  private fanAnchor: [number, number] | null = null;
  private fanReach = 0;

  private readonly fieldByKey = new Map<string, FieldDef>();
  private readonly valueRow = new Map<string, number>();

  readonly view: RiftsViewState;

  get model(): RiftsModel {
    return this.deps.index.models.find((m) => m.id === this.view.model) ?? this.deps.index.models[0];
  }

  constructor(
    private camera: Camera,
    private readonly deps: RiftsDeps,
    private readonly onNeedsRender: () => void,
  ) {
    this.frames = new FrameCache(deps.archiveBase);
    // Deformation Models live under archive/riftsclimate/models/<id>/, so they
    // stay out of archive.json's catalogue and out of other viewers.
    this.defFrames = new FrameCache(`${deps.archiveBase}/riftsclimate`);
    for (const f of deps.catalogue.fields) this.fieldByKey.set(f.key, f);
    deps.values.ids.forEach((id, i) => this.valueRow.set(id, i));

    this.scene.add(this.climate.mesh, this.deformation.mesh);
    this.backdrop = new Mesh(
      createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR }),
    );
    this.scene.add(this.backdrop, this.graticule.lines);
    // Outlines, then margins, then deposits: each canvas sits above the last.
    this.outlines = new RiftLines(camera, 1.3);
    this.rifts = new RiftLines(camera);
    this.points = new PointOverlay(camera);

    const classes: Record<string, boolean> = {};
    for (const c of deps.index.classes) classes[c.id] = true;
    this.view = {
      model: deps.index.models[0].id, age: 0, projection: 'globe',
      coastlines: true, graticule: true, climate: 'none', deformation: 'none', rifts: {}, polygons: {},
      colourBy: 'class', lifespan: 'since', window: 10, classes,
    };

    const colourFields = deps.catalogue.fields.filter((f) =>
      f.kind === 'num' && !f.parent && !/placement/i.test(f.group));
    this.ui = new RiftsUI(this.view, {
      onModel: () => void this.loadModel(),
      onAge: (age) => this.applyAge(age),
      onGraticule: (on) => { this.graticule.lines.visible = on; this.onNeedsRender(); },
      onCoastlines: (on) => { if (this.coastlines) this.coastlines.lines.visible = this.coastlines.land.visible = on; this.onNeedsRender(); },
      onClimate: () => { void this.loadClimateFrame(); this.refreshLegend(); },
      onDeformation: () => { void this.loadDeformationFrame(); this.refreshLegend(); },
      onRift: (phase, on) => {
        this.rifts.setVisible(phase, on);
        this.refreshLegend();
        this.onNeedsRender();
      },
      onPolygon: (group, on) => {
        this.outlines.setVisible(group, on);
        this.refreshLegend();
        this.onNeedsRender();
      },
      onColourBy: () => { this.restyle(); },
      onLifespan: () => {
        this.points.setLifespan(this.view.lifespan, this.view.window);
        this.afterPointsChanged();
      },
      onClass: (cls, on) => { this.points.setTypeVisible(cls, on); this.afterPointsChanged(); },
    }, deps.index.models, deps.index.classes, colourFields);

    this.panel = new DepositPanel({
      catalogue: deps.catalogue,
      values: deps.values,
      classColour: (c) => CLASS_STYLE[c]?.fill ?? '#cccccc',
      classLabel: (c) => deps.index.classes.find((x) => x.id === c)?.label ?? c,
      onClose: () => { this.selected = null; this.points.highlight(this.hovered); this.ui.setRightInset(0); this.onNeedsRender(); },
    });
  }

  async boot(): Promise<void> {
    await this.loadModel();
  }

  // --- the plate model: everything swaps together ------------------------------

  private async loadModel(): Promise<void> {
    const token = ++this.loadToken;
    const m = this.model;
    this.ui.setStatus(`loading ${m.label} ...`);
    this.ui.setModel(m);
    if (this.view.age > m.age_max) this.view.age = m.age_max;
    if (!m.climate_model) this.view.climate = 'none';
    if (!m.deformation) this.view.deformation = 'none';
    this.ui.refreshDisplay();

    const base = this.deps.archiveBase;
    const [coast, rifts, outlines, payload, climateManifest, deformationManifest] = await Promise.all([
      this.fetchCoastlines(m),
      Promise.all((m.rifts ?? []).map(async (p) => ({
        p, data: await fetchCoastlineData(base, p.geometry, p.rotations),
      }))),
      Promise.all((m.polygons ?? []).map(async (p) => ({
        p, data: await fetchCoastlineData(base, p.geometry, p.rotations),
      }))),
      fetchMaybeGzippedJSON(`${base}/${m.points}`) as Promise<PointsPayload>,
      m.climate_model ? loadManifest(base, m.climate_model) : Promise.resolve(null),
      m.deformation ? loadManifest(base, m.deformation.path) : Promise.resolve(null),
    ]);
    if (token !== this.loadToken) return;

    // remove() before dispose(): Coastlines.dispose() frees GPU resources but
    // never unparents its meshes (see paleobioInstance.ts).
    if (this.coastlines) {
      this.scene.remove(this.coastlines.lines, this.coastlines.land);
      this.coastlines.dispose();
    }
    this.rifts.clear();
    this.outlines.clear();

    this.coastlines = new Coastlines(coast.lines, coast.table, createMaskTexture(),
      LAND_R_UNDER_SURFACE, LAND_FILL_COLOR);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.setLineColor(0x9aa5b1);
    this.coastlines.setProjection(this.view.projection);
    this.coastlines.setOrientation(this.qOrient);
    this.coastlines.lines.visible = this.coastlines.land.visible = this.view.coastlines;
    this.scene.add(this.coastlines.lines, this.coastlines.land);

    for (const { p, data } of rifts) {
      this.rifts.addPhase(p.id, p.colour, data.lines, data.table, !!this.view.rifts[p.id]);
    }
    for (const { p, data } of outlines) {
      this.outlines.addPhase(p.id, p.colour, data.lines, data.table, !!this.view.polygons[p.id]);
    }

    this.climateManifest = climateManifest;
    this.deformationManifest = deformationManifest;

    this.payload = payload;
    this.points.loadData(payload, {
      lifespan: this.view.lifespan,
      ageWindow: this.view.window,
      keyline: 'rgba(8, 10, 14, 0.85)',
      size: 3.2,
    });
    for (const [cls, on] of Object.entries(this.view.classes)) this.points.setTypeVisible(cls, on);
    this.restyle();

    // Keep the open deposit open under the new model, if it exists there.
    if (this.selected !== null) {
      const id = this.selectedId;
      this.selected = id ? this.indexOf(id) : null;
    }
    this.applyAge(this.view.age);
    this.setCaption();
    this.ui.setStatus('');
    if (this.selected !== null) this.openPanel(this.selected);
  }

  private selectedId: string | null = null;

  private indexOf(id: string): number | null {
    const i = (this.payload?.points ?? []).findIndex((p) => p.deposit_id === id);
    return i >= 0 ? i : null;
  }

  /** The archive's own coastlines for this model (geometry, and its 0-540 Ma
   *  rotations), with the 540-1000 Ma rotations for the same plates appended.
   *  Nothing already in the archive is re-exported. */
  private async fetchCoastlines(m: RiftsModel): Promise<{ lines: ReturnType<typeof parseGeometry>; table: RotationTable }> {
    const base = this.deps.archiveBase;
    const [g, r, x] = await Promise.all([
      fetchVolumeBytes(`${base}/${m.coastlines.geometry}`),
      fetchVolumeBytes(`${base}/${m.coastlines.rotations}`),
      fetchVolumeBytes(`${base}/${m.coastlines.rotations_extension}`),
    ]);
    const lines = parseGeometry(g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength) as ArrayBuffer);
    const head = JSON.parse(new TextDecoder().decode(r)) as RotationTable;
    const tail = JSON.parse(new TextDecoder().decode(x)) as RotationTable;
    return { lines, table: appendRotations(head, tail) };
  }

  // --- time --------------------------------------------------------------------

  applyAge(age: number): void {
    this.view.age = age;
    this.ui.setAge(age);
    this.coastlines?.setAge(age);
    this.rifts.setAge(age);
    this.outlines.setAge(age);
    this.points.setTime(age);
    void this.loadClimateFrame();
    void this.loadDeformationFrame();
    this.afterPointsChanged();
  }

  /** Legend counts and the open panel's "drawn now" line both depend on what
   *  is live, so they are refreshed whenever that can change. */
  private afterPointsChanged(): void {
    this.refreshLegend();
    if (this.selected !== null && this.panel.visible) {
      this.panel.updateStatus({ age: this.view.age, modelLabel: this.model.label, ...this.drawnStatus(this.selected) });
    }
    this.onNeedsRender();
  }

  // --- rasters -----------------------------------------------------------------

  private async loadClimateFrame(): Promise<void> {
    const m = this.climateManifest;
    const token = ++this.climateToken;
    const maxAge = this.model.climate_age_max ?? 0;
    if (!m || this.view.climate === 'none' || this.view.age > maxAge + 0.5) {
      this.climate.mesh.visible = false;
      this.climateFrameAge = null;
      this.refreshBackdrop();
      this.refreshLegend();
      this.onNeedsRender();
      return;
    }
    const variable = m.variables.find((v) => v.id === this.view.climate)!;
    const frame = nearestFrame(m, this.view.age);
    const tex = await this.frames.get(m, variable.id, frame.id);
    if (token !== this.climateToken) return;
    this.paint(this.climate, m, variable, tex);
    this.climate.setDepthKm(ANNUAL_LAYER_KM);
    this.climateFrameAge = frame.age_ma;
    this.refreshBackdrop();
    this.refreshLegend();
    this.onNeedsRender();
  }

  private async loadDeformationFrame(): Promise<void> {
    const m = this.deformationManifest;
    const token = ++this.deformationToken;
    if (!m || this.view.deformation === 'none') {
      this.deformation.mesh.visible = false;
      this.deformationFrameAge = null;
      this.refreshLegend();
      this.onNeedsRender();
      return;
    }
    const variable = m.variables.find((v) => v.id === this.view.deformation)!;
    const frame = nearestFrame(m, this.view.age);
    if (Math.abs(frame.age_ma - this.view.age) > 1) {
      this.deformation.mesh.visible = false;
      this.deformationFrameAge = null;
      this.onNeedsRender();
      return;
    }
    const tex = await this.defFrames.get(m, variable.id, frame.id);
    if (token !== this.deformationToken) return;
    this.paint(this.deformation, m, variable, tex);
    this.deformation.setDepthKm(0);
    this.deformationFrameAge = frame.age_ma;
    this.refreshLegend();
    this.onNeedsRender();
  }

  private paint(slice: DepthSlice, m: Manifest, v: VariableInfo, tex: Data3DTexture): void {
    const mat = slice.material;
    const cm = this.deps.colormaps[v.default_colormap];
    mat.uniforms.uColormap.value = makeColormapTexture(cm.colors);
    mat.uniforms.uClipLo.value = physicalToEncoded(v, v.default_clip_min);
    mat.uniforms.uClipHi.value = physicalToEncoded(v, v.default_clip_max);
    mat.uniforms.uSteps.value = v.categorical ? (v.class_names?.length ?? 0) : 0;
    setMaskMode(mat, 'none');
    setNoDataStyle(mat, 'transparent');
    setNoDataSentinel(mat, m.no_data_sentinel);
    const res = m.resolutions.find((r) => r.id === m.default_resolution)!;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = m.depth_min_km;
    mat.uniforms.uDepthMax.value = m.depth_max_km;
    slice.mesh.visible = true;
  }

  /** The ocean backdrop is only needed where no climate raster covers the sphere. */
  private refreshBackdrop(): void {
    this.backdrop.visible = !this.climate.mesh.visible;
  }

  // --- deposit symbols ---------------------------------------------------------

  private restyle(): void {
    const key = this.view.colourBy;
    if (key === 'class') {
      this.points.setStyle((p) => CLASS_STYLE[p.type as string] ?? { fill: '#cccccc', symbol: 'circle', size: 3 });
    } else {
      const f = this.fieldByKey.get(key);
      const col = this.deps.values.columns[key];
      const cm = this.deps.colormaps.viridis.colors;
      const lo = f?.dist.edges[0] ?? 0;
      const hi = f?.dist.edges[f.dist.edges.length - 1] ?? 1;
      const hook: PointStyleHook = (p) => {
        const cls = CLASS_STYLE[p.type as string];
        const row = this.valueRow.get(p.deposit_id as string);
        const v = row === undefined ? null : col?.[row] ?? null;
        if (v === null) return { fill: NO_VALUE_FILL, symbol: cls?.symbol ?? 'circle', size: 2.4 };
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        const [r, g, b] = cm[Math.round(t * (cm.length - 1))];
        return { fill: `rgb(${r},${g},${b})`, symbol: cls?.symbol ?? 'circle', size: 3.6 };
      };
      this.points.setStyle(hook);
    }
    this.refreshLegend();
    this.onNeedsRender();
  }

  private liveByClass(): Map<string, number> {
    const out = new Map<string, number>();
    const pts = (this.payload?.points ?? []) as unknown as DepositPoint[];
    pts.forEach((p, i) => { if (this.points.isLive(i)) out.set(p.type, (out.get(p.type) ?? 0) + 1); });
    return out;
  }

  private refreshLegend(): void {
    const blocks: Parameters<RiftsUI['setLegend']>[0] = [];
    const live = this.liveByClass();
    const shown = [...live.values()].reduce((a, b) => a + b, 0);
    const when = this.view.lifespan === 'since'
      ? `formed by ${fmt(this.view.age)} Ma`
      : `forming within ±${this.view.window} Myr of ${fmt(this.view.age)} Ma`;
    if (this.view.colourBy === 'class') {
      blocks.push({
        title: `Deposits ${when}`,
        rows: this.deps.index.classes.map((c): LegendRow => ({
          label: c.label,
          fill: this.view.classes[c.id] ? (CLASS_STYLE[c.id]?.fill ?? '#ccc') : 'transparent',
          count: this.view.classes[c.id] ? `${(live.get(c.id) ?? 0).toLocaleString()} / ${c.n}` : 'off',
        })),
        note: `${shown.toLocaleString()} drawn in ${this.model.label}. Click one for its values.`,
      });
    } else {
      const f = this.fieldByKey.get(this.view.colourBy);
      if (f) {
        blocks.push({
          title: `Deposits ${when}, coloured by`,
          rows: [],
          ramp: {
            css: rampCss(this.deps.colormaps.viridis.colors),
            lo: `${fmt(f.dist.edges[0])}`, hi: `${fmt(f.dist.edges[f.dist.edges.length - 1])} ${f.unit}`,
          },
          note: `${f.label}. Grey, smaller: no value. ${shown.toLocaleString()} drawn.`,
        });
      }
    }

    const cm = this.climateManifest;
    if (this.view.climate !== 'none' && cm) {
      const v = cm.variables.find((x) => x.id === this.view.climate)!;
      const name = this.view.climate === 'P' ? 'Annual rainfall' : 'Annual mean surface temperature';
      blocks.push(this.climateFrameAge === null
        ? { title: `${name} (BRIDGE)`, note: `BRIDGE reaches back to ${this.model.climate_age_max} Ma only; nothing is drawn at ${fmt(this.view.age)} Ma.` }
        : {
          title: `${name} (BRIDGE, ${v.units})`,
          ramp: { css: rampCss(this.deps.colormaps[v.default_colormap].colors), lo: fmt(v.default_clip_min), hi: fmt(v.default_clip_max) },
          note: `Snapshot at ${fmt(this.climateFrameAge)} Ma (the nearest). Valdes et al. 2021.`,
        });
    }
    const dm = this.deformationManifest;
    if (this.view.deformation !== 'none' && dm) {
      const v = dm.variables.find((x) => x.id === this.view.deformation)!;
      if (this.deformationFrameAge === null) {
        blocks.push({ title: 'Deformation (defamation)', note: 'No grid at this age.' });
      } else if (v.categorical) {
        const colors = this.deps.colormaps[v.default_colormap].colors;
        const names = v.class_names ?? [];
        blocks.push({
          title: `Deformation style, ${fmt(this.deformationFrameAge)} Ma (defamation, ${this.model.label})`,
          rows: names.map((n, i) => {
            const [r, g, b] = colors[Math.min(colors.length - 1, Math.floor(((i + 0.5) / names.length) * colors.length))];
            return { label: n.replace(/_/g, ' '), fill: `rgb(${r},${g},${b})` };
          }),
          note: 'Only deforming crust has a value; everywhere else is left clear.',
        });
      } else {
        blocks.push({
          title: `Horizontal divergence, ${fmt(this.deformationFrameAge)} Ma (defamation, ${this.model.label})`,
          ramp: {
            css: rampCss(this.deps.colormaps[v.default_colormap].colors),
            lo: `${v.default_clip_min.toExponential(1)} (squeezing)`, hi: `${v.default_clip_max.toExponential(1)} per s (stretching)`,
          },
          note: 'Red: crust being stretched (extension); blue: squeezed; white: deforming crust that is '
            + 'barely doing either. Only deforming crust has a value. Colours saturate at the 90th '
            + 'percentile of all values.',
        });
      }
    }
    const rows = (this.model.rifts ?? []).filter((p) => this.view.rifts[p.id])
      .map((p) => ({ label: p.label, fill: p.colour }));
    if (rows.length) {
      blocks.push({
        title: 'Jackson & MacDonald margins (Merdith 2021)',
        rows,
        note: 'Each margin is drawn only while it is in that phase.',
      });
    }
    const outlineRows = (this.model.polygons ?? []).filter((p) => this.view.polygons[p.id])
      .map((p) => ({ label: p.label, fill: p.colour }));
    if (outlineRows.length) {
      blocks.push({
        title: `Continent polygons (${this.model.label})`,
        rows: outlineRows,
        note: 'Each outline is drawn from its begin age to its end age. "Original": the begin ages the '
          + 'model ships with. "Extended": the begin age the analysis now uses (RiftsClimate ADR-0004), '
          + 'taken from the other plate model for the same ground, only where the polygon rides on a block '
          + 'the model already has (its plate, or a parent it moves rigidly with, has a polygon then) and '
          + 'brings at least one ore deposit into range. "Could be extended, not used": drawn with the age '
          + 'it would have had; the analysis keeps its original age.',
      });
    }
    this.ui.setLegend(blocks);
  }

  private setCaption(): void {
    const m = this.model;
    const c = m.counts;
    const lines = [
      `${m.label}: deposits, continents${m.deformation ? ', deformation' : ''}`
      + `${m.climate_model ? ', BRIDGE climate' : ''}${m.rifts ? ', Jackson & MacDonald margins' : ''}`
      + ' -- all reconstructed in this one plate model.',
      `${c.drawable_at_own_age.toLocaleString()} of ${c.deposits.toLocaleString()} deposits can be drawn at their own age; `
      + `${c.unassigned} sit on no plate and ${c.older_than_their_plate} are older than their plate's continent polygon`
      + (c.no_rotation_at_own_age ? `; ${c.no_rotation_at_own_age} has no rotation at its age` : '')
      + `. The analysis placed ${c.placed_by_analysis.toLocaleString()} (also at each deposit's own age, `
      + `so ${c.disagree_with_analysis} differ).`,
      m.climate_model
        ? 'Jackson & MacDonald margins carry Merdith 2021 plate IDs, so they are shown only with Merdith 2021.'
        : 'BRIDGE climate was run on Scotese geography, so it is shown only with Scotese.',
      `Continents: ${m.coastlines.name}` + (m.coastlines.plates_fixed_540_1000
        ? `; ${m.coastlines.plates_fixed_540_1000} plate(s) carrying continents older than 540 Ma do not move `
          + 'between 540 and 1000 Ma in the rotation file.'
        : '; every plate carrying continents older than 540 Ma moves in the rotation file from 540 to 1000 Ma.'),
    ];
    const b = this.deps.index.built_from as { commit?: string; commit_dirty?: boolean; built?: string };
    lines.push(`Values from RiftsClimate ${b.commit ?? '?'}${b.commit_dirty ? ' (with uncommitted changes)' : ''}, `
      + `exported ${b.built ?? '?'}.`);
    this.ui.setCaption(lines);
  }

  // --- projection --------------------------------------------------------------

  setProjection(mode: ProjectionMode): void {
    this.view.projection = mode;
    const camera = this.deps.rebuildCamera(mode);
    this.camera = camera;
    this.climate.setProjection(mode);
    this.deformation.setProjection(mode);

    const oldGeom = this.backdrop.geometry;
    const oldMat = this.backdrop.material as Material;
    this.backdrop.geometry = createSurfaceGeometry(mode, BACKDROP_R);
    if (isFlat(mode)) {
      const mat = createFlatBackdropMaterial(BACKDROP_COLOR);
      mat.uniforms.uProjectionMode.value = PROJECTION_UNIFORM[mode];
      // The same ocean colour as the globe's MeshBasicMaterial: this raw shader
      // writes its uniform untouched, so it wants the colour un-converted.
      mat.uniforms.uColor.value = passthroughColor(BACKDROP_COLOR);
      this.backdrop.material = mat;
    } else {
      this.backdrop.material = new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR });
    }
    oldGeom.dispose();
    oldMat.dispose();

    this.coastlines?.setProjection(mode);
    this.graticule.setProjection(mode);
    this.rifts.setCamera(camera, mode);
    this.outlines.setCamera(camera, mode);
    this.points.setCamera(camera, mode);
    this.applyOrientation();
    this.resize();
    this.onNeedsRender();
  }

  get orientation(): Quaternion { return this.qOrient; }

  /** Turn a flat map so that `q` (a Map Orientation, geographic frame) holds.
   *  Every layer moves together: rasters, continents, graticule, margins and
   *  deposits -- and picking, which reads the same projected positions the
   *  deposits were drawn at. */
  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    this.applyOrientation();
    this.onNeedsRender();
  }

  /** Centre the flat map on a longitude (degrees east). */
  setCentreLongitude(lon: number): void {
    this.setOrientation(orientationQuaternion(lon, 0, 0));
  }

  /** The longitude now in the middle of a flat map. */
  get centreLongitude(): number {
    const [x, y, z, w] = this.qOrient;
    // The true point that orientation carries to display (0, 0).
    return lonLatFromGeoVec(rotateVector([-x, -y, -z, w], 1, 0, 0)).lon;
  }

  /** Map Orientation reaches the deposits, margins and rasters only in a flat
   *  Projection: on the globe, OrbitControls turns the view and the data must
   *  stay put (the guard reconstructionInstance.ts's applyReferenceRotation()
   *  documents). Coastlines and the graticule gate this themselves. */
  private applyOrientation(): void {
    const flat = isFlat(this.view.projection);
    const q: Quaternion = flat ? this.qOrient : [0, 0, 0, 1];
    this.coastlines?.setOrientation(this.qOrient);
    this.graticule.setOrientation(this.qOrient);
    this.points.setReferenceRotation(q);
    this.rifts.setOrientation(q);
    this.outlines.setOrientation(q);
    // The raster shader already round-trips a flat map's display (lon, lat)
    // through this rotation (core/material.ts, the Reference Plate path), so a
    // turned map samples BRIDGE and the deformation grids at the right place.
    const r = toRenderFrameRotation(q);
    this.climate.setReferenceRotation(r);
    this.deformation.setReferenceRotation(r);
    const lon = this.centreLongitude;
    this.ui.setMapHint(flat
      ? `Map centred on ${Math.abs(lon).toFixed(0)}°${lon < 0 ? 'W' : 'E'} · drag sideways to turn it`
      : '');
  }

  // --- pointer -----------------------------------------------------------------

  private point(i: number): DepositPoint {
    return (this.payload!.points as unknown as DepositPoint[])[i];
  }

  /** Hover: tooltip, ring, and -- after a short dwell -- fanning a pile of
   *  deposits apart so each can be reached (climate/main.ts's Boucot hover). */
  hoverAt(x: number, y: number): void {
    const picked = this.points.pick(x, y);
    const idx = picked ? picked.index : null;
    this.considerFan(x, y, idx);
    this.hovered = idx;
    this.points.highlight(idx ?? this.selected);
    if (idx !== null) {
      const p = this.point(idx);
      const unc = p.age_uncertainty_ma ? ` ± ${fmt(p.age_uncertainty_ma)}` : '';
      this.ui.showTooltip(x, y, [p.name || p.deposit_id,
        this.deps.index.classes.find((c) => c.id === p.type)?.label ?? p.type,
        `${p.age != null ? fmt(p.age) : '?'}${unc} Ma`]);
    } else {
      this.ui.hideTooltip();
    }
    this.onNeedsRender();
  }

  hoverOut(): void {
    this.closeFan();
    this.hovered = null;
    this.points.highlight(this.selected);
    this.ui.hideTooltip();
    this.onNeedsRender();
  }

  /** Click: a pile opens first (reconstructionInstance.selectSampleAt()'s
   *  rule); a click on a single deposit, or an opened fan's member, selects it. */
  clickAt(x: number, y: number): void {
    const picked = this.points.pick(x, y);
    const fan = this.points.spiderfied;
    const onFan = !!(fan && picked && fan.includes(picked.index));
    if (!onFan && this.points.clusterSizeAt(x, y) >= 2) {
      this.openFan(x, y);
      this.onNeedsRender();
      return;
    }
    if (!picked) return;
    this.ui.hideTooltip();
    this.selected = picked.index;
    this.selectedId = this.point(picked.index).deposit_id;
    this.points.highlight(picked.index);
    this.openPanel(picked.index);
    this.onNeedsRender();
  }

  private openPanel(i: number): void {
    this.panel.show({
      point: this.point(i), modelLabel: this.model.label, age: this.view.age, ...this.drawnStatus(i),
    });
    this.ui.setRightInset(this.panel.root.offsetWidth + 24);
  }

  private drawnStatus(i: number): { drawnNow: boolean; notDrawnReason: string } {
    if (this.points.isLive(i)) return { drawnNow: true, notDrawnReason: '' };
    const p = this.point(i);
    const t = this.view.age;
    let why = 'its class is switched off';
    if (!p.plate_id) why = `it is on no plate in ${this.model.label}, so it can only be shown at the present day`;
    else if (p.plate_begin_age != null && t > p.plate_begin_age) {
      why = `older than its plate's continent polygon, which begins at ${fmt(p.plate_begin_age)} Ma`;
    } else if (p.age != null && this.view.lifespan === 'since' && t > p.age) why = `it had not formed yet`;
    else if (p.age != null && this.view.lifespan === 'window' && Math.abs(t - p.age) > this.view.window) {
      why = `it formed more than ${this.view.window} Myr from this age`;
    } else if (this.view.classes[p.type]) why = 'no rotation for its plate at this age';
    return { drawnNow: false, notDrawnReason: why };
  }

  private considerFan(x: number, y: number, picked: number | null): void {
    if (this.fanAnchor) {
      const members = this.points.spiderfied;
      if (members && picked !== null && members.includes(picked)) return;
      const strayed = Math.hypot(x - this.fanAnchor[0], y - this.fanAnchor[1]) > this.fanReach;
      if (!strayed && picked === null) return;
      this.closeFan();
    }
    this.cancelDwell();
    if (this.points.clusterSizeAt(x, y) < 2) return;
    this.dwell = setTimeout(() => { this.dwell = null; this.openFan(x, y); this.onNeedsRender(); }, SPIDERFY_DWELL_MS);
  }

  private openFan(x: number, y: number): void {
    if (!this.points.spiderfy(x, y)) return;
    this.fanAnchor = [x, y];
    this.fanReach = this.points.spiderExtent() + SPIDERFY_KEEP_PADDING;
  }

  private cancelDwell(): void {
    if (this.dwell !== null) { clearTimeout(this.dwell); this.dwell = null; }
  }

  private closeFan(): void {
    this.cancelDwell();
    if (this.fanAnchor) this.points.unspiderfy();
    this.fanAnchor = null;
  }

  // --- frame -------------------------------------------------------------------

  setCameraAspect(camera: Camera): void {
    this.camera = camera;
    this.rifts.setCamera(camera, this.view.projection);
    this.outlines.setCamera(camera, this.view.projection);
    this.points.setCamera(camera, this.view.projection);
  }

  resize(): void {
    const rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    this.rifts.setRect(rect);
    this.outlines.setRect(rect);
    this.points.setRect(rect);
  }

  get animating(): boolean {
    return this.points.isAnimating();
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.outlines.draw();
    this.rifts.draw();
    this.points.draw();
  }
}

/** Append a later rotation table to an earlier one for the same plates, both
 *  on the same age step, dropping the repeated join age. */
export function appendRotations(head: RotationTable, tail: RotationTable): RotationTable {
  const step = head.ages[1] - head.ages[0];
  const tailStep = tail.ages[1] - tail.ages[0];
  const join = head.ages[head.ages.length - 1];
  if (Math.abs(step - tailStep) > 1e-9 || Math.abs(tail.ages[0] - join) > 1e-9) {
    throw new Error(`rotation tables do not join: ${join} Ma step ${step} vs ${tail.ages[0]} Ma step ${tailStep}`);
  }
  const plates: RotationTable['plates'] = {};
  for (const [pid, series] of Object.entries(head.plates)) {
    const more = tail.plates[pid];
    if (!more) throw new Error(`plate ${pid} has no rotations after ${join} Ma`);
    plates[pid] = series.concat(more.slice(1));
  }
  return { ...head, ages: head.ages.concat(tail.ages.slice(1)), plates };
}

function rampCss(colors: [number, number, number][]): string {
  const stops = [];
  for (let i = 0; i <= 8; i++) {
    const [r, g, b] = colors[Math.round((i / 8) * (colors.length - 1))];
    stops.push(`rgb(${r},${g},${b}) ${(i / 8) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
