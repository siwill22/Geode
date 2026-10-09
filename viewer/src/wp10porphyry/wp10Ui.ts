import GUI from 'lil-gui';

import type { Rung, WalkSetting, Wp10ViewState } from './types';

export interface Wp10UICallbacks {
  onSetting(): void;
  onAge(age: number): void;
  onLayers(): void;
  onCharts(): void;
  onChartOptions(): void;
}

export interface LegendRow { label: string; fill: string; count?: string }
export interface LegendBlock {
  title: string;
  rows?: LegendRow[];
  ramp?: { css: string; lo: string; hi: string; mid?: string };
  note?: string;
}

/**
 * The porphyry viewer's controls and on-screen text, laid out as the RiftsClimate
 * deposit viewer's (riftsclimateUi.ts): settings top right (what is shown), age in a
 * bottom bar with the projection button beside it (ADR-0058), legend top left,
 * caption bottom left. The charts panel is docked at the right edge, so the settings
 * and the bottom bar stop at its left edge (`setRightInset`).
 */
export class Wp10UI {
  readonly gui: GUI;
  private ageSlider: HTMLInputElement;
  private ageInput: HTMLInputElement;
  private ageSliderWrap: HTMLDivElement;
  private mapHint: HTMLDivElement;
  readonly ageGroup: HTMLDivElement;
  private bottomBar: HTMLDivElement;
  private status: HTMLDivElement;
  private legend: HTMLDivElement;
  private caption: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private rightInset = 0;

