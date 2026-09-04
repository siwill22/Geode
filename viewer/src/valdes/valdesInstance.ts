import {
  Scene, Vector3, type Camera, type Data3DTexture, type ShaderMaterial,
  type Texture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import { setNoDataSentinel, setNoDataStyle } from '../core/material';
import { Coastlines, type CoastlineData } from '../core/coastlines';
import { createMaskTexture } from '../core/mask';
import { R_SURFACE } from '../core/constants';
import type { ProjectionMode } from '../core/projection';
import type { Rect } from '../core/layout';
import { WindGlyphs } from '../core/windGlyphs';
import { WindStreaks } from '../core/windStreaks';
import {
  FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { ValdesUI, type ValdesViewState } from './valdesUi';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo, VectorFieldInfo } from '../core/types';

export interface ValdesInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  coastlineData: CoastlineData | null;
}

export interface ValdesInstanceHooks {
  onRemove(self: ValdesInstance): void;
  onAgeChange?(self: ValdesInstance, age: number): void;
  onDisplayChange?(self: ValdesInstance): void;
}

export const DEFAULT_VECTOR_VISIBLE = true;
export const DEFAULT_VECTOR_SCALE = 1;
export const DEFAULT_VECTOR_DENSITY = 1.5;
export type VectorStyle = 'glyph' | 'streak';
export const DEFAULT_VECTOR_STYLE: VectorStyle = 'glyph';
/** Fully opaque -- matches the field's look before this slider existed
 *  (relief only ever showed through no-data holes, never through valid
 *  data). See ValdesInstance.applyFieldOpacity(). */
export const DEFAULT_FIELD_OPACITY = 1;
const COASTLINE_CREDIT = 'continents Scotese 2008 rotation model, via Cao et al. 2018';

/** A hair inside R_SURFACE -- the same offset climateInstance.ts's OVERLAY_R
 *  uses outside it, just the other direction. Both Layers here reserve a
 *  NO_DATA sentinel over land (ocean-only variables) or below the seafloor
 *  (Ocean Depth), and setNoDataStyle('transparent') genuinely discards those
 *  fragments -- no depth write. Without something opaque sitting just
 *  beneath, that hole in the near hemisphere lets Vector Streak ribbons
 *  drawn on the FAR hemisphere of the same globe (DoubleSide,
 *  depthWrite:false, so nothing about them alone stops this) show straight
 *  through, which reads as a glitch, not empty ocean. See ADR-0015. */
const RELIEF_FILL_R = R_SURFACE * 0.9994;
const HILLSHADE_VARIABLE_ID = 'hillshade';

/**
 * Valdes/BRIDGE's two Layers -- see docs/adr/0008 for why this instance
 * exists at all (sole home for Valdes/BRIDGE, not a third climate.html
 * model) and CONTEXT.md's Layer entry for why they can't be Variables of
 * one Model: Monthly's axis is calendar month (every Frame); Ocean Depth's
 * is real depth (annual only), and the two don't share a grid or depth
 * range.
 */
export type ValdesLayer = 'monthly' | 'ocean_depth';

interface LayerSource {
  manifest: Manifest;
  variables: VariableInfo[];
  variableId: string;
  frames: FrameCache;
  colormapTexture: Texture;
}

/**
 * One Valdes/BRIDGE globe: a scalar field draped on the whole sphere,
 * toggled between the Monthly and Ocean Depth Layers, each with its own
 * optional Vector Field overlay (see resolveVectorFields() and
 * CONTEXT.md's Vector Field entry) -- a deliberately smaller sibling of
 * climate/climateInstance.ts's ClimateInstance: no Paleogeography Layer, no
 * multi-model comparison (Valdes is one source), no SEPARATE shaded-relief
 * overlay mesh -- instead `field`'s own opacity is adjustable (see
 * applyFieldOpacity()), fading it down toward `reliefFill` sitting just
 * behind it, same end result as ClimateInstance's overlay by the opposite
 * mechanism. No per-texel validity mask either (both Layers instead
 * reserve a NO_DATA byte,
 * see prep_bridge.py's encode_sparse -- a per-VARIABLE distinction the
 * older mask mechanism can't express, since Monthly mixes globally-valid
 * atmosphere variables with ocean-only ones).
 */
