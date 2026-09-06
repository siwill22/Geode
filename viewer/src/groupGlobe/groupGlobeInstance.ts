import {
  Vector3, Raycaster, Scene, Mesh, MeshBasicMaterial, FrontSide,
  type Camera, type Data3DTexture, type Vector2, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import {
  setMaskMode, setNoDataSentinel, setNoDataStyle as applyNoDataStyleUniform,
  type NoDataStyle,
} from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, LAND_R_UNDER_SURFACE, fetchCoastlineData, resolveCoastlineSet } from '../core/coastlines';
import { createSurfaceGeometry } from '../core/projection';
import {
  FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { monthProfile, type NoDataRule, type CellSample } from '../core/queryPoint';
import { vec3ToLonLat } from '../core/constants';
import { computeTimeSeries, type TimeSeriesPoint } from '../core/timeSeries';
import { FrameByteCache } from '../core/frameByteCache';
import { GroupGlobeUI, type GroupGlobeViewState } from './groupGlobeUi';
import type { GlobeTool } from '../core/tools';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';
import type { Rect } from '../core/layout';

export type { NoDataStyle };

// Same reasoning as deformation/deformationInstance.ts's identical constant:
// continent fill sits UNDER the data sphere, showing through wherever the
// active Variable has no value there -- a generated comparison viewer has
// no idea in advance whether any of its grid's Models are sparse.
const LAND_FILL_COLOR = 0x808080;

// Strictly inside LAND_R_UNDER_SURFACE so the land mesh always occludes it
// where land exists -- same margin convention as the other radius offsets
// in coastlines.ts.
const BACKDROP_R = LAND_R_UNDER_SURFACE * (1 - 0.0006);

export interface GroupGlobeInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  tools: GlobeTool[];
  title: string;
  axisALabel: string;
  axisBLabel: string;
  /** axisA value -> axisB value -> modelId. Must be a complete grid --
   *  see generator/validateRecipe.mjs's resolveModelGroup(), which is the
   *  only thing that's allowed to build one of these. */
  grid: Record<string, Record<string, string>>;
  defaultAxisA: string;
  defaultAxisB: string;
}

/** See globe/globeInstance.ts's GlobeInstanceHooks -- identical reasoning
 *  (no onFocus, age is the only Synced Field this wrapper type offers). */
export interface GroupGlobeInstanceHooks {
  onRemove(self: GroupGlobeInstance): void;
  onAgeChange?(self: GroupGlobeInstance, age: number): void;
}

interface GridSource {
  manifest: Manifest;
  variableId: string;
  frames: FrameCache;
  /** CPU-only twin of `frames`, feeding the `time-series` tool's Field
   *  Aggregate computation for THIS cell -- see globe/globeInstance.ts's
   *  identical field. */
  bytes: FrameByteCache;
}

/**
 * One globe comparing several Models across two declared axes (see
 * generator/recipeTypes.ts's ResolvedRecipe -- reconstruction_model and
 * comparison_role in v1.5), generalized directly from
 * deformation/deformationInstance.ts's reconstruction+layer switching:
 * that class IS this pattern, just hardcoded to deformation's own two
 * axes and its `-deformation`/`-age-heatflux` id-suffix convention for
 * finding them. This version reads the grouping from archive.json's own
 * declared fields instead (see core/types.ts's comparison_role doc
 * comment), so any future comparison family works the same way without a
 * new hardcoded viewer.
 */
