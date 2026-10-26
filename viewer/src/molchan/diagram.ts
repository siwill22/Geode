/** One deposit on the diagram. */
export interface DiagramPoint {
  /** Index into the deposits file. */
  dep: number;
  share: number;
  name: string;
  age: number;
  /** On the map now: drawn in its map colour; otherwise hollow grey. */
  shown: boolean;
  fill: string;
}

export interface DiagramData {
  title: string;
  rating: string;
  /** RiftsClimate's skill for this type and factor (index.json curves). */
  skill: number;
  /** More skills after the skill line (the new factors' within-period and regional skills). */
  skillExtra?: string;
  points: DiagramPoint[];
  selected: number | null;
  /** Every factor tested on this type, with its skill, for switching factor here; for a
   *  combination, each region set aside with its skill (label, tip; not pickable). */
  factors: Array<{ id: string; skill: number; current: boolean; label?: string; tip?: string; pickable?: boolean;
    /** The new factors: the within-period skill, shown beside the skill; their rows sit under
     *  their own heading (group 'new'). */
    within?: number | null; group?: 'new' }>;
  /** The list's title and note, if not the factors'. */
  listTitle?: string;
  listNote?: string;
  /** The diagram's note, if not the one-factor test's. */
  note?: string;
}

export interface DiagramCallbacks {
  onPickDeposit(dep: number): void;
  onPickFactor(id: string): void;
}

const PAD = { l: 42, r: 12, t: 10, b: 34 };
const CURVE = '#d8dee4';
const AREA = 'rgba(110, 160, 220, 0.22)';
const GRID = 'rgba(200, 210, 220, 0.10)';
const AXIS = 'rgba(200, 210, 220, 0.45)';
const INK = '#97a3ad';
const HOLLOW = 'rgba(150, 156, 164, 0.75)';
const HIT_PX = 8;

/**
 * The Molchan diagram of one factor and deposit type, docked at the right edge of the page,
 * with every factor's skill below it. Each deposit is a dot: across, its share of ground rated
 * higher; up, the share of deposits that would be missed if only ground rated higher than
 * its place were searched. Nothing is computed here but the drawing: the shares are
 * RiftsClimate's, and the skill shown is RiftsClimate's (checked against the dots).
 */
export class MolchanPanel {
  readonly el: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly skillEl: HTMLDivElement;
  private readonly noteEl: HTMLDivElement;
  private readonly factorsEl: HTMLDivElement;
  private readonly listTitleEl: HTMLDivElement;
  private readonly listNoteEl: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private data: DiagramData | null = null;
  private visible = true;
  /** Dots as drawn (css px), for hover and click. */
  private dots: Array<{ x: number; y: number; p: DiagramPoint }> = [];

