import {
  Vector3, Vector2, Raycaster, Scene, type Camera, type Data3DTexture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import {
  setMaskMode, setNoDataSentinel, setNoDataStyle as applyNoDataStyleUniform,
  type NoDataStyle,
} from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, LAND_R_UNDER_SURFACE, type CoastlineData } from '../core/coastlines';
import {
  FrameCache, makeColormapTexture, nearestFrame, physicalToEncoded, texelToPhysical,
  texelIndex, cellCenter,
} from '../core/volume';
import { vec3ToLonLat, type LonLat } from '../core/constants';
import { GlobeUI, type GlobeViewState, type GlobeTool } from './globeUi';
import type { CellSample } from './queryPointSample';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';

export type { NoDataStyle };

// Continent fill sits UNDER the data sphere (LAND_R_UNDER_SURFACE), showing
// through wherever the active Variable has no value there -- same choice as
// deformation/deformationInstance.ts, for the same reason: a fixed-model
// generated viewer has no idea in advance whether its Model is sparse.
const LAND_FILL_COLOR = 0x808080;

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

  readonly view: GlobeViewState = {
    variable: '', age: 0, clipMin: 0, clipMax: 1, noDataStyle: 'transparent', logScale: false,
  };

  private frames: FrameCache;
  private ageToken = 0;
  private raycaster = new Raycaster();

  get manifest(): Manifest { return this.deps.manifest; }

  get variable(): VariableInfo {
    return this.manifest.variables.find((v) => v.id === this.view.variable) ?? this.manifest.variables[0];
  }

  constructor(private camera: Camera, private readonly deps: GlobeInstanceDeps) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // whole-sphere paint, no depth axis in this wrapper's manifests
    this.scene.add(this.field.mesh);
    this.frames = new FrameCache(deps.archiveBase);

    this.ui = new GlobeUI(this.view, {
      onVariable: (id) => void this.setVariable(id),
      onAge: (age) => this.applyAge(age),
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onNoDataStyle: (style) => this.setNoDataStyle(style),
    }, deps.tools, deps.title);

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
    applyNoDataStyleUniform(this.field.material, this.view.noDataStyle);
    setNoDataSentinel(this.field.material, this.manifest.no_data_sentinel);

    this.view.variable = this.manifest.default_variable;
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

    await this.loadFrame(this.view.age);
    this.coastlines?.setAge(this.view.age);
    this.ui.setTimeInfo(this.manifest.frames.length > 1 ? `age ${this.view.age.toFixed(0)} Ma` : '');
    this.ui.setCredit([this.manifest.source, this.deps.creditCoastlines].filter(Boolean).join(' · '));
    this.ui.setStatus('');
  }

  async setVariable(variableId: string): Promise<void> {
    if (variableId === this.view.variable) return;
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
  }

  setNoDataStyle(style: NoDataStyle): void {
    this.view.noDataStyle = style;
    applyNoDataStyleUniform(this.field.material, style);
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
   * The `query-point` tool: raycast a click against the field sphere and
   * report the CURRENTLY-DISPLAYED frame's value there. Deliberately reads
   * only the texture already bound to the material -- no network fetch --
   * so this stays instant regardless of how many Frames the Model has (a
   * long deformation run can have ~1000; fetching all of them per click,
   * the way core/queryPoint.ts's Age Series does for a dedicated
   * time-series panel, would not be). Returns null if the click missed the
   * globe or no frame is loaded yet.
   */
  pickPoint(ndcX: number, ndcY: number): CellSample | null {
    if (!this.ui.queryPointEnabled) return null;
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.intersectObject(this.field.mesh, false)[0];
    if (!hit) return null;
    const at: LonLat = vec3ToLonLat(hit.point.x, hit.point.y, hit.point.z);

    const tex = this.field.material.uniforms.uVolume.value as Data3DTexture | null;
    if (!tex) return null;
    const res = this.manifest.resolutions.find((r) => r.id === this.manifest.default_resolution)!;
    const idx = texelIndex(res.nlon, res.nlat, at.lon, at.lat);
    const cell = cellCenter(res.nlon, res.nlat, idx % res.nlon, Math.floor(idx / res.nlon));
    const byte = (tex.image.data as Uint8Array)[idx]; // layer 0 -- see class doc comment
    const sentinel = this.manifest.no_data_sentinel;
    const value = sentinel !== undefined && byte === sentinel ? NaN : texelToPhysical(this.variable, byte);
    return { cell, value };
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.ui.dispose();
    this.coastlines?.dispose();
  }
}