export class ValdesInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  /** Opaque backing sphere, always painting paleogeography-scotese's
   *  shaded-relief hillshade -- see RELIEF_FILL_R's doc comment for why this
   *  exists (blocking Vector Streak/Glyph bleed-through wherever `field`
   *  discards, and reading as an actual globe rather than a flat grey/white
   *  fill while doing it, see ADR-0015). Absent gracefully (mesh stays
   *  invisible) if no paleogeography model happens to be in the archive. */
  readonly reliefFill = new DepthSlice(RELIEF_FILL_R);
  /** Reused verbatim from the wind mechanism (see core/windGlyphs.ts) for
   *  WHICHEVER Vector Field is currently active -- Wind, Ocean Surface
   *  Current, Sea-Ice Drift or Ocean Current, never more than one at a
   *  time, see CONTEXT.md's Vector Field entry. */
  readonly vectorGlyphs = new WindGlyphs();
  readonly vectorStreaks = new WindStreaks();
  readonly ui: ValdesUI;
  coastlines: Coastlines | null = null;

  readonly view: ValdesViewState = {
    layer: 'monthly', variable: '', age: 0, layerIndex: 0,
    clipMin: 0, clipMax: 1, vectorFieldId: null,
    showVector: DEFAULT_VECTOR_VISIBLE, vectorStyle: DEFAULT_VECTOR_STYLE,
    vectorScale: DEFAULT_VECTOR_SCALE, vectorDensity: DEFAULT_VECTOR_DENSITY,
    fieldOpacity: DEFAULT_FIELD_OPACITY,
  };

  private sources!: Record<ValdesLayer, LayerSource>;
  /** Separate from `view.layer` -- lil-gui writes straight into `view`
   *  before firing onChange, so comparing against it would always read as
   *  "already there." Same lesson as ClimateInstance's `activeLayer`. */
  private activeLayer!: ValdesLayer;
  private ageToken = 0;
  private vectorToken = 0;
  private availableVectorFields: VectorFieldInfo[] = [];
  private vectorUVar: VariableInfo | null = null;
  private vectorVVar: VariableInfo | null = null;
  private vectorUTex: Data3DTexture | null = null;
  private vectorVTex: Data3DTexture | null = null;
  private streakActive = false;
  private projectionMode: ProjectionMode = 'globe';
  /** The one paleogeography source, if the archive has one -- see boot().
   *  Only ever read for its 'hillshade' variable/frames; never picked or
   *  shown as a primary Layer (Valdes/BRIDGE has no Paleogeography Layer of
   *  its own, see ADR-0008). */
  private paleogeographySource: LayerSource | null = null;
  private reliefResolutionId: string | null = null;
  private reliefToken = 0;

  constructor(
    private camera: Camera,
    private readonly deps: ValdesInstanceDeps,
    private readonly hooks: ValdesInstanceHooks,
    label: string,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0);
    // `transparent` only enables blending -- at uOpacity 1 (the default)
    // it changes nothing on screen, so this is safe to set unconditionally
    // rather than toggling it in step with applyFieldOpacity().
    this.field.material.transparent = true;
    this.scene.add(this.field.mesh);

    this.reliefFill.setDepthKm(0);
    this.scene.add(this.reliefFill.mesh);

    this.vectorGlyphs.mesh.renderOrder = 4;
    this.scene.add(this.vectorGlyphs.mesh);
    this.vectorStreaks.mesh.renderOrder = 4;
    this.scene.add(this.vectorStreaks.mesh);

    this.ui = new ValdesUI(this.view, {
      onLayer: (l) => void this.setLayer(l),
      onVariable: (id) => void this.setVariable(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onLayerIndex: (i) => this.applyLayerIndex(i),
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onVectorField: (id) => void this.setVectorField(id),
      onShowVector: (v) => this.setVectorVisible(v),
      onVectorStyle: (v) => this.setVectorStyle(v),
      onVectorScale: (v) => this.setVectorScale(v),
      onVectorDensity: (v) => this.setVectorDensity(v),
      onFieldOpacity: (v) => this.applyFieldOpacity(v),
    }, label, () => this.hooks.onRemove(this));
  }

  get manifest(): Manifest { return this.sources[this.view.layer].manifest; }

  get variable(): VariableInfo {
    const src = this.sources[this.view.layer];
    return src.variables.find((v) => v.id === src.variableId) ?? src.variables[0];
  }

  get layer(): ValdesLayer { return this.view.layer; }

  private updateCredit(): void {
    const parts = [this.manifest.source];
    if (this.coastlines) parts.push(COASTLINE_CREDIT);
    this.ui.setCredit(parts.join(' · '));
  }

  async boot(monthlyModelId: string, oceanDepthModelId: string): Promise<void> {
    this.ui.setStatus('loading...');
    const [monthly, oceanDepth] = await Promise.all([
      this.loadSource(monthlyModelId), this.loadSource(oceanDepthModelId),
    ]);
    this.sources = { monthly, ocean_depth: oceanDepth };

    if (this.deps.coastlineData) {
      const maskTexture = createMaskTexture();
      this.coastlines = new Coastlines(
        this.deps.coastlineData.lines, this.deps.coastlineData.table, maskTexture,
      );
      this.coastlines.setMaskEnabled(false);
      this.coastlines.landVisible = false;
      this.scene.add(this.coastlines.lines, this.coastlines.land);
      this.coastlines.setAge(0);
    }

    const paleogeographyId = this.deps.archive.models.find((m) => m.type === 'paleogeography')?.id;
    if (paleogeographyId) {
      this.paleogeographySource = await this.loadSource(paleogeographyId);
      const shadeVar = this.paleogeographySource.variables.find((v) => v.id === HILLSHADE_VARIABLE_ID);
      if (shadeVar) {
        // Highest available grid, not manifest.default_resolution -- same
        // "sharpest detail available, not whichever prep run wrote the
        // manifest last" reasoning as ClimateInstance.boot()'s own
        // activeResolution pick, since "hi res" is the whole point of using
        // this over the field's own coarse BRIDGE grid as a fill.
        this.reliefResolutionId = this.paleogeographySource.manifest.resolutions.reduce(
          (best, r) => (r.nlon * r.nlat > best.nlon * best.nlat ? r : best),
        ).id;
        const cm = this.deps.colormaps[shadeVar.default_colormap];
        this.reliefFill.material.uniforms.uColormap.value = makeColormapTexture(cm.colors);
        this.reliefFill.mesh.visible = true;
        await this.loadReliefFrame(0);
        this.ui.setReliefAvailable(true);
      }
    }

    await this.switchLayer('monthly', 0);
    this.resolveVectorFields();
    this.ui.setVectorFields(this.availableVectorFields);
    if (this.availableVectorFields.length > 0) {
      await this.setVectorField(this.availableVectorFields[0].id);
      this.setVectorVisible(DEFAULT_VECTOR_VISIBLE);
    }

    const ages = this.manifest.frames.map((f) => f.age_ma);
    this.ui.setAgeRange(Math.min(...ages), Math.max(...ages));
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.applyLayerIndex(0);
    this.ui.setAge(this.view.age);
    this.ui.setStatus('');
    this.updateCredit();
    this.setProjection(this.projectionMode, this.camera);
    this.hooks.onDisplayChange?.(this);
  }

  applyLayout(rect: Rect): void {
    this.ui.setRect(rect);
  }

  setProjection(mode: ProjectionMode, camera: Camera): void {
    this.camera = camera;
    this.projectionMode = mode;
    this.field.setProjection(mode);
    this.reliefFill.setProjection(mode);
    if (this.coastlines) this.coastlines.lines.visible = mode === 'globe';
    this.vectorGlyphs.setProjection(mode);
    this.vectorStreaks.setProjection(mode);
    if (this.view.vectorFieldId) this.refreshVectorGlyphs();
    this.applyVectorVisibility();
  }

  private async loadSource(modelId: string): Promise<LayerSource> {
    const entry = this.deps.archive.models.find((m) => m.id === modelId);
    if (!entry) throw new Error(`no model in archive with id ${modelId}`);
    const manifest = await loadManifest(this.deps.archiveBase, entry.path);
    const variableId = manifest.default_variable;
    const variable = manifest.variables.find((v) => v.id === variableId) ?? manifest.variables[0];
    const cm = this.deps.colormaps[variable.default_colormap];
    return {
      manifest,
      variables: manifest.variables,
      variableId: variable.id,
      frames: new FrameCache(this.deps.archiveBase),
      colormapTexture: makeColormapTexture(cm.colors),
    };
  }

  async setLayer(layer: ValdesLayer): Promise<void> {
    if (layer === this.activeLayer) return;
    await this.switchLayer(layer, this.view.age);
    this.resolveVectorFields();
    this.ui.setVectorFields(this.availableVectorFields);
    if (this.availableVectorFields.length > 0) {
      await this.setVectorField(this.availableVectorFields[0].id);
    } else {
      this.view.vectorFieldId = null;
      this.vectorUTex = null;
      this.vectorVTex = null;
      this.applyVectorVisibility();
    }
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    // A layerIndex picked on the OTHER layer can sit outside this one's own
    // range (Monthly's 0-12 vs Ocean Depth's 0-19) -- reset to 0 rather than
    // clamp into a misleading "same number, different meaning" position.
    this.applyLayerIndex(0);
    this.ui.refreshDisplay();
    this.updateCredit();
    this.hooks.onDisplayChange?.(this);
  }

  private async switchLayer(layer: ValdesLayer, age: number): Promise<void> {
    this.activeLayer = layer;
    this.view.layer = layer;
    const src = this.sources[layer];
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    setNoDataSentinel(this.field.material, src.manifest.no_data_sentinel);
    setNoDataStyle(this.field.material, 'transparent');
    this.ui.setLayerAxis(layer, src.manifest.depth_labels_km);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(layer, age);
  }

  private clampToActiveDepthRange(index: number): number {
    const m = this.manifest;
    return Math.min(Math.max(index, m.depth_min_km), m.depth_max_km);
  }

  async setVariable(variableId: string): Promise<void> {
    const src = this.sources[this.view.layer];
    if (variableId === src.variableId) return;
    src.variableId = variableId;
    this.view.variable = variableId;
    const cm = this.deps.colormaps[this.variable.default_colormap];
    src.colormapTexture = makeColormapTexture(cm.colors);
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.view.layer, this.view.age);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.hooks.onDisplayChange?.(this);
  }

  /** Re-resolve the active Layer's OWN declared Vector Fields -- Monthly has
   *  three (Wind, Ocean Surface Current, Sea-Ice Drift), Ocean Depth has
   *  one (Ocean Current). Does not itself pick or fetch one -- see
   *  setVectorField(), called separately by boot()/setLayer() with the
   *  first available field as the default. */
  private resolveVectorFields(): void {
    this.availableVectorFields = this.sources[this.view.layer].manifest.vector_fields ?? [];
  }

  /** Switch which Vector Field (or none) is overlaid -- single-select,
   *  mutually exclusive, see CONTEXT.md's Vector Field entry and
   *  docs/adr/0012. `id` must be one of `availableVectorFields`, or null to
   *  turn the overlay off entirely without changing the Layer/scalar
   *  field. */
  async setVectorField(id: string | null): Promise<void> {
    this.view.vectorFieldId = id;
    const field = id ? this.availableVectorFields.find((f) => f.id === id) ?? null : null;
    if (!field) {
      this.vectorUTex = null;
      this.vectorVTex = null;
      this.vectorUVar = null;
      this.vectorVVar = null;
      this.applyVectorVisibility();
      this.ui.refreshDisplay();
      return;
    }
    const src = this.sources[this.view.layer];
    this.vectorUVar = src.variables.find((v) => v.id === field.u_variable)!;
    this.vectorVVar = src.variables.find((v) => v.id === field.v_variable)!;
    await this.loadVectorFrame(this.view.age);
    this.applyVectorVisibility();
    this.ui.refreshDisplay();
  }

  applyClip(lo: number, hi: number): void {
    const v = this.variable;
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(v, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(v, hi);
    this.field.material.uniforms.uSteps.value = v.categorical ? (v.class_names?.length ?? 0) : 0;
  }

  /** Fade `field` toward `reliefFill` sitting just behind it -- see
   *  ValdesUI's fieldOpacity slider and RELIEF_FILL_R's doc comment. */
  applyFieldOpacity(v: number): void {
    this.view.fieldOpacity = v;
    this.field.material.uniforms.uOpacity.value = v;
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(this.view.layer, age);
    if (this.view.vectorFieldId) void this.loadVectorFrame(age);
    if (this.reliefFill.mesh.visible) void this.loadReliefFrame(age);
    this.ui.setAge(age);
  }

  setVectorVisible(v: boolean): void {
    this.view.showVector = v;
    this.applyVectorVisibility();
  }

  setVectorStyle(style: VectorStyle): void {
    this.view.vectorStyle = style;
    this.applyVectorVisibility();
  }

  private applyVectorVisibility(): void {
    const active = !!this.view.vectorFieldId;
    const glyphVisible = active && this.view.showVector && this.view.vectorStyle === 'glyph';
    const streakVisible = active && this.view.showVector && this.view.vectorStyle === 'streak';
    this.vectorGlyphs.setVisible(glyphVisible);
    if (streakVisible && !this.streakActive) this.vectorStreaks.resetAll();
    this.streakActive = streakVisible;
    this.vectorStreaks.setVisible(streakVisible);
  }

  setVectorScale(v: number): void {
    this.vectorGlyphs.setSize(v);
    this.vectorStreaks.setSize(v);
    this.refreshVectorGlyphs();
  }

  setVectorDensity(v: number): void {
    this.vectorGlyphs.setDensity(v);
    this.vectorStreaks.setDensity(v);
    this.refreshVectorGlyphs();
  }

  /** Select a position on the shared layer-index axis -- calendar month for
   *  Monthly, real (non-uniformly-spaced, see prep_bridge.py) depth level
   *  for Ocean Depth, see CONTEXT.md's Month/Ocean Depth entries. */
  applyLayerIndex(index: number): void {
    this.view.layerIndex = index;
    this.field.setDepthKm(this.clampToActiveDepthRange(index));
    if (this.view.vectorFieldId) this.refreshVectorGlyphs();
    this.ui.setLayerIndex(index);
  }

  private async loadFrame(layer: ValdesLayer, age: number): Promise<void> {
    const src = this.sources[layer];
    const variableId = src.variableId;
    const token = ++this.ageToken;

    const frame = nearestFrame(src.manifest, age);
    src.frames.pin(src.manifest, variableId, frame.id);
    const tex = await src.frames.get(src.manifest, variableId, frame.id);
    if (token !== this.ageToken || layer !== this.view.layer || variableId !== src.variableId) return;
    this.applyVolume(src.manifest, tex);
    src.frames.prefetchNeighbours(src.manifest, variableId, frame.id);
  }

  private applyVolume(
    manifest: Manifest, tex: Data3DTexture, resolutionId: string = manifest.default_resolution,
    mat: ShaderMaterial = this.field.material,
  ): void {
    const res = manifest.resolutions.find((r) => r.id === resolutionId)!;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = manifest.depth_max_km;
  }

  /** Fetch the hillshade frame nearest `age` for reliefFill -- independent
   *  of `view.layer`/`view.variable`, same as ClimateInstance's own
   *  loadOverlayFrame(), which this mirrors. A no-op until boot() finds a
   *  paleogeography model and turns reliefFill on in the first place. */
  private async loadReliefFrame(age: number): Promise<void> {
    if (!this.paleogeographySource || !this.reliefResolutionId) return;
    const src = this.paleogeographySource;
    const resolutionId = this.reliefResolutionId;
    const token = ++this.reliefToken;

    const frame = nearestFrame(src.manifest, age);
    const tex = await src.frames.get(src.manifest, HILLSHADE_VARIABLE_ID, frame.id, resolutionId);
    if (token !== this.reliefToken) return;
    this.applyVolume(src.manifest, tex, resolutionId, this.reliefFill.material);
  }

  private async loadVectorFrame(age: number): Promise<void> {
    const src = this.sources[this.view.layer];
    const field = this.availableVectorFields.find((f) => f.id === this.view.vectorFieldId);
    if (!field) return;
    const token = ++this.vectorToken;

    const frame = nearestFrame(src.manifest, age);
    const [uTex, vTex] = await Promise.all([
      src.frames.get(src.manifest, field.u_variable, frame.id),
      src.frames.get(src.manifest, field.v_variable, frame.id),
    ]);
    if (token !== this.vectorToken) return;
    this.vectorUTex = uTex;
    this.vectorVTex = vTex;
    this.refreshVectorGlyphs();
  }

  /** The current layerIndex's (nlat*nlon) plane of the active Vector
   *  Field's U/V textures -- shared by refreshVectorGlyphs() and tick(),
   *  both reading the exact same slice. Null when no vector frame has
   *  loaded yet. */
  private currentVectorPlane(): {
    uData: Uint8Array; vData: Uint8Array; nlon: number; nlat: number;
    sentinel?: number; speedScale: number;
  } | null {
    if (!this.vectorUTex || !this.vectorVTex) return null;
    const manifest = this.sources[this.view.layer].manifest;
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    const plane = res.nlon * res.nlat;
    const offset = this.view.layerIndex * plane;
    const uData = this.vectorUTex.image.data as Uint8Array;
    const vData = this.vectorVTex.image.data as Uint8Array;
    const field = this.availableVectorFields.find((f) => f.id === this.view.vectorFieldId);
    return {
      uData: uData.subarray(offset, offset + plane),
      vData: vData.subarray(offset, offset + plane),
      nlon: res.nlon,
      nlat: res.nlat,
      sentinel: manifest.no_data_sentinel,
      speedScale: field?.display_speed_scale ?? 1,
    };
  }

  private refreshVectorGlyphs(): void {
    const plane = this.currentVectorPlane();
    if (!plane || !this.vectorUVar || !this.vectorVVar) return;
    this.vectorGlyphs.update(
      plane.uData, plane.vData, plane.nlon, plane.nlat, this.vectorUVar, this.vectorVVar,
      plane.sentinel, plane.speedScale,
    );
  }

  tick(dt: number): void {
    if (!this.streakActive) return;
    const plane = this.currentVectorPlane();
    if (!plane || !this.vectorUVar || !this.vectorVVar) return;
    this.vectorStreaks.update(
      dt, plane.uData, plane.vData, plane.nlon, plane.nlat, this.vectorUVar, this.vectorVVar,
      plane.sentinel, plane.speedScale,
    );
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.ui.dispose();
    this.coastlines?.dispose();
  }
}
