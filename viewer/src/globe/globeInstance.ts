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
import { GlobeUI, type GlobeViewState, type GlobeTool } from './globeUi';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';

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

  constructor(private camera: Camera, private readonly deps: GlobeInstanceDeps) {
    this.field.mesh.visible = true;
    this.field.setDepthKm(0); // whole-sphere paint, no depth axis in this wrapper's manifests
    this.scene.add(this.field.mesh);
    this.frames = new FrameCache(deps.archiveBase);

    this.backdrop = new Mesh(
      createSurfaceGeometry('globe', BACKDROP_R),
      new MeshBasicMaterial({ side: FrontSide }),
    );
    this.backdrop.visible = false; // 'transparent' style: nothing painted here at boot
    this.scene.add(this.backdrop);

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

  dispose(): void {
    this.ui.dispose();
    this.coastlines?.dispose();
  }
}
