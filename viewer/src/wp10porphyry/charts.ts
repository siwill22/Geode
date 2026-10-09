import { ERODED, FATE_COLOUR, FATE_LABEL, FOUND, type Walkers } from './data';
import type { LineColour, WalkFactor } from './types';

/** What the two charts draw: one rung and walk setting. */
export interface ChartsData {
  walkers: Walkers;
  factors: WalkFactor[];
  extentKm: number;
  formationDepthKm: number;
  binsStart: number[];
  binMyr: number;
  curve: { predicted: Array<number | null>; observed: Array<number | null> } | null;
  title: string;
}

export interface ChartsOptions {
  lines: number;
  onlyFound: boolean;
  lineColour: LineColour;
  span: number;
}

export interface ChartsCallbacks {
  /** A line was clicked: that simulated porphyry, at the age under the pointer. */
  onPickWalker(index: number | null, age: number): void;
  /** The age chart was clicked: move the age there. */
  onPickAge(age: number): void;
}

const MARGIN = { left: 46, right: 12, top: 10, bottom: 26 };
const AXIS = '#56606b';
const INK = '#97a3ad';
const CURSOR = 'rgba(230, 235, 240, 0.75)';
const BAR = 'rgba(150, 160, 172, 0.55)';
const PREDICTED = '#e0a100';
const HIT_PX = 6;

/**
 * The Kesler & Wilkinson-style charts, docked right of the map:
 *
 *  (a) depth against time for a sample of simulated porphyries (their 2008 Fig. 1):
 *      age on x, old on the left and today on the right; depth of the top of the body
 *      on y, surface at 0 and deeper downwards; the "within reach" band where the top is
 *      above the surface but the body not yet cut through; lines coloured by fate today,
 *      or, once a rung has one, each 1 Myr segment by the factor tilting the walk then.
 *  (b) the ages of porphyries found today, predicted (line) against the real ones
 *      (bars), per 5 Myr (their Fig. 2).
 *
 * Both share the age axis and carry a cursor at the map's age. The lines are drawn
 * once into an off-screen copy; moving the age or the selection only repaints the
 * cursor and the highlighted line on top of it.
 */
export class ChartsPanel {
  readonly root: HTMLDivElement;
  private readonly depthCanvas: HTMLCanvasElement;
  private readonly agesCanvas: HTMLCanvasElement;
  private readonly depthBase = document.createElement('canvas');
  private readonly agesBase = document.createElement('canvas');
  private readonly depthTitle: HTMLDivElement;
  private readonly depthKey: HTMLDivElement;
  private readonly agesKey: HTMLDivElement;
  private readonly tip: HTMLDivElement;

  private data: ChartsData | null = null;
  private opts: ChartsOptions = { lines: 300, onlyFound: false, lineColour: 'fate', span: 541 };
  private age = 0;
  private selected: number | null = null;
  private hovered: number | null = null;
  /** Indices of the lines drawn, and their screen points (x, y pairs, CSS px). */
  private drawn: number[] = [];
  private paths = new Map<number, Float32Array>();
  private yMax = 6;

  constructor(private readonly cb: ChartsCallbacks) {
    this.root = el('div', 'charts-panel');
    const a = el('div', 'chart-block chart-block-depth');
    this.depthTitle = el('div', 'chart-title');
    this.depthCanvas = el('canvas', 'chart-canvas');
    this.depthKey = el('div', 'chart-key');
    a.append(this.depthTitle, this.depthCanvas, this.depthKey);

    const b = el('div', 'chart-block chart-block-ages');
    const bt = el('div', 'chart-title');
    bt.textContent = 'Ages of porphyries found today';
    this.agesCanvas = el('canvas', 'chart-canvas');
    this.agesKey = el('div', 'chart-key');
    b.append(bt, this.agesCanvas, this.agesKey);

    this.tip = el('div', 'popup');
    this.tip.style.display = 'none';
    this.root.append(a, b);
    document.body.append(this.root, this.tip);

    this.depthCanvas.addEventListener('pointermove', (e) => this.hover(e));
    this.depthCanvas.addEventListener('pointerleave', () => {
      this.hovered = null;
      this.tip.style.display = 'none';
      this.paintDepth();
    });
    this.depthCanvas.addEventListener('click', (e) => {
      const [x, y] = this.local(this.depthCanvas, e);
      // The line highlighted under the pointer is the one picked: lines are dense, and a
      // click's whole-pixel position can land nearer a neighbour than the hover did.
      const i = this.hovered ?? this.nearest(x, y);
      this.cb.onPickWalker(i, this.ageAtX(x, this.depthCanvas));
    });
    this.agesCanvas.addEventListener('click', (e) => {
      const [x] = this.local(this.agesCanvas, e);
      this.cb.onPickAge(Math.round(this.ageAtX(x, this.agesCanvas)));
    });
  }

