import {
  Data3DTexture, PerspectiveCamera, Raycaster, Scene, Texture,
  Vector2, Vector3, type ShaderMaterial,
} from 'three';

import { densifyPolygon, vec3ToLonLat, type LonLat } from '../core/constants';
import {
  createCoreSphere, createPickSphere, createSurfaceSphere,
} from './globe';
import { createMaskTexture } from '../core/mask';
import { Cutaway, removedFraction } from './cutaway';
import { Coastlines, type CoastlineData } from '../core/coastlines';
import { setMaskMode } from '../core/material';
import {
  DepthSlice, DEFAULT_DEPTH_SLICE, sinkingDepthKm, canUseSinkingMode,
  type DepthSliceState,
} from '../core/depthSlice';
import {
  FrameCache, loadManifest, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { BoundaryOverlay } from '../core/boundaries';
import { DEFAULT_ISOSURFACE, Isosurface } from './isosurface';
import type { Rect } from '../core/layout';
import { UI, type SurfaceMode, type ViewState } from './ui';
import type {
  ArchiveIndex, ColormapData, CutawayState, Manifest, VariableInfo,
} from '../core/types';

/** Everything a globe needs but that is the same for every globe, loaded once. */
export interface GlobeInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  topography: Texture | null;
  coastlineData: CoastlineData | null;
  boundariesUrl: string | null;
}

export interface GlobeInstanceHooks {
  /** A tool other than "drag" was selected in this instance's panel, or the
   *  instance was clicked on: the shared OrbitControls' enabled state and the
   *  target of Enter/Escape/double-click follow whichever globe this reports. */
  onFocus(self: GlobeInstance): void;
  /** The instance's own "remove this globe" button was pressed. */
  onRemove(self: GlobeInstance): void;
  /** A user dragged THIS instance's own age slider. Only fired from the UI
   *  callback (a real user edit) -- never from inside applyAge() itself, so
   *  a broadcast-driven follower update can't re-trigger this and echo. */
  onAgeChange?(self: GlobeInstance, age: number): void;
  /** Same idea for the depth-slice panel (enabled/depthKm/sinking fields). */
  onDepthSliceChange?(self: GlobeInstance, state: DepthSliceState): void;
}

/**
 * One globe: its own scene, volume state, cutaway, isosurfaces, coastlines,
 * boundary overlay and control panel. Everything here is independent of every
 * other instance -- the only things shared across globes live in main.ts:
 * the renderer, the camera (and therefore rotation and zoom), and the
 * read-only catalog data in GlobeInstanceDeps.
 */
export class GlobeInstance {
  readonly scene = new Scene();
  readonly core = createCoreSphere();
  readonly maskTexture = createMaskTexture();
  readonly surface = createSurfaceSphere(this.maskTexture);
  readonly pick = createPickSphere();
  readonly cutaway = new Cutaway(this.maskTexture);
  readonly isosurface = new Isosurface();
  readonly depthSlice = new DepthSlice();
  readonly boundaries: BoundaryOverlay;
  readonly ui: UI;

  coastlines: Coastlines | null = null;

  manifest!: Manifest;
  variable!: VariableInfo;

  readonly view: ViewState = {
    modelId: '', variableId: '', colormap: 'RdBu',
    clipMin: -2, clipMax: 2, symmetricClip: true, colorSteps: 0,
    reconstructionAge: 0, cutDepthKm: 2890, inverted: false,
    surfaceOpacity: 1, surfaceMode: 'topography', showBoundaries: true,
    tool: 'drag', iso: { ...DEFAULT_ISOSURFACE }, depthSlice: { ...DEFAULT_DEPTH_SLICE },
  };
  readonly cut: CutawayState = {
    vertices: [], closed: false, depthKm: 2890, inverted: false,
  };

  private readonly frames: FrameCache;
  /** See ageToken in the original main.ts: guards against a slow fetch for an
   *  old age landing after a newer one has already been applied. */
  private ageToken = 0;

  private readonly raycaster = new Raycaster();
  private downPos: { x: number; y: number } | null = null;
  private dragVertex = -1;

