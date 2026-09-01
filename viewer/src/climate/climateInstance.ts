import {
  Scene, Vector3, type Data3DTexture, type PerspectiveCamera, type ShaderMaterial,
  type Texture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import { setMaskMode } from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, type CoastlineData } from '../core/coastlines';
import { R_SURFACE } from '../core/constants';
import {
  FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';

export interface ClimateInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  coastlineData: CoastlineData | null;
}

// Just clear of the primary field's sphere, same precedent as coastlines.ts's
// LAND_R -- nothing else renders at this radius in climate.html (the
// coastline LAND fill is permanently hidden here, only its outline at a
// larger radius still is drawn), so there's no third thing to collide with.
const OVERLAY_R = R_SURFACE * 1.0006;
export const DEFAULT_OVERLAY_OPACITY = 0.4;
const HILLSHADE_VARIABLE_ID = 'hillshade';

/**
 * The two things this globe can show, plus a shared continent-outline
 * overlay -- all THREE now on the SAME reconstruction lineage (Scotese),
 * unlike an earlier version of this viewer, which draped temperature under
 * Muller et al. coastlines: a different plate model than the one the climate
 * simulations were actually run on, so the continents under the field were
 * subtly wrong at every age but 0 Ma. "Paleogeography" here means a Scotese &
 * Wright (2018) PaleoDEM elevation raster; the overlay is Scotese (2008)
 * continent polygons rotated through time by prep/prep_coastlines.py (reused
 * unchanged, just pointed at Scotese's rotation file instead of Muller's) --
 * there is no Scotese plate-BOUNDARY dataset (subduction/ridge/transform),
 * only these continent outlines.
 */
export type ClimateLayer = 'climate' | 'paleogeography';

interface LayerSource {
  manifest: Manifest;
  variables: VariableInfo[];
  variableId: string;
  frames: FrameCache;
  colormapTexture: Texture;
}

/**
 * One paleoclimate globe: a scalar field draped on the whole sphere, toggled
 * between the climate simulation's own variable(s) and the Scotese
 * paleogeography raster. Deliberately NOT a GlobeInstance -- that class
 * carries cutaway/isosurface/sinking-rate machinery with no climate
 * equivalent. What IS reused (verbatim): the DepthSlice "paint the whole
 * sphere from one layer of a Data3DTexture" mechanism and FrameCache. A
 * paleogeography frame is a depth slice with ndepth=1; a climate frame's
 * "depth" is a calendar month (ndepth=12, see applyMonth()) -- see
 * prep/prep_climate.py and prep/prep_paleogeography.py. A THIRD DepthSlice
 * (`overlay`) draws paleogeography's shaded relief translucently on top of
 * whichever primary field is active, independent of it -- see
 * setOverlayOpacity() and loadOverlayFrame().
 */
