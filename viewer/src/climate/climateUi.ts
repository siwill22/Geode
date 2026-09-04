import GUI, { type Controller } from 'lil-gui';
import { TIME_SERIES_VARIABLE_IDS, type ClimateLayer, type WindStyle } from './climateInstance';
import { clampClipOrder, clipSliderStep } from '../core/clipRange';
import type { Rect } from '../core/layout';
import type { TimeSeriesPoint } from '../core/timeSeries';
import type { ColormapData, ResolutionInfo, VariableInfo } from '../core/types';

export interface ClimateViewState {
  layer: ClimateLayer;
  /** Which registered model of type 'climate' backs the 'climate' layer --
   *  see ClimateInstance's `activeClimateModelId`/setClimateModel(). Only
   *  meaningful while `layer === 'climate'`; a dropdown of one (today: just
   *  Li et al.) hides itself, see ClimateUI.setClimateModels(). */
  climateModelId: string;
  variable: string;
  /** Which of the paleogeography source's `manifest.resolutions` entries is
   *  active -- see ClimateInstance's `activeResolution`/`setResolution()`.
   *  Meaningful only for paleogeography-sourced data (the primary field when
   *  `layer === 'paleogeography'`, and the relief overlay always); the
   *  climate model has exactly one resolution today. */
  resolution: string;
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
  onClimateModel(id: string): void;
  onVariable(id: string): void;
  onResolution(id: string): void;
  onAge(age: number): void;
  onMonth(month: number): void;
  onClip(lo: number, hi: number): void;
  onOverlayOpacity(v: number): void;
  onShowWind(v: boolean): void;
  onWindStyle(style: WindStyle): void;
  onWindScale(v: number): void;
  onWindDensity(v: number): void;
  /** The time-series panel was just opened -- see setTimeSeriesVariables()'s
   *  own doc comment for why every open fires this rather than ClimateUI
   *  tracking "already requested" itself. */
  onExpandTimeSeries(): void;
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
  private climateModelCtrl: Controller;
  private resolutionCtrl: Controller;
  private variableCtrl: Controller;
  private monthCtrl: Controller;
  private playCtrl: Controller;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private clipMinCtrl: Controller;
  private clipMaxCtrl: Controller;
  private showWindCtrl: Controller;
  private windStyleCtrl: Controller;
  private windScaleCtrl: Controller;
  private windDensityCtrl: Controller;
  /** How many models of type 'climate' are registered -- the climate-model
   *  dropdown hides itself when there's only one, same "dropdown of one is
   *  a dead control" precedent as setResolutions(). Set by
   *  setClimateModels(), read by updateClimateModelVisibility(). */
  private climateModelCount = 1;
  private status: HTMLDivElement;
  /** Native range input, not a lil-gui controller -- age is common enough
   *  to want at the bottom of the screen rather than buried in the panel,
   *  and it's the one and only age control now (no duplicate lil-gui
   *  slider -- see setAge()). */
  private ageSlider: HTMLInputElement;
  private ageReadout: HTMLSpanElement;
  private ageSliderWrap: HTMLDivElement;
  /** Wraps ageSliderWrap (and, on whichever instance is currently
   *  "primary", the projection-toggle circle -- see
   *  mountProjectionToggle()) so the pair is ONE grid item in bottomBar's
   *  middle column, genuinely centred on the tile regardless of how wide
   *  legend/credit are (see .age-group's own CSS doc comment for why a
   *  flex justify-content:space-between wasn't good enough). */
  private ageGroup: HTMLDivElement;
  /** `[legend, ageGroup, credit]` as grid children, spanning this tile's
   *  own width along its bottom edge -- replaces the old separate
   *  bottom-left legend / bottom-right credit corners now that a slider
   *  needs to sit between them. */
  private bottomBar: HTMLDivElement;
  private legend: HTMLDivElement;
  private legendLabel: HTMLDivElement;
  private legendCanvas: HTMLCanvasElement;
  private legendTicks: HTMLDivElement;
  private legendTickMin: HTMLSpanElement;
  private legendTickMax: HTMLSpanElement;
  private legendKey: HTMLDivElement;
  /** Collapsed by default (see the constructor) -- a fan chart (median +
   *  IQR band + 5-95th pct band) per pickable variable of the ACTIVE layer,
   *  computed lazily on first expand (see setTimeSeriesVariables()'s own
   *  doc comment) rather than at boot, so a user who never opens this never
   *  pays for it. Lives in its own left-side timeSeriesAnchor now, not
   *  nested inside panelAnchor -- separated from the lil-gui menu both
   *  visually and structurally. */
  private timeSeriesAnchor: HTMLDivElement;
  private timeSeriesToggle: HTMLButtonElement;
  private timeSeriesBody: HTMLDivElement;
  private timeSeriesExpanded = false;
  /** One row per pickable variable, keyed by variable id -- rebuilt whole by
   *  setTimeSeriesVariables() whenever the variable SET changes (layer or
   *  climate-model switch), since a stale row for a variable that no longer
   *  applies would be worse than an empty panel. */
  private timeSeriesRows = new Map<string, {
    row: HTMLDivElement; canvas: HTMLCanvasElement; statusEl: HTMLDivElement; points: TimeSeriesPoint[] | null;
  }>();
  /** Shared by every row of every variable -- one floating element, moved
   *  and re-filled on each hover rather than built per-row, see
   *  showTooltip(). */
  private tooltip: HTMLDivElement;
  /** The Frame age range to plot the X axis over -- the manifest's own full
   *  range (see setAgeRange()), NOT the span of whichever points happen to
   *  be computed so far, so the marker line and axis stay stable as rows
   *  populate progressively at different speeds. */
  private timeSeriesAgeMin = 0;
  private timeSeriesAgeMax = 540;
  private timeSeriesCurrentAge = 0;
  /** Data-source attribution, bottom-right of this instance's own tile --
   *  see setCredit(), driven by ClimateInstance.updateCredit() from the
   *  ACTIVE model(s)' own manifest.source, not a fixed string. Used to be
   *  static HTML in climate.html naming only Li et al., which went stale
   *  the moment a second climate model existed. */
  private credit: HTMLDivElement;
  /** Positioned per-instance by setRect(); anchors the panel's top-right
   *  corner, same trick as tomography/ui.ts's UI class -- lil-gui's own
   *  auto-placement is a single fixed panel pinned to the window's top-right
   *  corner, which is right for one globe but would stack every instance's
   *  panel on top of the others once there is more than one. */
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
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
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });
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
    // Options populated once boot() knows every registered climate-type
    // model -- see setClimateModels(). Layer-gated (unlike resolutionCtrl
    // below): which CLIMATE model is selected is meaningless while
    // paleogeography is the primary field, so this hides whenever
    // `layer !== 'climate'`, on top of the "only one registered" hide --
    // see updateClimateModelVisibility(), called from setLayerVariables().
    this.climateModelCtrl = this.gui
      .add(this.state, 'climateModelId', {})
      .name('climate model')
      .onChange((v: string) => cb.onClimateModel(v));
    // Options populated once boot() knows the paleogeography source's own
    // resolutions -- see setResolutions(). Hidden entirely when there's only
    // one (a dropdown of one is a dead control, same precedent as the
    // variable/month group in setLayerVariables()), and NOT tied to layer
    // switches the way that group is: the relief overlay is always
    // paleogeography-sourced regardless of which layer is primary, so this
    // stays relevant even while viewing the climate layer.
    this.resolutionCtrl = this.gui
      .add(this.state, 'resolution', {})
      .name('paleogeography res')
      .onChange((v: string) => cb.onResolution(v));
    this.variableCtrl = this.gui
      .add(this.state, 'variable', {})
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));
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
    // Visible whenever the ACTIVE climate model has a wind field -- not
    // every one does (Pohl doesn't), unlike when this was written, when
    // "the climate model" meant exactly one fixed thing. See
    // setWindAvailable(), called from ClimateInstance.resolveWind().
    this.showWindCtrl = this.gui.add(this.state, 'showWind')
      .name('wind')
      .onChange((v: boolean) => cb.onShowWind(v));
    // Arrows (WindGlyph) and Streaks (WindStreaks) are mutually exclusive
    // display modes for the SAME field -- see ClimateInstance.setWindStyle()
    // and docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md.
    this.windStyleCtrl = this.gui.add(this.state, 'windStyle', { Arrows: 'glyph', Streaks: 'streak' })
      .name('wind style')
      .onChange((v: WindStyle) => cb.onWindStyle(v));
    // Up to 3x -- a plain user-facing "how big", independent of wind speed
    // (which already drives length/colour on its own, see windGlyphs.ts and
    // windStreaks.ts). Shared by both modes: "size" is ribbon width in
    // Streak mode, arrow length in Glyph mode; "density" is particle count
    // vs. lattice spacing. One pair of sliders rather than two, since
    // ClimateInstance already applies both to whichever mode isn't visible
    // too (see setWindScale()/setWindDensity()), so nothing is ever stale.
    this.windScaleCtrl = this.gui.add(this.state, 'windScale', 0.5, 3, 0.1)
      .name('wind size')
      .onChange((v: number) => cb.onWindScale(v));
    // Same 0.5-3 range as size, same "1 = today's default" convention --
    // see windGlyphs.ts's setDensity() for how this maps to a lattice step
    // and windStreaks.ts's for how it maps to a particle count.
    this.windDensityCtrl = this.gui.add(this.state, 'windDensity', 0.5, 3, 0.1)
      .name('wind density')
      .onChange((v: number) => cb.onWindDensity(v));
    this.clipMinCtrl = this.gui.add(this.state, 'clipMin', -60, 50, 0.1)
      .name('clip min')
      .onChange(() => {
        if (clampClipOrder(this.state, 'min')) this.clipMaxCtrl.updateDisplay();
        cb.onClip(this.state.clipMin, this.state.clipMax);
        this.updateLegendTicks(this.state.clipMin, this.state.clipMax);
      });
    this.clipMaxCtrl = this.gui.add(this.state, 'clipMax', -60, 50, 0.1)
      .name('clip max')
      .onChange(() => {
        if (clampClipOrder(this.state, 'max')) this.clipMinCtrl.updateDisplay();
        cb.onClip(this.state.clipMin, this.state.clipMax);
        this.updateLegendTicks(this.state.clipMin, this.state.clipMax);
      });

    // Always present once multiple globes exist, a no-op at exactly one --
    // see removeInstance()'s `instances.length <= 1` guard in main.ts --
    // rather than conditionally shown/hidden, matching tomography/ui.ts's
    // own "remove this globe" button.
    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }

    this.status = document.createElement('div');
    this.status.className = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');

    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.legendLabel = document.createElement('div');
    this.legendLabel.className = 'legend-label';
    this.legendCanvas = document.createElement('canvas');
    this.legendCanvas.className = 'legend-ramp';
    this.legendCanvas.width = 256;
    this.legendCanvas.height = 12;
    this.legendTicks = document.createElement('div');
    this.legendTicks.className = 'legend-ticks';
    this.legendTickMin = document.createElement('span');
    this.legendTickMax = document.createElement('span');
    this.legendTicks.append(this.legendTickMin, this.legendTickMax);
    this.legendKey = document.createElement('div');
    this.legendKey.className = 'legend-key';
    this.legend.append(this.legendLabel, this.legendCanvas, this.legendTicks, this.legendKey);

    // 'input' (not 'change') fires continuously while dragging, matching the
    // feel of lil-gui's own slider drag which this replaces entirely -- see
    // setAge() for the programmatic-update counterpart that must NOT loop
    // back through cb.onAge (sync broadcast, boot, test hooks).
    this.ageSlider = document.createElement('input');
    this.ageSlider.type = 'range';
    this.ageSlider.className = 'age-slider';
    this.ageSlider.min = '0';
    this.ageSlider.max = '540';
    this.ageSlider.step = '1';
    this.ageSlider.addEventListener('input', () => {
      const age = Number(this.ageSlider.value);
      this.state.age = age;
      this.setAge(age);
      cb.onAge(age);
    });
    this.ageReadout = document.createElement('span');
    this.ageReadout.className = 'age-readout';
    this.ageSliderWrap = document.createElement('div');
    this.ageSliderWrap.className = 'age-slider-wrap';
    this.ageSliderWrap.append(this.ageSlider, this.ageReadout);

    // Wraps ageSliderWrap alone by default; mountProjectionToggle() prepends
    // the (separate, circular) projection button in here too, beside it --
    // see ageGroup's own field doc comment for why this needs to be one
    // grid item rather than two.
    this.ageGroup = document.createElement('div');
    this.ageGroup.className = 'age-group';
    this.ageGroup.append(this.ageSliderWrap);

    this.credit = document.createElement('div');
    this.credit.className = 'credit';

    // A single bottom strip per tile -- [colour bar] .... [projection
    // toggle + age slider, centred] .... [attribution] -- replacing the old
    // separate bottom-left legend / bottom-right credit corners, now that
    // the age control lives here too rather than in the top-right lil-gui
    // panel.
    this.bottomBar = document.createElement('div');
    this.bottomBar.className = 'bottom-bar';
    this.bottomBar.append(this.legend, this.ageGroup, this.credit);
    document.body.appendChild(this.bottomBar);

    // Own top-left anchor, deliberately NOT inside panelAnchor -- separated
    // from the lil-gui panel both visually and structurally, per the user's
    // "not with the existing menu" ask. See applyRect() for how it clears
    // both the page-level #toolbar (top) and the bottom bar (bottom).
    this.timeSeriesAnchor = document.createElement('div');
    this.timeSeriesAnchor.className = 'timeseries-anchor';
    this.timeSeriesToggle = document.createElement('button');
    this.timeSeriesToggle.className = 'timeseries-toggle';
    this.timeSeriesToggle.textContent = '▸ time series';
    this.timeSeriesBody = document.createElement('div');
    this.timeSeriesBody.className = 'timeseries-body';
    this.timeSeriesToggle.addEventListener('click', () => this.toggleTimeSeries());
    this.timeSeriesAnchor.append(this.timeSeriesToggle, this.timeSeriesBody);
    document.body.appendChild(this.timeSeriesAnchor);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'timeseries-tooltip';
    document.body.appendChild(this.tooltip);

    this.applyRect();
  }

  /** Mounts the page's single global projection-toggle button (ClimateUI has
   *  no concept of Projection itself -- it applies to every globe on screen
   *  at once, see docs/adr/0003) as its own standalone circle directly
   *  beside THIS instance's own age-slider box (a sibling of ageSliderWrap
   *  within ageGroup, not nested inside ageSliderWrap itself -- kept
   *  visually separate so it doesn't read as part of the slider). main.ts
   *  calls this only on whichever instance is currently "primary" (see its
   *  own primary()/removeInstance()), re-mounting here -- moving the same
   *  DOM node, not cloning -- whenever the primary instance changes.
   *  Idempotent: safe to call again on an instance that already hosts it. */
  mountProjectionToggle(el: HTMLElement): void {
    this.ageGroup.insertBefore(el, this.ageSliderWrap);
  }

  private toggleTimeSeries(): void {
    this.timeSeriesExpanded = !this.timeSeriesExpanded;
    this.timeSeriesBody.style.display = this.timeSeriesExpanded ? 'flex' : 'none';
    this.timeSeriesToggle.textContent = this.timeSeriesExpanded ? '▾ time series' : '▸ time series';
    // Every open re-fires the request rather than ClimateUI tracking
    // "already asked" -- ClimateInstance owns the actual cache (keyed by
    // model/resolution) and no-ops a redundant request itself, which is one
    // fewer piece of "has this already happened" state to keep in sync
    // between the two classes for the same underlying fact.
    if (this.timeSeriesExpanded) this.cb.onExpandTimeSeries();
  }

  /** Bound by the manifest's own frame range (0-540 Ma) -- NOT
   *  archive.coastlines.age_max (200 Ma), which only bounds the paleogeography
   *  overlay, a narrower thing. See ClimateInstance's class doc. */
  setAgeRange(min: number, max: number, step = 1): void {
    this.ageSlider.min = String(min);
    this.ageSlider.max = String(max);
    this.ageSlider.step = String(step);
    this.timeSeriesAgeMin = min;
    this.timeSeriesAgeMax = max;
  }

  /** Rebuild the variable dropdown for whichever layer just became active,
   *  and hide the whole variable/month/play group when there's only one
   *  PICKABLE variable to show (paleogeography's 'elevation' -- its
   *  'hillshade' is overlay_only, filtered out here rather than offered as a
   *  second primary choice: it exists to drive the overlay mesh, not to be
   *  selected on its own; similarly climate's 'U'/'V' are vector_only, and
   *  a continental-only model's own landmask is mask_only -- none of these
   *  back a colour-mapped display of their own). A dropdown of one and a
   *  season slider with nothing to season are dead controls, not useful
   *  disabled ones. Also updates the climate-model dropdown's visibility --
   *  see updateClimateModelVisibility() -- since that's layer-gated too. */
  setLayerVariables(variables: VariableInfo[], layer: ClimateLayer): void {
    const pickable = variables.filter((v) => !v.overlay_only && !v.vector_only && !v.mask_only);
    // A time series is meaningful to look at (Koppen's class index stays a
    // dropdown choice below) but not to average -- "mean of class 3 and
    // class 7" isn't class 5 or anything else meaningful, unlike averaging a
    // continuous physical quantity -- and the panel is further curated down
    // to TIME_SERIES_VARIABLE_IDS (see that constant's own doc comment).
    // Must match ClimateInstance.pickableTimeSeriesVariables()'s own filter
    // exactly, or a row would be built here with nothing ever arriving to
    // fill it -- ClimateInstance excludes anything outside this set from
    // what it computes.
    this.setTimeSeriesVariables(
      pickable.filter((v) => !v.categorical && TIME_SERIES_VARIABLE_IDS.has(v.id)),
    );
    if (pickable.length <= 1) {
      this.variableCtrl.hide();
      this.monthCtrl.hide();
      this.playCtrl.hide();
      if (this.playTimer) this.stopPlay();
      this.monthName = null;
      this.updateLegendLabel();
    } else {
      const choices: Record<string, string> = {};
      for (const v of pickable) choices[v.name] = v.id;
      this.variableCtrl.options(choices);
      this.variableCtrl.show();
      this.monthCtrl.show();
      this.playCtrl.show();
      this.setMonth(this.state.month);
    }
    this.updateClimateModelVisibility(layer);
  }

  /** Populate the climate-model dropdown from every registered model of
   *  type 'climate' -- called once at boot, mirrors setResolutions()'s
   *  show/hide-when-one precedent, plus its own layer-gating (see
   *  updateClimateModelVisibility()). Labelled by the model's own archive
   *  name (e.g. "Li et al. 2022 Paleoclimate"), not its id. */
  setClimateModels(models: { id: string; name: string }[]): void {
    this.climateModelCount = models.length;
    const choices: Record<string, string> = {};
    for (const m of models) choices[m.name] = m.id;
    this.climateModelCtrl.options(choices);
    this.updateClimateModelVisibility(this.state.layer);
  }

  private updateClimateModelVisibility(layer: ClimateLayer): void {
    if (layer === 'climate' && this.climateModelCount > 1) this.climateModelCtrl.show();
    else this.climateModelCtrl.hide();
  }

  /** Show/hide the wind controls as a group -- not every climate model has
   *  a wind field (Pohl doesn't), unlike when this panel was designed
   *  around exactly one climate model that always did. Independent of
   *  `layer`: showing a dead wind control while paleogeography happens to
   *  be the primary field would be no better than while climate is. */
  setWindAvailable(has: boolean): void {
    const action = has ? 'show' : 'hide';
    this.showWindCtrl[action]();
    this.windStyleCtrl[action]();
    this.windScaleCtrl[action]();
    this.windDensityCtrl[action]();
  }

  /** Populate the resolution dropdown from the paleogeography source's own
   *  `manifest.resolutions` -- called once at boot, not on every layer
   *  switch (see the constructor's comment on `resolutionCtrl`). Labelled by
   *  grid dimensions (e.g. "1440x721") rather than the resolution `id`
   *  alone -- self-explanatory, and `ResolutionInfo` carries no separate
   *  display name to show instead. */
  setResolutions(resolutions: ResolutionInfo[]): void {
    if (resolutions.length <= 1) {
      this.resolutionCtrl.hide();
      return;
    }
    const choices: Record<string, string> = {};
    for (const r of resolutions) choices[`${r.nlon}x${r.nlat}`] = r.id;
    this.resolutionCtrl.options(choices);
    this.resolutionCtrl.show();
  }

  /** Rebuild the time-series rows for whichever variables are pickable on
   *  the NOW-active layer/model -- called from setLayerVariables() with the
   *  same `pickable` list it already computed, so a layer or climate-model
   *  switch (a different manifest, different Frames) always shows fresh
   *  rows rather than a stale set left over from before. Discards any
   *  already-computed points for the OLD variable set; if the panel is
   *  currently expanded, immediately re-requests data for the new one --
   *  "the panel is open" means "keep it live", the same reasoning
   *  ClimateInstance.setProjection() already applies to wind. Builds empty
   *  placeholder rows regardless of whether the panel is expanded (cheap:
   *  no fetch happens until onExpandTimeSeries() actually fires), so
   *  opening it later needs no separate "first paint" case. */
  private setTimeSeriesVariables(pickable: VariableInfo[]): void {
    this.timeSeriesBody.replaceChildren();
    this.timeSeriesRows.clear();
    for (const v of pickable) {
      const row = document.createElement('div');
      row.className = 'timeseries-row';
      const label = document.createElement('div');
      label.className = 'timeseries-label';
      label.textContent = v.name;
      const canvas = document.createElement('canvas');
      canvas.className = 'timeseries-canvas';
      canvas.width = 260;
      canvas.height = 110;
      canvas.addEventListener('mousemove', (e) => this.onTimeSeriesHover(e, v.id, canvas));
      canvas.addEventListener('mouseleave', () => this.hideTooltip());
      const statusEl = document.createElement('div');
      statusEl.className = 'timeseries-status';
      row.append(label, canvas, statusEl);
      this.timeSeriesBody.appendChild(row);
      this.timeSeriesRows.set(v.id, {
        row, canvas, statusEl, points: null,
      });
    }
    // Nothing to show (e.g. paleogeography, which carries none of
    // TIME_SERIES_VARIABLE_IDS) -- hide the toggle entirely rather than
    // offering an expand button for a permanently-empty box, and fold back
    // to collapsed so a later layer switch that DOES have rows doesn't
    // reopen already-expanded.
    const hasAny = pickable.length > 0;
    this.timeSeriesAnchor.style.display = hasAny ? 'flex' : 'none';
    if (!hasAny) {
      this.timeSeriesExpanded = false;
      this.timeSeriesBody.style.display = 'none';
      this.timeSeriesToggle.textContent = '▸ time series';
    }
    if (hasAny && this.timeSeriesExpanded) this.cb.onExpandTimeSeries();
  }

  /** Nearest-point lookup by X position, not exact pixel hit-testing --
   *  Frame ages aren't evenly spaced (see computeTimeSeries()), so "nearest
   *  age to the cursor" is the only sensible notion of hover target. Uses
   *  the canvas's own CSS-rendered width via getBoundingClientRect(), not
   *  its backing-store `width` attribute, so this stays correct regardless
   *  of how the two differ (the anchor's width -- and therefore the
   *  canvas's rendered width -- is capped per-tile by applyRect()). */
  private onTimeSeriesHover(e: MouseEvent, variableId: string, canvas: HTMLCanvasElement): void {
    const entry = this.timeSeriesRows.get(variableId);
    if (!entry?.points?.length) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const hoverAge = this.timeSeriesAgeMin + frac * (this.timeSeriesAgeMax - this.timeSeriesAgeMin);
    let nearest = entry.points[0];
    let bestDist = Math.abs(nearest.age - hoverAge);
    for (const p of entry.points) {
      const d = Math.abs(p.age - hoverAge);
      if (d < bestDist) { bestDist = d; nearest = p; }
    }
    this.showTooltip(e.clientX, e.clientY, nearest);
  }

  /** `position: fixed` on `document.body`, not nested under the row it's
   *  triggered from -- timeSeriesAnchor clips its own overflow (see its CSS
   *  doc comment), which would cut the tooltip off the moment it needed to
   *  extend past the anchor's own (narrow, per-tile-capped) bounds. Clamped
   *  to the viewport on the low/right edges so it never runs off-screen
   *  near a tile's own edge. */
  private showTooltip(clientX: number, clientY: number, p: TimeSeriesPoint): void {
    const fmt = (v: number) => (Number.isNaN(v) ? '—' : this.formatTick(v));
    this.tooltip.replaceChildren();
    const lines = [
      `${p.age.toFixed(0)} Ma`,
      `median ${fmt(p.p50)}`,
      `IQR ${fmt(p.p25)} – ${fmt(p.p75)}`,
      `5–95th pct ${fmt(p.p5)} – ${fmt(p.p95)}`,
      `mean ${fmt(p.mean)}`,
    ];
    for (const line of lines) {
      const row = document.createElement('div');
      row.textContent = line;
      this.tooltip.appendChild(row);
    }
    this.tooltip.style.display = 'block';
    const { width: tw, height: th } = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(clientX + 14, innerWidth - tw - 8)}px`;
    this.tooltip.style.top = `${Math.min(clientY + 14, innerHeight - th - 8)}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }

  setTimeSeriesLoading(variableId: string): void {
    const entry = this.timeSeriesRows.get(variableId);
    if (!entry) return;
    entry.statusEl.textContent = 'computing…';
  }

  setTimeSeriesData(variableId: string, points: TimeSeriesPoint[]): void {
    const entry = this.timeSeriesRows.get(variableId);
    if (!entry) return; // a stale response landing after setTimeSeriesVariables() rebuilt the rows
    entry.points = points;
    entry.statusEl.textContent = '';
    this.drawTimeSeriesRow(entry.canvas, points);
  }

  /** Redraw every row's marker (and, incidentally, the whole chart -- see
   *  drawTimeSeriesRow()'s own doc comment for why redrawing the line too is
   *  cheap enough not to bother splitting out) at the CURRENT age. Called
   *  from ClimateInstance.applyAge() regardless of whether the panel is
   *  expanded or any row has data yet -- drawTimeSeriesRow() on a null-points
   *  row is a no-op, and an expand later just paints from whatever's already
   *  stored. */
  setTimeSeriesAge(age: number): void {
    this.timeSeriesCurrentAge = age;
    for (const entry of this.timeSeriesRows.values()) {
      if (entry.points) this.drawTimeSeriesRow(entry.canvas, entry.points);
    }
  }

  /** A fan chart: a shaded p5-p95 band (outer, light), a shaded p25-p75 IQR
   *  band (inner, darker) drawn on top of it, a p50 median line on top of
   *  that, plus a vertical marker at the CURRENT age -- all from the SAME
   *  per-Frame percentiles computeTimeSeries() already returns, no extra
   *  fetch. p5/p95 rather than literal min/max deliberately, see
   *  weightedPercentile()'s own doc comment: one anomalous texel shouldn't
   *  dictate the band. Auto-scaled to whichever points exist so far (so a
   *  row redraws sensibly mid-progressive-load). A run of points breaks
   *  wherever p50 is NaN (mask covered every texel that Frame) -- both bands
   *  and the line stop and restart around the gap, rather than bridging
   *  across missing data, same "say so, don't fabricate" as before. Redrawn
   *  from scratch on every call -- at most a few hundred points on a small
   *  canvas, cheap enough that a separate "just move the marker" fast path
   *  would be premature. */
  private drawTimeSeriesRow(canvas: HTMLCanvasElement, points: TimeSeriesPoint[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const outer = points.flatMap((p) => [p.p5, p.p95]).filter((v) => !Number.isNaN(v));
    if (outer.length === 0) return;
    let vMin = Math.min(...outer);
    let vMax = Math.max(...outer);
    if (vMin === vMax) { vMin -= 1; vMax += 1; } // a perfectly flat series would otherwise divide by zero below

    const padX = 2;
    const padY = 3;
    const ageSpan = this.timeSeriesAgeMax - this.timeSeriesAgeMin || 1;
    const toX = (age: number) => padX + ((age - this.timeSeriesAgeMin) / ageSpan) * (w - 2 * padX);
    const toY = (v: number) => h - padY - ((v - vMin) / (vMax - vMin)) * (h - 2 * padY);

    // Contiguous non-gap runs -- a filled band can't skip a hole the way a
    // stroked line can just lift the pen.
    const runs: TimeSeriesPoint[][] = [];
    let current: TimeSeriesPoint[] = [];
    for (const p of points) {
      if (Number.isNaN(p.p50)) { if (current.length) runs.push(current); current = []; continue; }
      current.push(p);
    }
    if (current.length) runs.push(current);

    const fillBand = (run: TimeSeriesPoint[], top: 'p5' | 'p25', bottom: 'p95' | 'p75', style: string) => {
      ctx.fillStyle = style;
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = toX(p.age);
        const y = toY(p[top]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(toX(run[i].age), toY(run[i][bottom]));
      ctx.closePath();
      ctx.fill();
    };

    for (const run of runs) {
      fillBand(run, 'p5', 'p95', 'rgba(127, 208, 255, 0.15)');
      fillBand(run, 'p25', 'p75', 'rgba(127, 208, 255, 0.35)');
      ctx.strokeStyle = '#7fd0ff';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = toX(p.age);
        const y = toY(p.p50);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const markerX = toX(this.timeSeriesCurrentAge);
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(markerX, 0);
    ctx.lineTo(markerX, h);
    ctx.stroke();
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
      this.hideLegendTicks();
    } else {
      // setValue() only repaints the DOM when it differs from the bound
      // state's CURRENT value (lil-gui's own dirty check) -- assigning
      // state.clipMin directly first, then calling setValue() with that
      // same number, makes the two look equal and silently skips both
      // updateDisplay() and onChange. Let setValue() itself own the
      // assignment.
      // Step must be re-derived per variable, same reasoning as min/max --
      // see clipSliderStep()'s doc comment for the bug a step stuck at
      // whichever variable set it last causes.
      const step = clipSliderStep(v.encode_min, v.encode_max);
      this.clipMinCtrl.min(v.encode_min).max(v.encode_max).step(step).setValue(v.default_clip_min);
      this.clipMaxCtrl.min(v.encode_min).max(v.encode_max).step(step).setValue(v.default_clip_max);
      this.clipMinCtrl.name(`clip min (${v.units})`);
      this.clipMaxCtrl.name(`clip max (${v.units})`);
      this.clipMinCtrl.show();
      this.clipMaxCtrl.show();
      this.updateLegendTicks(v.default_clip_min, v.default_clip_max);
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

  /** Three significant figures -- enough to distinguish e.g. -70/65 (deg C)
   *  from a precipitation range under 10 without a long decimal tail. */
  private formatTick(v: number): string {
    return Number(v.toPrecision(3)).toString();
  }

  /** Label the ramp's two ends with the CURRENT clip range in physical
   *  units -- the ramp canvas always spans exactly [lo, hi] by construction
   *  (see material.ts's uClipLo/uClipHi), so this must be re-called
   *  whenever the clip sliders move, not just when the variable changes,
   *  or the numbers would silently go stale under the still-correct ramp. */
  private updateLegendTicks(lo: number, hi: number): void {
    this.legendTickMin.textContent = this.formatTick(lo);
    this.legendTickMax.textContent = this.formatTick(hi);
    this.legendTicks.style.display = 'flex';
  }

  private hideLegendTicks(): void {
    this.legendTicks.style.display = 'none';
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
   *  than through a slider drag. Also syncs the age slider, which isn't a
   *  lil-gui controller and so isn't swept by controllersRecursive(). */
  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.setAge(this.state.age);
  }

  /** `isError` swaps in the same red styling as the page-level #error box
   *  (see climate.html's boot() failure handler) -- without it, a failed
   *  fetch reusing the plain "loading..." look would just look like this
   *  globe was stuck loading forever, not like something that needs the
   *  user's attention. See main.ts's addInstance() for the failure path. */
  setStatus(msg: string, isError = false): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
    this.status.classList.toggle('status--error', isError);
  }

  /** Move the slider thumb and update its numeric readout WITHOUT re-firing
   *  onAge -- mirrors lil-gui's own updateDisplay(), used for a programmatic
   *  age change (sync broadcast, boot, test hook) that must not echo back
   *  through cb.onAge(). Also the only place the current age is shown
   *  textually, now that there's no separate top-left age label. */
  setAge(age: number): void {
    this.ageSlider.value = String(age);
    this.ageReadout.textContent = `${age.toFixed(0)} Ma`;
  }

  setCredit(text: string): void {
    this.credit.textContent = text;
  }

  /** Hides this instance's WHOLE legend (label, ramp, and any class key) --
   *  used by main.ts's refreshLegendVisibility() to suppress every globe's
   *  legend but one when more than one is showing the SAME categorical
   *  variable at once (today: only Koppen). Idempotent and safe to call with
   *  `true` even when already visible -- setVariable()/setLayerVariables()
   *  don't need to know or care that this was ever hidden. */
  setLegendVisible(visible: boolean): void {
    this.legend.style.display = visible ? 'block' : 'none';
  }

  /** Move this instance's panel, legend, status and time-info onto a new
   *  tile, in CSS pixels. Called once at boot with the full window and
   *  again whenever the globe grid is relaid out -- mirrors
   *  tomography/ui.ts's UI.setRect() exactly, with the addition of the
   *  legend (climate-only; tomography has no equivalent). */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    // Panel anchored top-right; time-series ANCHOR at the tile's top-left,
    // top edge flush with y+8 -- the same top offset #toolbar's own buttons
    // sit at -- so timeSeriesToggle ("time series") visually lines up with
    // "+ Add globe" rather than sitting lower. It's now the SAME height as
    // a toolbar button too (see .timeseries-toggle's CSS, matched padding
    // and font), so the two rows read as one continuous strip. The plots
    // themselves (timeSeriesBody) don't need a separate clearance
    // calculation to avoid the toolbar -- they're simply stacked below the
    // toggle in normal flex-column flow, and since the toggle's own height
    // now equals the toolbar's, "below the toggle" already means "below the
    // toolbar". Status sits below the toggle's OWN measured height, for the
    // same reason.
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${innerWidth - (x + width) + 8}px`;

    this.bottomBar.style.left = `${x + 12}px`;
    this.bottomBar.style.width = `${width - 24}px`;
    this.bottomBar.style.bottom = `${innerHeight - (y + height) + 8}px`;

    // Proportional to the tile's own width, not a fixed pixel value -- a
    // single full-width globe should give the slider noticeably more room
    // than a narrow tile in a multi-globe grid does. Floor keeps it usable
    // on a narrow tile; cap keeps it from sprawling absurdly wide on an
    // ultra-wide single-globe monitor.
    const sliderWidth = Math.max(200, Math.min(700, width * 0.4));
    this.ageSliderWrap.style.width = `${sliderWidth}px`;

    // Match .legend and .age-slider-wrap to each other's natural height --
    // NOT the bottom-bar row's own cross size, which the (often much
    // taller, wrapped multi-line) credit citation text would otherwise
    // drag both of them up to match (see their CSS doc comments). Reset
    // any height forced by a PREVIOUS call before re-measuring, or repeated
    // calls (window resize, adding/removing a globe) would ratchet the
    // matched height upward forever.
    this.legend.style.height = '';
    this.ageSliderWrap.style.height = '';
    const matchedHeight = Math.max(
      this.legend.getBoundingClientRect().height,
      this.ageSliderWrap.getBoundingClientRect().height,
    );
    this.legend.style.height = `${matchedHeight}px`;
    this.ageSliderWrap.style.height = `${matchedHeight}px`;

    const bottomBarHeight = this.bottomBar.getBoundingClientRect().height;
    this.timeSeriesAnchor.style.top = `${y + 8}px`;
    this.timeSeriesAnchor.style.left = `${x + 12}px`;
    this.timeSeriesAnchor.style.bottom = `${innerHeight - (y + height) + bottomBarHeight + 20}px`;
    // Capped to whatever's actually left of the tile after panelAnchor's own
    // measured width -- on a narrow multi-globe grid, a fixed 260px here
    // would run this tile's OWN lil-gui panel over, since both are
    // independently edge-anchored with no shared awareness of each other.
    // Floor of 140px keeps a collapsed row still legible rather than
    // vanishing to nothing on an extreme grid.
    const panelWidth = this.panelAnchor.getBoundingClientRect().width;
    const available = width - 12 - panelWidth - 20;
    this.timeSeriesAnchor.style.width = `${Math.max(140, Math.min(260, available))}px`;

    const toggleHeight = this.timeSeriesToggle.getBoundingClientRect().height;
    this.status.style.top = `${y + 8 + toggleHeight + 8}px`;
    this.status.style.left = `${x + 12}px`;
  }

  dispose(): void {
    this.stopPlay();
    this.gui.destroy();
    this.panelAnchor.remove();
    this.status.remove();
    // If this instance currently hosts the global projection-toggle button
    // (see mountProjectionToggle()), this detaches it too -- main.ts's
    // removeInstance() re-mounts it onto the new primary right after,
    // synchronously, before anything renders in between.
    this.bottomBar.remove(); // takes legend/ageGroup(+ageSliderWrap)/credit with it
    this.timeSeriesAnchor.remove(); // takes timeSeriesToggle/timeSeriesBody with it
    this.tooltip.remove();
  }
}
