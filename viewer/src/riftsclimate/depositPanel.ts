import type {
  DepositPoint, DepositValues, FieldCatalogue, FieldDef, FieldDistribution,
} from './types';

/**
 * The clicked deposit's panel: who it is, then every value the analysis holds
 * for it, section by section, each shown against the spread of that value over
 * the other deposits.
 *
 * The reference sets are always the same two: the deposit's own class, and all
 * deposits. The histograms are the ones RiftsClimate precomputed
 * (`fields.json`), so the bars are the analysis's own; the percentiles are
 * counted here from the same values the page loaded (`values.json`), which is
 * exact and cheap for ~1400 deposits.
 *
 * Built once per click, lazily: a section's rows are only drawn when it is
 * opened, because with every rift definition, window and random-place set
 * there are several hundred values and most readers open two sections.
 */

export interface PanelInfo {
  point: DepositPoint;
  modelLabel: string;
  age: number;
  drawnNow: boolean;
  /** Plain-language reason it is not drawn now, or ''. */
  notDrawnReason: string;
}

export interface PanelDeps {
  catalogue: FieldCatalogue;
  values: DepositValues;
  classColour(cls: string): string;
  classLabel(cls: string): string;
  onClose(): void;
}

const HIST_W = 132;
const HIST_H = 26;

/** Sections open on first show; the reader's own open/close choices are kept
 *  from one click to the next after that. */
const OPEN_BY_DEFAULT = new Set([
  'Where it formed', 'Rift association', 'Formation climate (best age)',
]);

export class DepositPanel {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private header: HTMLDivElement;
  private search: HTMLInputElement;
  private readonly rowOf = new Map<string, number>();
  private readonly classOfRow: string[] = [];
  private readonly sorted = new Map<string, { all: Float64Array; byClass: Map<string, Float64Array> }>();
  private readonly byKey = new Map<string, FieldDef>();
  private readonly children = new Map<string, FieldDef[]>();
  private readonly openState = new Map<string, boolean>();
  private current: PanelInfo | null = null;

  constructor(private readonly deps: PanelDeps) {
    deps.values.ids.forEach((id, i) => {
      this.rowOf.set(id, i);
      this.classOfRow.push(deps.values.classes[i] ?? '');
    });
    for (const f of deps.catalogue.fields) {
      this.byKey.set(f.key, f);
      if (f.parent) {
        const list = this.children.get(f.parent) ?? [];
        list.push(f);
        this.children.set(f.parent, list);
      }
    }

    this.root = el('div', 'deposit-panel');
    this.root.style.display = 'none';
    const close = el('button', 'dp-close');
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', () => { this.hide(); deps.onClose(); });
    this.header = el('div', 'dp-header');
    this.search = el('input', 'dp-search');
    this.search.type = 'search';
    this.search.placeholder = 'Find a value (e.g. rainfall, syn-rift, explored)';
    this.search.addEventListener('input', () => this.rebuildBody());
    const key = el('div', 'dp-key');
    key.innerHTML = '<span class="dp-key-all"></span> all deposits '
      + '<span class="dp-key-cls"></span> this class '
      + '<span class="dp-key-mark"></span> this deposit '
      + '<span class="dp-key-note">(each set of bars scaled to its own tallest)</span>';
    this.body = el('div', 'dp-body');
    this.root.append(close, this.header, this.search, key, this.body);
    document.body.appendChild(this.root);
  }

  get visible(): boolean { return this.root.style.display !== 'none'; }

  hide(): void {
    this.root.style.display = 'none';
    this.current = null;
  }

  /** Refresh only the "drawn at this age" line -- the slider moves while a
   *  deposit is open, and the values themselves never depend on the age. */
  updateStatus(info: Pick<PanelInfo, 'age' | 'drawnNow' | 'notDrawnReason' | 'modelLabel'>): void {
    if (!this.current) return;
    Object.assign(this.current, info);
    this.renderHeader();
  }

  private shownModel: string | null = null;

  show(info: PanelInfo): void {
    const modelChanged = this.shownModel !== info.modelLabel;
    this.shownModel = info.modelLabel;
    this.current = info;
    if (modelChanged) {
      // The rift values of the model on screen open first.
      for (const k of [...this.openState.keys()]) if (k.startsWith('sub:')) this.openState.delete(k);
    }
    this.root.style.display = '';
    this.renderHeader();
    this.rebuildBody();
  }

