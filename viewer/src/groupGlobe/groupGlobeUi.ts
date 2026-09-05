import GUI, { type Controller } from 'lil-gui';
import type { NoDataStyle } from '../core/material';
import { clampClipOrder, clipSliderStep } from '../core/clipRange';
import type { ColormapData, VariableInfo } from '../core/types';
import type { CellSample } from '../core/queryPoint';
import type { GlobeTool } from '../core/tools';

export interface GroupGlobeViewState {
  /** Current reconstruction_model value (e.g. "Cao2024"). */
  axisA: string;
  /** Current comparison_role value (e.g. "Deformation"). */
  axisB: string;
  variable: string;
  age: number;
  clipMin: number;
  clipMax: number;
  noDataStyle: NoDataStyle;
  logScale: boolean;
}

export interface GroupGlobeUICallbacks {
  onAxisA(value: string): void;
  onAxisB(value: string): void;
  onVariable(id: string): void;
  onAge(age: number): void;
  onClip(lo: number, hi: number): void;
  onNoDataStyle(style: NoDataStyle): void;
}

const LOG_SCALE_MIN_RATIO = 100;

/**
 * The `model-group-globe` panel -- two dropdowns (one per declared axis,
 * see generator/recipeTypes.ts) instead of `single-model-globe`'s one fixed
 * Model, otherwise the same shape as that wrapper's GlobeUI. Generalized
 * directly from deformation/deformationUi.ts's reconstruction+layer
 * dropdowns: those two controls ARE this pattern, just hardcoded to
 * deformation's own two axes instead of driven by whatever axis names a
 * recipe's comparison group actually has.
 */
export class GroupGlobeUI {
  readonly gui: GUI;
  private axisACtrl: Controller;
  private axisBCtrl: Controller;
  private variableCtrl: Controller;
  private ageCtrl: Controller;
  private clipFolder: GUI;
  private logScaleCtrl: Controller;
  private clipMinCtrl: Controller | null = null;
  private clipMaxCtrl: Controller | null = null;
  private noDataStyleCtrl: Controller | null = null;
  private currentVariable: VariableInfo | null = null;
  private logProxy = { min: 0, max: 0 };

  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private legend: HTMLDivElement | null = null;
  private legendLabel!: HTMLDivElement;
  private legendCanvas!: HTMLCanvasElement;
  private legendTicks!: HTMLDivElement;
  private legendTickMin!: HTMLSpanElement;
  private legendTickMax!: HTMLSpanElement;
  private legendKey!: HTMLDivElement;
  private credit: HTMLDivElement;
  private queryPanel: HTMLDivElement | null = null;

