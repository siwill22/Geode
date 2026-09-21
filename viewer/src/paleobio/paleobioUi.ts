import GUI, { type Controller } from 'lil-gui';
import type { ProjectionMode } from '../core/projection';
import type { PaleobioDataset, PaleobioViewState } from './types';

export interface PaleobioUICallbacks {
  onDataset(id: string): void;
  onGrouping(id: string): void;
  onView(view: 'aggregate' | 'occurrences'): void;
  onAge(age: number): void;
  onTemperature(on: boolean): void;
  onSizeBy(sizeBy: 'total' | 'richness'): void;
  onProjection(mode: ProjectionMode): void;
}

/**
 * The paleobiology panel, deliberately smaller than every other wrapper's.
 *
 * `core/` offers Variable selectors, Vector Fields, Cutaways, No-Data styles, a
 * month slider and Multi-Globe; none of them appear here. That is a choice, not
 * an omission: this viewer answers questions about fossil occurrences, and a
 * control that does not change the answer to one of those is noise. The base
 * raster is fixed per dataset for the same reason -- there is exactly one
 * correct raster under each Reconstruction Model, so offering a choice would
 * only offer a way to be wrong.
 *
 * Seven controls survive that test: which dataset, which Grouping, aggregate vs
 * individual occurrences, what sizes a glyph, the age, the temperature overlay
 * (which exists only where a Model paired with the dataset's own Reconstruction
 * Model has one), and the Projection.
 *
 * Projection earns its place because the two case studies want opposite things:
 * a global Phanerozoic dataset is read as a whole-world pattern, which a globe
 * can only ever show half of, while a regional one is read in place. It changes
 * how the data is viewed, never what is shown (see CONTEXT.md's Projection
 * entry), which is exactly the kind of control that is not noise.
 */
export class PaleobioUI {
  readonly gui: GUI;
  private datasetCtrl: Controller;
  private groupingCtrl: Controller;
  private viewCtrl: Controller;
  private ageCtrl: Controller;
  private tempCtrl: Controller;
  private sizeByCtrl: Controller;
  private projectionCtrl: Controller;

  private status: HTMLDivElement;
  private legend: HTMLDivElement;
  private legendTitle: HTMLDivElement;
  private legendRows: HTMLDivElement;
  private legendNote: HTMLDivElement;
  private caption: HTMLDivElement;
  private popup: HTMLDivElement;
  readonly panels: HTMLDivElement;
  readonly latitudeHost: HTMLDivElement;
  readonly diversityHost: HTMLDivElement;

  constructor(
    private state: PaleobioViewState,
    private cb: PaleobioUICallbacks,
    datasets: PaleobioDataset[],
  ) {
    this.gui = new GUI({ title: 'Paleobiology' });

    const names: Record<string, string> = {};
    for (const d of datasets) names[d.name] = d.id;
    this.datasetCtrl = this.gui.add(state, 'dataset', names).name('Dataset')
      .onChange((id: string) => this.cb.onDataset(id));

    this.groupingCtrl = this.gui.add(state, 'grouping', {}).name('Colour by')
      .onChange((id: string) => this.cb.onGrouping(id));

    this.viewCtrl = this.gui.add(state, 'view',
      { 'Summary cells': 'aggregate', 'Occurrences': 'occurrences' })
      .name('Show')
      .onChange((v: 'aggregate' | 'occurrences') => this.cb.onView(v));

    this.sizeByCtrl = this.gui.add(state, 'sizeBy',
      { 'Occurrences': 'total', 'Genera (richness)': 'richness' })
      .name('Cell size by')
      .onChange((v: 'total' | 'richness') => this.cb.onSizeBy(v));

    this.projectionCtrl = this.gui.add(state, 'projection',
      { Globe: 'globe', Robinson: 'robinson', 'Plate Carrée': 'plateCarree' })
      .name('Projection')
      .onChange((m: ProjectionMode) => this.cb.onProjection(m));

    this.ageCtrl = this.gui.add(state, 'age', 0, 540, 1).name('Age (Ma)')
      .onChange((age: number) => this.cb.onAge(age));

    this.tempCtrl = this.gui.add(state, 'showTemperature').name('Surface temperature')
      .onChange((on: boolean) => this.cb.onTemperature(on));

    this.status = el('div', 'status');
    this.caption = el('div', 'caption');
    this.popup = el('div', 'popup');
    this.popup.style.display = 'none';

    this.legend = el('div', 'legend');
    this.legendTitle = el('div', 'legend-title');
    this.legendRows = el('div', 'legend-rows');
    this.legendNote = el('div', 'legend-note');
    this.legend.append(this.legendTitle, this.legendRows, this.legendNote);

    this.panels = el('div', 'panels');
    this.latitudeHost = el('div', 'panel-host');
    this.diversityHost = el('div', 'panel-host');
    const latTitle = el('div', 'panel-title');
    latTitle.textContent = 'Latitude through time';
    const divTitle = el('div', 'panel-title');
    divTitle.textContent = 'Genus richness, with its sampling proxy';
    this.panels.append(latTitle, this.latitudeHost, divTitle, this.diversityHost);

    document.body.append(this.status, this.caption, this.legend, this.panels, this.popup);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.style.display = text ? '' : 'none';
  }