  private renderHeader(): void {
    const info = this.current!;
    const p = info.point;
    this.header.replaceChildren();
    const title = el('div', 'dp-title');
    title.textContent = p.name || p.deposit_id;
    const cls = el('div', 'dp-class');
    const sw = el('span', 'dp-swatch');
    sw.style.background = this.deps.classColour(p.type);
    cls.append(sw, document.createTextNode(`${this.deps.classLabel(p.type)} (${p.type})`));
    const age = el('div', 'dp-line');
    const unc = p.age_uncertainty_ma != null && p.age_uncertainty_ma > 0
      ? ` ± ${fmt(p.age_uncertainty_ma)}` : ' (no stated uncertainty)';
    age.textContent = `Formed ${p.age != null ? fmt(p.age) : '?'}${unc} Ma`;
    const pos = el('div', 'dp-line');
    pos.textContent = `Today at ${lonLat(p.lon, p.lat)}`;
    const plate = el('div', 'dp-line dp-dim');
    plate.textContent = p.plate_id
      ? `${info.modelLabel}: plate ${p.plate_id}`
        + (p.plate_begin_age != null ? `, its continent polygon reaches back to ${fmt(p.plate_begin_age)} Ma` : '')
      : `${info.modelLabel}: on no plate (outside every continent polygon)`;
    const now = el('div', info.drawnNow ? 'dp-line dp-ok' : 'dp-line dp-warn');
    now.textContent = info.drawnNow
      ? `Drawn at ${fmt(info.age)} Ma`
      : `Not drawn at ${fmt(info.age)} Ma: ${info.notDrawnReason}`;
    const id = el('div', 'dp-line dp-dim');
    id.textContent = p.deposit_id;
    this.header.append(title, cls, age, pos, plate, now, id);
  }

  private rebuildBody(): void {
    const info = this.current;
    if (!info) return;
    const q = this.search.value.trim().toLowerCase();
    this.body.replaceChildren();
    const row = this.rowOf.get(info.point.deposit_id);
    if (row === undefined) {
      this.body.textContent = 'No values for this deposit in values.json.';
      return;
    }
    const { catalogue } = this.deps;
    for (const section of catalogue.sections) {
      let fields = catalogue.fields.filter((f) => f.group === section);
      if (q) fields = fields.filter((f) => matches(f, q, this.children.get(f.key)));
      else fields = fields.filter((f) => !f.parent || !this.byKey.has(f.parent));
      if (!fields.length) continue;

      const det = this.details(`sec:${section}`, section, OPEN_BY_DEFAULT.has(section),
        `${fields.length}`, !!q);
      this.body.appendChild(det.root);
      const fill = () => {
        const subs = new Map<string, FieldDef[]>();
        for (const f of fields) {
          const s = f.subgroup ?? '';
          subs.set(s, [...(subs.get(s) ?? []), f]);
        }
        for (const [sub, list] of subs) {
          let host: HTMLElement = det.content;
          if (sub) {
            const open = sub.includes(`(${info.modelLabel})`);
            const inner = this.details(`sub:${section}:${sub}`, sub, open, `${list.length}`, !!q);
            inner.root.classList.add('dp-sub');
            det.content.appendChild(inner.root);
            host = inner.content;
            const draw = () => { for (const f of list) host.appendChild(this.fieldRow(f, row, sub, !!q)); };
            if (inner.isOpen()) draw(); else inner.onFirstOpen(draw);
            continue;
          }
          for (const f of list) host.appendChild(this.fieldRow(f, row, '', !!q));
        }
      };
      if (det.isOpen()) fill(); else det.onFirstOpen(fill);
    }
  }

