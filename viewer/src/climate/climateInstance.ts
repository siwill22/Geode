import {
  Scene, Vector3, type Camera, type Data3DTexture, type ShaderMaterial,
  type Texture, type WebGLRenderer,
} from 'three';

import { DepthSlice } from '../core/depthSlice';
import { setMaskMode, setValidMask } from '../core/material';
import { createMaskTexture } from '../core/mask';
import { Coastlines, type CoastlineData } from '../core/coastlines';
import { R_SURFACE } from '../core/constants';
import type { ProjectionMode } from '../core/projection';
import type { Rect } from '../core/layout';
import { WindGlyphs } from '../core/windGlyphs';
import { WindStreaks } from '../core/windStreaks';
import {
  FrameCache, loadManifest, loadMask2D, makeColormapTexture, nearestFrame, physicalToEncoded,
} from '../core/volume';
import { ClimateUI, type ClimateViewState } from './climateUi';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from '../core/types';

export interface ClimateInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  colormaps: ColormapData;
  coastlineData: CoastlineData | null;
}

/**
 * Cross-instance concerns for a multi-globe layout -- deliberately smaller
 * than tomography/instance.ts's GlobeInstanceHooks, which also carries an
 * onFocus (there is no per-instance TOOL state here competing with
 * OrbitControls for the same drag gesture, so nothing needs to know when
 * this instance gains "focus"; main.ts's own pointerdown/hitTest handler
 * sets its focus-tracking variable directly, with no round trip through the
 * instance needed).
 */
export interface ClimateInstanceHooks {
  /** This instance's own "remove this globe" button was pressed. */
  onRemove(self: ClimateInstance): void;
  /** A user dragged THIS instance's own age slider. Only fired from the UI
   *  callback (a real user edit) -- never from inside applyAge() itself, so
   *  a broadcast-driven follower update can't re-trigger this and echo.
   *  Mirrors GlobeInstanceHooks.onAgeChange exactly. */
  onAgeChange?(self: ClimateInstance, age: number): void;
  /** Same idea for the month slider / play-seasons control -- climate's own
   *  axis, with no tomography equivalent. */
  onMonthChange?(self: ClimateInstance, month: number): void;
  /** Fired whenever THIS instance's own displayed variable/layer/climate
   *  model changes -- not just when it starts/stops showing a CATEGORICAL
   *  variable, since main.ts can't cheaply tell which without asking every
   *  instance anyway (see its own refreshLegendVisibility(), which recomputes
   *  from scratch across every globe rather than trying to track deltas).
   *  Exists so that when two or more globes show the same categorical
   *  variable (today: only Koppen) at once, main.ts can hide the legend on
   *  every one but the first -- duplicate legends for the identical class
   *  list/colours add nothing, see setLegendVisible(). */
  onDisplayChange?(self: ClimateInstance): void;
}

// Just clear of the primary field's sphere, same precedent as coastlines.ts's
// LAND_R -- nothing else renders at this radius in climate.html (the
// coastline LAND fill is permanently hidden here, only its outline at a
// larger radius still is drawn), so there's no third thing to collide with.
const OVERLAY_R = R_SURFACE * 1.0006;
export const DEFAULT_OVERLAY_OPACITY = 0.4;
const HILLSHADE_VARIABLE_ID = 'hillshade';
export const DEFAULT_WIND_VISIBLE = true;
export const DEFAULT_WIND_SCALE = 1;
export const DEFAULT_WIND_DENSITY = 1;
export type WindStyle = 'glyph' | 'streak';
export const DEFAULT_WIND_STYLE: WindStyle = 'glyph';
// No manifest field carries this -- the coastline OUTLINE (not any model's
// own data) is always this one fixed rotation model, regardless of which
// climate/paleogeography model is active. See updateCredit().
const COASTLINE_CREDIT = 'continents Scotese 2008 rotation model, via Cao et al. 2018';