  constructor(private readonly cb: DiagramCallbacks) {
    this.el = div('charts-panel');
    const block = div('chart-block chart-block-molchan');
    this.titleEl = div('chart-title');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.skillEl = div('molchan-skill');
    this.noteEl = div('chart-note');
    block.append(this.titleEl, this.canvas, this.skillEl, this.noteEl);
    const fblock = div('chart-block');
    this.listTitleEl = div('chart-title');
    this.factorsEl = div('molchan-factors');
    this.listNoteEl = div('chart-note');
    fblock.append(this.listTitleEl, this.factorsEl, this.listNoteEl);
    this.tip = div('popup');
    this.tip.style.display = 'none';
    this.el.append(block, fblock);
    document.body.append(this.el, this.tip);

    this.canvas.addEventListener('pointermove', (ev) => this.hover(ev));
    this.canvas.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; });
    this.canvas.addEventListener('click', (ev) => {
      const d = this.nearest(ev);
      if (d) this.cb.onPickDeposit(d.p.dep);
    });
    addEventListener('resize', () => this.redraw());
  }

  get width(): number { return this.visible ? this.el.offsetWidth : 0; }

  /** More blocks, below the diagram and the list. */
  appendBlocks(blocks: HTMLElement[]): void {
    this.el.append(...blocks);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.el.style.display = on ? '' : 'none';
    this.redraw();
  }

  setData(d: DiagramData): void {
    this.data = d;
    this.titleEl.textContent = d.title;
    // The skill as RiftsClimate computed it, and as the dots give it: they must agree.
    const fromDots = d.points.length ? 0.5 - d.points.reduce((a, p) => a + p.share, 0) / d.points.length : NaN;
    const agree = Math.abs(fromDots - d.skill) < 1e-3;
    this.skillEl.textContent = `Skill ${sign(d.skill)} (${d.points.length} deposits)`
      + (agree ? '' : `: the dots give ${sign(fromDots)}, which does not match. Rebuild the archive.`)
      + (d.skillExtra ? `. ${d.skillExtra}` : '');
    this.skillEl.classList.toggle('molchan-skill-bad', !agree);
    this.listTitleEl.textContent = d.listTitle ?? 'Every factor on this deposit type: skill';
    this.listNoteEl.textContent = d.listNote ?? 'Click a factor to show it. The bar is drawn from 0 (no better '
      + 'than random ground) towards 0.5 (every deposit on the best-rated ground); left of 0, worse than random.';
    this.noteEl.textContent = d.note ?? `${capital(d.rating)}. Across: the share of ground (every place and time slice, `
      + 'weighted by area x duration) rated higher than where the deposit formed, ground rated the same '
      + 'counting half. Up: the share of deposits that would be missed if only ground rated higher than '
      + 'that were searched. Dashed: deposits placed at random on the ground. Skill is the shaded area '
      + 'between the curve and the dashed line, 0.5 minus the mean share. A share is a rank, not a '
      + 'chance that a deposit forms there. Filled dots: deposits on the map now; click one to go to it.';
    const rows: HTMLElement[] = [];
    d.factors.forEach((f, i) => {
      if (f.group === 'new' && d.factors[i - 1]?.group !== 'new') {
        const head = div('molchan-factor-head');
        head.textContent = 'New candidate factors (steps 1-2 only): skill, and within period';
        rows.push(head);
      }
      rows.push(this.factorRow(f));
    });
    this.factorsEl.replaceChildren(...rows);
    this.redraw();
  }

  private factorRow(f: DiagramData['factors'][number]): HTMLElement {
    const pickable = f.pickable ?? true;
    const row = div(`molchan-factor${f.current ? ' molchan-factor-current' : ''}${pickable ? '' : ' molchan-factor-fixed'}`);
    const name = div('molchan-factor-name');
    name.textContent = f.label ?? f.id;
    if (f.tip) row.title = f.tip;
    const track = div('molchan-bar-track');
    const bar = div(`molchan-bar${f.skill < 0 ? ' molchan-bar-neg' : ''}`);
    // Zero in the middle of the track; half the track is a skill of 0.5.
    const w = Math.min(50, Math.abs(f.skill) * 100);
    Object.assign(bar.style, { width: `${w}%`, left: f.skill < 0 ? `${50 - w}%` : '50%' });
    track.appendChild(bar);
    const val = div('molchan-factor-skill');
    val.textContent = sign(f.skill);
    const wp = div('molchan-factor-skill molchan-factor-within');
    wp.textContent = f.within == null ? '' : sign(f.within);
    if (f.within != null) wp.title = 'Within period: each deposit against its own geological period\'s ground only';
    row.append(name, track, val, wp);
    if (pickable) row.addEventListener('click', () => this.cb.onPickFactor(f.id));
    return row;
  }

  redraw(): void {
    if (!this.visible || !this.data) return;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pw = cssW - PAD.l - PAD.r;
    const ph = cssH - PAD.t - PAD.b;
    const X = (v: number) => PAD.l + v * pw;
    const Y = (v: number) => PAD.t + (1 - v) * ph;

    // Grid and axes.
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    for (const g of [0.25, 0.5, 0.75]) {
      ctx.moveTo(X(g), Y(0)); ctx.lineTo(X(g), Y(1));
      ctx.moveTo(X(0), Y(g)); ctx.lineTo(X(1), Y(g));
    }
    ctx.stroke();
    ctx.strokeStyle = AXIS;
    ctx.strokeRect(X(0), Y(1), pw, ph);
    ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const g of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(String(g), X(g), Y(0) + 4);
    ctx.fillText('share of ground rated higher', X(0.5), Y(0) + 17);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const g of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(String(g), X(0) - 5, Y(g));
    ctx.save();
    ctx.translate(11, Y(0.5));
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('share of deposits missed', 0, 0);
    ctx.restore();

    // The curve: starts at (0, 1) and steps down by 1/n at each deposit's share.
    const pts = this.data.points;
    const n = pts.length;
    const curve: Array<[number, number]> = [[0, 1]];
    this.dots = [];
    let y = 1;
    for (const p of pts) {
      curve.push([p.share, y]);
      this.dots.push({ x: X(p.share), y: Y(y - 0.5 / n), p });
      y -= 1 / n;
      curve.push([p.share, y]);
    }
    curve.push([1, Math.max(0, y)]);

    // Shaded: between the curve and the diagonal.
    ctx.beginPath();
    ctx.moveTo(X(0), Y(1));
    for (const [cx, cy] of curve) ctx.lineTo(X(cx), Y(cy));
    ctx.lineTo(X(1), Y(0));
    ctx.lineTo(X(0), Y(1));
    ctx.fillStyle = AREA;
    ctx.fill('evenodd');

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(1));
    ctx.lineTo(X(1), Y(0));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = CURVE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.forEach(([cx, cy], i) => (i ? ctx.lineTo(X(cx), Y(cy)) : ctx.moveTo(X(cx), Y(cy))));
    ctx.stroke();

    // Dots: hollow first, then those on the map, then the selected one on top.
    const order = [...this.dots].sort((a, b) => Number(a.p.shown) - Number(b.p.shown)
      || Number(a.p.dep === this.data!.selected) - Number(b.p.dep === this.data!.selected));
    for (const d of order) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 4, 0, 2 * Math.PI);
      if (d.p.shown) {
        ctx.fillStyle = d.p.fill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0f1216';
        ctx.stroke();
      } else {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = HOLLOW;
        ctx.stroke();
      }
      if (d.p.dep === this.data.selected) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 7, 0, 2 * Math.PI);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
  }

  private nearest(ev: MouseEvent): { x: number; y: number; p: DiagramPoint } | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    let best: { x: number; y: number; p: DiagramPoint } | null = null;
    let bd = HIT_PX;
    for (const d of this.dots) {
      const dd = Math.hypot(d.x - mx, d.y - my);
      if (dd <= bd) { bd = dd; best = d; }
    }
    return best;
  }

  private hover(ev: PointerEvent): void {
    const d = this.nearest(ev);
    this.canvas.style.cursor = d ? 'pointer' : 'crosshair';
    if (!d) { this.tip.style.display = 'none'; return; }
    const lines = [d.p.name || `deposit ${d.p.dep}`, `${d.p.age} Ma`,
      `${(d.p.share * 100).toFixed(1)}% of ground rated higher`];
    this.tip.replaceChildren(...lines.map((t, i) => {
      const e = div(i === 0 ? 'popup-title' : '');
      e.textContent = t;
      return e;
    }));
    this.tip.style.display = '';
    // Left of the pointer: the panel is at the right edge of the window.
    this.tip.style.left = `${ev.clientX - 14 - this.tip.offsetWidth}px`;
    this.tip.style.top = `${ev.clientY + 14}px`;
  }
}

function div(cls: string): HTMLDivElement {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  return e;
}

function sign(v: number): string {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}` : '-';
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