  private details(id: string, title: string, openDefault: boolean, badge: string, force = false) {
    const root = el('details', 'dp-section');
    const open = force || (this.openState.get(id) ?? openDefault);
    root.open = open;
    const summary = el('summary', '');
    summary.textContent = title;
    const b = el('span', 'dp-badge');
    b.textContent = badge;
    summary.appendChild(b);
    const content = el('div', 'dp-content');
    root.append(summary, content);
    let pending: (() => void) | null = null;
    root.addEventListener('toggle', () => {
      this.openState.set(id, root.open);
      if (root.open && pending) { const f = pending; pending = null; f(); }
    });
    return {
      root, content,
      isOpen: () => root.open,
      onFirstOpen: (f: () => void) => { pending = f; },
    };
  }

  private fieldRow(f: FieldDef, row: number, subgroup: string, flat: boolean): HTMLElement {
    const wrap = el('div', f.parent ? 'dp-row dp-child' : 'dp-row');
    const v = this.deps.values.columns[f.key]?.[row] ?? null;
    const cls = this.classOfRow[row];

    const label = el('div', 'dp-label');
    label.textContent = shortLabel(f.label, subgroup);
    label.title = f.about || f.label;
    const value = el('div', 'dp-value');
    value.textContent = formatValue(v, f);
    if (v === null) value.classList.add('dp-missing');

    const top = el('div', 'dp-row-top');
    top.append(label, value);
    wrap.appendChild(top);

    const bottom = el('div', 'dp-row-bottom');
    const canvas = el('canvas', 'dp-hist');
    drawHistogram(canvas, f.dist, cls, v, this.deps.classColour(cls));
    bottom.appendChild(canvas);
    const pct = el('div', 'dp-pct');
    if (v !== null) {
      const inClass = this.percentile(f, v, cls);
      const inAll = this.percentile(f, v, null);
      pct.innerHTML = '';
      pct.append(
        line(`${ordinal(inClass.pct)} percentile in class`, `of ${inClass.n.toLocaleString()} ${cls} with a value`),
        line(`${ordinal(inAll.pct)} in all`, `of ${inAll.n.toLocaleString()} deposits with a value`),
      );
    } else {
      pct.append(line('no value for this deposit',
        `${f.dist.n_class[cls] ?? 0} of this class and ${f.dist.n} of all deposits have one`));
    }
    const test = f.class_test?.[cls];
    if (test && test.mean_rank != null) {
      pct.append(line(
        `${cls} as a class: mean ${fmt(test.mean_rank)}`
        + (test.p_closer != null ? `, p = ${fmtP(test.p_closer)}` : ''),
        'The whole class against its own random places: mean share of random places closer '
        + '(0.5 = no different from random), and the chance of a mean this low if deposits sat '
        + 'where random places do.'));
    }
    bottom.appendChild(pct);
    wrap.appendChild(bottom);

    const kids = !flat ? this.children.get(f.key) : undefined;
    if (kids?.length) {
      const inline = el('div', 'dp-inline');
      const ranks = kids.filter((k) => k.key.includes('|rank_'));
      for (const k of ranks) {
        const kv = this.deps.values.columns[k.key]?.[row] ?? null;
        const s = el('span', '');
        s.textContent = `${shortLabel(k.label, subgroup).replace(/^.*share of random places at its age that are closer/, 'random places closer')}: ${formatValue(kv, k)}`;
        s.title = k.about;
        inline.appendChild(s);
      }
      const more = el('button', 'dp-more');
      more.textContent = `compared with random places (${kids.length}) ▸`;
      const box = el('div', 'dp-kids');
      box.style.display = 'none';
      more.addEventListener('click', () => {
        const opening = box.style.display === 'none';
        if (opening && !box.childElementCount) {
          for (const k of kids) box.appendChild(this.fieldRow(k, row, subgroup, true));
        }
        box.style.display = opening ? '' : 'none';
        more.textContent = `compared with random places (${kids.length}) ${opening ? '▾' : '▸'}`;
      });
      if (ranks.length) wrap.appendChild(inline);
      wrap.append(more, box);
    }
    return wrap;
  }