/**
 * The two things this globe can show, plus a shared continent-outline
 * overlay -- all on the SAME reconstruction lineage (Scotese), unlike an
 * earlier version of this viewer, which draped temperature under Muller et
 * al. coastlines: a different plate model than the one the climate
 * simulations were actually run on, so the continents under the field were
 * subtly wrong at every age but 0 Ma. "Paleogeography" here means a Scotese &
 * Wright (2018) PaleoDEM elevation raster; the overlay is Scotese (2008)
 * continent polygons rotated through time by prep/prep_coastlines.py (reused
 * unchanged, just pointed at Scotese's rotation file instead of Muller's) --
 * there is no Scotese plate-BOUNDARY dataset (subduction/ridge/transform),
 * only these continent outlines. "climate" itself can be backed by more than
 * one registered model (Li et al. 2022, Pohl et al.) -- see
 * `view.climateModelId`/setClimateModel().
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
 * between a climate simulation's own variable(s) and the Scotese
 * paleogeography raster. Deliberately NOT a GlobeInstance -- that class
 * carries cutaway/isosurface/sinking-rate machinery with no climate
 * equivalent. What IS reused (verbatim): the DepthSlice "paint the whole
 * sphere from one layer of a Data3DTexture" mechanism and FrameCache. A
 * paleogeography frame is a depth slice with ndepth=1; a climate frame's
 * "depth" is a calendar month -- see prep/prep_climate.py,
 * prep/prep_pohl.py and prep/prep_paleogeography.py. A THIRD DepthSlice
 * (`overlay`) draws paleogeography's shaded relief translucently on top of
 * whichever primary field is active, independent of it -- see
 * setOverlayOpacity() and loadOverlayFrame().
 *
 * Owns its own view state (`view`) and control panel (`ui`), the same shape
 * as tomography/instance.ts's GlobeInstance owning `view`/`ui` -- this is
 * what lets main.ts manage an arbitrary number of these without a second,
 * externally-tracked state object that has to be kept in sync with this
 * one's internals by convention (which is exactly the "two things that must
 * agree but nothing enforces it" bug class this codebase has hit and fixed
 * more than once this session).
 */
export class ClimateInstance {
  readonly scene = new Scene();
  readonly field = new DepthSlice();
  /** Shaded-relief overlay: always sourced from paleogeography-scotese's
   *  'hillshade' variable, independent of whichever layer/variable is
   *  primary -- see prep_paleogeography.py and setOverlayOpacity(). */
  readonly overlay = new DepthSlice(OVERLAY_R);
  /** Wind arrow field: always sourced from the ACTIVE climate model's own
   *  U/V (not every climate model has one -- see resolveWind()),
   *  independent of whichever layer/variable is primary -- same reasoning
   *  as `overlay` always sourcing from paleogeography. Tracks BOTH age and
   *  month (unlike the overlay, which has no month axis). */
  readonly wind = new WindGlyphs();
  /** The wind field's other display mode -- animated particle streaks
   *  instead of static arrows, same U/V source as `wind`. Mutually
   *  exclusive with it; see setWindStyle() and
   *  docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md. */
  readonly windStreaks = new WindStreaks();
  readonly ui: ClimateUI;
  coastlines: Coastlines | null = null;

  /** Every piece of state a control panel binds to, in one place -- see the
   *  class doc comment. Defaults mirror what climate/main.ts used to
   *  construct externally before this instance owned its own panel. */
  readonly view: ClimateViewState = {
    layer: 'climate', variable: 'T', climateModelId: '', resolution: '', age: 0, month: 0,
    clipMin: 0, clipMax: 1, overlayOpacity: DEFAULT_OVERLAY_OPACITY, showWind: DEFAULT_WIND_VISIBLE,
    windStyle: DEFAULT_WIND_STYLE, windScale: DEFAULT_WIND_SCALE, windDensity: DEFAULT_WIND_DENSITY,
  };