export class GroupGlobeInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  readonly ui: GroupGlobeUI;
  coastlines: Coastlines | null = null;
  /** A plain sphere UNDER the land mesh, painted only when noDataStyle is
   *  'grey'/'white'. The field itself always discards at a no-data texel
   *  (see setNoDataStyle()) rather than painting that colour directly --
   *  painting it in the field would sit ABOVE the land mesh and blank out
   *  the continents, making land indistinguishable from open ocean with no
   *  data. Land, sitting between this and the field, still occludes it
   *  wherever a continent exists, so the two stay visually distinct. */
  private readonly backdrop: Mesh;

  readonly view: GroupGlobeViewState = {
    axisA: '', axisB: '', variable: '', age: 0, clipMin: 0, clipMax: 1,
    noDataStyle: 'transparent', logScale: false,
  };

  private grid!: Record<string, Record<string, GridSource>>;
  /** Built lazily on first visit to each axisA value and kept alive after
   *  that -- same reasoning as DeformationInstance.coastlinesCache. */
  private coastlinesCache: Record<string, Coastlines | null> = {};
  /** Guards a slow coastline fetch for a stale axisA landing after a newer
   *  one already applied. */
  private coastlineToken = 0;
  /** Guards a slow frame fetch for a stale age/axis/variable landing after
   *  a newer one already applied -- same pattern as GlobeInstance. */
  private ageToken = 0;
  /** Each axisB value's own remembered age, for a trip through a static
   *  axisB (always pinned to its own single Frame's age) and back --
   *  generalizes DeformationInstance's single lastDeformationAge to
   *  however many time-varying axisB values a comparison group has. */
  private lastAgeByAxisB: Record<string, number> = {};
  private raycaster = new Raycaster();
  /** Guards setAxisA/setAxisB against a no-op re-entry -- deliberately NOT
   *  `this.view.axisA`/`axisB`: lil-gui's OptionController writes the new
   *  value into the shared `view` object BEFORE firing onChange (see its
   *  setValue()), so a real dropdown click has already made
   *  `axisA === this.view.axisA` true by the time this callback runs --
   *  guarding on that would silently no-op every real UI change while a
   *  test-hook call (which invokes setAxisA() directly, before `view` is
   *  touched) would look fine. Same reasoning as DeformationInstance's
   *  `activeLayer` field. */
  private activeAxisA = '';
  private activeAxisB = '';
  /** Keyed by `${manifest.id}/${resolutionId}/${variable.id}` -- see
   *  globe/globeInstance.ts's identical field. */
  private timeSeriesCache = new Map<string, Promise<TimeSeriesPoint[]>>();

  private get cell(): GridSource {
    return this.grid[this.view.axisA][this.view.axisB];
  }

  get manifest(): Manifest { return this.cell.manifest; }

  get variable(): VariableInfo {
    const src = this.cell;
    return src.manifest.variables.find((v) => v.id === src.variableId) ?? src.manifest.variables[0];
  }

  constructor(
    private camera: Camera,
    private readonly deps: GroupGlobeInstanceDeps,
    private readonly hooks: GroupGlobeInstanceHooks,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // whole-sphere paint, no depth axis in this wrapper's manifests
    this.scene.add(this.field.mesh);

    this.backdrop = new Mesh(
      createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide }),
    );
    this.backdrop.visible = false; // 'transparent' style: nothing painted here at boot
    this.scene.add(this.backdrop);

    this.ui = new GroupGlobeUI(this.view, {
      onAxisA: (v) => void this.setAxisA(v),
      onAxisB: (v) => void this.setAxisB(v),
      onVariable: (id) => void this.setVariable(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onNoDataStyle: (style) => this.setNoDataStyle(style),
      onExpandTimeSeries: () => this.onExpandTimeSeries(),
    }, deps.tools, deps.title, deps.axisALabel, deps.axisBLabel, () => this.hooks.onRemove(this));
  }

  async boot(): Promise<void> {
    this.ui.setStatus('loading...');
    setMaskMode(this.field.material, 'none'); // paints the WHOLE sphere
    this.setNoDataStyle(this.view.noDataStyle);

    const axisAValues = Object.keys(this.deps.grid);
    const axisBValues = Object.keys(this.deps.grid[axisAValues[0]]);
    this.ui.setAxisAOptions(axisAValues);
    this.ui.setAxisBOptions(axisBValues);

    this.grid = {};
    for (const a of axisAValues) {
      this.grid[a] = {};
      for (const b of axisBValues) {
        this.grid[a][b] = await this.loadCell(this.deps.grid[a][b]);
      }
    }

    this.view.axisA = this.deps.defaultAxisA;
    this.view.axisB = this.deps.defaultAxisB;
    this.activeAxisA = this.deps.defaultAxisA;
    this.activeAxisB = this.deps.defaultAxisB;
    await this.activateCoastlines(this.view.axisA);
    setNoDataSentinel(this.field.material, this.manifest.no_data_sentinel);

    const ages = this.currentAxisBAges();
    this.view.age = this.isStaticAxisB(this.view.axisB) ? ages[0] : Math.min(...ages);
    this.lastAgeByAxisB[this.view.axisB] = this.view.age;
    this.ui.setAgeRange(Math.min(...ages), Math.max(...ages));
    this.ui.setTimeSeriesAgeRange(Math.min(...ages), Math.max(...ages));
    this.ui.setAgeControlVisible(!this.isStaticAxisB(this.view.axisB));

    this.view.variable = this.cell.variableId;
    this.ui.setVariables(this.manifest.variables);
    this.ui.setTimeSeriesVariables(this.pickableTimeSeriesVariables());
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.field.material.uniforms.uColormap.value =
      makeColormapTexture(this.deps.colormaps[this.variable.default_colormap].colors);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);

    await this.loadFrame(this.view.age);
    this.coastlines?.setAge(this.view.age);
    this.ui.setTimeInfo(
      this.isStaticAxisB(this.view.axisB) ? 'present day' : `age ${this.view.age.toFixed(0)} Ma`,
    );
    this.ui.setTimeSeriesAge(this.view.age);
    this.updateCredit();
    this.ui.setStatus('');
    this.ui.refreshDisplay();
  }

  private async loadCell(modelId: string): Promise<GridSource> {
    const entry = this.deps.archive.models.find((m) => m.id === modelId);
    if (!entry) throw new Error(`no model in archive with id ${modelId}`);
    const manifest = await loadManifest(this.deps.archiveBase, entry.path);
    const variable = manifest.variables.find((v) => v.id === manifest.default_variable) ?? manifest.variables[0];
    return {
      manifest,
      variableId: variable.id,
      frames: new FrameCache(this.deps.archiveBase),
      bytes: new FrameByteCache(this.deps.archiveBase),
    };
  }

  /** See globe/globeInstance.ts's identical method -- same "no curated
   *  allowlist" reasoning (ADR-0017/docs/adr/0023), applied to whichever
   *  grid cell is CURRENTLY active. */
  private pickableTimeSeriesVariables(): VariableInfo[] {
    return this.manifest.variables.filter(
      (v) => !v.overlay_only && !v.vector_only && !v.mask_only && !v.categorical,
    );
  }

  /** See globe/globeInstance.ts's identical method -- computes for the
   *  CURRENTLY active grid cell, same "reflects whichever is active now"
   *  reasoning as ClimateInstance.onExpandTimeSeries(). */
  private onExpandTimeSeries(): void {
    const cell = this.cell;
    const manifest = cell.manifest;
    const resolutionId = manifest.default_resolution;
    for (const v of this.pickableTimeSeriesVariables()) {
      const key = `${manifest.id}/${resolutionId}/${v.id}`;
      const cached = this.timeSeriesCache.get(key);
      if (cached) {
        void cached.then((points) => this.ui.setTimeSeriesData(v.id, points));
        continue;
      }
      this.ui.setTimeSeriesLoading(v.id);
      const promise = computeTimeSeries(cell.bytes, manifest, v, resolutionId);
      this.timeSeriesCache.set(key, promise);
      void promise.then((points) => this.ui.setTimeSeriesData(v.id, points)).catch((e: unknown) => {
        console.error(e);
        this.timeSeriesCache.delete(key);
      });
    }
  }

  /** A comparison-role combination is "static" when every reconstruction's
   *  Model for it has exactly one Frame -- e.g. Age & Heat Flux, whose
   *  products carry no per-age reconstruction of their own. Generalizes
   *  DeformationInstance's hardcoded `layer === 'ageHeatflux'` check. */
  private isStaticAxisB(axisB: string): boolean {
    return Object.keys(this.grid).every((a) => this.grid[a][axisB].manifest.frames.length <= 1);
  }

  private currentAxisBAges(): number[] {
    return this.cell.manifest.frames.map((f) => f.age_ma);
  }

  /** Swap which axisA's Coastlines are in the scene, building and caching
   *  one on first visit -- see coastlinesCache's doc comment. A reconstruction
   *  with no exported native coastlines leaves the globe bare rather than
   *  falling back to a different one's rotations (ADR-0004). */
  private async activateCoastlines(axisA: string): Promise<void> {
    const token = ++this.coastlineToken;
    let built = this.coastlinesCache[axisA];
    if (built === undefined) {
      const anyCell = Object.values(this.grid[axisA])[0];
      const coastlineSet = resolveCoastlineSet(this.deps.archive, anyCell.manifest);
      built = null;
      if (coastlineSet) {
        try {
          const data = await fetchCoastlineData(this.deps.archiveBase, coastlineSet.geometry, coastlineSet.rotations);
          if (token !== this.coastlineToken) return; // a newer axisA already landed
          const maskTexture = createMaskTexture();
          built = new Coastlines(
            data.lines, data.table, maskTexture, LAND_R_UNDER_SURFACE, LAND_FILL_COLOR,
          );
          built.setMaskEnabled(false);
          built.landVisible = true;
        } catch {
          built = null; // a layer, not a prerequisite -- the globe still works
        }
      }
      this.coastlinesCache[axisA] = built;
    }
    if (token !== this.coastlineToken) return;
    if (this.coastlines) this.scene.remove(this.coastlines.lines, this.coastlines.land);
    this.coastlines = built;
    if (this.coastlines) this.scene.add(this.coastlines.lines, this.coastlines.land);
  }

  private updateCredit(): void {
    const parts = [this.manifest.source];
    if (this.coastlines && this.manifest.reconstruction_model) {
      parts.push(`coastlines ${this.manifest.reconstruction_model} (native rotations)`);
    }
    this.ui.setCredit(parts.filter(Boolean).join(' · '));
  }

  async setAxisA(axisA: string): Promise<void> {
    if (axisA === this.activeAxisA) return;
    this.activeAxisA = axisA;
    this.view.axisA = axisA;
    await this.activateCoastlines(axisA);
    setNoDataSentinel(this.field.material, this.manifest.no_data_sentinel);

    const ages = this.currentAxisBAges();
    const ageMin = Math.min(...ages);
    const ageMax = Math.max(...ages);
    this.ui.setAgeRange(ageMin, ageMax);
    this.ui.setTimeSeriesAgeRange(ageMin, ageMax);
    if (!this.isStaticAxisB(this.activeAxisB)) {
      this.view.age = Math.min(Math.max(this.view.age, ageMin), ageMax);
    }
    this.coastlines?.setAge(this.view.age);

    this.view.variable = this.cell.variableId;
    this.ui.setVariables(this.manifest.variables);
    this.ui.setTimeSeriesVariables(this.pickableTimeSeriesVariables());
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.field.material.uniforms.uColormap.value =
      makeColormapTexture(this.deps.colormaps[this.variable.default_colormap].colors);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.view.age);
    this.ui.setTimeInfo(
      this.isStaticAxisB(this.activeAxisB) ? 'present day' : `age ${this.view.age.toFixed(0)} Ma`,
    );
    this.ui.setTimeSeriesAge(this.view.age);
    this.ui.refreshDisplay();
    this.updateCredit();
  }

  async setAxisB(axisB: string): Promise<void> {
    if (axisB === this.activeAxisB) return;
    if (!this.isStaticAxisB(this.activeAxisB)) this.lastAgeByAxisB[this.activeAxisB] = this.view.age;
    this.activeAxisB = axisB;
    this.view.axisB = axisB;

    const ages = this.currentAxisBAges();
    const age = this.isStaticAxisB(axisB) ? ages[0] : (this.lastAgeByAxisB[axisB] ?? Math.min(...ages));
    this.view.age = age;
    this.coastlines?.setAge(age);
    this.ui.setAgeRange(Math.min(...ages), Math.max(...ages));
    this.ui.setTimeSeriesAgeRange(Math.min(...ages), Math.max(...ages));
    this.ui.setAgeControlVisible(!this.isStaticAxisB(axisB));

    this.view.variable = this.cell.variableId;
    this.ui.setVariables(this.manifest.variables);
    this.ui.setTimeSeriesVariables(this.pickableTimeSeriesVariables());
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.field.material.uniforms.uColormap.value =
      makeColormapTexture(this.deps.colormaps[this.variable.default_colormap].colors);
    setNoDataSentinel(this.field.material, this.manifest.no_data_sentinel);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(age);
    this.ui.setTimeInfo(this.isStaticAxisB(axisB) ? 'present day' : `age ${age.toFixed(0)} Ma`);
    this.ui.setTimeSeriesAge(age);
    this.ui.refreshDisplay();
    this.updateCredit();
  }

  async setVariable(variableId: string): Promise<void> {
    const cell = this.cell;
    if (variableId === cell.variableId) return;
    cell.variableId = variableId;
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

  /** No-op while the active axisB combination is static (see
   *  isStaticAxisB()) -- mirrors DeformationInstance.applyAge()'s identical
   *  guard. */
  applyAge(age: number): void {
    if (this.isStaticAxisB(this.view.axisB)) return;
    this.view.age = age;
    this.lastAgeByAxisB[this.view.axisB] = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
    this.ui.setTimeSeriesAge(age);
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
    const cell = this.cell;
    const variableId = cell.variableId;
    const token = ++this.ageToken;
    const frame = nearestFrame(cell.manifest, age);
    cell.frames.pin(cell.manifest, variableId, frame.id);
    const tex = await cell.frames.get(cell.manifest, variableId, frame.id);
    // An axis/variable switch or a newer age can all land after this fetch
    // started -- `cell !== this.cell` catches an axisA/axisB change in one
    // check, since a different combination is always a different object.
    if (token !== this.ageToken || cell !== this.cell || variableId !== cell.variableId) return;
    this.applyVolume(cell.manifest, tex);
    cell.frames.prefetchNeighbours(cell.manifest, variableId, frame.id);
  }

  private applyVolume(manifest: Manifest, tex: Data3DTexture): void {
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    const mat = this.field.material;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = manifest.depth_max_km;
  }

  /** The `query-point` tool -- see globe/globeInstance.ts's identical
   *  method for the full ADR-0011 reasoning. Reads through the currently
   *  active grid cell's own cached texture, so switching axisA/axisB then
   *  querying always answers for whatever combination is on screen. */
  async queryPointAt(ndc: Vector2): Promise<CellSample | null> {
    if (!this.ui.queryPointEnabled) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.field.mesh, false)[0];
    if (!hit) return null;
    const at = vec3ToLonLat(hit.point.x, hit.point.y, hit.point.z);

    const cell = this.cell;
    const res = cell.manifest.resolutions.find((r) => r.id === cell.manifest.default_resolution)!;
    const variable = this.variable;
    const frame = nearestFrame(cell.manifest, this.view.age);
    const tex = await cell.frames.get(cell.manifest, variable.id, frame.id);
    const rule: NoDataRule = { sentinel: cell.manifest.no_data_sentinel };
    const profile = monthProfile(tex, res, variable, at, rule);
    return profile[0] ?? null;
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** See globe/globeInstance.ts's identical applyLayout(). */
  applyLayout(rect: Rect): void {
    this.ui.setRect(rect);
  }

  dispose(): void {
    this.ui.dispose();
    for (const c of Object.values(this.coastlinesCache)) c?.dispose();
  }
}
