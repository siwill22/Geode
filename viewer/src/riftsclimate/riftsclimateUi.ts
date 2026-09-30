import GUI, { type Controller } from 'lil-gui';
import type { ProjectionMode } from '../core/projection';
import type {
  ClimateLayer, DeformationLayer, DepositClass, FieldDef, RiftsModel, RiftsViewState,
} from './types';

export interface RiftsUICallbacks {
  onModel(id: string): void;
  onAge(age: number): void;
  onProjection(mode: ProjectionMode): void;
  onCoastlines(on: boolean): void;
  onClimate(layer: ClimateLayer): void;
  onDeformation(layer: DeformationLayer): void;
  onRift(phase: string, on: boolean): void;
  onColourBy(key: string): void;
  onLifespan(): void;
  onClass(cls: string, on: boolean): void;
}

export interface LegendRow { label: string; fill: string; count?: string }

/**
 * The deposit viewer's controls and on-screen text.
 *
 * Every control either chooses what is drawn or how it is viewed. The plate
 * model is the only one that changes several layers at once, on purpose
 * (ADR-0057): deposits, coastlines, deformation, climate and rifts are all
 * reconstructed in one plate model or not drawn at all. A layer that has no
 * version in the selected model is hidden, and the caption says why, rather
 * than drawn under the wrong plates.
 */
export class RiftsUI {
  readonly gui: GUI;
  private modelCtrl: Controller;
  private ageCtrl: Controller;
  private climateCtrl: Controller;
  private deformationCtrl: Controller;
  private riftCtrls: Controller[] = [];
  private riftFolder: GUI;
  private windowCtrl: Controller;

  private status: HTMLDivElement;
  private legend: HTMLDivElement;
  private caption: HTMLDivElement;
  private tooltip: HTMLDivElement;

  constructor(
    private state: RiftsViewState,
    private cb: RiftsUICallbacks,
    models: RiftsModel[],
    classes: DepositClass[],
    colourFields: FieldDef[],
  ) {
    this.gui = new GUI({ title: 'RiftsClimate deposits' });

    const names: Record<string, string> = {};
    for (const m of models) names[m.label] = m.id;
    this.modelCtrl = this.gui.add(state, 'model', names).name('Plate model')
      .onChange((id: string) => this.cb.onModel(id));
    this.ageCtrl = this.gui.add(state, 'age', 0, 1000, 1).name('Age (Ma)')
      .onChange((age: number) => this.cb.onAge(age));
    this.gui.add(state, 'projection', { Globe: 'globe', Robinson: 'robinson', 'Plate Carrée': 'plateCarree' })
      .name('Projection')
      .onChange((m: ProjectionMode) => this.cb.onProjection(m));

    const dep = this.gui.addFolder('Deposits');
    dep.add(state, 'lifespan', { 'Formed by this age': 'since', 'Forming near this age': 'window' })
      .name('Show')
      .onChange(() => { this.syncWindow(); this.cb.onLifespan(); });
    this.windowCtrl = dep.add(state, 'window', 1, 100, 1).name('± Myr')
      .onChange(() => this.cb.onLifespan());
    const colour: Record<string, string> = { 'Deposit class': 'class' };
    for (const f of colourFields) {
      let label = f.label;
      if (colour[label]) label = `${label} [${f.group}]`;
      colour[label] = f.key;
    }
    dep.add(state, 'colourBy', colour).name('Colour by')
      .onChange((k: string) => this.cb.onColourBy(k));
    const cls = dep.addFolder('Classes');
    for (const c of classes) {
      cls.add(state.classes, c.id).name(`${c.label} (${c.n})`)
        .onChange((on: boolean) => this.cb.onClass(c.id, on));
    }
    this.syncWindow();

    const layers = this.gui.addFolder('Map layers');
    layers.add(state, 'coastlines').name('Continents')
      .onChange((on: boolean) => this.cb.onCoastlines(on));
    this.climateCtrl = layers.add(state, 'climate', {
      None: 'none', 'Annual rainfall (BRIDGE)': 'P', 'Annual temperature (BRIDGE)': 'T',
    }).name('Climate')
      .onChange((v: ClimateLayer) => this.cb.onClimate(v));
    this.deformationCtrl = layers.add(state, 'deformation', {
      None: 'none',
      'Stretching (+) / squeezing (−)': 'horizontal_divergence',
      'Deformation style': 'deformation_style',
    }).name('Deformation')
      .onChange((v: DeformationLayer) => this.cb.onDeformation(v));
    this.riftFolder = layers.addFolder('Jackson & MacDonald margins');

    this.status = el('div', 'status');
    this.legend = el('div', 'legend');
    this.caption = el('div', 'caption');
    this.tooltip = el('div', 'popup');
    this.tooltip.style.display = 'none';
    document.body.append(this.status, this.legend, this.caption, this.tooltip);
  }

  private syncWindow(): void {
    this.windowCtrl.domElement.style.display = this.state.lifespan === 'window' ? '' : 'none';
  }

  /** Show only the layers the selected plate model has. */
  setModel(m: RiftsModel): void {
    this.ageCtrl.min(m.age_min).max(m.age_max).updateDisplay();
    this.climateCtrl.domElement.style.display = m.climate_model ? '' : 'none';
    this.deformationCtrl.domElement.style.display = m.deformation ? '' : 'none';
    for (const c of this.riftCtrls) c.destroy();
    this.riftCtrls = [];
    for (const p of m.rifts ?? []) {
      if (!(p.id in this.state.rifts)) this.state.rifts[p.id] = p.id === 'syn_rift';
      const c = this.riftFolder.add(this.state.rifts, p.id).name(p.label)
        .onChange((on: boolean) => this.cb.onRift(p.id, on));
      const sw = el('span', 'gui-swatch');
      sw.style.background = p.colour;
      (c.domElement.querySelector('.lil-name') ?? c.domElement.querySelector('.name'))?.prepend(sw);
      this.riftCtrls.push(c);
    }
    this.riftFolder.domElement.style.display = m.rifts?.length ? '' : 'none';
    this.refreshDisplay();
  }

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  /** Make room for the deposit panel on the right. */
  setRightInset(px: number): void {
    this.gui.domElement.style.right = `${px}px`;
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

  /** Legend blocks, top-left: the deposit colouring, then each raster shown. */
  setLegend(blocks: Array<{ title: string; rows?: LegendRow[]; ramp?: { css: string; lo: string; hi: string };
    note?: string }>): void {
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
        const lo = el('span', '');
        lo.textContent = b.ramp.lo;
        const hi = el('span', '');
        hi.textContent = b.ramp.hi;
        ends.append(lo, hi);
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