  /** Keyed by model id (not by ClimateLayer) -- 'climate' can now be backed
   *  by more than one registered model, so a fixed two-entry record can't
   *  express this. sourceKey() resolves which entry a given layer means
   *  right now. */
  private sources!: Record<string, LayerSource>;
  private paleogeographyModelId!: string;
  /** Tracks which layer is actually loaded on screen, separate from
   *  `view.layer` -- see setLayer()'s doc comment for why comparing against
   *  the shared, UI-bound `view` object doesn't work. Set only inside
   *  switchLayer(), after a real switch decision has been made. */
  private activeLayer!: ClimateLayer;
  /** Same reasoning as `activeLayer` -- the resolution control also binds
   *  directly to `view` (lil-gui writes the new value into it before firing
   *  onChange), so setResolution()'s guard must compare against this
   *  separately-tracked field, not `view.resolution`. Set only inside
   *  setResolution(), after a real switch decision has been made. */
  private activeResolution!: string;
  /** Same reasoning again -- the climate-model control also binds directly
   *  to `view`. Set only inside setClimateModel(). */
  private activeClimateModelId!: string;
  /** Guards a slow fetch for a stale age/layer landing after a newer one
   *  already applied -- same pattern as GlobeInstance.ageToken. */
  private ageToken = 0;
  private overlayToken = 0;
  private hasOverlay = false;
  private windToken = 0;
  private hasWind = false;
  private windUVar!: VariableInfo;
  private windVVar!: VariableInfo;
  private windUTex: Data3DTexture | null = null;
  private windVTex: Data3DTexture | null = null;
  /** Guards a slow landmask fetch the same way ageToken/overlayToken do --
   *  see applyValidMask(). */
  private maskToken = 0;
  /** Whether Wind Streak is the currently-shown mode -- tracked separately
   *  from view.showWind/view.windStyle so applyWindVisibility() can tell a
   *  transition INTO visible (needs resetAll()) from staying visible. */
  private streakActive = false;
  /** Set only by setProjection() -- see its own doc comment. Re-read by
   *  boot() once coastlines/wind actually exist, to re-apply whichever
   *  Projection was already active before they did. */
  private projectionMode: ProjectionMode = 'globe';

