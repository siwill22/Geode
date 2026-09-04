import GUI, { type Controller } from 'lil-gui';
import type { ValdesLayer, VectorStyle } from './valdesInstance';
import { clampClipOrder, clipSliderStep } from '../core/clipRange';
import type { Rect } from '../core/layout';
import type { ColormapData, VariableInfo, VectorFieldInfo } from '../core/types';

export interface ValdesViewState {
  layer: ValdesLayer;
  variable: string;
  age: number;
  /** Position on the shared layer-index axis -- calendar month (Monthly) or
   *  real depth level (Ocean Depth), see ValdesInstance.applyLayerIndex(). */
  layerIndex: number;
  clipMin: number;
  clipMax: number;
  /** id of the active Vector Field (see core/types.ts's VectorFieldInfo),
   *  or null if none is shown -- single-select, see CONTEXT.md's Vector
   *  Field entry and docs/adr/0012. */
  vectorFieldId: string | null;
  showVector: boolean;
  vectorStyle: VectorStyle;
  vectorScale: number;
  vectorDensity: number;
  /** How opaque the primary field is, 0 (invisible, only the paleogeography
   *  relief fill shows) to 1 (current default: field fully hides it except
   *  at no-data holes) -- see ValdesInstance.applyFieldOpacity() and
   *  RELIEF_FILL_R's doc comment for the mesh this fades toward. Only
   *  meaningful once a paleogeography source loaded; the control hides
   *  itself otherwise, see setReliefAvailable(). */
  fieldOpacity: number;
}

export interface ValdesUICallbacks {
  onLayer(layer: ValdesLayer): void;
  onVariable(id: string): void;
  onAge(age: number): void;
  onLayerIndex(index: number): void;
  onClip(lo: number, hi: number): void;
  onVectorField(id: string | null): void;
  onShowVector(v: boolean): void;
  onVectorStyle(style: VectorStyle): void;
  onVectorScale(v: number): void;
  onVectorDensity(v: number): void;
  onFieldOpacity(v: number): void;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'Annual',
];
const N_REAL_MONTHS = 12;
const PLAY_INTERVAL_MS = 350;
const NONE_VECTOR_FIELD = '__none__';

/**
 * The Valdes/BRIDGE instance's control panel -- a deliberately smaller
 * sibling of climate/climateUi.ts's ClimateUI: one fixed data source (no
 * climate-model or resolution picker), no time-series panel. What's new
 * relative to ClimateUI: a Vector Field dropdown (Wind, Ocean Surface
 * Current, Sea-Ice Drift, Ocean Current, or None, depending on what the
 * active Layer declares -- see setVectorFields()), and a layer-index axis
 * whose label/range is re-derived per Layer switch (see setLayerAxis())
 * rather than a fixed 13-month scale. The relief slider mirrors
 * ClimateUI's, just tuned the other way round: ClimateUI fades a separate
 * overlay mesh IN over an opaque field; Valdes has no overlay mesh, so this
 * fades the field's OWN opacity down to reveal the relief fill sitting
 * just behind it (see ValdesInstance.applyFieldOpacity()).
 */
export class ValdesUI {
  readonly gui: GUI;
  private layerCtrl: Controller;
  private variableCtrl: Controller;
  private layerIndexCtrl: Controller;
  private playCtrl: Controller;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private clipMinCtrl: Controller;
  private clipMaxCtrl: Controller;
  private vectorFieldCtrl: Controller;
  private showVectorCtrl: Controller;
  private vectorStyleCtrl: Controller;
  private vectorScaleCtrl: Controller;
  private vectorDensityCtrl: Controller;
  private fieldOpacityCtrl: Controller;
  private status: HTMLDivElement;
  private ageSlider: HTMLInputElement;
  private ageReadout: HTMLSpanElement;
  private ageSliderWrap: HTMLDivElement;
  private ageGroup: HTMLDivElement;
  private bottomBar: HTMLDivElement;
  private legend: HTMLDivElement;
  private legendLabel: HTMLDivElement;
  private legendCanvas: HTMLCanvasElement;
  private legendTicks: HTMLDivElement;
  private legendTickMin: HTMLSpanElement;
  private legendTickMax: HTMLSpanElement;
  private legendKey: HTMLDivElement;
  private credit: HTMLDivElement;
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  private variableLabel = '';
  /** Labels for the CURRENT layer's index axis -- MONTH_NAMES for Monthly,
   *  `${km} km` strings for Ocean Depth (see setLayerAxis()). Length always
   *  matches the active manifest's ndepth. */
  private axisLabels: string[] = MONTH_NAMES;
  /** Whether the active Layer supports "play" (cycling the index
   *  automatically) -- Monthly's months make sense to animate through;
   *  Ocean Depth's levels don't carry the same "loop forever" reading, so
   *  the button hides on that Layer rather than cycling depth levels. */
  private playSupported = true;