  /** Kept for exportPNG(), which needs to crop the shared canvas to this
   *  instance's own tile -- both are set every frame / relayout. */
  private lastRenderer: import('three').WebGLRenderer | null = null;
  private lastRect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly deps: GlobeInstanceDeps,
    private readonly hooks: GlobeInstanceHooks,
    label: string,
    startCollapsed = false,
  ) {
    this.frames = new FrameCache(deps.archiveBase);
    this.boundaries = new BoundaryOverlay(camera);

    this.scene.add(
      this.core, this.surface.mesh, this.pick, this.cutaway.wall,
      this.cutaway.floor, this.cutaway.outline, this.cutaway.handles,
      this.isosurface.mesh, this.depthSlice.mesh,
    );

    this.ui = new UI(this.view, deps.archive, Object.keys(deps.colormaps), {
      onModel: (id) => void this.selectModel(id),
      onVariable: (id) => void this.selectVariable(id),
      onColormap: (n) => this.applyColormap(n),
      onColorSteps: (n) => { this.view.colorSteps = n; this.applyColorSteps(); },
      onClip: () => this.applyClip(),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onCutDepth: () => this.rebuildCutaway(),
      onInvert: () => this.rebuildCutaway(),
      onSurfaceOpacity: (v) => this.setSurfaceOpacity(v),
      onSurfaceMode: (m) => { this.applySurfaceMode(m); this.ui.setStatus(''); },
      onBoundaries: (on) => { this.boundaries.visible = on; },
      onIsosurface: () => this.applyIso(),
      onDepthSlice: () => {
        this.applyDepthSlice();
        this.hooks.onDepthSliceChange?.(this, this.view.depthSlice);
      },
      onTool: () => { this.hooks.onFocus(this); },
      onClear: () => { this.cut.vertices = []; this.cut.closed = false; this.rebuildCutaway(); },
      onExportPNG: () => this.exportPNG(),
      onExportPolygon: () => this.exportPolygon(),
      onImportPolygon: () => this.importPolygon(),
    }, label, () => this.hooks.onRemove(this), startCollapsed);

    this.ui.setAgeRange(deps.archive.coastlines.age_min, deps.archive.coastlines.age_max);
  }

  // --- boot -------------------------------------------------------------

  async boot(modelId: string): Promise<void> {
    await this.selectModel(modelId);

    if (this.deps.boundariesUrl) {
      this.ui.setStatus('loading plate boundaries...');
      try {
        await this.boundaries.load(this.deps.boundariesUrl);
        await this.boundaries.setAge(this.view.reconstructionAge);
      } catch {
        // Boundaries are a layer, not a prerequisite; the globe still works.
      }
    }

    if (this.deps.coastlineData) {
      this.ui.setStatus('loading coastlines...');
      this.coastlines = new Coastlines(
        this.deps.coastlineData.lines, this.deps.coastlineData.table, this.maskTexture,
      );
      this.scene.add(this.coastlines.lines, this.coastlines.land);
      this.coastlines.setAge(this.view.reconstructionAge);
    }

    this.setSurfaceOpacity(this.view.surfaceOpacity);
    this.applySurfaceMode(this.deps.topography ? this.view.surfaceMode : 'flat');
    this.ui.setStatus('');
    this.updateTimeInfo();
    this.rebuildCutaway();
  }

  applyLayout(rect: Rect): void {
    this.lastRect = rect;
    this.boundaries.setRect(rect);
    this.ui.setRect(rect);
  }

  render(renderer: import('three').WebGLRenderer): void {
    this.lastRenderer = renderer;
    renderer.render(this.scene, this.camera);
    this.boundaries.draw();
  }

  dispose(): void {
    this.boundaries.dispose();
    this.ui.dispose();
    this.coastlines?.dispose();
    this.maskTexture.dispose();
  }

  // --- material plumbing --------------------------------------------------

  private volumeMaterials(): ShaderMaterial[] {
    return [this.cutaway.wallMaterial, this.cutaway.floorMaterial, this.depthSlice.material];
  }

  applyColormap(name: string): void {
    const cm = this.deps.colormaps[name];
    if (!cm) return;
    const tex = makeColormapTexture(cm.colors);
    for (const m of this.volumeMaterials()) m.uniforms.uColormap.value = tex;
  }

  applyColorSteps(): void {
    for (const m of this.volumeMaterials()) m.uniforms.uSteps.value = this.view.colorSteps;
  }

  applyClip(): void {
    const lo = physicalToEncoded(this.variable, this.view.clipMin);
    const hi = physicalToEncoded(this.variable, this.view.clipMax);
    for (const m of this.volumeMaterials()) {
      m.uniforms.uClipLo.value = lo;
      m.uniforms.uClipHi.value = hi;
    }
  }

  applyIso(): void {
    if (this.variable) {
      this.isosurface.setEncodedIso(
        physicalToEncoded(this.variable, this.view.iso.coldValue),
        physicalToEncoded(this.variable, this.view.iso.hotValue),
      );
    }
    this.isosurface.update(this.view.iso);
  }

  applyDepthSlice(): void {
    const ds = this.view.depthSlice;
    if (!canUseSinkingMode(this.manifest)) ds.sinkingEnabled = false;
    if (ds.sinkingEnabled) this.recomputeSinkingDepth();
    else this.depthSlice.setDepthKm(ds.depthKm);
    this.depthSlice.mesh.visible = ds.enabled;
    this.ui.setDepthEditable(!ds.sinkingEnabled);
    this.updateSurfaceVisibility();
    this.ui.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.updateTimeInfo();
  }

  /**
   * Sinking mode makes age drive slice depth too. Pure arithmetic, so it
   * runs synchronously wherever age changes -- no fetch involved.
   */
  private recomputeSinkingDepth(): void {
    const ds = this.view.depthSlice;
    if (!ds.enabled || !ds.sinkingEnabled || !canUseSinkingMode(this.manifest)) return;
    ds.depthKm = sinkingDepthKm(this.view.reconstructionAge, ds.rateUpperCmPerYr, ds.rateLowerCmPerYr);
    this.depthSlice.setDepthKm(ds.depthKm);
    // The depth slider is a DIFFERENT lil-gui controller than whatever
    // triggered this (the age slider, or nothing at all on boot) -- it does
    // not repaint itself just because the underlying number changed.
    this.ui.refreshDepthSliceDisplay();
  }

  /**
   * The slice and the crust sphere occupy the identical radius (R_SURFACE),
   * so leaving both visible is genuine z-fighting, not a look to choose --
   * this has to be computed, not just set from the surfaceMode dropdown.
   * view.surfaceMode itself is never touched here, so disabling the slice
   * restores whatever surface mode was already selected.
   */
  private updateSurfaceVisibility(): void {
    this.surface.mesh.visible = this.view.surfaceMode !== 'none' && !this.view.depthSlice.enabled;
  }

  private applyVolume(tex: Data3DTexture): void {
    const res = this.manifest.resolutions.find(
      (r) => r.id === this.manifest.default_resolution,
    )!;
    for (const m of this.volumeMaterials()) {
      m.uniforms.uVolume.value = tex;
      (m.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
      m.uniforms.uDepthMin.value = this.manifest.depth_min_km;
      m.uniforms.uDepthMax.value = this.manifest.depth_max_km;
    }
    this.isosurface.setVolume(tex);
    this.isosurface.setGrid(res.nlon, res.nlat, res.ndepth);
    this.isosurface.setModelDepthRange(this.manifest.depth_min_km, this.manifest.depth_max_km);
    this.cutaway.setVolumeDepthRange(this.manifest.depth_max_km);
    this.rebuildCutaway();
    setMaskMode(this.cutaway.wallMaterial, 'none');
    setMaskMode(this.cutaway.floorMaterial, 'inside');
    this.cutaway.floorMaterial.uniforms.uMask.value = this.maskTexture;
  }

  private colormapOptions(v: VariableInfo): string[] {
    const want = (v.high_means ?? 'fast') === 'hot' ? 'warm' : 'cool';
    return Object.keys(this.deps.colormaps).filter((n) => {
      const c = this.deps.colormaps[n];
      // A colormap flagged general: false (koppen's fixed class palette,
      // geo's sea-level hinge) is calibrated to one specific variable and
      // means nothing applied to another -- never a generic option here,
      // regardless of polarity.
      if (c.general === false) return false;
      return c.diverging ? c.high_end === want : true;
    });
  }

  async selectVariable(id: string): Promise<void> {
    this.variable = this.manifest.variables.find((v) => v.id === id)
      ?? this.manifest.variables[0];
    this.ui.setStatus(`loading ${this.manifest.name} / ${this.variable.name}...`);

    const frame = nearestFrame(this.manifest, this.view.reconstructionAge);
    this.frames.pin(this.manifest, this.variable.id, frame.id);
    this.applyVolume(await this.frames.get(this.manifest, this.variable.id, frame.id));

    this.view.colormap = this.variable.default_colormap;
    this.ui.setVariable(this.variable);
    this.ui.setColormapOptions(this.colormapOptions(this.variable), this.view.colormap);
    this.applyColormap(this.view.colormap);
    this.applyColorSteps();
    this.applyClip();
    this.applyIso();
    this.applyDepthSlice();
    this.updateTimeInfo();
    this.frames.prefetchNeighbours(this.manifest, this.variable.id, frame.id);
    this.ui.setStatus('');
  }

  async selectModel(id: string): Promise<void> {
    const entry = this.deps.archive.models.find((m) => m.id === id)!;
    this.view.modelId = id;
    this.ui.setStatus(`loading ${entry.name}...`);
    this.manifest = await loadManifest(this.deps.archiveBase, entry.path);
    this.reconcileDepthSliceWithModel();
    this.variable = this.manifest.variables.find((v) => v.id === this.manifest.default_variable)
      ?? this.manifest.variables[0];
    this.ui.setModel(this.manifest, this.variable);
    await this.selectVariable(this.variable.id);
  }

  /**
   * Sinking mode is tomography-only; switching to a convection model must
   * turn it off, not leave a stale, now-meaningless state.
   */
  private reconcileDepthSliceWithModel(): void {
    const ds = this.view.depthSlice;
    const allowed = canUseSinkingMode(this.manifest);
    if (ds.sinkingEnabled && !allowed) {
      ds.sinkingEnabled = false;
      this.ui.setStatus(`${this.manifest.name} has its own time axis; sinking-rate mode is tomography-only`);
    }
    this.ui.setSinkingAllowed(allowed);
  }

  setSurfaceOpacity(v: number): void {
    this.view.surfaceOpacity = v;
    this.surface.material.uniforms.uOpacity.value = v;
    this.coastlines?.setOpacity(v);
  }

  applySurfaceMode(m: SurfaceMode): void {
    this.view.surfaceMode = m;
    this.surface.setTopography(m === 'topography' ? this.deps.topography : null);
    if (this.coastlines) this.coastlines.landVisible = m === 'land';
    this.updateSurfaceVisibility();
  }

  private reconcileSurfaceWithAge(age: number): void {
    if (age > 0 && this.view.surfaceMode === 'topography') {
      this.applySurfaceMode('land');
      this.ui.setSurfaceMode('land');
      this.ui.setStatus('topography is present-day; switched to land fill');
    } else if (age === 0 && this.view.surfaceMode === 'land' && this.deps.topography) {
      this.ui.setStatus('');
    }
  }

  /**
   * Settle the async layers for an age so a screenshot taken right after this
   * shows the age that was asked for rather than whatever was up before.
   * Exposed for the test harness (window.__geode.setAge in main.ts); ordinary
   * interaction just calls applyAge() and lets the loads land when they land.
   */
  async settleAge(age: number): Promise<void> {
    if (this.manifest && this.manifest.frames.length > 1) {
      await this.frames.get(this.manifest, this.variable.id, nearestFrame(this.manifest, age).id);
    }
  }

  /**
   * Report the age each layer is really showing.
   *
   * A static tomography manifest has exactly one frame, so `frames.length<2`
   * used to mean "nothing here is time-dependent, blank the readout" -- but
   * that is precisely the case a depth slice locked to a sinking rate needs
   * to report through (age driving depth, not a loaded frame). Sinking mode
   * gets its own branch rather than folding into the mantle-frame one, since
   * "mantle present-day" is a different claim from "mantle 140 Ma": the
   * volume never moved, only the depth being read out of it did.
   */
  updateTimeInfo(): void {
    if (!this.manifest) { this.ui.setTimeInfo(''); return; }
    const ds = this.view.depthSlice;
    const multiFrame = this.manifest.frames.length > 1;
    if (!multiFrame && !ds.enabled) { this.ui.setTimeInfo(''); return; }

    const age = this.view.reconstructionAge;
    const parts = [`age ${age.toFixed(1)} Ma`];

    if (ds.enabled) parts.push(`slice ${ds.depthKm.toFixed(0)} km`);

    if (ds.enabled && ds.sinkingEnabled && canUseSinkingMode(this.manifest)) {
      parts.push(ds.rateUpperCmPerYr === ds.rateLowerCmPerYr
        ? `${ds.rateUpperCmPerYr.toFixed(1)} cm/yr`
        : `${ds.rateUpperCmPerYr.toFixed(1)}/${ds.rateLowerCmPerYr.toFixed(1)} cm/yr`);
      parts.push('mantle present-day');
    } else if (multiFrame) {
      const vol = nearestFrame(this.manifest, age).age_ma;
      parts.push(`mantle ${vol.toFixed(0)} Ma`);
    }

    if (this.boundaries.frameTime !== null) {
      parts.push(`boundaries ${this.boundaries.frameTime.toFixed(0)} Ma`);
    }
    this.ui.setTimeInfo(parts.join('  ·  '));
  }

  applyAge(age: number): void {
    this.view.reconstructionAge = age;
    const token = ++this.ageToken;

    this.coastlines?.setAge(age);
    this.reconcileSurfaceWithAge(age);
    this.recomputeSinkingDepth();
    void this.boundaries.setAge(age, () => {
      if (token === this.ageToken) this.updateTimeInfo();
    });

    if (this.manifest && this.manifest.frames.length > 1) {
      const frame = nearestFrame(this.manifest, age);
      this.frames.pin(this.manifest, this.variable.id, frame.id);
      void this.frames.get(this.manifest, this.variable.id, frame.id).then((tex) => {
        if (token !== this.ageToken) return;
        for (const m of this.volumeMaterials()) m.uniforms.uVolume.value = tex;
        this.isosurface.setVolume(tex);
        this.frames.prefetchNeighbours(this.manifest, this.variable.id, frame.id);
      }).catch((e) => this.ui.setStatus(String(e)));
    }
    this.updateTimeInfo();
  }

  // --- cutaway ------------------------------------------------------------

  rebuildCutaway(): void {
    this.cut.depthKm = this.view.cutDepthKm;
    this.cut.inverted = this.view.inverted;
    this.cutaway.update(this.cut);
    this.boundaries.setMask(this.cut.closed ? this.cutaway.mask : null);
  }

  closePolygon(): void {
    if (this.cut.vertices.length < 3) return;
    this.cut.closed = true;
    const frac = removedFraction(densifyPolygon(this.cut.vertices, 0.5));
    this.cut.inverted = frac > 0.5;
    this.view.inverted = this.cut.inverted;
    this.ui.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.rebuildCutaway();
  }

  // --- interaction ----------------------------------------------------
  //
  // Called by main.ts once it has worked out which tile a pointer event
  // landed in and converted the event into this instance's own NDC space.
  // modifierHeld is a single global keyboard flag -- rotating without leaving
  // a tool is the same gesture on every globe.

  toolActive(modifierHeld: boolean): boolean {
    return this.view.tool !== 'drag' && !modifierHeld;
  }

  private pickLonLat(ndc: Vector2): LonLat | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.pick, false)[0];
    if (!hit) return null;
    const p = hit.point;
    return vec3ToLonLat(p.x, p.y, p.z);
  }

  private nearestVertex(ndc: Vector2): number {
    const ll = this.pickLonLat(ndc);
    if (!ll) return -1;
    let best = -1;
    let bestD = 6; // degrees
    for (let i = 0; i < this.cut.vertices.length; i++) {
      const v = this.cut.vertices[i];
      const d = Math.hypot(v.lat - ll.lat, (v.lon - ll.lon) * Math.cos(v.lat * Math.PI / 180));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  onPointerDown(ndc: Vector2, modifierHeld: boolean, clientX: number, clientY: number): void {
    if (!this.toolActive(modifierHeld)) return;
    this.downPos = { x: clientX, y: clientY };
    if (this.view.tool === 'edit') this.dragVertex = this.nearestVertex(ndc);
  }

  onPointerMove(ndc: Vector2, modifierHeld: boolean): void {
    if (!this.toolActive(modifierHeld) || this.dragVertex < 0) return;
    const ll = this.pickLonLat(ndc);
    if (!ll) return;
    this.cut.vertices[this.dragVertex] = ll;
    this.rebuildCutaway();
  }

  onPointerUp(ndc: Vector2, modifierHeld: boolean, clientX: number, clientY: number): void {
    if (!this.toolActive(modifierHeld) || !this.downPos) {
      this.downPos = null; this.dragVertex = -1; return;
    }
    const moved = Math.hypot(clientX - this.downPos.x, clientY - this.downPos.y);
    this.downPos = null;
    if (this.dragVertex >= 0) { this.dragVertex = -1; return; }
    if (moved > 5) return;

    if (this.view.tool === 'draw') {
      const ll = this.pickLonLat(ndc);
      if (!ll) return;
      if (this.cut.closed) { this.cut.vertices = []; this.cut.closed = false; }
      this.cut.vertices.push(ll);
      this.rebuildCutaway();
    } else if (this.view.tool === 'edit') {
      const i = this.nearestVertex(ndc);
      if (i >= 0) { this.cut.vertices.splice(i, 1); this.rebuildCutaway(); }
    }
  }

  onDblClick(): void {
    if (this.view.tool === 'draw') this.closePolygon();
  }

  onKeyEnter(): void { this.closePolygon(); }

  onKeyEscape(): void {
    this.cut.vertices = [];
    this.cut.closed = false;
    this.rebuildCutaway();
  }

  // --- export -----------------------------------------------------------

  private download(name: string, blob: Blob): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * A screenshot of just this globe's tile. Composites the WebGL canvas
   * (cropped to this instance's viewport rect) with this instance's own
   * boundary overlay canvas, which is already sized to that same tile.
   *
   * Reads whatever the shared canvas held from the last animate() frame --
   * that loop runs continuously at 60fps, so nothing here needs to force an
   * extra render first the way the single-globe version once did.
   */
  exportPNG(): void {
    const renderer = this.lastRenderer;
    if (!renderer) return;
    const gl = renderer.domElement;
    const rect = this.lastRect;
    const dpr = Math.min(devicePixelRatio, 2);
    const out = document.createElement('canvas');
    out.width = Math.round(rect.width * dpr);
    out.height = Math.round(rect.height * dpr);
    const ctx = out.getContext('2d')!;
    ctx.drawImage(
      gl,
      Math.round(rect.x * dpr), Math.round(rect.y * dpr), out.width, out.height,
      0, 0, out.width, out.height,
    );
    ctx.drawImage(this.boundaries.canvas, 0, 0, out.width, out.height);
    out.toBlob((b) => b && this.download('geode.png', b));
  }

  exportPolygon(): void {
    const ring = this.cut.vertices.map((v) => [v.lon, v.lat]);
    if (ring.length) ring.push(ring[0]);
    const gj = {
      type: 'Feature',
      properties: { cut_depth_km: this.cut.depthKm, inverted: this.cut.inverted },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
    this.download('cutaway.geojson', new Blob([JSON.stringify(gj, null, 2)],
      { type: 'application/geo+json' }));
  }

  importPolygon(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.geojson,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const gj = JSON.parse(await f.text());
      const coords = gj.geometry?.coordinates?.[0] ?? gj.coordinates?.[0];
      if (!coords) return;
      this.cut.vertices = coords
        .slice(0, coords.length - 1)
        .map((c: number[]) => ({ lon: c[0], lat: c[1] }));
      if (typeof gj.properties?.inverted === 'boolean') {
        this.view.inverted = gj.properties.inverted;
      }
      this.cut.closed = true;
      this.rebuildCutaway();
    };
    input.click();
  }
}