  constructor(
    private camera: Camera,
    private readonly deps: ClimateInstanceDeps,
    private readonly hooks: ClimateInstanceHooks,
    label: string,
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

    // After the field (1) and the overlay (2), same as the coastline
    // outlines -- opaque 3D glyphs depth-test correctly regardless of
    // render order, this only matters for blending against the overlay's
    // transparency.
    this.wind.mesh.renderOrder = 4;
    this.scene.add(this.wind.mesh);
    this.windStreaks.mesh.renderOrder = 4;
    this.scene.add(this.windStreaks.mesh);

    this.ui = new ClimateUI(this.view, {
      onLayer: (l) => void this.setLayer(l),
      onClimateModel: (id) => void this.setClimateModel(id),
      onVariable: (id) => void this.setVariable(id),
      onResolution: (id) => void this.setResolution(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onMonth: (month) => { this.applyMonth(month); this.hooks.onMonthChange?.(this, month); },
      onClip: (lo, hi) => this.applyClip(lo, hi),
      onOverlayOpacity: (v) => this.setOverlayOpacity(v),
      onShowWind: (v) => this.setWindVisible(v),
      onWindStyle: (v) => this.setWindStyle(v),
      onWindScale: (v) => this.setWindScale(v),
      onWindDensity: (v) => this.setWindDensity(v),
    }, label, () => this.hooks.onRemove(this));
  }

  /** Which `sources` entry a layer means RIGHT NOW -- 'paleogeography' is
   *  always the one registered paleogeography model; 'climate' is whichever
   *  one `view.climateModelId` currently selects. */
  private sourceKey(layer: ClimateLayer): string {
    return layer === 'paleogeography' ? this.paleogeographyModelId : this.view.climateModelId;
  }

  get manifest(): Manifest { return this.sources[this.sourceKey(this.view.layer)].manifest; }

  get variable(): VariableInfo {
    const src = this.sources[this.sourceKey(this.view.layer)];
    return src.variables.find((v) => v.id === src.variableId) ?? src.variables[0];
  }

  get layer(): ClimateLayer { return this.view.layer; }

  /** Rebuilds the bottom-right attribution line from the ACTIVE model(s)'
   *  own manifest.source, not a fixed string -- used to be static HTML
   *  naming only Li et al., which went stale the moment a second climate
   *  model existed (see climate.html's history). While `layer === 'climate'`
   *  this credits both the active climate model AND paleogeography (the
   *  relief overlay is always paleogeography-sourced regardless of which
   *  layer is primary, see setOverlayOpacity's own doc comment); while
   *  `layer === 'paleogeography'` that source alone already covers both the
   *  primary field and the overlay. Call after anything that changes which
   *  model is active: boot(), setLayer(), setClimateModel(). */
  private updateCredit(): void {
    const paleoCredit = this.sources[this.paleogeographyModelId].manifest.source;
    const parts = this.view.layer === 'climate'
      ? [this.sources[this.activeClimateModelId].manifest.source, `paleogeography ${paleoCredit}`]
      : [paleoCredit];
    if (this.coastlines) parts.push(COASTLINE_CREDIT);
    this.ui.setCredit(parts.join(' · '));
  }

  async boot(climateModelIds: string[], paleogeographyModelId: string): Promise<void> {
    this.ui.setStatus('loading...');
    this.paleogeographyModelId = paleogeographyModelId;

    const ids = [...climateModelIds, paleogeographyModelId];
    const loaded = await Promise.all(ids.map((id) => this.loadSource(id)));
    const entries: [string, LayerSource][] = ids.map((id, i) => [id, loaded[i]]);
    this.sources = Object.fromEntries(entries);

    this.activeClimateModelId = climateModelIds[0];
    this.view.climateModelId = this.activeClimateModelId;
    this.ui.setClimateModels(climateModelIds.map((id) => ({
      id, name: this.deps.archive.models.find((m) => m.id === id)?.name ?? id,
    })));

    const paleogeography = this.sources[paleogeographyModelId];
    this.activeResolution = paleogeography.manifest.default_resolution;
    this.view.resolution = this.activeResolution;
    this.ui.setResolutions(paleogeography.manifest.resolutions);

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

    const shadeVar = paleogeography.variables.find((v) => v.id === HILLSHADE_VARIABLE_ID);
    this.hasOverlay = !!shadeVar;
    if (shadeVar) {
      const cm = this.deps.colormaps[shadeVar.default_colormap];
      this.overlay.material.uniforms.uColormap.value = makeColormapTexture(cm.colors);
    }

    this.resolveWind();
    this.ui.setWindAvailable(this.hasWind);

    await this.switchLayer('climate', 0);
    if (this.hasOverlay) await this.loadOverlayFrame(0);
    if (this.hasWind) {
      await this.loadWindFrame(0);
      this.setWindVisible(DEFAULT_WIND_VISIBLE);
    }

    // Post-boot panel setup -- previously done externally in climate/main.ts
    // once instance.boot() resolved; now internal, same as GlobeInstance's
    // own boot() configuring its ui directly.
    const ages = this.manifest.frames.map((f) => f.age_ma);
    this.ui.setAgeRange(Math.min(...ages), Math.max(...ages));
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables, this.view.layer);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.applyMonth(this.view.month);
    this.ui.setTimeInfo(`age ${this.view.age.toFixed(0)} Ma`);
    this.ui.setStatus('');
    this.updateCredit();
    // Re-apply whichever Projection was already active (set by main.ts's
    // createInstance() before boot() ever ran, so field/overlay/camera are
    // already correct) now that coastlines/wind actually exist -- both are
    // built during boot(), above, so the EARLIER setProjection() call had
    // nothing to hide yet. Without this a globe added while Plate Carrée is
    // active would boot with its coastline outline left showing.
    this.setProjection(this.projectionMode, this.camera);
    this.hooks.onDisplayChange?.(this);
  }

  applyLayout(rect: Rect): void {
    this.ui.setRect(rect);
  }

