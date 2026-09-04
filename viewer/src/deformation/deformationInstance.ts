import {
  Scene, Vector3, type Camera, type Data3DTexture, type Texture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import {
  setMaskMode, setNoDataSentinel, setNoDataStyle as applyNoDataStyleUniform,
  type NoDataStyle,
} from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, LAND_R_UNDER_SURFACE, type CoastlineData } from '../core/coastlines';
import {
  FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { DeformationUI, type DeformationViewState } from './deformationUi';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';

export type { NoDataStyle };

// Continent fill sits UNDER the data sphere (LAND_R_UNDER_SURFACE), showing
// through wherever the active Variable has no value there -- unlike the
// mantle/climate viewers, where land fill sits ABOVE the data as a
// substitute for missing topography. A plain medium grey, not PALETTE.land
// (tuned for that other role, against a different backdrop) -- neutral
// enough not to compete with either colour ramp end.
const LAND_FILL_COLOR = 0x808080;

export interface DeformationInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
}

/** One pipeline run (Muller2019, Cao2024, ...) this viewer can switch
 *  between -- a Deformation + Age & Heat Flux Model pair sharing one
 *  variable vocabulary (see prep_deformation.py's DEFORMATION_VARS), plus
 *  the coastlines reconstructed under THAT run's own native rotations
 *  (ADR-0004: a run's continents must not be shown under a different
 *  model's rotation file). `coastlineData` is null if that run's native
 *  coastlines were not exported -- the globe still works, just bare. */
export interface ReconstructionConfig {
  id: string;
  label: string;
  deformationModelId: string;
  ageHeatfluxModelId: string;
  coastlineData: CoastlineData | null;
  creditCoastlines: string;
}

/**
 * The two Models this viewer switches between, following the climate
 * viewer's Layer precedent (see CONTEXT.md's Layer entry) rather than a
 * variable-only dropdown: 'ageHeatflux' has a fundamentally different time
 * relationship to the age slider (its data never changes, only the
 * coastlines under it do) and mixing it into one flat variable list would
 * hide that distinction.
 */
export type DeformationLayer = 'deformation' | 'ageHeatflux';

interface LayerSource {
  manifest: Manifest;
  variableId: string;
  frames: FrameCache;
  colormapTexture: Texture;
}

/**
 * One globe showing output of the `defamation` pipeline: a scalar field
 * draped on the whole sphere (like ClimateInstance), toggled between a
 * time-varying Deformation Layer and a static Age & Heat Flux Layer -- see
 * docs/plans/deformation-viewer.md. Deliberately simpler than
 * ClimateInstance: no month axis, no wind/overlay layers, and no multi-globe
 * support (out of scope for v1), so this skips ClimateInstance's `hooks`/
 * `Rect` machinery entirely and just owns one Scene against a fixed camera.
 *
 * Age & Heat Flux is assumed present-day: unlike the mantle viewer's static
 * tomography models (one Frame, but coastlines still scrub freely under it),
 * this Layer's own products carry no per-age reconstruction at all, so
 * setLayer() pins BOTH the data and the coastlines to 0 Ma and hides the age
 * slider entirely rather than leaving a live control with nothing left for
 * it to reconstruct. The Deformation Layer's own age is remembered
 * (`lastDeformationAge`) so a trip through Age & Heat Flux and back doesn't
 * silently reset wherever the user had scrubbed to.
 */
