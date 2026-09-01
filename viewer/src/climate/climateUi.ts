import GUI, { type Controller } from 'lil-gui';
import type { ClimateLayer } from './climateInstance';
import type { ColormapData, VariableInfo } from '../core/types';

export interface ClimateViewState {
  layer: ClimateLayer;
  variable: string;
  age: number;
  month: number;
  clipMin: number;
  clipMax: number;
  overlayOpacity: number;
  showWind: boolean;
}

export interface ClimateUICallbacks {
  onLayer(layer: ClimateLayer): void;
  onVariable(id: string): void;
  onAge(age: number): void;
  onMonth(month: number): void;
  onClip(lo: number, hi: number): void;
  onOverlayOpacity(v: number): void;
  onShowWind(v: boolean): void;
}

const N_MONTHS = 12; // must match prep_climate.py's month axis
const PLAY_INTERVAL_MS = 350;

/**
 * A deliberately small panel: layer choice, variable choice, age, month
 * (seasonality), colour clip range, a legend, and status text. No
 * cutaway/isosurface/sinking-rate folders -- those are tomography concepts
 * with no climate equivalent, kept out rather than disabled. The variable
 * dropdown and month slider/play button are climate-only: paleogeography is
 * a single static field, so setLayerVariables() hides all three on that layer
 * rather than showing them disabled with nothing to do.
 */
export class ClimateUI {
  readonly gui: GUI;
  private layerCtrl: Controller;
  private variableCtrl: Controller;
  private ageCtrl: Controller;
  private monthCtrl: Controller;
  private playCtrl: Controller;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private clipMinCtrl: Controller;
  private clipMaxCtrl: Controller;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private legend: HTMLDivElement;
  private legendLabel: HTMLDivElement;
  private legendCanvas: HTMLCanvasElement;

