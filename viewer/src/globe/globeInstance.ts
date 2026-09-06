import {
  Vector3, Mesh, MeshBasicMaterial, FrontSide,
  type Vector2, Raycaster, Scene, type Camera, type Data3DTexture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import {
  setMaskMode, setNoDataSentinel, setNoDataStyle as applyNoDataStyleUniform,
  type NoDataStyle,
} from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, LAND_R_UNDER_SURFACE, type CoastlineData } from '../core/coastlines';
import { createSurfaceGeometry } from '../core/projection';
import {
  FrameCache, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { monthProfile, type NoDataRule, type CellSample } from '../core/queryPoint';
import { vec3ToLonLat } from '../core/constants';
import { computeTimeSeries, type TimeSeriesPoint } from '../core/timeSeries';
import { FrameByteCache } from '../core/frameByteCache';
import { GlobeUI, type GlobeViewState, type GlobeTool } from './globeUi';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';
import type { Rect } from '../core/layout';

export type { NoDataStyle };

// Continent fill sits UNDER the data sphere (LAND_R_UNDER_SURFACE), showing
// through wherever the active Variable has no value there -- same choice as
// deformation/deformationInstance.ts, for the same reason: a fixed-model
// generated viewer has no idea in advance whether its Model is sparse.
const LAND_FILL_COLOR = 0x808080;

// Strictly inside LAND_R_UNDER_SURFACE so the land mesh always occludes it
// where land exists -- same margin convention as the other radius offsets
// in coastlines.ts. See `backdrop`'s doc comment below.
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);

export interface GlobeInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  manifest: Manifest;
  coastlineData: CoastlineData | null;
  creditCoastlines: string | null;
  tools: GlobeTool[];
  title: string;
}

/** No onFocus -- unlike tomography's GlobeInstance, this wrapper has no
 *  per-instance tool state competing with OrbitControls for the same drag
 *  gesture, the same reasoning ClimateInstanceHooks already documents (see
 *  docs/adr/0022). Age is the only Synced Field this wrapper type offers
 *  (see CONTEXT.md) -- there's no depth-slice/month control in the fixed
 *  `GlobeTool` vocabulary to broadcast. */
export interface GlobeInstanceHooks {
  onRemove(self: GlobeInstance): void;
  onAgeChange?(self: GlobeInstance, age: number): void;
}

/**
 * One globe showing one Model, generalized from deformation/deformationInstance.ts
 * by dropping the reconstruction/Layer switching that class needed (this
 * viewer type shows exactly one Model -- see generator/recipeTypes.ts's
 * `datasets.length === 1` v1 constraint) -- see
 * docs/plans/consider-this-general-question-virtual-kay.md for why this is
 * meant to become the base every viewer sits on, not a parallel one.
 */
