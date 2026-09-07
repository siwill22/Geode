import GUI, { type Controller } from 'lil-gui';
import type { NoDataStyle } from '../core/material';
import { clampClipOrder, clipSliderStep } from '../core/clipRange';
import { TimeSeriesPanel } from '../core/timeSeriesPanel';
import type { ColormapData, VariableInfo } from '../core/types';
import type { CellSample } from '../core/queryPoint';
import type { TimeSeriesPoint } from '../core/timeSeries';
import type { GlobeTool } from '../core/tools';
import type { Rect } from '../core/layout';

export type { GlobeTool };

export interface GlobeViewState {
  variable: string;
  age: number;
  clipMin: number;
  clipMax: number;
  noDataStyle: NoDataStyle;
  /** UI-only: see DeformationUI's identical field for why this exists and
   *  is never read by rendering code. */
  logScale: boolean;
}

export interface GlobeUICallbacks {
  onVariable(id: string): void;
  onAge(age: number): void;
  onClip(lo: number, hi: number): void;
  onNoDataStyle(style: NoDataStyle): void;
  /** The `time-series` panel was just expanded -- see
   *  TimeSeriesPanel.setVariables()'s own doc comment for why every open
   *  fires this rather than tracking "already requested" here. */
  onExpandTimeSeries(): void;
}

const LOG_SCALE_MIN_RATIO = 100;

/**
 * The single-model-globe panel -- one dataset, no reconstruction/layer
 * switching (see deformation/deformationUi.ts for the shape this was
 * generalized from). Which controls actually appear is driven entirely by
 * `tools`, a recipe's own `ui.tools` list (see generator/recipeTypes.ts):
 * a generated site only shows what its recipe asked for, not everything
 * this class is capable of.
 */
export class GlobeUI {
  readonly gui: GUI;
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
  /** Positioned per-instance by setRect(); anchors the panel's top-right
   *  corner -- see tomography/ui.ts's identical panelAnchor, the pattern
   *  this generalizes for Multi-Globe (docs/adr/0022). */
  private panelAnchor: HTMLDivElement;
  /** The `time-series` tool's fan-chart box, extracted into core/ so this
   *  wrapper and groupGlobe/groupGlobeUi.ts don't each duplicate the DOM/
   *  canvas plumbing (see docs/adr/0023) -- null unless the recipe asked
   *  for it. */
  private timeSeriesPanel: TimeSeriesPanel | null = null;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private state: GlobeViewState,
    private cb: GlobeUICallbacks,
    private readonly tools: GlobeTool[],
    title: string,
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });

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

    // top: 48/84, not 12/44 -- clears the page-level #globe-menu-toggle icon
    // fixed at the screen's actual top-left corner (core/multiGlobeMenu.css),
    // which for the top-left tile is the same screen position these would
    // otherwise sit at.
    this.status = document.createElement('div');
    this.status.className = 'status';
    Object.assign(this.status.style, { top: '48px', left: '12px' });
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    Object.assign(this.timeInfo.style, { top: '84px', left: '12px' });
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
      // Stacks below .status/.timeinfo in the top-LEFT corner -- lil-gui's
      // own panel already owns the top-right (see .lil-gui's default
      // fixed positioning), so a query-point panel there would sit hidden
      // behind it, as a first version of this did.
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

    if (tools.includes('time-series')) {
      this.timeSeriesPanel = new TimeSeriesPanel({ onExpand: () => cb.onExpandTimeSeries() });
    }

    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }
  }

  /** Move this instance's panel, status, time-info, legend, query panel and
   *  credit onto a new tile, in CSS pixels -- called once at boot with the
   *  full window and again whenever the globe grid is relaid out (see
   *  core/multiInstanceHost.ts, docs/adr/0022). */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    const rightEdge = innerWidth - (x + width);
    const bottomEdge = innerHeight - (y + height);
    // Anchored to the same corners the original fixed-viewport CSS put each
    // element in, matching tomography/ui.ts's identical convention.
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${rightEdge + 8}px`;
    this.status.style.top = `${y + 48}px`;
    this.status.style.left = `${x + 12}px`;
    this.timeInfo.style.top = `${y + 80}px`;
    this.timeInfo.style.left = `${x + 12}px`;
    if (this.queryPanel) {
      this.queryPanel.style.top = `${y + 112}px`;
      this.queryPanel.style.left = `${x + 12}px`;
    }
    if (this.legend) {
      this.legend.style.bottom = `${bottomEdge + 12}px`;
      this.legend.style.left = `${x + 12}px`;
    }
    this.credit.style.bottom = `${bottomEdge + 8}px`;
    this.credit.style.right = `${rightEdge + 12}px`;

    if (this.timeSeriesPanel) {
      // Below status(y+12)/timeInfo(y+44)/queryPanel(y+76)'s fixed top-left
      // stack; above the legend, whose own height varies (taller for a
      // categorical class key) -- measured fresh each call rather than
      // assumed, same reasoning as panelWidth below.
      const panelWidth = this.panelAnchor.getBoundingClientRect().width;
      const legendHeight = this.legend ? this.legend.getBoundingClientRect().height : 0;
      const bottomPx = bottomEdge + 12 + (this.legend ? legendHeight + 8 : 0);
      this.timeSeriesPanel.setRect(this.rect, { topOffset: 108, bottomPx, panelWidth });
    }
  }

  get queryPointEnabled(): boolean {
    return this.tools.includes('query-point');
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
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

  /** Show the result of a point query -- see globeInstance.ts's
   *  queryPointAt(), which reads through the same core/queryPoint.ts
   *  monthProfile() the climate viewer's Anchored Point uses, against the
   *  currently-displayed frame's own cached texture (no extra fetch), so
   *  this always reflects whatever age/variable is on screen right now.
   *  No-op if `query-point` wasn't in the recipe's tool list (queryPanel
   *  is null). */
  showQueryResult(sample: CellSample, variable: VariableInfo): void {
    if (!this.queryPanel) return;
    const label = variable.categorical
      ? (variable.class_names?.[Math.round(sample.value)] ?? 'no data')
      : (Number.isNaN(sample.value) ? 'no data' : `${sample.value.toPrecision(4)} ${variable.units}`);
    this.queryPanel.textContent =
      `${sample.cell.lat.toFixed(1)}°, ${sample.cell.lon.toFixed(1)}°: ${label}`;
    this.queryPanel.style.display = 'block';
  }

  setTimeSeriesAgeRange(min: number, max: number): void {
    this.timeSeriesPanel?.setAgeRange(min, max);
  }

  setTimeSeriesVariables(variables: VariableInfo[]): void {
    this.timeSeriesPanel?.setVariables(variables.map((v) => ({ id: v.id, name: v.name })));
  }

  setTimeSeriesLoading(variableId: string): void {
    this.timeSeriesPanel?.setLoading(variableId);
  }

  setTimeSeriesData(variableId: string, points: TimeSeriesPoint[]): void {
    this.timeSeriesPanel?.setData(variableId, points);
  }

  setTimeSeriesAge(age: number): void {
    this.timeSeriesPanel?.setAge(age);
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
    this.panelAnchor.remove();
    this.status.remove();
    this.timeInfo.remove();
    this.legend?.remove();
    this.queryPanel?.remove();
    this.credit.remove();
    this.timeSeriesPanel?.dispose();
  }
}