  constructor(private state: Wp10ViewState, private cb: Wp10UICallbacks, rungs: Rung[], walks: WalkSetting[],
    ageMax: number) {
    this.gui = new GUI({ title: 'Porphyry Cu: form, walk, survive' });
    const rungOpts: Record<string, string> = {};
    for (const r of rungs) rungOpts[r.label] = r.id;
    this.gui.add(state, 'rung', rungOpts).name('Where they form (rung)').onChange(() => this.cb.onSetting());
    const walkOpts: Record<string, string> = {};
    for (const w of walks) {
      walkOpts[`${w.label} (${w.step_m_per_myr} m per step, ${Math.round(w.up * 100)}/`
        + `${Math.round((1 - w.up - w.down) * 100)}/${Math.round(w.down * 100)} up/stay/down)`] = w.id;
    }
    this.gui.add(state, 'walk', walkOpts).name('Walk setting').onChange(() => this.cb.onSetting());

    const map = this.gui.addFolder('Map layers');
    const layers = () => this.cb.onLayers();
    map.add(state, 'formation').name('Where porphyries form').onChange(layers);
    map.add(state, 'formationColour', {
      'Formation rate': 'rate',
      'Forming now and found today': 'rate_found',
    }).name('  coloured by').onChange(layers);
    map.add(state, 'simulated').name('Simulated porphyries').onChange(layers);
    map.add(state, 'simColour', { 'Depth at this age': 'depth', 'Fate today': 'fate' })
      .name('  coloured by').onChange(layers);
    map.add(state, 'real').name('Real porphyries').onChange(layers);
    map.add(state, 'finds').name('Predicted finds per place (0 Ma)').onChange(layers);
    map.add(state, 'findsColour', { 'Predicted number found': 'predicted', 'Real minus predicted': 'difference' })
      .name('  coloured by').onChange(layers);
    map.add(state, 'boundaries').name('Plate boundaries').onChange(layers);
    map.add(state, 'boundaryColour', { 'Type (as labelled)': 'label', 'Closing or opening rate': 'convergence' })
      .name('  coloured by').onChange(layers);
    map.add(state, 'convergentOnly').name('  only where closing').onChange(layers);
    map.add(state, 'coastlines').name('Continents').onChange(layers);
    map.add(state, 'graticule').name('Latitude/longitude lines').onChange(layers);

    // Folders start closed, so the panel covers only the corner above the map.
    map.close();
    const charts = this.gui.addFolder('Charts');
    charts.close();
    charts.add(state, 'charts').name('Show charts').onChange(() => this.cb.onCharts());
    const opt = () => this.cb.onChartOptions();
    charts.add(state, 'lines', 10, 1000, 10).name('Lines drawn').onFinishChange(opt);
    charts.add(state, 'onlyFound').name('Only those found today').onChange(opt);
    charts.add(state, 'lineColour', { 'Fate today': 'fate', 'Factor tilting the walk (rung 2 on)': 'factor' })
      .name('Colour lines by').onChange(opt);
    charts.add(state, 'chartSpan', { '541 Ma to today': 541, '300 Ma': 300, '150 Ma': 150, '60 Ma': 60 })
      .name('Age axis from').onChange(opt);

    this.status = el('div', 'status');
    this.legend = el('div', 'legend');
    this.caption = el('div', 'caption');
    this.tooltip = el('div', 'popup');
    this.tooltip.style.display = 'none';

    this.ageSlider = el('input', 'age-slider');
    this.ageSlider.type = 'range';
    this.ageSlider.min = '0';
    this.ageSlider.max = String(ageMax);
    this.ageSlider.step = '1';
    this.ageSlider.setAttribute('aria-label', 'Age (Ma)');
    this.ageSlider.addEventListener('input', () => this.commitAge(Number(this.ageSlider.value)));
    const readout = el('span', 'age-readout');
    this.ageInput = el('input', 'age-input');
    this.ageInput.type = 'text';
    this.ageInput.inputMode = 'numeric';
    this.ageInput.setAttribute('aria-label', 'Age in Ma');
    this.ageInput.addEventListener('change', () => {
      const v = Number(this.ageInput.value);
      if (Number.isFinite(v)) this.commitAge(v); else this.setAge(this.state.age);
    });
    this.ageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.ageInput.blur(); });
    readout.append(this.ageInput, document.createTextNode(' Ma'));
    this.mapHint = el('div', 'map-hint');
    this.ageSliderWrap = el('div', 'age-slider-wrap');
    this.ageSliderWrap.append(this.ageSlider, readout, this.mapHint);
    this.ageGroup = el('div', 'age-group');
    this.ageGroup.append(this.ageSliderWrap);
    this.bottomBar = el('div', 'bottom-bar');
    this.bottomBar.append(this.caption, this.ageGroup);
    document.body.append(this.status, this.legend, this.bottomBar, this.tooltip);
    this.setAge(state.age);
    this.layout();
    addEventListener('resize', () => this.layout());
  }

  mountProjectionToggle(button: HTMLElement): void {
    this.ageGroup.prepend(button);
  }

  /** Keep the settings and the bottom bar over the map, left of the charts. */
  setRightInset(px: number): void {
    this.rightInset = px;
    this.gui.domElement.style.right = `${px + 8}px`;
    this.bottomBar.style.right = `${px + 12}px`;
    this.layout();
  }

  private layout(): void {
    const mapW = innerWidth - this.rightInset;
    this.ageSliderWrap.style.width = `${Math.max(200, Math.min(560, mapW * 0.4))}px`;
    this.caption.style.maxWidth = `${Math.max(200, Math.min(54 * 7, mapW * 0.3))}px`;
  }

  private commitAge(age: number): void {
    const a = Math.round(Math.max(Number(this.ageSlider.min), Math.min(Number(this.ageSlider.max), age)));
    this.state.age = a;
    this.setAge(a);
    this.cb.onAge(a);
  }

  setAge(age: number): void {
    this.ageSlider.value = String(age);
    this.ageInput.value = String(Math.round(age));
  }

  setMapHint(text: string): void {
    this.mapHint.textContent = text;
    this.mapHint.style.display = text ? '' : 'none';
  }

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.setAge(this.state.age);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.style.display = text ? '' : 'none';
  }

  setCaption(lines: string[]): void {
    this.caption.replaceChildren(...lines.map((t, i) => {
      const d = el('div', i === 0 ? '' : 'caption-counts');
      d.textContent = t;
      return d;
    }));
  }

  setLegend(blocks: LegendBlock[]): void {
    this.legend.replaceChildren();
    for (const b of blocks) {
      const box = el('div', 'legend-block');
      const t = el('div', 'legend-title');
      t.textContent = b.title;
      box.appendChild(t);
      for (const r of b.rows ?? []) {
        const row = el('div', 'legend-row');
        const sw = el('span', 'legend-swatch');
        sw.style.background = r.fill;
        const l = el('span', 'legend-label');
        l.textContent = r.label;
        row.append(sw, l);
        if (r.count !== undefined) {
          const n = el('span', 'legend-count');
          n.textContent = r.count;
          row.appendChild(n);
        }
        box.appendChild(row);
      }
      if (b.ramp) {
        const bar = el('div', 'legend-ramp');
        bar.style.background = b.ramp.css;
        const ends = el('div', 'legend-ends');
        for (const text of [b.ramp.lo, b.ramp.mid, b.ramp.hi]) {
          if (text === undefined) continue;
          const s = el('span', '');
          s.textContent = text;
          ends.appendChild(s);
        }
        box.append(bar, ends);
      }
      if (b.note) {
        const n = el('div', 'legend-note');
        n.textContent = b.note;
        box.appendChild(n);
      }
      this.legend.appendChild(box);
    }
  }

  showTooltip(x: number, y: number, lines: string[]): void {
    this.tooltip.replaceChildren(...lines.map((t, i) => {
      const d = el('div', i === 0 ? 'popup-title' : '');
      d.textContent = t;
      return d;
    }));
    this.tooltip.style.display = '';
    this.tooltip.style.left = `${x + 14}px`;
    this.tooltip.style.top = `${y + 14}px`;
  }

  hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