  constructor(
    private state: ClimateViewState,
    private cb: ClimateUICallbacks,
    title = 'Geode Paleoclimate',
  ) {
    this.gui = new GUI({ title });
    // 'layer' picks which MODEL is active (the CESM climate simulation vs.
    // the Scotese paleogeography raster) -- labelled "Climate" rather than
    // any one variable's name, since 'variable' below is what actually
    // picks temperature/precipitation/albedo/land fraction within it. The
    // two dropdowns used to both say "Temperature" at once, which read as
    // if they controlled the same thing.
    this.layerCtrl = this.gui
      .add(this.state, 'layer', { Climate: 'climate', Paleogeography: 'paleogeography' })
      .name('layer')
      .onChange((v: ClimateLayer) => cb.onLayer(v));
    this.variableCtrl = this.gui
      .add(this.state, 'variable', {})
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));
    this.ageCtrl = this.gui.add(this.state, 'age', 0, 540, 1)
      .name('age (Ma)')
      .onChange((v: number) => cb.onAge(v));
    this.monthCtrl = this.gui.add(this.state, 'month', 0, N_MONTHS - 1, 1)
      .name('month (0-11)')
      .onChange((v: number) => cb.onMonth(v));
    this.playCtrl = this.gui
      .add({ fn: () => this.togglePlay() }, 'fn')
      .name('▶ play seasons');
    // Always visible, unlike variable/month -- the overlay is independent of
    // which layer/variable is primary, so there's no layer where it has
    // nothing to show (see ClimateInstance's 'overlay' DepthSlice).
    this.gui.add(this.state, 'overlayOpacity', 0, 0.8, 0.01)
      .name('relief overlay')
      .onChange((v: number) => cb.onOverlayOpacity(v));
    // Always visible, same reasoning as the overlay slider above -- wind is
    // always sourced from the climate model regardless of active layer, so
    // there's no layer where it has nothing to show.
    this.gui.add(this.state, 'showWind')
      .name('wind')
      .onChange((v: boolean) => cb.onShowWind(v));
    this.clipMinCtrl = this.gui.add(this.state, 'clipMin', -60, 50, 0.1)
      .name('clip min')
      .onChange(() => cb.onClip(this.state.clipMin, this.state.clipMax));
    this.clipMaxCtrl = this.gui.add(this.state, 'clipMax', -60, 50, 0.1)
      .name('clip max')
      .onChange(() => cb.onClip(this.state.clipMin, this.state.clipMax));

    this.status = document.createElement('div');
    this.status.className = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.legendLabel = document.createElement('div');
    this.legendLabel.className = 'legend-label';
    this.legendCanvas = document.createElement('canvas');
    this.legendCanvas.className = 'legend-ramp';
    this.legendCanvas.width = 256;
    this.legendCanvas.height = 12;
    this.legend.append(this.legendLabel, this.legendCanvas);
    document.body.appendChild(this.legend);
  }

  /** Bound by the manifest's own frame range (0-540 Ma) -- NOT
   *  archive.coastlines.age_max (200 Ma), which only bounds the paleogeography
   *  overlay, a narrower thing. See ClimateInstance's class doc. */
  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
  }

  /** Rebuild the variable dropdown for whichever layer just became active,
   *  and hide the whole variable/month/play group when there's only one
   *  PICKABLE variable to show (paleogeography's 'elevation' -- its
   *  'hillshade' is overlay_only, filtered out here rather than offered as a
   *  second primary choice: it exists to drive the overlay mesh, not to be
   *  selected on its own; similarly climate's 'U'/'V' are vector_only --
   *  they back the wind glyph field, not a colour-mapped display of their
   *  own). A dropdown of one and a season slider with nothing to season are
   *  dead controls, not useful disabled ones. */
  setLayerVariables(variables: VariableInfo[]): void {
    const pickable = variables.filter((v) => !v.overlay_only && !v.vector_only);
    if (pickable.length <= 1) {
      this.variableCtrl.hide();
      this.monthCtrl.hide();
      this.playCtrl.hide();
      if (this.playTimer) this.stopPlay();
      return;
    }
    const choices: Record<string, string> = {};
    for (const v of pickable) choices[v.name] = v.id;
    this.variableCtrl.options(choices);
    this.variableCtrl.show();
    this.monthCtrl.show();
    this.playCtrl.show();
  }

  private togglePlay(): void {
    if (this.playTimer) { this.stopPlay(); return; }
    this.playCtrl.name('⏸ pause');
    this.playTimer = setInterval(() => {
      this.state.month = (this.state.month + 1) % N_MONTHS;
      this.monthCtrl.updateDisplay();
      this.cb.onMonth(this.state.month);
    }, PLAY_INTERVAL_MS);
  }

  private stopPlay(): void {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    this.playCtrl.name('▶ play seasons');
  }

  setVariable(v: VariableInfo, colormap: ColormapData[string]): void {
    // setValue() only repaints the DOM when it differs from the bound state's
    // CURRENT value (lil-gui's own dirty check) -- assigning state.clipMin
    // directly first, then calling setValue() with that same number, makes
    // the two look equal and silently skips both updateDisplay() and
    // onChange. Let setValue() itself own the assignment.
    this.clipMinCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_min);
    this.clipMaxCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_max);
    this.clipMinCtrl.name(`clip min (${v.units})`);
    this.clipMaxCtrl.name(`clip max (${v.units})`);
    this.legendLabel.textContent = `${v.name} (${v.units})`;
    this.paintLegend(colormap);
  }

  private paintLegend(cm: ColormapData[string]): void {
    const off = document.createElement('canvas');
    off.width = cm.colors.length;
    off.height = 1;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(cm.colors.length, 1);
    cm.colors.forEach(([r, g, b], i) => {
      img.data[i * 4] = r; img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    });
    octx.putImageData(img, 0, 0);

    const ctx = this.legendCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.legendCanvas.width, this.legendCanvas.height);
    ctx.drawImage(off, 0, 0, this.legendCanvas.width, this.legendCanvas.height);
  }

  /** Repaint every controller from the bound state -- needed after a
   *  programmatic change (e.g. the test hook) edits `state` directly rather
   *  than through a slider drag. */
  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
  }

  setTimeInfo(msg: string): void {
    this.timeInfo.textContent = msg;
    this.timeInfo.style.display = msg ? 'block' : 'none';
  }

  dispose(): void {
    this.stopPlay();
    this.gui.destroy();
    this.status.remove();
    this.timeInfo.remove();
    this.legend.remove();
  }
}
