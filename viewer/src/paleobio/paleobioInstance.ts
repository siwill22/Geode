import {
  Color, FrontSide, Mesh, MeshBasicMaterial, Scene, Vector3,
  type Camera, type Data3DTexture, type Material, type WebGLRenderer,
} from 'three';

import {
  attachLatitudePanel, attachTimeSeries,
  type LatitudePanelHandle, type TimeDirection, type TimeSeriesHandle, type TimeSeriesSource,
} from './panels';

import { AggregateOverlay } from '../core/aggregateOverlay';
import { PointOverlay } from '../core/pointOverlay';
import { Coastlines, LAND_R_UNDER_SURFACE, fetchCoastlineData } from '../core/coastlines';
import { createMaskTexture } from '../core/mask';
import { DepthSlice } from '../core/depthSlice';
import {
  PROJECTION_UNIFORM, createSurfaceGeometry, isFlat, type ProjectionMode,
} from '../core/projection';
import {
  createFlatBackdropMaterial, setMaskMode, setNoDataSentinel, setNoDataStyle,
} from '../core/material';
import { FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded } from '../core/volume';
import { PaleobioUI } from './paleobioUi';
import type { ArchiveIndex, ColormapData, CoastlineSet, Manifest } from '../core/types';
import type { PaleobioDataset, PaleobioIndex, PaleobioViewState } from './types';

const LAND_FILL_COLOR = 0x6f6a60;

/** Both panels, explicitly, so they cannot drift apart. Geode is present-left
 *  everywhere (core/timeSeriesPanel.ts, and every age slider); petrify
 *  defaults to oldest-left. Leaving either on its default is what made the two
 *  charts run in opposite directions. */
const TIME_DIRECTION: TimeDirection = 'present-left';

/** Strictly inside the land mesh's radius so land always occludes it, matching
 *  the margin convention in coastlines.ts and GlobeInstance's own backdrop. */
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);
/** Ocean, for a dataset with no base raster. */
const BACKDROP_COLOR = 0x16202b;

export interface PaleobioDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  index: PaleobioIndex;
  /** `${archiveBase}/paleobio` -- where a dataset's own files live. */
  dataBase: string;
  /** Point the camera at a lon/lat from a given distance. Implemented by the
   *  page, which owns the camera and OrbitControls -- the instance knows WHERE
   *  it wants to look, not how the controls are wired. */
  frameOn(lon: number, lat: number, distance: number): void;
  /** Rebuild the camera and controls for a Projection and hand back the new
   *  camera. Globe and flat need different camera TYPES, so switching always
   *  means a new object, never a reconfigured one (ADR-0003) -- and the page
   *  owns both, so the instance asks rather than reaches. */
  rebuildCamera(mode: ProjectionMode): Camera;
}

/**
 * One globe showing one paleobiology dataset.
 *
 * The two case studies are separate datasets rather than one with a switch,
 * because they are reconstructed under DIFFERENT Reconstruction Models
 * (corals under Scotese, the only cataloged model reaching 540 Ma; Panama under
 * Müller 2019, which loses none of the marine record to unassigned plates where
 * Scotese loses 14.5%). Switching dataset therefore switches the reconstruction,
 * the coastlines, the base raster and the age range together -- they are one
 * decision, not four, and the Reconstruction Model is never separately
 * selectable. Offering it as a control would offer a way to draw fossils under
 * plates they were not reconstructed with (ADR-0004).
 */
export class PaleobioInstance {
  readonly scene = new Scene();
  readonly ui: PaleobioUI;

  /** Base raster (paleogeography), null where the dataset has none paired with
   *  its own Reconstruction Model -- see PaleobioDataset.base_model. */
  private readonly field = new DepthSlice();
  /**
   * An opaque sphere under everything, shown only when the dataset has NO base
   * raster.
   *
   * Land polygons cover continents, not ocean, so without this the ocean is a
   * hole: you see the far hemisphere's coastlines through the globe, and the
   * Panama view came out looking like Australia was sitting in the south
   * Pacific. The corals dataset never showed it because its PaleoDEM raster
   * paints the whole sphere. Same fix, same reasoning, as GlobeInstance's own
   * backdrop.
   */
  private readonly backdrop: Mesh;
  private coastlines: Coastlines | null = null;
  private readonly points: PointOverlay;
  private readonly cells: AggregateOverlay;