export class GlobeInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  readonly ui: GlobeUI;
  coastlines: Coastlines | null = null;
  /** A plain sphere UNDER the land mesh, painted only when noDataStyle is
   *  'grey'/'white' -- see GroupGlobeInstance's identical field for the
   *  full reasoning (painting that colour in the field itself would sit
   *  ABOVE the land mesh and blank out the continents). */
  private readonly backdrop: Mesh;

  readonly view: GlobeViewState = {
    variable: '', age: 0, clipMin: 0, clipMax: 1, noDataStyle: 'transparent', logScale: false,
  };

  private frames: FrameCache;
  /** CPU-only twin of `frames`, feeding the `time-series` tool's Field
   *  Aggregate computation -- see climate/climateInstance.ts's identical
   *  `bytes` field and ADR-0011 for why this is a separate cache from the
   *  GPU-bound one above. */
  private bytes: FrameByteCache;
  /** Keyed by `${manifest.id}/${resolutionId}/${variable.id}`, caching the
   *  PROMISE so two expands racing share the same in-flight fetch -- see
   *  ClimateInstance's identical field for the full reasoning. */
  private timeSeriesCache = new Map<string, Promise<TimeSeriesPoint[]>>();
  private ageToken = 0;
  private raycaster = new Raycaster();
  /** Guards setVariable() against a no-op re-entry -- deliberately NOT
   *  `this.view.variable`: lil-gui's OptionController writes the new value
   *  into the shared `view` object BEFORE firing onChange, so a real
   *  dropdown click has already made `variableId === this.view.variable`
   *  true by the time this callback runs. Guarding on that silently no-ops
   *  every real UI change (the label updates because lil-gui already wrote
   *  it, but the frame reload/colormap/clip-range never happen) while a
   *  test-hook call, which invokes setVariable() directly before `view` is
   *  touched, looks fine. Same bug, and same fix, as
   *  GroupGlobeInstance's `activeAxisA`/`activeAxisB`. */
  private activeVariable = '';

  get manifest(): Manifest { return this.deps.manifest; }

  get variable(): VariableInfo {
    return this.manifest.variables.find((v) => v.id === this.view.variable) ?? this.manifest.variables[0];
  }

  constructor(
    private camera: Camera,
    private readonly deps: GlobeInstanceDeps,
    private readonly hooks: GlobeInstanceHooks,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // whole-sphere paint, no depth axis in this wrapper's manifests
    this.scene.add(this.field.mesh);
    this.frames = new FrameCache(deps.archiveBase);
    this.bytes = new FrameByteCache(deps.archiveBase);

    this.backdrop = new Mesh(
      createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide }),
    );
    this.backdrop.visible = false; // 'transparent' style: nothing painted here at boot
    this.scene.add(this.backdrop);

    this.ui = new GlobeUI(this.view, {
      onVariable: (id) => void this.setVariable(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onNoDataStyle: (style) => this.setNoDataStyle(style),
      onExpandTimeSeries: () => this.onExpandTimeSeries(),
    }, deps.tools, deps.title, () => this.hooks.onRemove(this));

    if (deps.coastlineData) {
      // Blank, permanently disabled mask -- no cutaway concept here, but
      // Coastlines' shader still declares the uniform (same precedent as
      // ClimateInstance/DeformationInstance).
      const maskTexture = createMaskTexture();
      this.coastlines = new Coastlines(
        deps.coastlineData.lines, deps.coastlineData.table, maskTexture,
        LAND_R_UNDER_SURFACE, LAND_FILL_COLOR,
      );
      this.coastlines.setMaskEnabled(false);
      this.coastlines.landVisible = true;
      this.scene.add(this.coastlines.lines, this.coastlines.land);
    }
  }

  async boot(): Promise<void> {
    this.ui.setStatus('loading...');
    setMaskMode(this.field.material, 'none'); // paints the WHOLE sphere
    this.setNoDataStyle(this.view.noDataStyle);
    setNoDataSentinel(this.field.material, this.manifest.no_data_sentinel);

    this.view.variable = this.manifest.default_variable;
    this.activeVariable = this.manifest.default_variable;
    this.ui.setVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.field.material.uniforms.uColormap.value =
      makeColormapTexture(this.deps.colormaps[this.variable.default_colormap].colors);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);

    const ages = this.manifest.frames.map((f) => f.age_ma);
    const ageMin = Math.min(...ages);
    const ageMax = Math.max(...ages);
    this.view.age = ageMin;
    this.ui.setAgeRange(ageMin, ageMax);
    this.ui.setTimeSeriesAgeRange(ageMin, ageMax);
    this.ui.setTimeSeriesVariables(this.pickableTimeSeriesVariables());

    await this.loadFrame(this.view.age);
    this.coastlines?.setAge(this.view.age);
    this.ui.setTimeInfo(this.manifest.frames.length > 1 ? `age ${this.view.age.toFixed(0)} Ma` : '');
    this.ui.setCredit([this.manifest.source, this.deps.creditCoastlines].filter(Boolean).join(' · '));
    this.ui.setStatus('');
  }

  async setVariable(variableId: string): Promise<void> {
    if (variableId === this.activeVariable) return;
    this.activeVariable = variableId;
    this.view.variable = variableId;
    const cm = this.deps.colormaps[this.variable.default_colormap];
    this.field.material.uniforms.uColormap.value = makeColormapTexture(cm.colors);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.view.age);
    this.ui.setVariable(this.variable, cm);
  }

  applyClip(lo: number, hi: number): void {
    const v = this.variable;
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(v, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(v, hi);
    this.field.material.uniforms.uSteps.value = v.categorical ? (v.class_names?.length ?? 0) : 0;
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
    this.ui.setTimeSeriesAge(age);
  }

  /** The variables a Field Aggregate `time-series` can meaningfully be
   *  computed for -- unlike climate/climateInstance.ts's curated
   *  TIME_SERIES_VARIABLE_IDS (a fixed allowlist that only makes sense for
   *  ONE specific source), this wrapper type has no domain reason to
   *  exclude any non-auxiliary variable: a generated site shows every
   *  Field-Aggregate-computable variable its Model has, not a hardcoded
   *  subset (see docs/adr/0023, ADR-0017's "never restrict without a
   *  domain reason"). Categorical is still excluded -- "mean of class 3 and
   *  class 7" is meaningless for a class index, the same exclusion
   *  ClimateInstance applies. */
  private pickableTimeSeriesVariables(): VariableInfo[] {
    return this.manifest.variables.filter(
      (v) => !v.overlay_only && !v.vector_only && !v.mask_only && !v.categorical,
    );
  }

  /** Compute (or resolve from cache) the Field Aggregate series for every
   *  pickable variable of this Model -- see ClimateInstance's identical
   *  onExpandTimeSeries() for the full reasoning (shared cache keying,
   *  retry-on-failure). */
  private onExpandTimeSeries(): void {
    const manifest = this.manifest;
    const resolutionId = manifest.default_resolution;
    for (const v of this.pickableTimeSeriesVariables()) {
      const key = `${manifest.id}/${resolutionId}/${v.id}`;
      const cached = this.timeSeriesCache.get(key);
      if (cached) {
        void cached.then((points) => this.ui.setTimeSeriesData(v.id, points));
        continue;
      }
      this.ui.setTimeSeriesLoading(v.id);
      const promise = computeTimeSeries(this.bytes, manifest, v, resolutionId);
      this.timeSeriesCache.set(key, promise);
      void promise.then((points) => this.ui.setTimeSeriesData(v.id, points)).catch((e: unknown) => {
        console.error(e);
        this.timeSeriesCache.delete(key); // let the next expand retry rather than caching a permanent failure
      });
    }
  }

  setNoDataStyle(style: NoDataStyle): void {
    this.view.noDataStyle = style;
    applyNoDataStyleUniform(this.field.material, style);
    // Override the colour-fill path applyNoDataStyleUniform just set: the
    // field always discards at a no-data texel (see `backdrop`'s doc
    // comment), never paints it directly.
    this.field.material.uniforms.uSparseNoDataMode.value = 1;
    this.backdrop.visible = style !== 'transparent';
    if (style !== 'transparent') {
      (this.backdrop.material as MeshBasicMaterial).color.set(style === 'white' ? 0xffffff : 0xcccccc);
    }
  }

  private async loadFrame(age: number): Promise<void> {
    const variableId = this.view.variable;
    const token = ++this.ageToken;
    const frame = nearestFrame(this.manifest, age);
    this.frames.pin(this.manifest, variableId, frame.id);
    const tex = await this.frames.get(this.manifest, variableId, frame.id);
    if (token !== this.ageToken || variableId !== this.view.variable) return;
    this.applyVolume(tex);
    this.frames.prefetchNeighbours(this.manifest, variableId, frame.id);
  }

  private applyVolume(tex: Data3DTexture): void {
    const res = this.manifest.resolutions.find((r) => r.id === this.manifest.default_resolution)!;
    const mat = this.field.material;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = this.manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = this.manifest.depth_max_km;
  }

  /**
   * The `query-point` tool ("Anchored Point", see ADR-0011): raycast a
   * click against the field sphere and report the CURRENTLY-DISPLAYED
   * frame's value there, via the same engine-level monthProfile() the
   * climate viewer's shift-click gesture uses (ClimateInstance's
   * queryMonthProfileAt()) -- the engine boundary starts at a LonLat per
   * ADR-0011, so raycasting stays here, in this wrapper's own code.
   *
   * Re-fetches the current Frame's texture via `this.frames.get()` rather
   * than reading the material's uVolume uniform directly -- FrameCache
   * already has it cached (this IS the texture on screen), so this costs
   * no new network request, and it avoids reaching into the material's
   * internals (same reasoning as ClimateInstance's own version).
   *
   * monthProfile() returns one CellSample per depth layer; this wrapper's
   * v1 manifests are always single-layer whole-sphere fields (ndepth 1),
   * so `profile[0]` is always the right one. A multi-layer manifest (e.g.
   * a climate Model's Months) would need to pick whichever layer
   * field.mesh is actually sampling, which this does not attempt.
   *
   * Returns null if the click missed the globe or the tool wasn't
   * requested by the recipe.
   */
  async queryPointAt(ndc: Vector2): Promise<CellSample | null> {
    if (!this.ui.queryPointEnabled) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.field.mesh, false)[0];
    if (!hit) return null;
    const at = vec3ToLonLat(hit.point.x, hit.point.y, hit.point.z);

    const res = this.manifest.resolutions.find((r) => r.id === this.manifest.default_resolution)!;
    const variable = this.variable;
    const frame = nearestFrame(this.manifest, this.view.age);
    const tex = await this.frames.get(this.manifest, variable.id, frame.id);
    const rule: NoDataRule = { sentinel: this.manifest.no_data_sentinel };
    const profile = monthProfile(tex, res, variable, at, rule);
    return profile[0] ?? null;
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** Move this instance's panel/status/legend/etc. onto a new tile -- see
   *  core/multiInstanceHost.ts, docs/adr/0022. */
  applyLayout(rect: Rect): void {
    this.ui.setRect(rect);
  }

  dispose(): void {
    this.ui.dispose();
    this.coastlines?.dispose();
  }
}
