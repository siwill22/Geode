import {
  Scene, Vector3, type Data3DTexture, type PerspectiveCamera, type Texture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import { createMaskTexture } from '../core/mask';
import { Coastlines, type CoastlineData } from '../core/coastlines';
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
  variable: VariableInfo;
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
 * climate or paleogeography frame IS a depth slice with ndepth=1 -- see
 * prep/prep_climate.py and prep/prep_paleogeography.py.
 */
export class ClimateInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  coastlines: Coastlines | null = null;

  private sources!: Record<ClimateLayer, LayerSource>;
  private activeLayer: ClimateLayer = 'climate';
  private currentAge = 0;
  /** Guards a slow fetch for a stale age/layer landing after a newer one
   *  already applied -- same pattern as GlobeInstance.ageToken. */
  private ageToken = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly deps: ClimateInstanceDeps,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // the manifest's one layer, always
    this.scene.add(this.field.mesh);
  }

  get manifest(): Manifest { return this.sources[this.activeLayer].manifest; }

  get variable(): VariableInfo { return this.sources[this.activeLayer].variable; }

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

    await this.switchLayer('climate', 0);
  }

  private async loadSource(modelId: string): Promise<LayerSource> {
    const entry = this.deps.archive.models.find((m) => m.id === modelId);
    if (!entry) throw new Error(`no model in archive with id ${modelId}`);
    const manifest = await loadManifest(this.deps.archiveBase, entry.path);
    const variable = manifest.variables.find((v) => v.id === manifest.default_variable)
      ?? manifest.variables[0];
    const cm = this.deps.colormaps[variable.default_colormap];
    return {
      manifest,
      variable,
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
    this.applyClip(src.variable.default_clip_min, src.variable.default_clip_max);
    await this.loadFrame(layer, age);
  }

  applyClip(lo: number, hi: number): void {
    const src = this.sources[this.activeLayer];
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(src.variable, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(src.variable, hi);
  }

  applyAge(age: number): void {
    this.currentAge = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(this.activeLayer, age);
  }

  private async loadFrame(layer: ClimateLayer, age: number): Promise<void> {
    const src = this.sources[layer];
    const token = ++this.ageToken;

    const frame = nearestFrame(src.manifest, age);
    src.frames.pin(src.manifest, src.variable.id, frame.id);
    const tex = await src.frames.get(src.manifest, src.variable.id, frame.id);
    // A layer switch or a newer age can both land after this fetch started.
    if (token !== this.ageToken || layer !== this.activeLayer) return;
    this.applyVolume(src.manifest, tex);
    src.frames.prefetchNeighbours(src.manifest, src.variable.id, frame.id);
  }

  private applyVolume(manifest: Manifest, tex: Data3DTexture): void {
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    const mat = this.field.material;
    mat.uniforms.uVolume.value = tex;
    (mat.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    mat.uniforms.uDepthMin.value = manifest.depth_min_km;
    mat.uniforms.uDepthMax.value = manifest.depth_max_km;
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }
}