  /** Switch this globe's Projection -- always called from main.ts for every
   *  instance at once, alongside the shared camera it just built for `mode`
   *  (see docs/adr/0003): Globe and Plate Carrée need different camera
   *  types, so main.ts always replaces the camera object wholesale rather
   *  than reconfiguring this instance's existing one in place. Rebuilds the
   *  field/overlay geometry for `mode` and reprojects wind; coastlines still
   *  hide rather than reproject -- their CPU build pipeline (plate-rotation
   *  slerp) is a separate, unrelated piece of work, see docs/adr/0003. */
  setProjection(mode: ProjectionMode, camera: Camera): void {
    this.camera = camera;
    this.projectionMode = mode;
    this.field.setProjection(mode);
    this.overlay.setProjection(mode);
    if (this.coastlines) this.coastlines.lines.visible = mode === 'globe';
    this.wind.setProjection(mode);
    this.windStreaks.setProjection(mode);
    // WindGlyphs only reposes on an explicit update() call (unlike
    // WindStreaks, which reposes every frame via tick()) -- without this,
    // arrows would keep showing whatever matrices they last had under the
    // OLD Projection until some unrelated data change (age, month, ...)
    // happened to trigger the next refreshWindGlyphs().
    if (this.hasWind) this.refreshWindGlyphs();
    this.applyWindVisibility();
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
   *  the age carries over so switching layers mid-scrub doesn't reset it.
   *
   *  Guards against redundant work with `activeLayer`, NOT `view.layer`:
   *  lil-gui writes the new value straight into `view` (the same object
   *  ClimateUI is bound to) before firing onChange, so by the time this runs
   *  `view.layer` already equals `layer` -- comparing against it here would
   *  always be true and silently no-op every real dropdown switch. */
  async setLayer(layer: ClimateLayer): Promise<void> {
    if (layer === this.activeLayer) return;
    await this.switchLayer(layer, this.view.age);
    this.view.variable = this.variable.id;
    this.ui.setLayerVariables(this.manifest.variables, this.view.layer);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.ui.refreshDisplay();
    this.updateCredit();
    this.hooks.onDisplayChange?.(this);
  }

  private async switchLayer(layer: ClimateLayer, age: number): Promise<void> {
    this.activeLayer = layer;
    this.view.layer = layer;
    const src = this.sources[this.sourceKey(layer)];
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    // A month picked on the OTHER layer can sit outside this one's own
    // depth_min_km/depth_max_km (e.g. month 6 is valid for climate's 0-11
    // range but not paleogeography's 0-1) -- see clampToActiveDepthRange().
    this.field.setDepthKm(this.clampToActiveDepthRange(this.view.month));
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(layer, age);
  }

  /** Keep the depth-slice selector inside the ACTIVE layer's own valid
   *  depth_min_km/depth_max_km range. material.ts's shader treats a slice
   *  depth outside the CURRENT manifest's range as missing data and paints
   *  the whole globe its flat "no data" grey -- it does not clamp on its
   *  own, despite depth_max_km=1 for paleogeography making every value in
   *  range sample the exact same (only) layer regardless. Without this, a
   *  month picked while on the climate layer survives a switch to
   *  paleogeography and silently blanks it. */
  private clampToActiveDepthRange(km: number): number {
    const m = this.manifest;
    return Math.min(Math.max(km, m.depth_min_km), m.depth_max_km);
  }

  /** Switch which variable of the ACTIVE layer's model is on screen -- no
   *  manifest reload, just a different variable id fetched from the same
   *  FrameCache (which already keys frames by variable, see volume.ts). */
  async setVariable(variableId: string): Promise<void> {
    const src = this.sources[this.sourceKey(this.view.layer)];
    if (variableId === src.variableId) return;
    src.variableId = variableId;
    const cm = this.deps.colormaps[this.variable.default_colormap];
    src.colormapTexture = makeColormapTexture(cm.colors);
    this.field.material.uniforms.uColormap.value = src.colormapTexture;
    this.applyClip(this.variable.default_clip_min, this.variable.default_clip_max);
    await this.loadFrame(this.view.layer, this.view.age);
    this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    this.hooks.onDisplayChange?.(this);
  }

  /** Switch which of the paleogeography source's `manifest.resolutions`
   *  entries is on screen. Guards against redundant work with
   *  `activeResolution`, not `view.resolution` -- see that field's doc
   *  comment for why (same lesson as setLayer()'s `activeLayer` guard).
   *  Re-fetches the primary field only if paleogeography is the active
   *  layer, but ALWAYS re-fetches the overlay -- it is paleogeography-sourced
   *  regardless of which layer is primary. */
  async setResolution(resolutionId: string): Promise<void> {
    if (resolutionId === this.activeResolution) return;
    this.activeResolution = resolutionId;
    this.view.resolution = resolutionId;
    const work = [this.loadOverlayFrame(this.view.age)];
    if (this.view.layer === 'paleogeography') work.push(this.loadFrame('paleogeography', this.view.age));
    await Promise.all(work);
    this.ui.refreshDisplay();
  }

  /** Switch which registered climate-type model backs the 'climate' layer.
   *  Guards against redundant work with `activeClimateModelId`, not
   *  `view.climateModelId` -- same lesson as setLayer()'s `activeLayer`
   *  guard, since this control also binds directly to `view`.
   *
   *  Doesn't force the layer to 'climate' if paleogeography is currently
   *  showing -- the user can pick a different climate model while looking
   *  at paleogeography, and the switch takes effect (variable list, wind
   *  availability) the next time they switch layer back, the same lazy
   *  fetch-on-display timing setVariable() already uses. */
  async setClimateModel(modelId: string): Promise<void> {
    if (modelId === this.activeClimateModelId) return;
    this.activeClimateModelId = modelId;
    this.view.climateModelId = modelId;

    this.resolveWind();
    this.ui.setWindAvailable(this.hasWind);
    if (this.hasWind) {
      await this.loadWindFrame(this.view.age);
    } else {
      this.windUTex = null;
      this.windVTex = null;
    }
    this.applyWindVisibility();

    if (this.view.layer === 'climate') {
      await this.switchLayer('climate', this.view.age);
      this.view.variable = this.variable.id;
      this.ui.setLayerVariables(this.manifest.variables, this.view.layer);
      this.ui.setVariable(this.variable, this.deps.colormaps[this.variable.default_colormap]);
    }
    this.ui.refreshDisplay();
    this.updateCredit();
    this.hooks.onDisplayChange?.(this);
  }

  /** Re-resolve hasWind/windUVar/windVVar from whichever climate model is
   *  now selected -- not every climate model has a wind vector field (Pohl
   *  doesn't), unlike before this was a fixed, boot-time-only fact. */
  private resolveWind(): void {
    const manifest = this.sources[this.view.climateModelId].manifest;
    const windField = manifest.vector_fields?.[0] ?? null;
    this.hasWind = !!windField;
    if (windField) {
      const src = this.sources[this.view.climateModelId];
      this.windUVar = src.variables.find((v) => v.id === windField.u_variable)!;
      this.windVVar = src.variables.find((v) => v.id === windField.v_variable)!;
    }
  }

  applyClip(lo: number, hi: number): void {
    const v = this.variable;
    this.field.material.uniforms.uClipLo.value = physicalToEncoded(v, lo);
    this.field.material.uniforms.uClipHi.value = physicalToEncoded(v, hi);
    // Categorical variables (e.g. Koppen classes) reuse the EXISTING
    // "discrete contour bands" uSteps uniform to turn the continuous ramp
    // into flat class colours -- see material.ts's fragment shader and
    // prep_colormaps.py's build_categorical_colormap(). 0 = continuous,
    // the default for every ordinary variable.
    this.field.material.uniforms.uSteps.value = v.categorical ? (v.class_names?.length ?? 0) : 0;
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    void this.loadFrame(this.view.layer, age);
    if (this.hasOverlay) void this.loadOverlayFrame(age);
    if (this.hasWind) void this.loadWindFrame(age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
  }

  setOverlayOpacity(v: number): void {
    this.overlay.material.uniforms.uOpacity.value = v;
  }

  setWindVisible(v: boolean): void {
    this.view.showWind = v;
    this.applyWindVisibility();
  }

  /** Switch between the two wind display modes -- mutually exclusive, see
   *  the `windStreaks` field's doc comment and ADR-0002. */
  setWindStyle(style: WindStyle): void {
    this.view.windStyle = style;
    this.applyWindVisibility();
  }

  /** Show whichever mode (view.windStyle) is current and hide the other --
   *  both forced off if the active climate model has no wind field at all
   *  (see resolveWind()). Wind Streak gets a full resetAll() the moment it
   *  TRANSITIONS from hidden to visible (mode switch, or the "wind"
   *  checkbox turning back on) rather than resuming whatever stale particle
   *  state it had -- see WindStreaks.resetAll()'s own doc comment for why. */
  private applyWindVisibility(): void {
    const glyphVisible = this.hasWind && this.view.showWind && this.view.windStyle === 'glyph';
    const streakVisible = this.hasWind && this.view.showWind && this.view.windStyle === 'streak';
    this.wind.setVisible(glyphVisible);
    if (streakVisible && !this.streakActive) this.windStreaks.resetAll();
    this.streakActive = streakVisible;
    this.windStreaks.setVisible(streakVisible);
  }

  /** Repose/rescale immediately from whichever U/V frame is already held --
   *  applied to BOTH wind modes (not just the active one) so switching
   *  style later doesn't land on a stale scale/density from whenever that
   *  mode was last active; only the visible mode's mesh actually renders. */
  setWindScale(v: number): void {
    this.wind.setSize(v);
    this.windStreaks.setSize(v);
    this.refreshWindGlyphs();
  }

  /** Same reasoning as setWindScale(). */
  setWindDensity(v: number): void {
    this.wind.setDensity(v);
    this.windStreaks.setDensity(v);
    this.refreshWindGlyphs();
  }

  /** Select a month on the shared "layer axis" -- see prep_climate.py.
   *  Layer-agnostic in effect (paleogeography's manifest is still ndepth=1,
   *  so any in-range value lands on its one layer) but NOT in the raw value:
   *  see clampToActiveDepthRange() for why it has to go through that rather
   *  than being handed to the shader as-is. */
  applyMonth(month: number): void {
    this.view.month = month;
    this.field.setDepthKm(this.clampToActiveDepthRange(month));
    // No fetch needed: the wind textures for the current age already carry
    // all 12 months, so a month change is just a different plane of data
    // already in hand -- see refreshWindGlyphs().
    if (this.hasWind) this.refreshWindGlyphs();
    this.ui.setMonth(month);
  }

  /** `layer`'s own default resolution for a climate source (exactly one
   *  today, for every registered climate model); `view.resolution` for
   *  paleogeography -- the one source with a user-facing choice. */
  private resolutionFor(layer: ClimateLayer): string {
    return layer === 'paleogeography' ? this.view.resolution : this.sources[this.sourceKey(layer)].manifest.default_resolution;
  }

  private async loadFrame(layer: ClimateLayer, age: number): Promise<void> {
    const key = this.sourceKey(layer);
    const src = this.sources[key];
    const variableId = src.variableId; // captured now -- src.variableId may change under us
    const resolutionId = this.resolutionFor(layer);
    const token = ++this.ageToken;

    const frame = nearestFrame(src.manifest, age);
    src.frames.pin(src.manifest, variableId, frame.id, resolutionId);
    const tex = await src.frames.get(src.manifest, variableId, frame.id, resolutionId);
    // A layer/model/variable/resolution switch or a newer age can all land after this fetch started.
    if (token !== this.ageToken || key !== this.sourceKey(this.view.layer) || variableId !== src.variableId
      || resolutionId !== this.resolutionFor(layer)) return;
    this.applyVolume(src.manifest, tex, resolutionId);
    src.frames.prefetchNeighbours(src.manifest, variableId, frame.id, resolutionId);
    void this.applyValidMask(src, key, frame.id, resolutionId);
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

  /** Fetch (or clear) the primary field's per-texel land/ocean validity
   *  mask for a continental-only model (e.g. Pohl) -- see
   *  core/material.ts's uValidMask. A model with full coverage (no
   *  `manifest.mask_variable`, e.g. Li et al. or paleogeography) clears
   *  any mask left over from a previously-active model instead of fetching
   *  anything. Mirrors loadFrame()/loadOverlayFrame()'s own stale-fetch
   *  guard with its own token, since this runs as an un-awaited side effect
   *  of loadFrame() and could otherwise land after a newer one. */
  private async applyValidMask(
    src: LayerSource, modelId: string, frameId: string, resolutionId: string,
  ): Promise<void> {
    const maskVar = src.manifest.mask_variable;
    const token = ++this.maskToken;
    if (!maskVar) {
      setValidMask(this.field.material, null);
      return;
    }
    const tex = await loadMask2D(this.deps.archiveBase, modelId, src.manifest, maskVar, frameId, resolutionId);
    if (token !== this.maskToken) return;
    setValidMask(this.field.material, tex);
  }

  /** Fetch the hillshade frame nearest `age` and apply it to the overlay
   *  mesh, independent of `view.layer`/`variableId` -- the overlay always
   *  tracks the paleogeography source's own 'hillshade' variable, at
   *  whichever resolution `view.resolution` currently selects. Mirrors
   *  loadFrame()'s stale-fetch guard with its own token. */
  private async loadOverlayFrame(age: number): Promise<void> {
    const src = this.sources[this.paleogeographyModelId];
    const resolutionId = this.view.resolution;
    const token = ++this.overlayToken;

    const frame = nearestFrame(src.manifest, age);
    const tex = await src.frames.get(src.manifest, HILLSHADE_VARIABLE_ID, frame.id, resolutionId);
    if (token !== this.overlayToken || resolutionId !== this.view.resolution) return;
    this.applyVolume(src.manifest, tex, resolutionId, this.overlay.material);
  }

  /** Fetch the U/V frames nearest `age` (always from the ACTIVE climate
   *  model, independent of `view.layer`) and hand their raw bytes to
   *  WindGlyphs. Mirrors loadFrame()/loadOverlayFrame()'s stale-fetch
   *  guard. A no-op if the active model has no wind field -- callers
   *  already check `hasWind` first. */
  private async loadWindFrame(age: number): Promise<void> {
    const src = this.sources[this.view.climateModelId];
    const field = src.manifest.vector_fields![0];
    const token = ++this.windToken;

    const frame = nearestFrame(src.manifest, age);
    const [uTex, vTex] = await Promise.all([
      src.frames.get(src.manifest, field.u_variable, frame.id),
      src.frames.get(src.manifest, field.v_variable, frame.id),
    ]);
    if (token !== this.windToken) return;
    this.windUTex = uTex;
    this.windVTex = vTex;
    this.refreshWindGlyphs();
  }

  /** The current month's (nlat*nlon) plane of the active climate model's
   *  U/V textures -- shared by refreshWindGlyphs() (WindGlyphs) and tick()
   *  (WindStreaks), both reading the exact same slice of the same data. See
   *  loadVolume()'s doc comment for why a plane is a contiguous
   *  (nlat*nlon) slice at `month * nlat * nlon` (longitude fastest, then
   *  latitude, then depth). Null when no wind frame has loaded yet. */
  private currentWindPlane(): {
    uData: Uint8Array; vData: Uint8Array; nlon: number; nlat: number;
  } | null {
    if (!this.windUTex || !this.windVTex) return null;
    const manifest = this.sources[this.view.climateModelId].manifest;
    const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
    const plane = res.nlon * res.nlat;
    const offset = this.view.month * plane;
    const uData = this.windUTex.image.data as Uint8Array;
    const vData = this.windVTex.image.data as Uint8Array;
    return {
      uData: uData.subarray(offset, offset + plane),
      vData: vData.subarray(offset, offset + plane),
      nlon: res.nlon,
      nlat: res.nlat,
    };
  }

  /** Re-pose every wind glyph from whichever U/V plane is currently held. */
  private refreshWindGlyphs(): void {
    const plane = this.currentWindPlane();
    if (!plane) return;
    this.wind.update(
      plane.uData, plane.vData, plane.nlon, plane.nlat, this.windUVar, this.windVVar,
    );
  }

  /** Advance the Wind Streak particle simulation by one animation frame's
   *  worth of (real, wall-clock) time. Called every frame regardless of
   *  whether any data changed -- unlike WindGlyphs, which only reposes on
   *  data/control changes, Wind Streak must keep moving between them (it is
   *  a perpetual flow along a static snapshot, see the class doc comment on
   *  WindStreaks) or it would just sit frozen. A no-op whenever Wind Streak
   *  isn't the active, visible mode. */
  tick(dt: number): void {
    if (!this.streakActive) return;
    const plane = this.currentWindPlane();
    if (!plane) return;
    this.windStreaks.update(
      dt, plane.uData, plane.vData, plane.nlon, plane.nlat, this.windUVar, this.windVVar,
    );
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** Same level of thoroughness as GlobeInstance.dispose(): the panel and
   *  coastlines (which own DOM nodes / a texture respectively) are
   *  disposed; base geometries/materials (field, overlay, wind, windStreaks)
   *  are not, bounded by however many instances remain rather than worth
   *  the extra bookkeeping -- matching the precedent this mirrors rather
   *  than holding climate to a stricter standard. */
  dispose(): void {
    this.ui.dispose();
    this.coastlines?.dispose();
  }
}