  constructor(
    private state: GroupGlobeViewState,
    private cb: GroupGlobeUICallbacks,
    private readonly tools: GlobeTool[],
    title: string,
    axisALabel: string,
    axisBLabel: string,
  ) {
    this.gui = new GUI({ title });

    this.axisACtrl = this.gui.add(this.state, 'axisA', {}).name(axisALabel)
      .onChange((v: string) => cb.onAxisA(v));
    this.axisBCtrl = this.gui.add(this.state, 'axisB', {}).name(axisBLabel)
      .onChange((v: string) => cb.onAxisB(v));

    this.variableCtrl = this.gui
      .add(this.state, 'variable', {})
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));

    this.ageCtrl = this.gui.add(this.state, 'age', 0, 1, 1)
      .name('age (Ma)')
      .onChange((v: number) => cb.onAge(v));
    if (!tools.includes('age-slider')) this.ageCtrl.hide();

    this.clipFolder = this.gui.addFolder('clip range');
    this.logScaleCtrl = this.clipFolder.add(this.state, 'logScale')
      .name('log scale')
      .onChange(() => { if (this.currentVariable) this.rebuildClipControls(this.currentVariable); });

    if (tools.includes('no-data-toggle')) {
      this.noDataStyleCtrl = this.gui
        .add(this.state, 'noDataStyle', { Transparent: 'transparent', 'Light grey': 'grey', White: 'white' })
        .name('no-data style')
        .onChange((v: NoDataStyle) => cb.onNoDataStyle(v));
    }

    this.status = document.createElement('div');
    this.status.className = 'status';
    Object.assign(this.status.style, { top: '12px', left: '12px' });
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    Object.assign(this.timeInfo.style, { top: '44px', left: '12px' });
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    if (tools.includes('legend')) {
      this.legend = document.createElement('div');
      this.legend.className = 'legend';
      Object.assign(this.legend.style, { bottom: '12px', left: '12px' });
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
      document.body.appendChild(this.legend);
    }

    if (tools.includes('query-point')) {
      this.queryPanel = document.createElement('div');
      this.queryPanel.className = 'query-panel';
      Object.assign(this.queryPanel.style, { top: '76px', left: '12px' });
      this.queryPanel.style.display = 'none';
      document.body.appendChild(this.queryPanel);
    }

    this.credit = document.createElement('div');
    this.credit.className = 'credit';
    Object.assign(this.credit.style, { bottom: '8px', right: '12px' });
    document.body.appendChild(this.credit);
  }

  get queryPointEnabled(): boolean {
    return this.tools.includes('query-point');
  }

  setAxisAOptions(values: string[]): void {
    this.axisACtrl.options(Object.fromEntries(values.map((v) => [v, v])));
  }

  setAxisBOptions(values: string[]): void {
    this.axisBCtrl.options(Object.fromEntries(values.map((v) => [v, v])));
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
  }

  /** Hidden, not disabled, when the active axisB combination is static (a
   *  single Frame) -- see GroupGlobeInstance's isStaticAxisB(): a
   *  greyed-out slider with nothing left for it to do reads as a bug, the
   *  same reasoning as DeformationUI's identical choice. */
  setAgeControlVisible(visible: boolean): void {
    if (visible && this.tools.includes('age-slider')) this.ageCtrl.show(); else this.ageCtrl.hide();
  }

  setVariables(variables: VariableInfo[]): void {
    const choices: Record<string, string> = {};
    for (const v of variables) choices[v.name] = v.id;
    this.variableCtrl.options(choices);
    if (variables.length <= 1) this.variableCtrl.hide();
  }

  private rebuildClipControls(v: VariableInfo): void {
    this.currentVariable = v;
    this.clipMinCtrl?.destroy();
    this.clipMaxCtrl?.destroy();

    const canLog = !v.diverging && !v.categorical && v.encode_min > 0
      && v.encode_max / v.encode_min >= LOG_SCALE_MIN_RATIO;
    if (canLog) this.logScaleCtrl.show(); else { this.state.logScale = false; this.logScaleCtrl.hide(); }

    if (this.state.logScale && canLog) {
      this.logProxy.min = Math.log10(this.state.clipMin);
      this.logProxy.max = Math.log10(this.state.clipMax);
      const lo = Math.log10(v.encode_min);
      const hi = Math.log10(v.encode_max);
      const step = clipSliderStep(lo, hi);
      const onLogChange = (which: 'min' | 'max') => (x: number) => {
        this.state[which === 'min' ? 'clipMin' : 'clipMax'] = 10 ** x;
        if (clampClipOrder(this.state, which)) {
          if (which === 'min') {
            this.logProxy.max = Math.log10(this.state.clipMax);
            this.clipMaxCtrl?.updateDisplay();
          } else {
            this.logProxy.min = Math.log10(this.state.clipMin);
            this.clipMinCtrl?.updateDisplay();
          }
        }
        this.cb.onClip(this.state.clipMin, this.state.clipMax);
        this.updateLegendTicks(this.state.clipMin, this.state.clipMax);
      };
      this.clipMinCtrl = this.clipFolder.add(this.logProxy, 'min', lo, hi, step)
        .name(`clip min (log₁₀ ${v.units})`)
        .onChange(onLogChange('min'));
      this.clipMaxCtrl = this.clipFolder.add(this.logProxy, 'max', lo, hi, step)
        .name(`clip max (log₁₀ ${v.units})`)
        .onChange(onLogChange('max'));
    } else {
      const step = clipSliderStep(v.encode_min, v.encode_max);
      const onLinearChange = (which: 'min' | 'max') => () => {
        if (clampClipOrder(this.state, which)) {
          (which === 'min' ? this.clipMaxCtrl : this.clipMinCtrl)?.updateDisplay();
        }
        this.cb.onClip(this.state.clipMin, this.state.clipMax);
        this.updateLegendTicks(this.state.clipMin, this.state.clipMax);
      };
      this.clipMinCtrl = this.clipFolder.add(this.state, 'clipMin', v.encode_min, v.encode_max, step)
        .name(`clip min (${v.units})`)
        .onChange(onLinearChange('min'));
      this.clipMaxCtrl = this.clipFolder.add(this.state, 'clipMax', v.encode_min, v.encode_max, step)
        .name(`clip max (${v.units})`)
        .onChange(onLinearChange('max'));
    }
  }

  setVariable(v: VariableInfo, colormap: ColormapData[string]): void {
    if (v.categorical) {
      this.clipFolder.hide();
      this.hideLegendTicks();
    } else {
      this.clipFolder.show();
      this.state.clipMin = v.default_clip_min;
      this.state.clipMax = v.default_clip_max;
      this.rebuildClipControls(v);
      this.updateLegendTicks(v.default_clip_min, v.default_clip_max);
    }
    if (!this.legend) return;
    this.legendLabel.textContent = v.categorical ? v.name : `${v.name} (${v.units})`;
    this.paintLegend(colormap);
    if (v.categorical && v.class_names) this.showLegendKey(v.class_names, colormap.colors);
    else this.hideLegendKey();
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
    if (this.legendKey) this.legendKey.style.display = 'none';
  }

  private formatTick(v: number): string {
    if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(2);
    return Number(v.toPrecision(3)).toString();
  }

  private updateLegendTicks(lo: number, hi: number): void {
    if (!this.legend) return;
    this.legendTickMin.textContent = this.formatTick(lo);
    this.legendTickMax.textContent = this.formatTick(hi);
    this.legendTicks.style.display = 'flex';
  }

  private hideLegendTicks(): void {
    if (this.legendTicks) this.legendTicks.style.display = 'none';
  }

  private paintLegend(cm: ColormapData[string]): void {
    if (!this.legend) return;
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

  /** See GlobeUI.showQueryResult() -- same panel, same convention. */
  showQueryResult(sample: CellSample, variable: VariableInfo): void {
    if (!this.queryPanel) return;
    const label = variable.categorical
      ? (variable.class_names?.[Math.round(sample.value)] ?? 'no data')
      : (Number.isNaN(sample.value) ? 'no data' : `${sample.value.toPrecision(4)} ${variable.units}`);
    this.queryPanel.textContent =
      `${sample.cell.lat.toFixed(1)}°, ${sample.cell.lon.toFixed(1)}°: ${label}`;
    this.queryPanel.style.display = 'block';
  }

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

  setCredit(text: string): void {
    this.credit.textContent = text;
  }

  dispose(): void {
    this.gui.destroy();
    this.status.remove();
    this.timeInfo.remove();
    this.legend?.remove();
    this.queryPanel?.remove();
    this.credit.remove();
  }
}
