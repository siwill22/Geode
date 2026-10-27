import GUI, { type Controller } from 'lil-gui';

import type { LegendBlock } from '../wp10porphyry/wp10Ui';
import type { ComboMap, MolchanFactor, MolchanIndex, MolchanViewState } from './types';
import { comboKey } from './types';

export interface MolchanUICallbacks {
  /** Deposit type or factor changed. */
  onSetting(): void;
  onAge(age: number): void;
  onLayers(): void;
  onDiagram(): void;
}

/**
 * The Molchan viewer's controls and on-screen text, laid out as the WP10 porphyry viewer's
 * (wp10Ui.ts): settings top right, age in a bottom bar with the projection button beside it
 * (ADR-0058), legend top left, caption bottom left. The Molchan diagram is docked at the right
 * edge, so the settings and the bottom bar stop at its left edge (`setRightInset`).
 */
export class MolchanUI {
  readonly gui: GUI;
  private factorCtl: Controller;
  private comboCtl: Controller;
  private comboSetCtl: Controller;
  private colourCtl: Controller;
  private ageSlider: HTMLInputElement;
  private ageInput: HTMLInputElement;
  private ageSliderWrap: HTMLDivElement;
  private sliceReadout: HTMLDivElement;
  private mapHint: HTMLDivElement;
  readonly ageGroup: HTMLDivElement;
  private bottomBar: HTMLDivElement;
  private status: HTMLDivElement;
  private legend: HTMLDivElement;
  private caption: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private rightInset = 0;

  constructor(private state: MolchanViewState, private cb: MolchanUICallbacks, private index: MolchanIndex) {
    this.gui = new GUI({ title: 'One-factor Molchan test: its inputs' });
    const types: Record<string, string> = {};
    for (const t of index.types) types[t.label] = t.id;
    this.gui.add(state, 'type', types).name('Deposit type').onChange(() => {
      this.setFactorOptions();
      this.setComboOptions();
      this.cb.onSetting();
    });
    this.gui.add(state, 'show', { 'One factor (step 1)': 'factor', 'Combination (step 3)': 'combination' })
      .name('Show').onChange(() => { this.enableControls(); this.cb.onSetting(); });
    this.factorCtl = this.gui.add(state, 'factor', this.factorOptions()).name('Factor');
    this.factorCtl.onChange(() => this.cb.onSetting());
    // the run with screened new factors, where RiftsClimate wrote one for the type
    this.comboSetCtl = this.gui.add(state, 'comboSet', { 'Main candidates': 'main', 'With screened new factors': 'screened' })
      .name('  candidates').onChange(() => { this.setComboOptions(); this.cb.onSetting(); });
    this.comboCtl = this.gui.add(state, 'combo', this.comboOptions()).name('Combination');
    this.comboCtl.onChange(() => this.cb.onSetting());

    const layers = () => this.cb.onLayers();
    const map = this.gui.addFolder('Map layers');
    map.add(state, 'boxes').name('Ground (place x time slice)').onChange(layers);
    this.colourCtl = map.add(state, 'colourBy', { 'Share of ground rated higher': 'share', 'Value of the factor': 'value' })
      .name('  coloured by').onChange(layers);
    map.add(state, 'testOnly').name('  as the test sees it (slices in pairs)').onChange(layers);
    map.add(state, 'deposits').name('Deposits').onChange(layers);
    map.add(state, 'window', {
      'Formed in this time slice': 'slice', 'Within 10 Myr': '10', 'Within 25 Myr': '25', 'Within 50 Myr': '50',
    }).name('  shown if').onChange(layers);
    map.add(state, 'post_rift').name('Post-rift (passive) margins').onChange(layers);
    map.add(state, 'syn_rift').name('Syn-rift margins').onChange(layers);
    map.add(state, 'collision').name('Collision margins').onChange(layers);
    map.add(state, 'after_collision').name('Margin lines after collision').onChange(layers);
    if (index.files.boundaries) {
      map.add(state, 'boundaries').name('Plate boundaries (Merdith 2021)').onChange(layers);
      map.add(state, 'boundaryColour', { 'Type of boundary': 'label', 'Convergence rate': 'convergence' })
        .name('  boundaries coloured by').onChange(layers);
    }
    map.add(state, 'polygons').name('Continent polygons').onChange(layers);
    map.add(state, 'coastlines').name('Continents').onChange(layers);
    map.add(state, 'graticule').name('Latitude/longitude lines').onChange(layers);
    map.close();
    this.gui.add(state, 'diagram').name('Molchan diagram').onChange(() => this.cb.onDiagram());

    this.status = el('div', 'status');
    this.legend = el('div', 'legend');
    this.caption = el('div', 'caption');
    this.tooltip = el('div', 'popup');
    this.tooltip.style.display = 'none';

    this.ageSlider = el('input', 'age-slider');
    this.ageSlider.type = 'range';
    this.ageSlider.min = '0';
    this.ageSlider.max = String(index.age_max);
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
    this.sliceReadout = el('div', 'map-hint');
    this.mapHint = el('div', 'map-hint');
    this.ageSliderWrap = el('div', 'age-slider-wrap');
    this.ageSliderWrap.append(this.ageSlider, readout, this.sliceReadout, this.mapHint);
    this.ageGroup = el('div', 'age-group');
    this.ageGroup.append(this.ageSliderWrap);
    this.bottomBar = el('div', 'bottom-bar');
    this.bottomBar.append(this.caption, this.ageGroup);
    document.body.append(this.status, this.legend, this.bottomBar, this.tooltip);
    this.setAge(state.age);
    this.enableControls();
    this.layout();
    addEventListener('resize', () => this.layout());
  }