  private frames: FrameCache;
  private baseManifest: Manifest | null = null;
  private climateManifest: Manifest | null = null;
  private latitudePanel: LatitudePanelHandle | null = null;
  private diversityPanel: TimeSeriesHandle | null = null;
  private ageToken = 0;
  private loadToken = 0;

  readonly view: PaleobioViewState = {
    dataset: '', grouping: '', view: 'aggregate', age: 0,
    showTemperature: false, sizeBy: 'total', projection: 'globe',
  };

  get dataset(): PaleobioDataset {
    return this.deps.index.datasets.find((d) => d.id === this.view.dataset)
      ?? this.deps.index.datasets[0];
  }

  constructor(
    private camera: Camera,
    private readonly deps: PaleobioDeps,
    private readonly onNeedsRender: () => void,
  ) {
    this.frames = new FrameCache(deps.archiveBase);
    this.scene.add(this.field.mesh);
    this.backdrop = new Mesh(
      createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR }),
    );
    this.backdrop.visible = false;
    this.scene.add(this.backdrop);
    this.points = new PointOverlay(camera);
    this.cells = new AggregateOverlay(camera);

    this.view.dataset = deps.index.datasets[0].id;
    this.ui = new PaleobioUI(this.view, {
      onDataset: (id) => { this.view.dataset = id; void this.loadDataset(); },
      onGrouping: (id) => this.setGrouping(id),
      onView: (v) => this.setView(v),
      onAge: (age) => this.applyAge(age),
      onTemperature: (on) => { this.view.showTemperature = on; void this.loadFrame(); },
      onSizeBy: (s) => { this.cells.setSizeBy(s); this.onNeedsRender(); },
      onProjection: (m) => this.setProjection(m),
    }, deps.index.datasets);

    window.addEventListener('pointermove', (e) => this.onHover(e));
  }

  async boot(): Promise<void> {
    await this.loadDataset();
  }

  /**
   * Everything that changes when the dataset does -- reconstruction, coastlines,
   * raster, occurrences, summaries and both panels.
   *
   * Guarded by a token rather than a boolean: two dataset switches in quick
   * succession would otherwise race, and the loser could finish last and leave
   * the globe showing one dataset's points under the other's coastlines. That
   * failure is silent, which is exactly the kind this viewer must not have.
   */
  private async loadDataset(): Promise<void> {
    const token = ++this.loadToken;
    const d = this.dataset;
    this.ui.setStatus(`loading ${d.name} ...`);
    this.ui.setCaption(d);
    this.ui.setAgeRange(d.age_min, d.age_max);
    this.ui.setGroupings(d, d.default_grouping);
    this.ui.setTemperatureAvailable(!!d.climate_model);
    this.view.grouping = d.default_grouping;
    this.view.age = d.age_min;
    this.view.showTemperature = false;
    this.ui.refreshDisplay();

    const base = `${this.deps.dataBase}/${d.path}`;

    // Coastlines, resolved by the dataset's OWN declared Reconstruction Model id.
    // An explicit lookup, never a fallback keyed on a manifest `type`.
    const set = this.coastlineSetFor(d.reconstruction_model);
    if (this.coastlines) {
      // remove() BEFORE dispose(): Coastlines.dispose() frees GPU resources but
      // never unparents its meshes -- it does not hold a scene reference and was
      // never meant to. Disposing alone left every previous dataset's land mesh
      // in the scene, still drawing, which showed up as a stale spherical blob
      // sitting over the flat map once a second Projection existed to make it
      // obvious.
      this.scene.remove(this.coastlines.lines, this.coastlines.land);
      this.coastlines.dispose();
    }
    this.coastlines = null;
    if (set) {
      const data = await fetchCoastlineData(this.deps.archiveBase, set.geometry, set.rotations);
      if (token !== this.loadToken) return;
      this.coastlines = new Coastlines(
        data.lines, data.table, createMaskTexture(), LAND_R_UNDER_SURFACE, LAND_FILL_COLOR);
      this.coastlines.setMaskEnabled(false);
      this.coastlines.landVisible = true;
      // A fresh Coastlines starts on 'globe'. Switching dataset while a flat
      // Projection is active would otherwise silently drop back to a sphere.
      this.coastlines.setProjection(this.view.projection);
      this.scene.add(this.coastlines.lines, this.coastlines.land);
    }

    this.baseManifest = d.base_model
      ? await loadManifest(this.deps.archiveBase, this.modelPath(d.base_model))
      : null;
    this.climateManifest = d.climate_model
      ? await loadManifest(this.deps.archiveBase, this.modelPath(d.climate_model))
      : null;
    if (token !== this.loadToken) return;

    await Promise.all([
      this.points.load(`${base}/${d.files.points}`, {
        // An Occurrence is dated to an INTERVAL, never a point in time -- `range`
        // is the only lifespan mode that is honest about that.
        lifespan: 'range',
        size: 2.6,
        keyline: 'rgba(10, 14, 20, 0.75)',
      }),
      this.cells.load(`${base}/${d.files.aggregates}`, {
        grouping: d.default_grouping,
        mode: 'pie',
        sizeBy: this.view.sizeBy,
        maxRadius: 15,
        sizeRef: 60,
      }),
    ]);
    if (token !== this.loadToken) return;

    await this.buildPanels(d, base, token);
    if (token !== this.loadToken) return;

    this.setView(this.view.view);
    // A flat map is already showing the whole world; "fly to the region" is a
    // globe-only idea, and applying it to an orthographic camera would just
    // move it along its own view axis to no visible effect.
    if (!isFlat(this.view.projection)) {
      this.deps.frameOn(d.view_centre[0], d.view_centre[1], d.view_distance);
    }
    this.applyAge(d.age_min);
    this.ui.setStatus('');
    this.onNeedsRender();
  }

  private async buildPanels(d: PaleobioDataset, base: string, token: number): Promise<void> {
    this.latitudePanel?.destroy();
    this.diversityPanel?.destroy();
    this.latitudePanel = null;
    this.diversityPanel = null;

    const range: [number, number] = [d.age_min, d.age_max];
    const latitude = await attachLatitudePanel({
      element: this.ui.latitudeHost,
      url: `${base}/${d.files.latitude}`,
      range,
      grouping: this.view.grouping,
      onSeek: (age: number) => { this.applyAge(age); this.ui.refreshDisplay(); },
      onRender: () => this.onNeedsRender(),
      height: 140,
      timeDirection: TIME_DIRECTION,
    });
    if (token !== this.loadToken) { latitude.destroy(); return; }
    this.latitudePanel = latitude;

    // Richness beside its sampling proxy, never instead of it. Raw Phanerozoic
    // richness substantially tracks how much rock and how many workers there
    // were; the response is to show the reader that correlation, not to assert
    // it was corrected for.
    const series: TimeSeriesSource['series'] = {
      richness: { label: 'Genera sampled', colour: 'rgb(126, 200, 227)' },
      occurrences: { label: 'Occurrences (sampling)', colour: 'rgb(150, 150, 155)' },
      collections: { label: 'Collections (sampling)', colour: 'rgb(110, 110, 118)' },
    };
    if (d.id === 'panama') {
      // The two derived series that state "both signs" quantitatively: immigrant
      // fraction rises as the bridge opens, basin similarity falls as the seaway
      // shuts. Blank (not zero) wherever a basin is unsampled in a stage -- see
      // prep_pbdb.py, where writing 0 there was a real bug.
      series.immigrant_frac_north = {
        label: 'S-origin genera in N America', colour: 'rgb(69, 117, 180)',
      };
      series.immigrant_frac_south = {
        label: 'N-origin genera in S America', colour: 'rgb(214, 96, 77)',
      };
      series.basin_similarity = {
        label: 'Caribbean–Pacific similarity', colour: 'rgb(244, 165, 79)',
      };
    }
    const diversity = await attachTimeSeries({
      element: this.ui.diversityHost,
      sources: [{ url: `${base}/${d.files.diversity}`, series }],
      range,
      onSeek: (age: number) => { this.applyAge(age); this.ui.refreshDisplay(); },
      onRender: () => this.onNeedsRender(),
      timeDirection: TIME_DIRECTION,
    });
    if (token !== this.loadToken) { diversity.destroy(); return; }
    this.diversityPanel = diversity;
  }

  /**
   * Which coastline geometry belongs to a Reconstruction Model id.
   *
   * Scotese's live under `archive.scotese_coastlines` for historical reasons
   * while every other model's live under `archive.native_coastlines[id]`; both
   * are keyed on the id the DATASET declares, so this stays a lookup and never
   * becomes the kind of `manifest.type`-based fallback ADR-0004 forbids.
   */
  private coastlineSetFor(id: string): CoastlineSet | null {
    const key = id.toLowerCase();
    if (key === 'scotese') return this.deps.archive.scotese_coastlines ?? null;
    return this.deps.archive.native_coastlines?.[key] ?? null;
  }

  private modelPath(id: string): string {
    const entry = this.deps.archive.models.find((m) => m.id === id);
    if (!entry) throw new Error(`archive.json has no model "${id}"`);
    return entry.path;
  }

  setGrouping(id: string): void {
    this.view.grouping = id;
    this.cells.setGrouping(id);
    this.latitudePanel?.setGrouping(id);
    this.retypePoints(id);
    this.refreshLegend();
    this.onNeedsRender();
  }

  /**
   * Repoint `PointLayer`'s own `type` field at the active Grouping's category.
   *
   * `points.json` carries every Grouping's value per point (`g_subclass`,
   * `g_origin`, ...) because shipping one file per Grouping would repeat every
   * coordinate and rotation for each. `PointLayer` symbolises on a single
   * `type`, so switching Grouping rewrites that field and restyles -- the
   * documented way to drive it from a palette the page owns.
   *
   * A point with no category under this Grouping ("which side of the seaway"
   * means nothing for a land mammal) gets the em-dash category, which is then
   * switched off: it is not drawn in a drab colour alongside real categories,
   * because that reads as a class of its own.
   */
  private retypePoints(id: string): void {
    const layer = (this.points as unknown as { layer: {
      points: Array<Record<string, unknown>>;
      types: Record<string, boolean>;
      restyle(): void;
    } | null }).layer;
    if (!layer) return;
    for (const p of layer.points) p.type = (p[`g_${id}`] as string) ?? '—';
    layer.types = {};
    for (const p of layer.points) layer.types[p.type as string] = true;
    layer.types['—'] = false;
    layer.restyle();
  }

  /**
   * Switch Projection: new camera and controls, new surface geometry, and every
   * layer re-laid-out.
   *
   * Nothing about WHAT is shown changes -- only how it is viewed (CONTEXT.md's
   * Projection entry). The backdrop swaps material as well as geometry because
   * a sphere's opaque fill and a flat map's are different problems: the flat one
   * has to stop at the map outline, which for Robinson is a curve.
   */
  setProjection(mode: ProjectionMode): void {
    this.view.projection = mode;
    const camera = this.deps.rebuildCamera(mode);
    this.camera = camera;

    this.field.setProjection(mode);

    const oldGeom = this.backdrop.geometry;
    const oldMat = this.backdrop.material as Material;
    this.backdrop.geometry = createSurfaceGeometry(mode, BACKDROP_R);
    if (isFlat(mode)) {
      const mat = createFlatBackdropMaterial(BACKDROP_COLOR);
      mat.uniforms.uProjectionMode.value = PROJECTION_UNIFORM[mode];
      this.backdrop.material = mat;
    } else {
      this.backdrop.material = new MeshBasicMaterial({ side: FrontSide, color: BACKDROP_COLOR });
    }
    oldGeom.dispose();
    oldMat.dispose();

    this.coastlines?.setProjection(mode);
    this.points.setCamera(camera, mode);
    this.cells.setCamera(camera, mode);
    this.resize();
    this.onNeedsRender();
  }

  setView(view: 'aggregate' | 'occurrences'): void {
    this.view.view = view;
    this.cells.visible = view === 'aggregate';
    this.points.visible = view === 'occurrences';
    this.ui.setSizeByEnabled(view === 'aggregate');
    this.refreshLegend();
    this.onNeedsRender();
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    this.points.setTime(age);
    this.cells.setTime(age);
    this.latitudePanel?.setTime(age);
    this.diversityPanel?.setTime(age);
    void this.loadFrame();
    this.refreshLegend();
    this.onNeedsRender();
  }

  private refreshLegend(): void {
    const d = this.dataset;
    const g = d.groupings.find((x) => x.id === this.view.grouping);
    const totals = this.cells.totals();
    const rows = this.cells.categories.map((c, i) => ({
      label: this.cells.labelFor(c),
      fill: this.cells.fillFor(c),
      count: totals[i] ?? 0,
    }));
    // A Derived Grouping always shows its rule. The distinction between "read
    // from the data" and "inferred by a rule" is invisible in a colour, and a
    // derived category that looks observed is how a map ends up asserting more
    // than it knows (CONTEXT.md, Observed vs Derived Grouping).
    this.ui.setLegend(g?.label ?? '', rows, g?.derived ? `Derived: ${g.rule}` : null);
  }

  private async loadFrame(): Promise<void> {
    const manifest = this.view.showTemperature && this.climateManifest
      ? this.climateManifest
      : this.baseManifest;
    if (!manifest) {
      this.field.mesh.visible = false;
      this.backdrop.visible = true;
      return;
    }
    this.backdrop.visible = false;

    const variable = this.view.showTemperature && this.climateManifest
      ? manifest.variables.find((v) => v.id === 'T') ?? manifest.variables[0]
      : manifest.variables.find((v) => v.id === 'elevation') ?? manifest.variables[0];

    const token = ++this.ageToken;
    const frame = nearestFrame(manifest, this.view.age);
    const tex = await this.frames.get(manifest, variable.id, frame.id);
    if (token !== this.ageToken) return;

    const mat = this.field.material;
    const cm = this.deps.colormaps[variable.default_colormap];
    mat.uniforms.uColormap.value = makeColormapTexture(cm.colors);
    mat.uniforms.uClipLo.value = physicalToEncoded(variable, variable.default_clip_min);
    mat.uniforms.uClipHi.value = physicalToEncoded(variable, variable.default_clip_max);
    mat.uniforms.uSteps.value = variable.categorical ? (variable.class_names?.length ?? 0) : 0;
    setMaskMode(mat, 'none');
    setNoDataStyle(mat, 'transparent');
    setNoDataSentinel(mat, manifest.no_data_sentinel);
    this.applyVolume(manifest, tex);
    this.field.mesh.visible = true;
    this.field.setDepthKm(0);
    this.onNeedsRender();
  }

  private applyVolume(manifest: Manifest, tex: Data3DTexture): void {
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    const mat = this.field.material;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = manifest.depth_max_km;
  }

  private onHover(e: PointerEvent): void {
    if (this.view.view !== 'aggregate') { this.ui.hidePopup(); return; }
    const hit = this.cells.pick(e.clientX, e.clientY) as {
      slot: number; total: number; richness: number | null;
      byCategory: Record<string, number>;
    } | null;
    this.cells.highlight(hit ? hit.slot : null);
    if (!hit) { this.ui.hidePopup(); this.onNeedsRender(); return; }
    const lines = [
      `${hit.total.toLocaleString()} occurrences`
      + (hit.richness != null ? ` · ${hit.richness} genera` : ''),
      ...Object.entries(hit.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${this.cells.labelFor(k)}: ${n.toLocaleString()}`),
    ];
    this.ui.showPopup(e.clientX, e.clientY, lines);
    this.onNeedsRender();
  }

  setCameraAspect(camera: Camera): void {
    this.camera = camera;
    this.points.setCamera(camera, this.view.projection);
    this.cells.setCamera(camera, this.view.projection);
  }

  resize(): void {
    const rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    this.points.setRect(rect);
    this.cells.setRect(rect);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.points.draw();
    this.cells.draw();
    this.latitudePanel?.draw();
    this.diversityPanel?.draw();
  }
}

export const BACKGROUND = new Color(0x0b0d10);