  /** Mid-rank percentile: the share of deposits with a lower value, ties
   *  counted half, over the deposits that have a value at all. */
  private percentile(f: FieldDef, v: number, cls: string | null): { pct: number; n: number } {
    let s = this.sorted.get(f.key);
    if (!s) {
      const col = this.deps.values.columns[f.key] ?? [];
      const all: number[] = [];
      const by = new Map<string, number[]>();
      col.forEach((x, i) => {
        if (x === null || !Number.isFinite(x)) return;
        all.push(x);
        const c = this.classOfRow[i];
        by.set(c, [...(by.get(c) ?? []), x]);
      });
      s = {
        all: Float64Array.from(all).sort(),
        byClass: new Map([...by].map(([c, a]) => [c, Float64Array.from(a).sort()])),
      };
      this.sorted.set(f.key, s);
    }
    const arr = cls === null ? s.all : (s.byClass.get(cls) ?? new Float64Array());
    if (!arr.length) return { pct: NaN, n: 0 };
    const below = lowerBound(arr, v);
    const upTo = upperBound(arr, v);
    return { pct: (100 * (below + 0.5 * (upTo - below))) / arr.length, n: arr.length };
  }
}

// --- drawing -----------------------------------------------------------------

function drawHistogram(
  canvas: HTMLCanvasElement, d: FieldDistribution, cls: string, v: number | null, colour: string,
): void {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = HIST_W * dpr;
  canvas.height = HIST_H * dpr;
  canvas.style.width = `${HIST_W}px`;
  canvas.style.height = `${HIST_H}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const n = d.all.length;
  if (!n) return;
  const lo = d.edges[0];
  const hi = d.edges[d.edges.length - 1];
  const x = (val: number) => ((val - lo) / (hi - lo || 1)) * HIST_W;
  const bw = HIST_W / n;
  const maxAll = Math.max(1, ...d.all);
  const own = d.by_class[cls] ?? [];
  const maxOwn = Math.max(1, ...own);
  const h = HIST_H - 3;

  ctx.fillStyle = 'rgba(150, 158, 168, 0.45)';
  for (let i = 0; i < n; i++) {
    const bh = (d.all[i] / maxAll) * h;
    if (bh > 0) ctx.fillRect(i * bw, HIST_H - bh, Math.max(1, bw - 0.5), bh);
  }
  ctx.fillStyle = colour;
  for (let i = 0; i < n; i++) {
    const bh = ((own[i] ?? 0) / maxOwn) * h;
    if (bh > 0) ctx.fillRect(i * bw + bw * 0.22, HIST_H - bh, Math.max(1, bw * 0.56), bh);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, HIST_H - 1, HIST_W, 1);
  if (v !== null && Number.isFinite(v)) {
    const mx = Math.max(1, Math.min(HIST_W - 1, x(v)));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mx - 0.75, 0, 1.5, HIST_H);
    ctx.beginPath();
    ctx.moveTo(mx - 3.5, 0);
    ctx.lineTo(mx + 3.5, 0);
    ctx.lineTo(mx, 4);
    ctx.fill();
  }
}

// --- helpers -----------------------------------------------------------------

function matches(f: FieldDef, q: string, kids?: FieldDef[]): boolean {
  const hay = `${f.label} ${f.group} ${f.subgroup ?? ''} ${f.about}`.toLowerCase();
  return hay.includes(q) || !!kids?.some((k) => k.label.toLowerCase().includes(q));
}

function shortLabel(label: string, subgroup: string): string {
  return subgroup && label.startsWith(`${subgroup}: `) ? label.slice(subgroup.length + 2) : label;
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x).toLocaleString();
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  if (a === 0) return '0';
  if (a >= 0.001) return x.toPrecision(2);
  return x.toExponential(1);
}

function fmtP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toPrecision(2);
}

function formatValue(v: number | null, f: FieldDef): string {
  if (v === null) return 'no value';
  if (f.kind === 'bool') return v ? 'yes' : 'no';
  if (f.unit === 'share') return `${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%`;
  const unit = f.unit && f.unit !== 'count' ? (f.unit === '°' ? '°' : ` ${f.unit}`) : '';
  return `${fmt(v)}${unit}`;
}

function ordinal(p: number): string {
  if (!Number.isFinite(p)) return '—';
  const n = Math.round(p);
  const s = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

function lonLat(lon: number, lat: number): string {
  return `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}, ${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
}

function lowerBound(a: Float64Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

function upperBound(a: Float64Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

function line(text: string, title: string): HTMLDivElement {
  const d = el('div', '');
  d.textContent = text;
  d.title = title;
  return d;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