export class DeformationInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  readonly ui: DeformationUI;
  coastlines: Coastlines | null = null;

  readonly view: DeformationViewState = {
    reconstruction: '', layer: 'deformation', variable: '', age: 0, clipMin: 0, clipMax: 1,
    noDataStyle: 'transparent', logScale: false,
  };

  private allSources!: Record<string, Record<DeformationLayer, LayerSource>>;
  private reconstructions!: Record<string, ReconstructionConfig>;
  /** Built lazily on first visit to each reconstruction and kept alive after
   *  that -- rebuilding a Coastlines (land-fill triangulation included) on
   *  every dropdown flip would be wasteful, and data size is not a
   *  constraint for this viewer (see the Cao2024 ingest that prompted
   *  multi-reconstruction support at all). */
  private coastlinesCache: Record<string, Coastlines | null> = {};
  private get sources(): Record<DeformationLayer, LayerSource> {
    return this.allSources[this.view.reconstruction];
  }
  private activeLayer!: DeformationLayer;
  /** Guards a slow fetch for a stale age/layer/variable landing after a
   *  newer one already applied -- same pattern as GlobeInstance.ageToken. */
  private ageToken = 0;
  /** The Deformation Layer's own age, remembered across a trip through Age &
   *  Heat Flux (always pinned to 0 Ma -- see switchLayer()) so returning to
   *  Deformation doesn't silently reset wherever the user had scrubbed to. */
  private lastDeformationAge = 0;

  constructor(
    private camera: Camera,
    private readonly deps: DeformationInstanceDeps,
  ) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // no depth/month axis in this manifest shape (ndepth=1)
    this.scene.add(this.field.mesh);

    this.ui = new DeformationUI(this.view, {
      onReconstruction: (id) => void this.setReconstruction(id),
      onLayer: (l) => void this.setLayer(l),
      onVariable: (id) => void this.setVariable(id),
      onAge: (age) => this.applyAge(age),
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onNoDataStyle: (style) => this.setNoDataStyle(style),
    });
  }

  get manifest(): Manifest { return this.sources[this.view.layer].manifest; }

  get variable(): VariableInfo {
    const src = this.sources[this.view.layer];
    return src.manifest.variables.find((v) => v.id === src.variableId) ?? src.manifest.variables[0];
  }

  async boot(reconstructions: ReconstructionConfig[]): Promise<void> {
    this.ui.setStatus('loading...');
    this.reconstructions = Object.fromEntries(reconstructions.map((r) => [r.id, r]));

    const entries = await Promise.all(reconstructions.map(async (r) => {
      const [deformationSrc, ageHeatfluxSrc] = await Promise.all([
        this.loadSource(r.deformationModelId),
        this.loadSource(r.ageHeatfluxModelId),
      ]);
      return [r.id, { deformation: deformationSrc, ageHeatflux: ageHeatfluxSrc }] as const;
    }));
    this.allSources = Object.fromEntries(entries);

    this.view.reconstruction = reconstructions[0].id;
    this.ui.setReconstructions(reconstructions.map((r) => ({ id: r.id, label: r.label })));
    this.activateCoastlines(this.view.reconstruction);

    setMaskMode(this.field.material, 'none'); // paints the WHOLE sphere
    applyNoDataStyleUniform(this.field.material, this.view.noDataStyle);

    await this.switchLayer('deformation', 0);
    this.coastlines?.setAge(0);

    // The age slider's range is the Deformation Layer's own Frame span --
    // the static layer has exactly one Frame and stays reachable at any age
    // (see the class doc comment), so it must not narrow this range.
    const ages = this.sources.deformation.manifest.frames.map((f) => f.age_ma);
    this.ui.setAgeRange(Math.min(...ages), Math.max(...ages));

    this.ui.setAgeControlVisible(true); // boots on the Deformation Layer
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.ui.setTimeInfo(`age ${this.view.age.toFixed(0)} Ma`);
    this.ui.setStatus('');
    this.updateCredit();
  }

  /** Swap which reconstruction's Coastlines are in the scene, building and
   *  caching one on first visit (see coastlinesCache's doc comment). A run
   *  with no exported native coastlines (coastlineData null) leaves the
   *  globe bare rather than falling back to a different run's rotations --
   *  ADR-0004 is specifically about not doing that. */
  private activateCoastlines(id: string): void {
    if (this.coastlines) this.scene.remove(this.coastlines.lines, this.coastlines.land);

    const cfg = this.reconstructions[id];
    if (!cfg.coastlineData) {
      this.coastlines = null;
      return;
    }

    let built = this.coastlinesCache[id];
    if (!built) {
      // Blank, permanently disabled mask -- there is no cutaway concept
      // here, but Coastlines' shader still declares the uniform. Same
      // precedent as ClimateInstance.
      const maskTexture = createMaskTexture();
      built = new Coastlines(
        cfg.coastlineData.lines, cfg.coastlineData.table, maskTexture,
        LAND_R_UNDER_SURFACE, LAND_FILL_COLOR,
      );
      built.setMaskEnabled(false);
      // Filled, unlike ClimateInstance's outline-only choice: both Layers
      // here are mostly no-data (~92% for Deformation, ~51% for Age & Heat
      // Flux -- see the plan doc), so a plain grey landmass underneath gives
      // the empty parts of the globe a legible shape instead of a void. Sits
      // BELOW the field sphere (LAND_R_UNDER_SURFACE, above), so it only
      // shows through where the field actually has nothing to draw.
      built.landVisible = true;
      this.coastlinesCache[id] = built;
    }
    this.coastlines = built;
    this.scene.add(this.coastlines.lines, this.coastlines.land);
  }

  /** Switch which pipeline run drives both Layers. Age carries over,
   *  clamped into the new run's own Frame span (Muller2019 spans 0-240 Ma,
   *  Cao2024 0-1000 Ma) -- same "don't silently reset the user's scrub
   *  position" reasoning as setLayer()'s lastDeformationAge. Each
   *  reconstruction's LayerSource keeps its own persistent variableId (set
   *  the first time that reconstruction is loaded, changed only by explicit
   *  setVariable() calls) -- switching does NOT try to carry the current
   *  variable across runs, mirroring how switchLayer() already treats the
   *  Deformation <-> Age & Heat Flux Layers as independent in that respect. */
  async setReconstruction(id: string): Promise<void> {
    if (id === this.view.reconstruction) return;
    this.view.reconstruction = id;
    this.activateCoastlines(id);

    const ages = this.sources.deformation.manifest.frames.map((f) => f.age_ma);
    const ageMin = Math.min(...ages);
    const ageMax = Math.max(...ages);
    this.ui.setAgeRange(ageMin, ageMax);

    const layer = this.view.layer;
    if (layer === 'deformation') {
      this.lastDeformationAge = Math.min(Math.max(this.lastDeformationAge, ageMin), ageMax);
    }
    const age = layer === 'ageHeatflux' ? 0 : this.lastDeformationAge;
    this.view.age = age;
    this.coastlines?.setAge(age);

    await this.switchLayer(layer, age);

    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.ui.setTimeInfo(layer === 'ageHeatflux' ? 'present day' : `age ${age.toFixed(0)} Ma`);
    this.ui.refreshDisplay();
    this.updateCredit();
  }

  private updateCredit(): void {
    const parts = [this.manifest.source];
    const cfg = this.reconstructions[this.view.reconstruction];
    if (this.coastlines && cfg) parts.push(cfg.creditCoastlines);
    this.ui.setCredit(parts.join(' · '));
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
      variableId: variable.id,
      frames: new FrameCache(this.deps.archiveBase),
      colormapTexture: makeColormapTexture(cm.colors),
    };
  }

  /** Switch which Layer is on screen. The colormap, clip range and no-data
   *  sentinel change with it -- each Model has its own encode range, ramp
   *  and (potentially) sentinel byte -- but age carries over so switching
   *  mid-scrub doesn't reset it. Guarded with `activeLayer`, not
   *  `view.layer`, for the same reason ClimateInstance.setLayer() is: lil-gui
   *  writes the new value into the shared `view` object before firing
   *  onChange. */
  async setLayer(layer: DeformationLayer): Promise<void> {
    if (layer === this.activeLayer) return;
    if (this.activeLayer === 'deformation') this.lastDeformationAge = this.view.age;
    // Age & Heat Flux is assumed present-day: its products (tectonothermal
    // age, heat flux) carry no per-age reconstruction of their own -- see
    // docs/plans/deformation-viewer.md -- so there is no reconstruction
    // control to offer on this Layer, not just a data Frame that happens to
    // be pinned while coastlines still scrub freely (the mantle viewer's
    // static-tomography precedent this class doc comment originally invoked
    // does NOT apply here for that reason).
    const age = layer === 'ageHeatflux' ? 0 : this.lastDeformationAge;
    await this.switchLayer(layer, age);
    this.view.age = age;
    this.coastlines?.setAge(age);
    this.ui.setAgeControlVisible(layer === 'deformation');
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.ui.setTimeInfo(layer === 'ageHeatflux' ? 'present day' : `age ${age.toFixed(0)} Ma`);
    this.ui.refreshDisplay();
    this.updateCredit();
  }

  private async switchLayer(layer: DeformationLayer, age: number): Promise<void> {
    this.activeLayer = layer;
    this.view.layer = layer;
    const src = this.sources[layer];
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    setNoDataSentinel(this.field.material, src.manifest.no_data_sentinel);
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(layer, age);
  }

  async setVariable(variableId: string): Promise<void> {
    const src = this.sources[this.view.layer];
    if (variableId === src.variableId) return;
    src.variableId = variableId;
    this.view.variable = variableId; // keep the dropdown's bound state in sync
                                      // for a programmatic call (real dropdown
                                      // clicks already write this themselves)
    const cm = this.deps.colormaps[this.variable.default_colormap];
    src.colormapTexture = makeColormapTexture(cm.colors);
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.view.layer, this.view.age);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
  }

  applyClip(lo: number, hi: number): void {
    const v = this.variable;
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(v, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(v, hi);
    // Categorical (deformation_style) reuses the existing "discrete contour
    // bands" uSteps uniform -- same mechanism as climate's Koppen.
    this.field.material.uniforms.uSteps.value = v.categorical ? (v.class_names?.length ?? 0) : 0;
  }

  /** No-op on the Age & Heat Flux Layer -- it is assumed present-day with no
   *  reconstruction control at all (see setLayer()'s doc comment), so this
   *  ignores any call that lands while it's active rather than relying
   *  solely on the UI hiding the slider to enforce that. */
  applyAge(age: number): void {
    if (this.view.layer === 'ageHeatflux') return;
    this.view.age = age;
    this.lastDeformationAge = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(this.view.layer, age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
  }

  setNoDataStyle(style: NoDataStyle): void {
    this.view.noDataStyle = style;
    applyNoDataStyleUniform(this.field.material, style);
  }

  private async loadFrame(layer: DeformationLayer, age: number): Promise<void> {
    const src = this.sources[layer];
    const variableId = src.variableId; // captured now -- may change under us
    const token = ++this.ageToken;

    const frame = nearestFrame(src.manifest, age);
    src.frames.pin(src.manifest, variableId, frame.id);
    const tex = await src.frames.get(src.manifest, variableId, frame.id);
    // A layer/variable switch or a newer age can all land after this fetch started.
    if (token !== this.ageToken || layer !== this.view.layer || variableId !== src.variableId) return;
    this.applyVolume(src.manifest, tex);
    src.frames.prefetchNeighbours(src.manifest, variableId, frame.id);
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

  dispose(): void {
    this.ui.dispose();
    for (const c of Object.values(this.coastlinesCache)) c?.dispose();
  }
}
