import GUI, { type Controller } from 'lil-gui';
import type { ClimateLayer, WindStyle } from './climateInstance';
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
  windStyle: WindStyle;
  windScale: number;
  windDensity: number;
}

export interface ClimateUICallbacks {
  onLayer(layer: ClimateLayer): void;
  onVariable(id: string): void;
  onAge(age: number): void;
  onMonth(month: number): void;
  onClip(lo: number, hi: number): void;
  onOverlayOpacity(v: number): void;
  onShowWind(v: boolean): void;
  onWindStyle(style: WindStyle): void;
  onWindScale(v: number): void;
  onWindDensity(v: number): void;
}

const N_REAL_MONTHS = 12; // the calendar months -- must match prep_climate.py's N_MONTHS
const N_LAYERS = N_REAL_MONTHS + 1; // + the derived Annual layer -- must match prep_climate.py's N_LAYERS
const PLAY_INTERVAL_MS = 350;
// Month 0 = January per the source's own coordinate metadata (checked
// directly against the .nc file's 'month' comment, 'From January to
// December' -- this axis has already had one inversion bug this session,
// on age, so this one got verified rather than assumed). Index 12 ("Annual")
// is prep_climate.py's derived 13th layer, the mean of the 12 real months --
// see add_annual_layer() there.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'Annual',
];

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
  private legendKey: HTMLDivElement;
  /** The variable-name/units portion of the legend text, set by
   *  setVariable(); combined with monthName (below) by updateLegendLabel()
   *  since the two change independently. */
  private variableLabel = '';
  /** Null when the month axis isn't showing (paleogeography has none) --
   *  see setLayerVariables(). */
  private monthName: string | null = null;

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
    this.monthCtrl = this.gui.add(this.state, 'month', 0, N_LAYERS - 1, 1)
      .name('month')
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
    // Arrows (WindGlyph) and Streaks (WindStreaks) are mutually exclusive
    // display modes for the SAME field -- see ClimateInstance.setWindStyle()
    // and docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md.
    this.gui.add(this.state, 'windStyle', { Arrows: 'glyph', Streaks: 'streak' })
      .name('wind style')
      .onChange((v: WindStyle) => cb.onWindStyle(v));
    // Up to 3x -- a plain user-facing "how big", independent of wind speed
    // (which already drives length/colour on its own, see windGlyphs.ts and
    // windStreaks.ts). Shared by both modes: "size" is ribbon width in
    // Streak mode, arrow length in Glyph mode; "density" is particle count
    // vs. lattice spacing. One pair of sliders rather than two, since
    // ClimateInstance already applies both to whichever mode isn't visible
    // too (see setWindScale()/setWindDensity()), so nothing is ever stale.
    this.gui.add(this.state, 'windScale', 0.5, 3, 0.1)
      .name('wind size')
      .onChange((v: number) => cb.onWindScale(v));
    // Same 0.5-3 range as size, same "1 = today's default" convention --
    // see windGlyphs.ts's setDensity() for how this maps to a lattice step
    // and windStreaks.ts's for how it maps to a particle count.
    this.gui.add(this.state, 'windDensity', 0.5, 3, 0.1)
      .name('wind density')
      .onChange((v: number) => cb.onWindDensity(v));
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
    this.legendKey = document.createElement('div');
    this.legendKey.className = 'legend-key';
    this.legend.append(this.legendLabel, this.legendCanvas, this.legendKey);
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
      this.monthName = null;
      this.updateLegendLabel();
      return;
    }
    const choices: Record<string, string> = {};
    for (const v of pickable) choices[v.name] = v.id;
    this.variableCtrl.options(choices);
    this.variableCtrl.show();
    this.monthCtrl.show();
    this.playCtrl.show();
    this.setMonth(this.state.month);
  }

  private togglePlay(): void {
    if (this.playTimer) { this.stopPlay(); return; }
    this.playCtrl.name('⏸ pause');
    this.playTimer = setInterval(() => {
      // Cycles the 12 REAL months only -- N_REAL_MONTHS, not N_LAYERS.
      // Animating through to "Annual" mid-loop would be a strange pause,
      // not a season.
      this.state.month = (this.state.month + 1) % N_REAL_MONTHS;
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
    if (v.categorical) {
      this.clipMinCtrl.hide();
      this.clipMaxCtrl.hide();
    } else {
      // setValue() only repaints the DOM when it differs from the bound
      // state's CURRENT value (lil-gui's own dirty check) -- assigning
      // state.clipMin directly first, then calling setValue() with that
      // same number, makes the two look equal and silently skips both
      // updateDisplay() and onChange. Let setValue() itself own the
      // assignment.
      this.clipMinCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_min);
      this.clipMaxCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_max);
      this.clipMinCtrl.name(`clip min (${v.units})`);
      this.clipMaxCtrl.name(`clip max (${v.units})`);
      this.clipMinCtrl.show();
      this.clipMaxCtrl.show();
    }
    this.variableLabel = v.categorical ? v.name : `${v.name} (${v.units})`;
    this.updateLegendLabel();
    this.paintLegend(colormap);
    if (v.categorical && v.class_names) this.showLegendKey(v.class_names, colormap.colors);
    else this.hideLegendKey();
  }

  /** Show the active month's name on both the slider itself and next to the
   *  legend -- "month 7" means nothing to a reader, and the colour bar is
   *  exactly where a season needs to be legible alongside the variable it
   *  qualifies. Cleared (not called) when the month axis is hidden -- see
   *  setLayerVariables(). */
  setMonth(monthIndex: number): void {
    this.monthName = MONTH_NAMES[monthIndex];
    this.monthCtrl.name(`month: ${this.monthName}`);
    this.updateLegendLabel();
  }

  private updateLegendLabel(): void {
    this.legendLabel.textContent = this.monthName
      ? `${this.variableLabel} — ${this.monthName}`
      : this.variableLabel;
  }

  /** A compact swatch-and-name key for a categorical variable (e.g. Koppen
   *  classes) -- the colour bar alone is a row of unlabelled flat bands,
   *  not legible on its own the way a continuous ramp's min/max sliders
   *  make a gradient legible. Swatch colour for class i is sampled at that
   *  class's BAND CENTRE, (i+0.5)/N of the way across the 256-texel ramp --
   *  the same point the shader itself samples for a quantised band (see
   *  material.ts's uSteps), so the key always matches what's actually
   *  drawn. NOT the inverse of prep_colormaps.py's texel->class assignment
   *  (floor(texel*N/256)) -- integer floor() isn't symmetric, so inverting
   *  it naively (floor(class*256/N)) lands one texel into the WRONG class's
   *  block for most classes; sampling the centre avoids the boundary
   *  entirely instead of trying to invert it. */
  private showLegendKey(classNames: string[], colors256: [number, number, number][]): void {
    const n = classNames.length;
    this.legendKey.replaceChildren();
    for (let i = 0; i < n; i++) {
      const [r, g, b] = colors256[Math.min(255, Math.floor(((i + 0.5) * 256) / n))];
      const row = document.createElement('div');
      row.className = 'legend-key-row';
      const swatch = document.createElement('span');
      swatch.className = 'legend-key-swatch';
      swatch.style.background = `rgb(${r}, ${g}, ${b})`;
      const label = document.createElement('span');
      label.textContent = classNames[i];
      row.append(swatch, label);
      this.legendKey.appendChild(row);
    }
    this.legendKey.style.display = 'grid';
  }

  private hideLegendKey(): void {
    this.legendKey.style.display = 'none';
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