export class ClimateInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  /** Shaded-relief overlay: always sourced from paleogeography-scotese's
   *  'hillshade' variable, independent of whichever layer/variable is
   *  primary -- see prep_paleogeography.py and setOverlayOpacity(). */
  readonly overlay = new DepthSlice(OVERLAY_R);
  coastlines: Coastlines | null = null;

  private sources!: Record<ClimateLayer, LayerSource>;
  private activeLayer: ClimateLayer = 'climate';
  private currentAge = 0;
  private currentMonth = 0;
  /** Guards a slow fetch for a stale age/layer landing after a newer one
   *  already applied -- same pattern as GlobeInstance.ageToken. */
  private ageToken = 0;
  private overlayToken = 0;
  private hasOverlay = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly deps: ClimateInstanceDeps,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // month 0, until applyMonth() picks a real one
    this.scene.add(this.field.mesh);

    this.overlay.mesh.visible = true;
    this.overlay.mesh.renderOrder = 2; // after the field (1), before coastline outlines (3)
    this.overlay.setDepthKm(0); // hillshade has no month/depth axis of its own
    setMaskMode(this.overlay.material, 'none');
    this.overlay.material.transparent = true; // the whole point is being see-through
    this.overlay.material.uniforms.uOpacity.value = DEFAULT_OVERLAY_OPACITY;
    // Full encoded range, unclipped -- there's nothing to clip here, only
    // opacity to dial. See loadOverlayFrame() for where the colormap/volume
    // uniforms actually get set, once the paleogeography source has loaded.
    this.overlay.material.uniforms.uClipLo.value = 0;
    this.overlay.material.uniforms.uClipHi.value = 1;
    this.scene.add(this.overlay.mesh);
  }

  get manifest(): Manifest { return this.sources[this.activeLayer].manifest; }

  get variable(): VariableInfo {
    const src = this.sources[this.activeLayer];
    return src.variables.find((v) => v.id === src.variableId) ?? src.variables[0];
  }

  get layer(): ClimateLayer { return this.activeLayer; }

  async boot(climateModelId: string, paleogeographyModelId: string): Promise<void> {
    const [climate, paleogeography] = await Promise.all([
      this.loadSource(climateModelId),
      this.loadSource(paleogeographyModelId),
    ]);
    this.sources = { climate, paleogeography };

    if (this.deps.coastlineData) {
      // Blank, permanently disabled mask: there is no cutaway concept here,
      // but Coastlines' shader still declares the uniform -- see the same
      // precedent in the field material (depthSlice.ts).
      const maskTexture = createMaskTexture();
      this.coastlines = new Coastlines(
        this.deps.coastlineData.lines, this.deps.coastlineData.table, maskTexture,
      );
      this.coastlines.setMaskEnabled(false);
      // Outline only, never the filled land polygon: unlike the tomography
      // viewer (where the fill substitutes for missing data over land),
      // BOTH layers here already colour the whole sphere -- an opaque land
      // fill would just paint over real temperature/elevation data.
      this.coastlines.landVisible = false;
      this.scene.add(this.coastlines.lines, this.coastlines.land);
      this.coastlines.setAge(0);
    }

    const shadeVar = this.sources.paleogeography.variables.find(
      (v) => v.id === HILLSHADE_VARIABLE_ID,
    );
    this.hasOverlay = !!shadeVar;
    if (shadeVar) {
      const cm = this.deps.colormaps[shadeVar.default_colormap];
      this.overlay.material.uniforms.uColormap.value = makeColormapTexture(cm.colors);
    }

    await this.switchLayer('climate', 0);
    if (this.hasOverlay) await this.loadOverlayFrame(0);
  }

  private async loadSource(modelId: string): Promise<LayerSource> {
    const entry = this.deps.archive.models.find((m) => m.id === modelId);
    if (!entry) throw new Error(`no model in archive with id ${modelId}`);
    const manifest = await loadManifest(this.deps.archiveBase, entry.path);
    const variableId = manifest.default_variable;
    const variable = manifest.variables.find((v) => v.id === variableId)
      ?? manifest.variables[0];
    const cm = this.deps.colormaps[variable.default_colormap];
    return {
      manifest,
      variables: manifest.variables,
      variableId: variable.id,
      frames: new FrameCache(this.deps.archiveBase),
      colormapTexture: makeColormapTexture(cm.colors),
    };
  }

  /** Switch which loaded source is on screen. The colormap and clip range
   *  change with it -- each variable has its own encode range and ramp -- but
   *  the age carries over so switching layers mid-scrub doesn't reset it. */
  async setLayer(layer: ClimateLayer): Promise<void> {
    if (layer === this.activeLayer) return;
    await this.switchLayer(layer, this.currentAge);
  }

  private async switchLayer(layer: ClimateLayer, age: number): Promise<void> {
    this.activeLayer = layer;
    const src = this.sources[layer];
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(layer, age);
  }

  /** Switch which variable of the ACTIVE layer's model is on screen -- no
   *  manifest reload, just a different variable id fetched from the same
   *  FrameCache (which already keys frames by variable, see volume.ts). */
  async setVariable(variableId: string): Promise<void> {
    const src = this.sources[this.activeLayer];
    if (variableId === src.variableId) return;
    src.variableId = variableId;
    const cm = this.deps.colormaps[this.variable.default_colormap];
    src.colormapTexture = makeColormapTexture(cm.colors);
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.activeLayer, this.currentAge);
  }

  applyClip(lo: number, hi: number): void {
    const v = this.variable;
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(v, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(v, hi);
  }

  applyAge(age: number): void {
    this.currentAge = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(this.activeLayer, age);
    if (this.hasOverlay) void this.loadOverlayFrame(age);
  }

  setOverlayOpacity(v: number): void {
    this.overlay.material.uniforms.uOpacity.value = v;
  }

  /** Select a month (0-11) on the shared "layer axis" -- see prep_climate.py.
   *  Deliberately layer-agnostic: paleogeography's manifest is still
   *  ndepth=1, so any month value clamps harmlessly onto its one layer via
   *  the shader's existing depth clamp. No branching needed here. */
  applyMonth(month: number): void {
    this.currentMonth = month;
    this.field.setDepthKm(month);
  }

  private async loadFrame(layer: ClimateLayer, age: number): Promise<void> {
    const src = this.sources[layer];
    const variableId = src.variableId; // captured now -- src.variableId may change under us
    const token = ++this.ageToken;

    const frame = nearestFrame(src.manifest, age);
    src.frames.pin(src.manifest, variableId, frame.id);
    const tex = await src.frames.get(src.manifest, variableId, frame.id);
    // A layer/variable switch or a newer age can all land after this fetch started.
    if (token !== this.ageToken || layer !== this.activeLayer || variableId !== src.variableId) return;
    this.applyVolume(src.manifest, tex);
    src.frames.prefetchNeighbours(src.manifest, variableId, frame.id);
  }

  private applyVolume(
    manifest: Manifest, tex: Data3DTexture, mat: ShaderMaterial = this.field.material,
  ): void {
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = manifest.depth_max_km;
  }

  /** Fetch the hillshade frame nearest `age` and apply it to the overlay
   *  mesh, independent of `activeLayer`/`variableId` -- the overlay always
   *  tracks the paleogeography source's own 'hillshade' variable. Mirrors
   *  loadFrame()'s stale-fetch guard with its own token. */
  private async loadOverlayFrame(age: number): Promise<void> {
    const src = this.sources.paleogeography;
    const token = ++this.overlayToken;

    const frame = nearestFrame(src.manifest, age);
    const tex = await src.frames.get(src.manifest, HILLSHADE_VARIABLE_ID, frame.id);
    if (token !== this.overlayToken) return;
    this.applyVolume(src.manifest, tex, this.overlay.material);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }
}
