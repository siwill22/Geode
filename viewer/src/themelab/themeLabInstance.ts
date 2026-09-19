import { type Camera, type PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { createMaskTexture } from '../core/mask';
import { BoundaryOverlay } from '../core/boundaries';
import { reconstructionAssetPath, reconstructionAssetUrl } from '../core/reconstructions';
import { DEFAULT_THEME, resolveTheme, type ResolvedTheme, type ThemeId } from '../core/theme';
import type { ReconstructionManifest } from '../core/types';
import type { Rect } from '../core/layout';
import { ThemeLabUI, type ThemeLabViewState } from './themeLabUi';

export interface ThemeLabInstanceDeps {
  archiveBase: string;
  manifest: ReconstructionManifest;
  title: string;
}

export interface ThemeLabInstanceHooks {
  onRemove(self: ThemeLabInstance): void;
  onAgeChange?(self: ThemeLabInstance, age: number): void;
}

/**
 * One globe in the theme lab: a single Reconstruction Model's coastlines and
 * Boundary Frames, and nothing else. No painted field, no Variable, no legend.
 *
 * The minimal content is the point rather than a limitation. This wrapper
 * exists to judge a Theme, so anything on screen that a Theme does not govern
 * is a distraction from the only question being asked.
 *
 * THEME IS PER-INSTANCE HERE, and only here. Everywhere else a Theme is global
 * to the page (docs/adr/0038), by the same rule that makes it per-instance in
 * this wrapper: CONTEXT.md's Synced Field rule says a field that defines what
 * is being COMPARED is never shared. In every other viewer a Theme is
 * presentation and two palettes side by side would be noise; in a lab whose
 * subject IS the Theme, it is the comparison axis.
 */
export class ThemeLabInstance {
  readonly scene = new Scene();
  readonly ui: ThemeLabUI;
  readonly boundaries: BoundaryOverlay;
  /** Built up-front, unlike coastlines: it needs no fetched data, and having
   *  it in the scene before boot() means the very first painted frame already
   *  has an ocean rather than a flash of page colour. */
  readonly ocean = new OceanSurface('globe');
  coastlines!: Coastlines;

  readonly view: ThemeLabViewState = {
    age: 0,
    showBoundaries: true,
    showLand: true,
    showOcean: true,
    showEdges: true,
    themeId: DEFAULT_THEME,
  };

  /** Resolved once per Theme change, not per frame -- every consumer wants the
   *  numeric form and resolving involves a Lab conversion for `shade` pens. */
  private resolved: ResolvedTheme = resolveTheme(DEFAULT_THEME);

  get theme(): ResolvedTheme { return this.resolved; }
  get manifest(): ReconstructionManifest { return this.deps.manifest; }

  constructor(
    private camera: Camera,
    private readonly deps: ThemeLabInstanceDeps,
    private readonly hooks: ThemeLabInstanceHooks,
  ) {
    this.boundaries = new BoundaryOverlay(camera as PerspectiveCamera);

    this.ui = new ThemeLabUI(this.view, {
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onShowBoundaries: (show) => { this.boundaries.visible = show; },
      onShowLand: (show) => { if (this.coastlines) this.coastlines.landVisible = show; },
      onShowOcean: (show) => { this.ocean.visible = show; },
      onShowEdges: (show) => { if (this.coastlines) this.coastlines.penVisible = show; },
      onTheme: (id) => this.applyThemeId(id),
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
    // Default land radius (LAND_R, just clear of the surface sphere), NOT
    // LAND_R_UNDER_SURFACE: there is an opaque ocean at R_SURFACE now, and
    // land beneath it would be inside the sphere and invisible.
    this.coastlines = new Coastlines(data.lines, data.table, maskTexture);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.landVisible = this.view.showLand;
    this.coastlines.penVisible = this.view.showEdges;
    this.scene.add(this.ocean.mesh, this.coastlines.lines, this.coastlines.land);

    this.view.age = m.age_min;
    this.ui.setAgeRange(m.age_min, m.age_max);

    if (m.has_boundaries && m.boundaries) {
      await this.boundaries.load(reconstructionAssetUrl(this.deps.archiveBase, m, m.boundaries));
    }
    this.ui.setBoundariesAvailable(m.has_boundaries);
    this.boundaries.visible = m.has_boundaries && this.view.showBoundaries;

    // Applied after the coastlines exist but BEFORE the first age render, so
    // nothing is ever painted in the seed colours.
    this.applyThemeId(this.view.themeId);

    this.coastlines.setAge(this.view.age);
    await this.boundaries.setAge(this.view.age);
    this.ui.setTimeInfo(`age ${this.view.age.toFixed(0)} Ma`);
    this.ui.setCredit(`${m.name} -- ${m.citation}`);
    this.ui.setStatus('');
  }

  applyThemeId(id: ThemeId): void {
    this.view.themeId = id;
    this.resolved = resolveTheme(id);
    this.coastlines?.applyTheme(this.resolved);
    this.ocean.applyTheme(this.resolved);
    this.boundaries.applyTheme(this.resolved);
    this.ui.setThemeInfo(this.resolved);
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines.setAge(age);
    void this.boundaries.setAge(age);
    this.ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
  }

  applyLayout(rect: Rect): void {
    this.boundaries.setRect(rect);
    this.ui.setRect(rect);
  }

  /**
   * Render into the tile this instance owns.
   *
   * The scissored clear is what makes a per-instance `page` colour possible at
   * all: `setClearColor` is renderer-global (one canvas, one renderer, see
   * core/layout.ts), so without clearing inside this tile's own scissor rect
   * every globe would share whichever Theme happened to set it last.
   */
  render(renderer: WebGLRenderer): void {
    renderer.setClearColor(this.resolved.page, 1);
    renderer.clear(true, true, false);
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