  get visible(): boolean { return this.root.style.display !== 'none'; }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    if (on) this.redraw();
  }

  get width(): number { return this.visible ? this.root.offsetWidth : 0; }

  setData(d: ChartsData): void {
    this.data = d;
    if (this.selected !== null && this.selected >= d.walkers.n) this.selected = null;
    this.redraw();
  }

  setOptions(o: ChartsOptions): void {
    this.opts = { ...o };
    this.redraw();
  }

  setAge(age: number): void {
    this.age = age;
    this.paintDepth();
    this.paintAges();
  }

  setSelected(i: number | null): void {
    this.selected = i;
    this.paintDepth();
  }

  /** Everything: sizes, the off-screen lines and bars, then the overlays. */
  redraw(): void {
    if (!this.visible || !this.data) return;
    // Text first: the keys' height decides how much room the canvases get.
    this.drawn = this.chooseLines();
    this.updateDepthText();
    this.updateAgesText();
    this.fit(this.depthCanvas, this.depthBase);
    this.fit(this.agesCanvas, this.agesBase);
    this.drawDepthBase();
    this.drawAgesBase();
    this.paintDepth();
    this.paintAges();
  }

  // --- geometry ---------------------------------------------------------------------

  private fit(c: HTMLCanvasElement, base: HTMLCanvasElement): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(50, c.clientWidth);
    const h = Math.max(50, c.clientHeight);
    for (const k of [c, base]) {
      k.width = Math.round(w * dpr);
      k.height = Math.round(h * dpr);
      k.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private size(c: HTMLCanvasElement): { w: number; h: number } {
    return { w: c.clientWidth, h: c.clientHeight };
  }

  private x(age: number, c: HTMLCanvasElement): number {
    const { w } = this.size(c);
    return MARGIN.left + ((this.opts.span - age) / this.opts.span) * (w - MARGIN.left - MARGIN.right);
  }

  private ageAtX(x: number, c: HTMLCanvasElement): number {
    const { w } = this.size(c);
    const f = (x - MARGIN.left) / (w - MARGIN.left - MARGIN.right);
    return Math.max(0, Math.min(this.opts.span, this.opts.span * (1 - f)));
  }

  private yTop(): number { return -(this.data?.extentKm ?? 2) - 0.6; }

  private y(depth: number): number {
    const { h } = this.size(this.depthCanvas);
    const t = (depth - this.yTop()) / (this.yMax - this.yTop());
    return MARGIN.top + t * (h - MARGIN.top - MARGIN.bottom);
  }

  private local(c: HTMLCanvasElement, e: MouseEvent): [number, number] {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Which simulated porphyries the depth chart draws: the first `lines` of the sample
   *  (it is already in random order), or the first `lines` of those found today. */
  private chooseLines(): number[] {
    const w = this.data!.walkers;
    const out: number[] = [];
    for (let i = 0; i < w.n && out.length < this.opts.lines; i++) {
      if (this.opts.onlyFound && w.s.fate[i] !== FOUND) continue;
      out.push(i);
    }
    // Eroded first, then still buried, then found today on top.
    const order = [2, 1, 0];
    out.sort((a, b) => order.indexOf(w.s.fate[a]) - order.indexOf(w.s.fate[b]));
    return out;
  }

  private path(i: number): Float32Array {
    const w = this.data!.walkers;
    const d = w.s.depth_km[i];
    const age0 = w.s.age_ma[i];
    const pts: number[] = [];
    for (let k = 0; k < d.length; k++) {
      const a = age0 - k;
      if (a > this.opts.span) continue;
      pts.push(this.x(Math.max(0, a), this.depthCanvas), this.y(d[k]));
    }
    return Float32Array.from(pts);
  }

  // --- (a) depth against time ----------------------------------------------------------

  private drawDepthBase(): void {
    const d = this.data!;
    const w = d.walkers;
    let deepest = 4;
    for (const i of this.drawn) {
      const ds = w.s.depth_km[i];
      for (let k = 0; k < ds.length; k++) if (w.s.age_ma[i] - k <= this.opts.span && ds[k] > deepest) deepest = ds[k];
    }
    this.yMax = Math.ceil(deepest / 2) * 2;
    this.paths.clear();
    for (const i of this.drawn) this.paths.set(i, this.path(i));

    const c = this.depthBase;
    const ctx = c.getContext('2d')!;
    const { w: W, h: H } = this.size(this.depthCanvas);
    ctx.clearRect(0, 0, W, H);
    const L = MARGIN.left;
    const R = W - MARGIN.right;
    const ext = d.extentKm;

    // "Within reach": the top is at or above the surface and the body is not yet cut
    // through -- found today if it is here at 0 Ma.
    ctx.fillStyle = 'rgba(224, 161, 0, 0.10)';
    ctx.fillRect(L, this.y(-ext), R - L, this.y(0) - this.y(-ext));
    this.yAxis(ctx, W, H);
    this.xAxis(ctx, this.depthCanvas, H);

    const factorMode = this.opts.lineColour === 'factor' && !!w.s.factor;
    ctx.lineWidth = 0.8;
    ctx.lineJoin = 'round';
    for (const i of this.drawn) {
      const p = this.paths.get(i)!;
      if (p.length < 4) continue;
      if (factorMode) {
        // One colour per 1 Myr step: the factor tilting the walk at that moment.
        const f = w.s.factor![i];
        const skip = w.s.depth_km[i].length - p.length / 2;
        for (let k = 0; k + 3 < p.length; k += 2) {
          ctx.strokeStyle = d.factors[f[skip + k / 2]]?.colour ?? '#888';
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(p[k], p[k + 1]);
          ctx.lineTo(p[k + 2], p[k + 3]);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = FATE_COLOUR[w.s.fate[i]];
        ctx.globalAlpha = w.s.fate[i] === FOUND ? 0.9 : 0.4;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
        ctx.stroke();
      }
      // Where an eroded one was cut through: a small tick.
      if (w.s.fate[i] === ERODED && !factorMode) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = FATE_COLOUR[ERODED];
        ctx.fillRect(p[p.length - 2] - 1, p[p.length - 1] - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;

    // Surface and the erosion line on top of the lines, so they stay readable.
    ctx.strokeStyle = '#cfd6dd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, this.y(0));
    ctx.lineTo(R, this.y(0));
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#c8615a';
    ctx.beginPath();
    ctx.moveTo(L, this.y(-ext));
    ctx.lineTo(R, this.y(-ext));
    ctx.stroke();
    ctx.setLineDash([]);
    // Labels at the left, on a dark plate so the lines under them do not hide them.
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    plate(ctx, 'surface', L + 4, this.y(0), '#cfd6dd');
    plate(ctx, 'within reach', L + 4, this.y(-ext / 2), '#e0a100');
    plate(ctx, `eroded through: top ${ext} km above the surface`, L + 4, this.y(-ext), '#d98a82');
  }

  private yAxis(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const L = MARGIN.left;
    ctx.strokeStyle = AXIS;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = this.yMax > 12 ? 4 : 2;
    for (let v = -2; v <= this.yMax; v += v < 0 ? 2 : step) {
      const y = this.y(v);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(W - MARGIN.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(v), L - 5, y);
    }
    ctx.save();
    ctx.translate(11, (MARGIN.top + H - MARGIN.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('depth of the top below the surface (km)', 0, 0);
    ctx.restore();
  }

  private xAxis(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, H: number): void {
    const span = this.opts.span;
    const step = span >= 400 ? 100 : span >= 150 ? 50 : span >= 60 ? 20 : 10;
    ctx.strokeStyle = AXIS;
    ctx.fillStyle = INK;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const yb = H - MARGIN.bottom;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, yb);
    ctx.lineTo(this.x(0, c), yb);
    ctx.stroke();
    for (let a = 0; a <= span; a += step) {
      const x = this.x(a, c);
      ctx.beginPath();
      ctx.moveTo(x, yb);
      ctx.lineTo(x, yb + 3);
      ctx.stroke();
      ctx.fillText(a === 0 ? '0 Ma' : String(a), x, yb + 5);
    }
  }

  private updateDepthText(): void {
    const d = this.data!;
    const w = d.walkers;
    const n = [0, 0, 0];
    for (let i = 0; i < w.n; i++) n[w.s.fate[i]]++;
    const shownN = [0, 0, 0];
    for (const i of this.drawn) shownN[w.s.fate[i]]++;
    this.depthTitle.textContent = `Depth through time, simulated porphyries (${d.title})`;
    const factorMode = this.opts.lineColour === 'factor' && !!w.s.factor;
    const rows = factorMode
      ? d.factors.map((f) => swatch(f.colour, f.label))
      : [0, 1, 2].map((f) => swatch(FATE_COLOUR[f], `${FATE_LABEL[f]}: ${shownN[f]} drawn of ${n[f]}`));
    const note = el('div', 'chart-note');
    note.textContent = `${this.drawn.length} of ${w.n} in the sample drawn`
      + `${this.opts.onlyFound ? ' (found today only)' : ''}. Each forms at about `
      + `${d.formationDepthKm} km and moves up, stays or moves down one step every 1 Myr. Click a line to `
      + 'find that porphyry on the map.'
      + (this.opts.lineColour === 'factor' && !w.s.factor
        ? ' This rung has no factor tilting the walk, so lines are coloured by fate.' : '');
    this.depthKey.replaceChildren(...rows, note);
  }

  /** The lines as drawn, then the selected and hovered line, then the age cursor. */
  private paintDepth(): void {
    if (!this.visible || !this.data) return;
    const c = this.depthCanvas;
    const ctx = c.getContext('2d')!;
    const { w: W, h: H } = this.size(c);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.depthBase, 0, 0, W, H);
    for (const [i, colour, width] of [
      [this.hovered, 'rgba(255,255,255,0.7)', 1.6],
      [this.selected, '#ffffff', 2.4],
    ] as Array<[number | null, string, number]>) {
      if (i === null) continue;
      const p = this.paths.get(i) ?? this.path(i);
      if (p.length < 4) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = width + 2;
      this.stroke(ctx, p);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      this.stroke(ctx, p);
      ctx.fillStyle = FATE_COLOUR[this.data.walkers.s.fate[i]];
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    this.cursor(ctx, c, H);
    if (this.selected !== null && this.data.walkers.exists(this.selected, this.age) && this.age <= this.opts.span) {
      const yy = this.y(this.data.walkers.depthAt(this.selected, this.age));
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.x(this.age, c), yy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private stroke(ctx: CanvasRenderingContext2D, p: Float32Array): void {
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
    ctx.stroke();
  }

  private cursor(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, H: number): void {
    if (this.age > this.opts.span) return;
    const x = this.x(this.age, c);
    ctx.strokeStyle = CURSOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, MARGIN.top);
    ctx.lineTo(x, H - MARGIN.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    const label = `${Math.round(this.age)} Ma`;
    const w = ctx.measureText(label).width;
    const right = x > c.clientWidth - 60;
    plate(ctx, label, right ? x - w - 7 : x + 3, H - MARGIN.bottom - 9, '#e6ebf0');
  }

  private nearest(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = HIT_PX * HIT_PX;
    const candidates = this.selected !== null && !this.paths.has(this.selected)
      ? [...this.drawn, this.selected] : this.drawn;
    for (const i of candidates) {
      const p = this.paths.get(i) ?? this.path(i);
      for (let k = 0; k + 3 < p.length; k += 2) {
        const d = segDist2(x, y, p[k], p[k + 1], p[k + 2], p[k + 3]);
        // Ties go to the later-drawn (found today drawn last, on top).
        if (d <= bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  private hover(e: PointerEvent): void {
    if (!this.data) return;
    const [x, y] = this.local(this.depthCanvas, e);
    const i = this.nearest(x, y);
    if (i !== this.hovered) {
      this.hovered = i;
      this.paintDepth();
    }
    if (i === null) { this.tip.style.display = 'none'; return; }
    const w = this.data.walkers;
    const fate = w.s.fate[i];
    const e2 = w.erodedAt[i];
    this.tip.replaceChildren(
      line(`Simulated porphyry ${i + 1}`, 'popup-title'),
      line(`formed ${w.s.age_ma[i].toFixed(1)} Ma`),
      line(fate === ERODED ? `eroded through at ${e2!.toFixed(0)} Ma`
        : `${FATE_LABEL[fate]}; top ${fmtDepth(w.depthToday(i))} today`),
      line('click to find it on the map', 'popup-dim'),
    );
    this.tip.style.display = '';
    // Left of the pointer when there is no room to its right (the panel is at the edge).
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${e.clientX + 14 + tw > innerWidth - 4 ? e.clientX - 14 - tw : e.clientX + 14}px`;
    this.tip.style.top = `${e.clientY + 14}px`;
  }

  // --- (b) ages found today ------------------------------------------------------------

  private agesScale(): { yMax: number } {
    const c = this.data!.curve;
    let m = 1;
    if (c) {
      this.data!.binsStart.forEach((b, j) => {
        if (b >= this.opts.span) return;
        m = Math.max(m, c.observed[j] ?? 0, c.predicted[j] ?? 0);
      });
    }
    return { yMax: m * 1.08 };
  }

  private drawAgesBase(): void {
    const d = this.data!;
    const c = this.agesBase;
    const ctx = c.getContext('2d')!;
    const { w: W, h: H } = this.size(this.agesCanvas);
    ctx.clearRect(0, 0, W, H);
    const curve = d.curve;
    const { yMax } = this.agesScale();
    const T = MARGIN.top;
    const B = H - MARGIN.bottom;
    const y = (v: number) => B - (v / yMax) * (B - T);
    const step = niceStep(yMax);

    ctx.strokeStyle = AXIS;
    ctx.fillStyle = INK;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= yMax; v += step) {
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y(v));
      ctx.lineTo(W - MARGIN.right, y(v));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(v), MARGIN.left - 5, y(v));
    }
    ctx.save();
    ctx.translate(11, (T + B) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(`porphyries per ${d.binMyr} Myr`, 0, 0);
    ctx.restore();
    this.xAxis(ctx, this.agesCanvas, H);
    if (!curve) return;

    // Real porphyries: bars, one per bin, with a 1 px gap between them.
    ctx.fillStyle = BAR;
    d.binsStart.forEach((b, j) => {
      const v = curve.observed[j] ?? 0;
      if (b >= this.opts.span || v <= 0) return;
      const x0 = this.x(Math.min(this.opts.span, b + d.binMyr), this.agesCanvas);
      const x1 = this.x(b, this.agesCanvas);
      ctx.fillRect(x0 + 0.5, y(v), Math.max(1, x1 - x0 - 1), B - y(v));
    });
    // Predicted: a line through the bin centres.
    ctx.strokeStyle = PREDICTED;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    d.binsStart.forEach((b, j) => {
      const v = curve.predicted[j];
      if (v == null || b >= this.opts.span) return;
      const xx = this.x(Math.min(this.opts.span, b + d.binMyr / 2), this.agesCanvas);
      if (!started) { ctx.moveTo(xx, y(v)); started = true; } else ctx.lineTo(xx, y(v));
    });
    ctx.stroke();
  }

  private updateAgesText(): void {
    const d = this.data!;
    const curve = d.curve;
    if (!curve) { this.agesKey.replaceChildren(); return; }
    const obs = curve.observed.reduce<number>((a, v) => a + (v ?? 0), 0);
    const bar = el('span', 'chart-swatch');
    bar.style.background = BAR;
    const ln = el('span', 'chart-swatch chart-swatch-line');
    ln.style.background = PREDICTED;
    const r1 = el('div', 'chart-key-row');
    r1.append(bar, document.createTextNode(`real porphyries (${obs} dated, 0-541 Ma)`));
    const r2 = el('div', 'chart-key-row');
    r2.append(ln, document.createTextNode('predicted found today, scaled to the same total'));
    const note = el('div', 'chart-note');
    note.textContent = `${d.title}. Predicted from every place and time, not from the sample `
      + 'above. Click to move the map to that age.';
    this.agesKey.replaceChildren(r1, r2, note);
  }

  private paintAges(): void {
    if (!this.visible || !this.data) return;
    const c = this.agesCanvas;
    const ctx = c.getContext('2d')!;
    const { w: W, h: H } = this.size(c);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.agesBase, 0, 0, W, H);
    this.cursor(ctx, c, H);
  }
}

export function fmtDepth(d: number): string {
  if (Math.abs(d) < 0.005) return 'at the surface';
  return d > 0 ? `${d.toFixed(2)} km below the surface` : `${(-d).toFixed(2)} km above the surface`;
}

/** Text on a small dark plate, left-aligned at x, vertically centred on y. */
function plate(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string): void {
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15, 18, 22, 0.85)';
  ctx.fillRect(x - 2, y - 7, w + 4, 13);
  ctx.fillStyle = colour;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function niceStep(max: number): number {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

function swatch(colour: string, label: string): HTMLDivElement {
  const row = el('div', 'chart-key-row');
  const s = el('span', 'chart-swatch chart-swatch-line');
  s.style.background = colour;
  row.append(s, document.createTextNode(label));
  return row;
}

function line(text: string, cls = ''): HTMLDivElement {
  const d = el('div', cls);
  d.textContent = text;
  return d;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
