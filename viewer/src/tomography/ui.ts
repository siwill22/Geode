import GUI from 'lil-gui';
import { MAX_STEPS, type IsosurfaceState } from './isosurface';
import { SINKING_RATE_PRESETS, CUSTOM_PRESET_ID, type DepthSliceState } from '../core/depthSlice';
import { clipSliderStep } from '../core/clipRange';
import type { Rect } from '../core/layout';
import type { ArchiveIndex, Manifest, VariableInfo } from '../core/types';

export type ToolMode = 'drag' | 'draw' | 'edit';

/**
 * What the globe's surface shows.
 *   topography - GEBCO relief. Present-day only; meaningless at age > 0.
 *   land       - reconstructed land polygons filled, correct at any age.
 *   flat       - plain ocean colour.
 *   none       - hide the outer sphere entirely, to see a depth slice or
 *                isosurface without needing to open a cutaway.
 */
export type SurfaceMode = 'topography' | 'land' | 'flat' | 'none';

export interface ViewState {
  modelId: string;
  variableId: string;
  colormap: string;
  clipMin: number;
  clipMax: number;
  symmetricClip: boolean;
  colorSteps: number;   // 0 = continuous ramp, else discrete bands
  reconstructionAge: number;
  cutDepthKm: number;
  inverted: boolean;
  surfaceOpacity: number;
  surfaceMode: SurfaceMode;
  showBoundaries: boolean;
  tool: ToolMode;
  iso: IsosurfaceState;
  depthSlice: DepthSliceState;
}

export interface UICallbacks {
  onModel(id: string): void;
  onVariable(id: string): void;
  onColormap(name: string): void;
  onColorSteps(n: number): void;
  onClip(): void;
  onAge(age: number): void;
  onCutDepth(km: number): void;
  onInvert(): void;
  onSurfaceOpacity(v: number): void;
  onSurfaceMode(m: SurfaceMode): void;
  onBoundaries(on: boolean): void;
  onIsosurface(): void;
  onDepthSlice(): void;
  onTool(t: ToolMode): void;
  onClear(): void;
  onExportPNG(): void;
  onExportPolygon(): void;
  onImportPolygon(): void;
}