  setCaption(dataset: PaleobioDataset): void {
    // The counts that qualify everything else on screen. `never_drawable` is
    // 0.1% for panama and 11.6% for corals; a reader comparing them needs the
    // number, not a footnote in a prep log.
    const pct = (n: number) => `${((100 * n) / dataset.occurrences).toFixed(1)}%`;
    this.caption.innerHTML = '';
    const p = el('div', '');
    p.textContent = dataset.caption;
    const q = el('div', 'caption-counts');
    q.textContent = `${dataset.occurrences.toLocaleString()} occurrences · `
      + `${dataset.never_drawable.toLocaleString()} (${pct(dataset.never_drawable)}) never drawable `
      + `at their own age · ${dataset.stage_dropped.toLocaleString()} `
      + `(${pct(dataset.stage_dropped)}) resolve to no single stage, so are absent from the `
      + `panels below · ${dataset.citation}`;
    this.caption.append(p, q);
  }

  setGroupings(dataset: PaleobioDataset, active: string): void {
    const options: Record<string, string> = {};
    for (const g of dataset.groupings) options[g.label] = g.id;
    // Rebuild rather than mutate: lil-gui's OptionController caches its <option>
    // set at construction, so swapping datasets has to replace the controller.
    const parent = this.groupingCtrl.parent;
    this.groupingCtrl.destroy();
    this.groupingCtrl = parent.add(this.state, 'grouping', options).name('Colour by')
      .onChange((id: string) => this.cb.onGrouping(id));
    this.state.grouping = active;
    this.groupingCtrl.updateDisplay();
    this.reorder();
  }

  /** Re-append every controller in a fixed order.
   *
   *  `setGroupings()` has to destroy and rebuild the "Colour by" dropdown
   *  (lil-gui's OptionController caches its <option> set at construction), and a
   *  rebuilt controller lands at the END of the panel. Without this the control
   *  order silently depends on how many times the dataset has been switched. */
  private reorder(): void {
    for (const c of [this.datasetCtrl, this.groupingCtrl, this.viewCtrl,
                     this.sizeByCtrl, this.projectionCtrl, this.ageCtrl, this.tempCtrl]) {
      c.domElement.parentElement?.appendChild(c.domElement);
    }
  }

  setAgeRange(min: number, max: number): void {
    this.ageCtrl.min(min).max(max).updateDisplay();
  }

  setTemperatureAvailable(available: boolean): void {
    this.tempCtrl.domElement.style.display = available ? '' : 'none';
  }

  setSizeByEnabled(enabled: boolean): void {
    this.sizeByCtrl.domElement.style.display = enabled ? '' : 'none';
  }

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  /**
   * Category swatches with live on-screen counts.
   *
   * The counts are what is drawn AT THIS AGE, not what the file contains --
   * a legend reporting the whole dataset while the globe shows one slice of it
   * would describe something the reader cannot see.
   */
  setLegend(
    title: string,
    rows: Array<{ label: string; fill: string; count: number }>,
    note: string | null,
  ): void {
    this.legendTitle.textContent = title;
    this.legendRows.innerHTML = '';
    const total = rows.reduce((a, r) => a + r.count, 0);
    for (const r of rows) {
      const row = el('div', 'legend-row');
      const sw = el('span', 'legend-swatch');
      sw.style.background = r.fill;
      const label = el('span', 'legend-label');
      label.textContent = r.label;
      const n = el('span', 'legend-count');
      n.textContent = r.count ? r.count.toLocaleString() : '—';
      row.append(sw, label, n);
      this.legendRows.append(row);
    }
    const sum = el('div', 'legend-row legend-total');
    sum.textContent = total ? `${total.toLocaleString()} shown` : 'nothing at this age';
    this.legendRows.append(sum);

    this.legendNote.textContent = note ?? '';
    this.legendNote.style.display = note ? '' : 'none';
  }

  showPopup(x: number, y: number, lines: string[]): void {
    this.popup.innerHTML = '';
    for (const line of lines) {
      const d = el('div', '');
      d.textContent = line;
      this.popup.append(d);
    }
    this.popup.style.display = '';
    this.popup.style.left = `${x + 14}px`;
    this.popup.style.top = `${y + 14}px`;
  }

  hidePopup(): void {
    this.popup.style.display = 'none';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
