import { type Camera, type PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { createMaskTexture } from '../core/mask';
import { BoundaryOverlay } from '../core/boundaries';
import { loadReconstructionManifest, reconstructionAssetPath, reconstructionAssetUrl } from '../core/reconstructions';
import type { ReconstructionEntry, ReconstructionManifest } from '../core/types';
import type { Rect } from '../core/layout';
import { ReconstructionGroupUI, type ReconstructionGroupViewState } from './reconstructionGroupUi';


export interface ReconstructionGroupInstanceDeps {
  archiveBase: string;
  entries: ReconstructionEntry[];
  title: string;
}

/** See globe/globeInstance.ts's GlobeInstanceHooks -- identical reasoning
 *  (no onFocus, Reconstruction Age is the only Synced Field this wrapper
 *  type offers). */
export interface ReconstructionGroupInstanceHooks {
  onRemove(self: ReconstructionGroupInstance): void;
  onAgeChange?(self: ReconstructionGroupInstance, age: number): void;
}

/**
 * One globe comparing several Reconstruction Models' own geometry, switched
 * via one dropdown -- coastlines always, Boundary Frames when the currently
 * -selected model has them (docs/adr/0019). Never a numerical field
 * (docs/adr/0020): the comparison is ONE axis (which Reconstruction Model),
 * never a 2-D grid like `model-group-globe`'s reconstruction x role. See
 * reconstruction/reconstructionInstance.ts for the single-model sibling
 * this generalizes by adding reconstruction-switching, the same
 * relationship globe/groupGlobe already have.
 */
export class ReconstructionGroupInstance {
  readonly scene = new Scene();
  readonly ui: ReconstructionGroupUI;
  readonly boundaries: BoundaryOverlay;
  /** A solid ocean, always present: continents previously sat straight on
   *  the page colour, so the globe read as a cut-out and the far
   *  hemisphere's coastlines showed through. */
  readonly ocean = new OceanSurface('globe');
  coastlines: Coastlines | null = null;
  private readonly maskTexture = createMaskTexture();

  readonly view: ReconstructionGroupViewState = { reconstruction: '', age: 0, showBoundaries: true };

  /** Guards setReconstruction() against a no-op re-entry -- deliberately NOT
   *  `this.view.reconstruction`: lil-gui's OptionController writes the new
   *  value into the shared `view` object BEFORE firing onChange, so a real
   *  dropdown click has already made this comparison true by the time this
   *  callback runs. Same bug, same fix, as GroupGlobeInstance's
   *  `activeAxisA`/`activeAxisB`. */
  private activeReconstruction = '';

  get manifest(): ReconstructionManifest | null { return this.currentManifest; }
  private currentManifest: ReconstructionManifest | null = null;

  constructor(
    private camera: Camera,
    private readonly deps: ReconstructionGroupInstanceDeps,
    private readonly hooks: ReconstructionGroupInstanceHooks,
  ) {
    this.boundaries = new BoundaryOverlay(camera as PerspectiveCamera);

    this.ui = new ReconstructionGroupUI(this.view, {
      onReconstruction: (id) => void this.setReconstruction(id),
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onShowBoundaries: (show) => { this.boundaries.visible = show; },
    }, deps.title, () => this.hooks.onRemove(this));
    this.ui.setReconstructionOptions(deps.entries);
  }

  async boot(): Promise<void> {
    const first = this.deps.entries[0];
    if (!first) throw new Error('reconstruction-group-globe needs at least 1 reconstruction_models entry');
    this.view.reconstruction = first.id;
    await this.setReconstruction(first.id);
  }

  async setReconstruction(id: string): Promise<void> {
    if (id === this.activeReconstruction) return;
    this.activeReconstruction = id;
    this.view.reconstruction = id;

    const entry = this.deps.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`reconstruction_models has no entry '${id}'`);

    this.ui.setStatus('loading...');
    const manifest = await loadReconstructionManifest(this.deps.archiveBase, entry.path);
    this.currentManifest = manifest;

    if (this.coastlines) {
      this.scene.remove(this.coastlines.lines, this.coastlines.land);
      this.coastlines.dispose();
      this.coastlines = null;
    }

    const data = await fetchCoastlineData(
      this.deps.archiveBase,
      reconstructionAssetPath(manifest, manifest.coastlines.geometry),
      reconstructionAssetPath(manifest, manifest.coastlines.rotations),
    );
    // Default land radius, not LAND_R_UNDER_SURFACE: there is an opaque
    // ocean at R_SURFACE now, and land beneath it would be inside the
    // sphere. Land colour comes from the Theme rather than a local grey.
    this.coastlines = new Coastlines(data.lines, data.table, this.maskTexture);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.landVisible = true;
    this.scene.add(this.ocean.mesh, this.coastlines.lines, this.coastlines.land);
    // No Theme control in this wrapper yet (docs/adr/0038 wants one); it
    // renders the default Theme's furniture until that lands.
    const theme = resolveTheme(DEFAULT_THEME);
    this.ocean.applyTheme(theme);
    this.coastlines.applyTheme(theme);
    // Boundaries too, or they keep the pre-Theme black subduction stroke --
    // which was already weak on a black page and is invisible against a solid
    // ocean. Safe to call before load(): BoundaryOverlay holds it as
    // pendingTheme and applies it when the frames arrive.
    this.boundaries.applyTheme(theme);

    if (manifest.has_boundaries && manifest.boundaries) {
      await this.boundaries.load(reconstructionAssetUrl(this.deps.archiveBase, manifest, manifest.boundaries));
    }
    this.ui.setBoundariesAvailable(manifest.has_boundaries);
    this.boundaries.visible = manifest.has_boundaries;

    this.view.age = manifest.age_min;
    this.ui.setAgeRange(manifest.age_min, manifest.age_max);
    this.coastlines.setAge(this.view.age);
    await this.boundaries.setAge(this.view.age);
    this.ui.setTimeInfo(`age ${this.view.age.toFixed(0)} Ma`);
    this.ui.setCredit(`${manifest.name} -- ${manifest.citation}`);
    this.ui.refreshDisplay();
    this.ui.setStatus('');
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines?.setAge(age);
    void this.boundaries.setAge(age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
  }

  /** Move this instance's boundary overlay and panel onto a new tile -- see
   *  core/multiInstanceHost.ts, docs/adr/0022. */
  applyLayout(rect: Rect): void {
    this.boundaries.setRect(rect);
    this.ui.setRect(rect);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.boundaries.draw();
  }

  dispose(): void {
    this.ui.dispose();
    this.ocean.dispose();
    this.coastlines?.dispose();
    this.boundaries.dispose();
  }
}