  constructor(
    private state: ValdesViewState,
    private cb: ValdesUICallbacks,
    title = 'Geode Valdes/BRIDGE',
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });

    this.layerCtrl = this.gui
      .add(this.state, 'layer', { Monthly: 'monthly', 'Ocean Depth': 'ocean_depth' })
      .name('layer')
      .onChange((v: ValdesLayer) => cb.onLayer(v));
    this.variableCtrl = this.gui
      .add(this.state, 'variable', {})
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));
    this.layerIndexCtrl = this.gui.add(this.state, 'layerIndex', 0, MONTH_NAMES.length - 1, 1)
      .name('month')
      .onChange((v: number) => cb.onLayerIndex(v));
    this.playCtrl = this.gui
      .add({ fn: () => this.togglePlay() }, 'fn')
      .name('▶ play seasons');

    // Hidden until boot() confirms a paleogeography source actually loaded
    // -- see setReliefAvailable() -- same "dead control stays hidden"
    // precedent as the vector-field group below (BRIDGE has no
    // Paleogeography Layer of its own, see ADR-0008, so this isn't
    // guaranteed the way it is in ClimateUI).
    this.fieldOpacityCtrl = this.gui.add(this.state, 'fieldOpacity', 0, 1, 0.01)
      .name('raster opacity')
      .onChange((v: number) => cb.onFieldOpacity(v));
    this.fieldOpacityCtrl.hide();

    this.vectorFieldCtrl = this.gui
      .add(this.state, 'vectorFieldId', { None: NONE_VECTOR_FIELD })
      .name('vector field')
      .onChange((v: string) => cb.onVectorField(v === NONE_VECTOR_FIELD ? null : v));
    this.showVectorCtrl = this.gui.add(this.state, 'showVector')
      .name('show vectors')
      .onChange((v: boolean) => cb.onShowVector(v));
    this.vectorStyleCtrl = this.gui.add(this.state, 'vectorStyle', { Arrows: 'glyph', Streaks: 'streak' })
      .name('vector style')
      .onChange((v: VectorStyle) => cb.onVectorStyle(v));
    this.vectorScaleCtrl = this.gui.add(this.state, 'vectorScale', 0.5, 3, 0.1)
      .name('vector size')
      .onChange((v: number) => cb.onVectorScale(v));
    this.vectorDensityCtrl = this.gui.add(this.state, 'vectorDensity', 0.5, 3, 0.1)
      .name('vector density')
      .onChange((v: number) => cb.onVectorDensity(v));

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

    this.ageGroup = document.createElement('div');
    this.ageGroup.className = 'age-group';
    this.ageGroup.append(this.ageSliderWrap);

    this.credit = document.createElement('div');
    this.credit.className = 'credit';

    this.bottomBar = document.createElement('div');
    this.bottomBar.className = 'bottom-bar';
    this.bottomBar.append(this.legend, this.ageGroup, this.credit);
    document.body.appendChild(this.bottomBar);

    this.applyRect();
  }

  /** Mounts the page's single global projection-toggle button as its own
   *  standalone circle beside THIS instance's age-slider box -- mirrors
   *  ClimateUI.mountProjectionToggle() exactly, see its own doc comment. */
  mountProjectionToggle(el: HTMLElement): void {
    this.ageGroup.insertBefore(el, this.ageSliderWrap);
  }

  /** Rebuild the variable dropdown for whichever Layer just became active --
   *  mirrors ClimateUI.setLayerVariables() minus the climate-model
   *  visibility bookkeeping (Valdes has no such control). */
  setLayerVariables(variables: VariableInfo[]): void {
    const pickable = variables.filter((v) => !v.overlay_only && !v.vector_only && !v.mask_only);
    const choices: Record<string, string> = {};
    for (const v of pickable) choices[v.name] = v.id;
    this.variableCtrl.options(choices);
  }

  /** Re-derive the layer-index axis's labels and range for `layer` --
   *  Monthly always uses the fixed MONTH_NAMES scale; Ocean Depth uses the
   *  manifest's own `depth_labels_km` (see types.ts's doc comment on that
   *  field for why real km can't just be the slider's own min/max). Called
   *  once per Layer switch, before setLayerIndex(). */
  setLayerAxis(layer: ValdesLayer, depthLabelsKm: number[] | undefined): void {
    if (layer === 'monthly') {
      this.axisLabels = MONTH_NAMES;
      this.playSupported = true;
    } else {
      this.axisLabels = (depthLabelsKm ?? []).map((km) => (
        km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`
      ));
      this.playSupported = false;
    }
    this.layerIndexCtrl.min(0).max(Math.max(0, this.axisLabels.length - 1)).step(1);
    this.layerIndexCtrl.name(layer === 'monthly' ? 'month' : 'depth');
    if (this.playTimer) this.stopPlay();
    if (this.playSupported) this.playCtrl.show(); else this.playCtrl.hide();
  }

  /** Populate the Vector Field dropdown from whichever Vector Fields the
   *  active Layer declares (Monthly: Wind/Ocean Surface Current/Sea-Ice
   *  Drift; Ocean Depth: Ocean Current) -- always includes "None". Hidden
   *  entirely alongside the rest of the vector controls when a Layer
   *  declares none at all. */
  setVectorFields(fields: VectorFieldInfo[]): void {
    const choices: Record<string, string> = { None: NONE_VECTOR_FIELD };
    for (const f of fields) choices[f.name] = f.id;
    this.vectorFieldCtrl.options(choices);
    const action = fields.length > 0 ? 'show' : 'hide';
    this.vectorFieldCtrl[action]();
    this.showVectorCtrl[action]();
    this.vectorStyleCtrl[action]();
    this.vectorScaleCtrl[action]();
    this.vectorDensityCtrl[action]();
  }

  /** Show/hide the raster-opacity slider -- called once from boot() once it
   *  knows whether a paleogeography source (with a hillshade variable)
   *  actually loaded, since the slider fades toward that mesh and has
   *  nothing to reveal otherwise. */
  setReliefAvailable(available: boolean): void {
    if (available) this.fieldOpacityCtrl.show(); else this.fieldOpacityCtrl.hide();
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageSlider.min = String(min);
    this.ageSlider.max = String(max);
    this.ageSlider.step = String(step);
  }

  private togglePlay(): void {
    if (this.playTimer) { this.stopPlay(); return; }
    this.playCtrl.name('⏸ pause');
    this.playTimer = setInterval(() => {
      this.state.layerIndex = (this.state.layerIndex + 1) % N_REAL_MONTHS;
      this.layerIndexCtrl.updateDisplay();
      this.cb.onLayerIndex(this.state.layerIndex);
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
      // Step must be re-derived per variable, same reasoning as min/max --
      // see clipSliderStep()'s doc comment for the bug a step stuck at
      // whichever variable set it last causes (this is exactly what made
      // Ocean vertical velocity's clip sliders unusable: encode_min/max
      // only 0.0016 cm/s apart, step still the constructor's 0.1 default).
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

  setLayerIndex(index: number): void {
    const label = this.axisLabels[index] ?? String(index);
    this.layerIndexCtrl.name(`${this.state.layer === 'monthly' ? 'month' : 'depth'}: ${label}`);
    this.updateLegendLabel(label);
  }

  private updateLegendLabel(axisLabel?: string): void {
    const label = axisLabel ?? this.axisLabels[this.state.layerIndex];
    this.legendLabel.textContent = label ? `${this.variableLabel} — ${label}` : this.variableLabel;
  }

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

  private formatTick(v: number): string {
    return Number(v.toPrecision(3)).toString();
  }

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

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.setAge(this.state.age);
  }

  setStatus(msg: string, isError = false): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
    this.status.classList.toggle('status--error', isError);
  }

  setAge(age: number): void {
    this.ageSlider.value = String(age);
    this.ageReadout.textContent = `${age.toFixed(0)} Ma`;
  }

  setCredit(text: string): void {
    this.credit.textContent = text;
  }

  setLegendVisible(visible: boolean): void {
    this.legend.style.display = visible ? 'block' : 'none';
  }

  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${innerWidth - (x + width) + 8}px`;

    this.bottomBar.style.left = `${x + 12}px`;
    this.bottomBar.style.width = `${width - 24}px`;
    this.bottomBar.style.bottom = `${innerHeight - (y + height) + 8}px`;

    const sliderWidth = Math.max(200, Math.min(700, width * 0.4));
    this.ageSliderWrap.style.width = `${sliderWidth}px`;

    this.legend.style.height = '';
    this.ageSliderWrap.style.height = '';
    const matchedHeight = Math.max(
      this.legend.getBoundingClientRect().height,
      this.ageSliderWrap.getBoundingClientRect().height,
    );
    this.legend.style.height = `${matchedHeight}px`;
    this.ageSliderWrap.style.height = `${matchedHeight}px`;

    this.status.style.top = `${y + 8}px`;
    this.status.style.left = `${x + 12}px`;
  }

  dispose(): void {
    this.stopPlay();
    this.gui.destroy();
    this.panelAnchor.remove();
    this.status.remove();
    this.bottomBar.remove();
  }
}