export class UI {
  readonly gui: GUI;
  private clipMinCtrl!: any;
  private clipMaxCtrl!: any;
  private variableCtrl!: any;
  private colormapCtrl!: any;
  private ageCtrl!: any;
  private isoColdEnabledCtrl!: any;
  private isoColdCtrl!: any;
  private isoHotEnabledCtrl!: any;
  private isoHotCtrl!: any;
  private depthSliceDepthCtrl!: any;
  private depthSinkingCtrl!: any;
  private sinkingPresetCtrl!: any;
  private depthRateUpperCtrl!: any;
  private depthRateLowerCtrl!: any;
  private folderData: GUI;
  private surfaceModeCtrl: any;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  /** Positioned per-instance by setRect(); anchors the panel's top-right corner. */
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private state: ViewState,
    archive: ArchiveIndex,
    colormapNames: string[],
    private cb: UICallbacks,
    title = 'Geode',
    onRemove?: () => void,
    // Every additional globe past the first starts collapsed to just its
    // title bar -- see climate/climateUi.ts's identical parameter for the
    // full reasoning (several full panels from Multi-Globe/the "Start Here"
    // presets otherwise obscure most of the screen).
    startCollapsed = false,
  ) {
    // lil-gui's own auto-placement is a single fixed panel pinned to the
    // window's top-right corner, which is right for one globe but would stack
    // every instance's panel on top of the others once there is more than one.
    // Anchoring a per-instance container instead lets setRect() move each
    // panel to its own tile, and reduces to exactly the original placement
    // when the tile is the whole window.
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });
    if (startCollapsed) this.gui.close();

    // Quick access: added directly to the panel root, above every folder and
    // never collapsed with one -- these are the two controls scrubbed
    // constantly while exploring a model, so they don't get a fold to open
    // first. Everything else below is one-time setup or occasional tuning,
    // grouped into folders by what question it answers.
    this.ageCtrl = this.gui
      .add(this.state, 'reconstructionAge', archive.coastlines.age_min,
        archive.coastlines.age_max, 0.5)
      .name('age (Ma)')
      .onChange((v: number) => cb.onAge(v));
    this.gui.add(this.state.depthSlice, 'enabled')
      .name('depth slice')
      .onChange(() => cb.onDepthSlice());
    this.depthSliceDepthCtrl = this.gui
      .add(this.state.depthSlice, 'depthKm', 0, 2890, 10)
      .name('depth (km)')
      .onChange(() => cb.onDepthSlice());

    const models: Record<string, string> = {};
    // Climate/paleogeography models have their own page (climate.html), and
    // Valdes/BRIDGE's Monthly/Ocean Depth Layers have their own dedicated
    // instance (valdes.html, see docs/adr/0008) -- all four have an
    // interface suited to them; listing one here would just be a confusing
    // dead end, since this panel offers no path to anything but its
    // cutaway/isosurface/sinking-rate controls (no month axis, in
    // particular), none of which apply to those Layers.
    const OTHER_PAGE_TYPES = new Set([
      'climate', 'paleogeography', 'climate-monthly', 'climate-ocean-depth',
    ]);
    for (const m of archive.models) {
      // fixture-* entries are synthetic data for scripts/shoot.mjs's own
      // acceptance checks -- never a real published model, so never offered
      // here. A Model declaring reconstruction_model/comparison_role is a
      // member of a comparison family (e.g. Cao2024/Muller2019 Deformation
      // vs. Age & Heat Flux) meant to be switched between via the
      // generator's model-group-globe wrapper's two dedicated axis
      // dropdowns -- exposed one-by-one in this plain single-model list, it
      // reads as four confusingly-similar near-duplicate entries with no
      // way to see they're related. Same exclusion tomography/main.ts's
      // Atlantic preset already applies for the same reason.
      if (!OTHER_PAGE_TYPES.has(m.type) && !m.id.startsWith('fixture-')
        && !m.reconstruction_model && !m.comparison_role) {
        models[m.name] = m.id;
      }
    }

    // "Data": what to look at and how to colour it -- model/variable choice
    // and the colour ramp both answer that one question.
    this.folderData = this.gui.addFolder('Data');
    this.folderData
      .add(this.state, 'modelId', models)
      .name('model')
      .onChange((v: string) => cb.onModel(v));
    this.variableCtrl = this.folderData
      .add(this.state, 'variableId', { '-': '-' })
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));
    this.colormapCtrl = this.folderData
      .add(this.state, 'colormap', colormapNames)
      .name('colormap')
      .onChange((v: string) => cb.onColormap(v));
    this.clipMinCtrl = this.folderData
      .add(this.state, 'clipMin', -10, 0, 0.01)
      .name('clip min')
      .onChange(() => this.handleClip('min'));
    this.clipMaxCtrl = this.folderData
      .add(this.state, 'clipMax', 0, 10, 0.01)
      .name('clip max')
      .onChange(() => this.handleClip('max'));
    this.folderData.add(this.state, 'symmetricClip')
      .name('symmetric')
      .onChange(() => this.handleClip('min'));
    // 0 and 1 both mean "smooth" -- a single band would be one flat colour
    // across the whole section, which nobody wants and which reads as a bug.
    this.folderData.add(this.state, 'colorSteps', 0, 20, 1)
      .name('divisions (0 = smooth)')
      .onChange((v: number) => cb.onColorSteps(v));

    const fs = this.gui.addFolder('Scene');
    this.surfaceModeCtrl = fs
      .add(this.state, 'surfaceMode',
        {
          Topography: 'topography',
          'Filled continents': 'land',
          'Transparent continents': 'flat',
          None: 'none',
        })
      .name('surface')
      .onChange((v: SurfaceMode) => cb.onSurfaceMode(v));
    fs.add(this.state, 'surfaceOpacity', 0, 1, 0.01)
      .name('surface opacity')
      .onChange((v: number) => cb.onSurfaceOpacity(v));
    fs.add(this.state, 'showBoundaries')
      .name('plate boundaries')
      .onChange((v: boolean) => cb.onBoundaries(v));

    const fx = this.gui.addFolder('Cutaway');
    fx.add(this.state, 'tool', { 'Drag Globe': 'drag', 'Draw Polygon': 'draw', 'Edit Vertices': 'edit' })
      .name('tool')
      .onChange((v: ToolMode) => cb.onTool(v));
    fx.add(this.state, 'cutDepthKm', 100, 2890, 10)
      .name('cut depth (km)')
      .onChange((v: number) => cb.onCutDepth(v));
    fx.add(this.state, 'inverted')
      .name('invert')
      .onChange(() => cb.onInvert());
    fx.add({ clear: () => cb.onClear() }, 'clear').name('clear polygon');

    // Two isosurfaces, not one with a mirrored partner: a cold downwelling and
    // a hot upwelling are unrelated objects at unrelated magnitudes, and tying
    // their isovalues together would be a claim about the data.
    const fi = this.gui.addFolder('Isosurfaces');
    this.isoColdEnabledCtrl = fi.add(this.state.iso, 'coldEnabled')
      .name('cold surface')
      .onChange(() => cb.onIsosurface());
    this.isoColdCtrl = fi
      .add(this.state.iso, 'coldValue', -1, 1, 0.001)
      .name('cold isovalue')
      .onChange(() => cb.onIsosurface());
    this.isoHotEnabledCtrl = fi.add(this.state.iso, 'hotEnabled')
      .name('hot surface')
      .onChange(() => cb.onIsosurface());
    this.isoHotCtrl = fi
      .add(this.state.iso, 'hotValue', -1, 1, 0.001)
      .name('hot isovalue')
      .onChange(() => cb.onIsosurface());
    // "iso depth", never bare "depth": the Cutaway's cut depth is a different
    // quantity in the same units, and the two must not read as the same control.
    fi.add(this.state.iso, 'depthMinKm', 0, 2890, 10)
      .name('iso depth min (km)')
      .onChange(() => cb.onIsosurface());
    fi.add(this.state.iso, 'depthMaxKm', 0, 2890, 10)
      .name('iso depth max (km)')
      .onChange(() => cb.onIsosurface());
    fi.add(this.state.iso, 'steps', 32, MAX_STEPS, 8)
      .name('quality (steps)')
      .onChange(() => cb.onIsosurface());
    fi.close();

    // Sinking-rate SETUP for the depth slice above (enabled/depth themselves
    // are quick-access controls at the panel root). Slabs are assumed to
    // sink vertically at a fixed rate -- stated here rather than left
    // implicit. See docs/plans/depth-slice-and-sinking-rate.md.
    const fd = this.gui.addFolder('Sinking rate');
    this.depthSinkingCtrl = fd
      .add(this.state.depthSlice, 'sinkingEnabled')
      .name('lock to age (sinking rate)')
      .onChange(() => cb.onDepthSlice());
    // Presets seed the two rate sliders below rather than replacing them --
    // picking one is a starting point, not a lock. Editing either slider by
    // hand reverts this to "Custom" so the dropdown never claims a paper's
    // rate when the numbers no longer match it.
    const presetOptions: Record<string, string> = { Custom: CUSTOM_PRESET_ID };
    for (const p of SINKING_RATE_PRESETS) presetOptions[p.label] = p.id;
    this.sinkingPresetCtrl = fd
      .add(this.state.depthSlice, 'sinkingPreset', presetOptions)
      .name('sinking rate model')
      .onChange((id: string) => {
        const preset = SINKING_RATE_PRESETS.find((p) => p.id === id);
        if (preset) {
          this.state.depthSlice.rateUpperCmPerYr = preset.upperCmPerYr;
          this.state.depthSlice.rateLowerCmPerYr = preset.lowerCmPerYr;
          this.depthRateUpperCtrl.updateDisplay();
          this.depthRateLowerCtrl.updateDisplay();
        }
        cb.onDepthSlice();
      });
    // Range covers Shephard et al. 2017's fast-upper-mantle preset (5 cm/yr)
    // with a little headroom, not just the lower-mantle-only presets.
    this.depthRateUpperCtrl = fd
      .add(this.state.depthSlice, 'rateUpperCmPerYr', 0.5, 6.0, 0.1)
      .name('sinking rate above 660 km (cm/yr)')
      .onChange(() => this.revertSinkingPresetToCustom());
    this.depthRateLowerCtrl = fd
      .add(this.state.depthSlice, 'rateLowerCmPerYr', 0.5, 6.0, 0.1)
      .name('sinking rate below 660 km (cm/yr)')
      .onChange(() => this.revertSinkingPresetToCustom());
    fd.close();

    const fe = this.gui.addFolder('Export');
    fe.add({ png: () => cb.onExportPNG() }, 'png').name('PNG screenshot');
    fe.add({ p: () => cb.onExportPolygon() }, 'p').name('polygon -> GeoJSON');
    fe.add({ i: () => cb.onImportPolygon() }, 'i').name('load polygon');
    fe.close();

    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }

    this.status = document.createElement('div');
    this.status.className = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    this.applyRect();
  }

  private handleClip(driver: 'min' | 'max'): void {
    if (this.state.symmetricClip) {
      const m = driver === 'min'
        ? Math.abs(this.state.clipMin)
        : Math.abs(this.state.clipMax);
      this.state.clipMin = -m;
      this.state.clipMax = m;
      this.clipMinCtrl.updateDisplay();
      this.clipMaxCtrl.updateDisplay();
    }
    this.cb.onClip();
  }

  /** Re-point the variable dropdown and clip sliders when the model changes. */
  setModel(manifest: Manifest, variable: VariableInfo): void {
    const opts: Record<string, string> = {};
    for (const v of manifest.variables) opts[v.name] = v.id;
    this.variableCtrl = this.variableCtrl.options(opts).onChange(
      (v: string) => this.cb.onVariable(v),
    );
    this.variableCtrl.setValue(variable.id);
    this.setVariable(variable);
  }

  /**
   * Clip sliders are bounded by the encode range: outside it the data is clamped.
   *
   * The isovalues are re-seeded from the same defaults for a blunter reason:
   * they are absolute numbers in the variable's own units, and REVEAL is in per
   * cent while OPT1 is in kelvin. Carrying "2" across that switch would silently
   * mean something 400 times smaller.
   */
  setVariable(v: VariableInfo): void {
    this.state.clipMin = v.default_clip_min;
    this.state.clipMax = v.default_clip_max;
    // Step must be re-derived per variable, same reasoning as min/max
    // below -- see clipSliderStep()'s doc comment. Each half gets its own
    // step, sized to ITS OWN span (min's [encode_min, 0], max's
    // [0, encode_max]), since the two are rarely symmetric.
    this.clipMinCtrl.min(v.encode_min).max(0).step(clipSliderStep(v.encode_min, 0)).setValue(v.default_clip_min);
    this.clipMaxCtrl.min(0).max(v.encode_max).step(clipSliderStep(0, v.encode_max)).setValue(v.default_clip_max);
    this.clipMinCtrl.name(`clip min (${v.units})`);
    this.clipMaxCtrl.name(`clip max (${v.units})`);

    const step = (v.encode_max - v.encode_min) / 1000;
    this.isoColdCtrl.min(v.encode_min).max(v.encode_max).step(step)
      .setValue(v.default_clip_min);
    this.isoHotCtrl.min(v.encode_min).max(v.encode_max).step(step)
      .setValue(v.default_clip_max);

    // 'fast' variables (seismic velocity) are the opposite of temperature: the
    // high value is the COLD one, so calling it "hot isovalue" would say the
    // opposite of what the isosurface.setPolarity() colour shows. "slow"/
    // "fast" name the physical quantity instead of a temperature that may be
    // inverted from it.
    const [lowLabel, highLabel] = (v.high_means ?? 'fast') === 'fast'
      ? ['slow', 'fast']
      : ['cold', 'hot'];
    this.isoColdEnabledCtrl.name(`${lowLabel} surface`);
    this.isoHotEnabledCtrl.name(`${highLabel} surface`);
    this.isoColdCtrl.name(`${lowLabel} isovalue (${v.units})`);
    this.isoHotCtrl.name(`${highLabel} isovalue (${v.units})`);
  }

  setSurfaceMode(m: SurfaceMode): void {
    this.state.surfaceMode = m;
    this.surfaceModeCtrl.updateDisplay();
  }

  /** Depth is state-computed while sinking mode drives it -- dragging the
   *  slider then would just get overwritten on the next age change. */
  setDepthEditable(editable: boolean): void {
    this.depthSliceDepthCtrl.disable(!editable);
  }

  /** A hand-edited rate no longer necessarily matches the preset it was
   *  seeded from, so the dropdown must stop claiming it does. */
  private revertSinkingPresetToCustom(): void {
    if (this.state.depthSlice.sinkingPreset !== CUSTOM_PRESET_ID) {
      this.state.depthSlice.sinkingPreset = CUSTOM_PRESET_ID;
      this.sinkingPresetCtrl.updateDisplay();
    }
    this.cb.onDepthSlice();
  }

  /** Repaint just the depth number -- called every time sinking mode
   *  recomputes it from age, which can happen many times a second while
   *  scrubbing, so this deliberately doesn't sweep every controller. */
  refreshDepthSliceDisplay(): void {
    this.depthSliceDepthCtrl.updateDisplay();
  }

  /** Grey out sinking mode for models with their own time axis (convection):
   *  letting one slider drive both the loaded frame and the sinking depth
   *  would double-count time. */
  setSinkingAllowed(allowed: boolean): void {
    this.depthSinkingCtrl.disable(!allowed);
    this.sinkingPresetCtrl.disable(!allowed);
    this.depthRateUpperCtrl.disable(!allowed);
    this.depthRateLowerCtrl.disable(!allowed);
    this.depthSinkingCtrl.name(allowed
      ? 'lock to age (sinking rate)'
      : 'lock to age (disabled: model has its own time axis)');
  }

  /**
   * Restrict the age slider to what the loaded model can actually show.
   * A single-frame tomography model still reconstructs its coastlines, so the
   * range comes from the archive rather than the model's frame list.
   */
  setAgeRange(min: number, max: number, step = 0.5): void {
    this.ageCtrl.min(min).max(max).step(step);
    if (this.state.reconstructionAge > max) {
      this.state.reconstructionAge = max;
    }
    this.ageCtrl.updateDisplay();
  }

  /**
   * Offer only the ramps whose polarity suits the variable.
   *
   * A temperature anomaly and a velocity anomaly need opposite orientations,
   * and picking the wrong one inverts every structure on screen while looking
   * completely plausible. Filtering makes that unreachable rather than merely
   * non-default.
   */
  setColormapOptions(names: string[], current: string): void {
    this.colormapCtrl = this.colormapCtrl
      .options(names)
      .onChange((v: string) => this.cb.onColormap(v));
    this.colormapCtrl.setValue(current);
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
  }

  /**
   * What each layer is ACTUALLY showing.
   *
   * The slider is continuous but the volume steps in 20 Myr and the boundaries
   * in 1 Myr, so at most ages the mantle on screen is not the age the user
   * asked for. Saying so is the difference between a snapped frame and a
   * misleading one.
   */
  setTimeInfo(msg: string): void {
    this.timeInfo.textContent = msg;
    this.timeInfo.style.display = msg ? 'block' : 'none';
  }

  /**
   * Move this instance's panel, status and time-info onto a new tile, in CSS
   * pixels. Called once at boot with the full window and again whenever the
   * globe grid is relaid out.
   */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    // Anchored to the tile's top-right / bottom-left corners, matching where
    // lil-gui's own auto-placement and the original #status/#timeinfo CSS put
    // them when the tile was the whole window.
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${innerWidth - (x + width) + 8}px`;
    this.status.style.left = `${x + 12}px`;
    this.status.style.bottom = `${innerHeight - (y + height) + 12}px`;
    this.timeInfo.style.left = `${x + 12}px`;
    this.timeInfo.style.bottom = `${innerHeight - (y + height) + 44}px`;
  }

  dispose(): void {
    this.gui.destroy();
    this.panelAnchor.remove();
    this.status.remove();
    this.timeInfo.remove();
  }
}