  /** The combination maps written for the chosen type: the best-of-all choice first. */
  private comboOptions(): Record<string, string> {
    const out: Record<string, string> = {};
    const maps = this.index.combos?.[comboKey(this.index, this.state)]?.maps ?? [];
    let top = 0;
    for (const m of maps) {
      const label = slotNames(m);
      const name = m.kind === 'best' ? 'Best-of-all choice (each region its own pick)'
        : m.kind === 'top' ? `Best ${++top}: ${label}`
          : m.kind === 'published' ? `Published: ${label}` : `One factor: ${label}`;
      out[name] = m.id;
    }
    return out;
  }

  /** After the type changed: that type's maps, keeping the same kind of map where possible. */
  setComboOptions(): void {
    const opts = this.comboOptions();
    if (!Object.values(opts).includes(this.state.combo)) this.state.combo = Object.values(opts)[0] ?? '';
    this.comboCtl = this.comboCtl.options(opts).name('Combination');
    this.comboCtl.onChange(() => this.cb.onSetting());
    this.enableControls();
  }

  /** A factor is picked in one-factor mode, a map in combination mode (shares only). */
  enableControls(): void {
    const combo = this.state.show === 'combination';
    this.factorCtl.show(!combo);
    this.comboCtl.show(combo);
    this.comboSetCtl.show(combo && !!this.index.combos?.[`${this.state.type}|screened`]);
    this.colourCtl.enable(!combo);
    this.gui.title(combo ? 'Combinations (step 3): held-out maps' : 'One-factor Molchan test: its inputs');
  }

  /** The factors tested on the chosen deposit type (collision is MVT only). */
  private factorOptions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.index.factors.filter((x: MolchanFactor) => x.types.includes(this.state.type))) out[f.id] = f.id;
    return out;
  }

  private setFactorOptions(): void {
    const opts = this.factorOptions();
    if (!Object.values(opts).includes(this.state.factor)) this.state.factor = Object.values(opts)[0];
    // lil-gui's options() replaces the controller with a new one.
    this.factorCtl = this.factorCtl.options(opts).name('Factor');
    this.factorCtl.onChange(() => this.cb.onSetting());
    this.enableControls();
  }

  mountProjectionToggle(button: HTMLElement): void {
    this.ageGroup.prepend(button);
  }

  /** Keep the settings and the bottom bar over the map, left of the diagram panel. */
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

  /** The time slice covering the age, under the slider. */
  setSlice(text: string): void {
    this.sliceReadout.textContent = text;
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

/** A screened run's label names its slots ("@new idea 1"); each region set aside fills them
 *  without seeing itself. Name the factor when every region filled the slot the same way. */
function slotNames(m: ComboMap): string {
  return m.label.replace(/@new idea (\d)/g, (slot, n) => {
    const fills = new Set<string>();
    for (const r of Object.values(m.regions)) {
      const hit = r.combination.split(/ \+ | \| both at once: | x /)
        .find((t) => t.endsWith(` [new idea ${n}]`));
      if (hit) fills.add(hit.slice(0, -` [new idea ${n}]`.length));
    }
    return fills.size === 1 ? `${[...fills][0]} [new idea ${n}]` : `${slot.slice(1)} (varies by region)`;
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
