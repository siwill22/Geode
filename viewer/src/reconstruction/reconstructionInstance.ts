import { type Camera, type PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { Coastlines, LAND_R_UNDER_SURFACE, fetchCoastlineData } from '../core/coastlines';
import { createMaskTexture } from '../core/mask';
import { BoundaryOverlay } from '../core/boundaries';
import { reconstructionAssetPath, reconstructionAssetUrl } from '../core/reconstructions';
import type { ReconstructionManifest } from '../core/types';
import type { Rect } from '../core/layout';
import { ReconstructionUI, type ReconstructionViewState } from './reconstructionUi';

const LAND_FILL_COLOR = 0x808080;

export interface ReconstructionInstanceDeps {
  archiveBase: string;
  manifest: ReconstructionManifest;
  title: string;
}

/** See globe/globeInstance.ts's GlobeInstanceHooks -- identical reasoning
 *  (no onFocus, Reconstruction Age is the only Synced Field this wrapper
 *  type offers). */
export interface ReconstructionInstanceHooks {
  onRemove(self: ReconstructionInstance): void;
  onAgeChange?(self: ReconstructionInstance, age: number): void;
}

/**
 * One globe showing exactly one Reconstruction Model's own geometry --
 * coastlines always, Boundary Frames when the model has them (see
 * docs/adr/0019). Never a numerical field (docs/adr/0020) -- this is the
 * `single-reconstruction-globe` wrapper, the reconstruction-only sibling of
 * globe/globeInstance.ts (which shows exactly one numerical Model instead).
 */
export class ReconstructionInstance {
  readonly scene = new Scene();
  readonly ui: ReconstructionUI;
  readonly boundaries: BoundaryOverlay;
  /** Built in boot() once the geometry has been fetched -- every
   *  Reconstruction Model has coastlines (unlike Boundary Frames, never
   *  optional), so this is always assigned before any other method runs. */
  coastlines!: Coastlines;

  readonly view: ReconstructionViewState = { age: 0, showBoundaries: true };

  get manifest(): ReconstructionManifest { return this.deps.manifest; }

  constructor(
    private camera: Camera,
    private readonly deps: ReconstructionInstanceDeps,
    private readonly hooks: ReconstructionInstanceHooks,
  ) {
    this.boundaries = new BoundaryOverlay(camera as PerspectiveCamera);

    this.ui = new ReconstructionUI(this.view, {
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onShowBoundaries: (show) => { this.boundaries.visible = show; },
    }, deps.title, () => this.hooks.onRemove(this));
  }

  async boot(): Promise<void> {
    this.ui.setStatus('loading...');
    const m = this.deps.manifest;

    const data = await fetchCoastlineData(
      this.deps.archiveBase,
      reconstructionAssetPath(m, m.coastlines.geometry),
      reconstructionAssetPath(m, m.coastlines.rotations),
    );
    const maskTexture = createMaskTexture();
    this.coastlines = new Coastlines(data.lines, data.table, maskTexture, LAND_R_UNDER_SURFACE, LAND_FILL_COLOR);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.landVisible = true;
    this.scene.add(this.coastlines.lines, this.coastlines.land);

    this.view.age = m.age_min;
    this.ui.setAgeRange(m.age_min, m.age_max);

    if (m.has_boundaries && m.boundaries) {
      await this.boundaries.load(reconstructionAssetUrl(this.deps.archiveBase, m, m.boundaries));
    }
    this.ui.setBoundariesAvailable(m.has_boundaries);
    this.boundaries.visible = m.has_boundaries;

    this.coastlines.setAge(this.view.age);
    await this.boundaries.setAge(this.view.age);
    this.ui.setTimeInfo(`age ${this.view.age.toFixed(0)} Ma`);
    this.ui.setCredit(`${m.name} -- ${m.citation}`);
    this.ui.setStatus('');
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines.setAge(age);
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
    this.coastlines?.dispose();
    this.boundaries.dispose();
  }
}
