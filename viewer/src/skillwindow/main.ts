import {
  cellWeights, factorTest, inWindow, ref95, type FactorResult, type WindowDeposits, type WindowGround,
} from './compute';
import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';

/**
 * RiftsClimate's step 1 (the plain Molchan test, one factor at a time, its direction stated in
 * advance) in any time window the reader picks: every factor's skill, its Molchan diagram, and
 * its skill through time in a moving window. For reading the strength of each relationship by
 * eye; nothing here is fitted or chosen. The numbers are computed in the page from the ranks
 * RiftsClimate wrote (prep/geode_window_export.py there), and checked against RiftsClimate's
 * own in a set of windows (scripts/check_skillwindow.mjs).
 */

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;
const BASE = `${ARCHIVE}/riftsclimate/window`;
/** The archive format this page reads (prep_riftsclimate_window.py FORMAT). */
const FORMAT = 1;
const TYPE_LABEL: Record<string, string> = {
  Kimberlite: 'Kimberlites (Tappe et al. 2018)', Carbonatite: 'Carbonatites (Humphreys-Williams & Zahirovic 2021)',
  'PbZn-CD': 'SEDEX', 'PbZn-MVT': 'MVT', 'Cu-sed': 'Sediment-hosted Cu', VMS: 'VMS', 'Cu-por': 'Porphyry Cu',
};
const PRESETS: [number, number][] = [[0, 1000], [0, 541], [0, 200], [200, 541], [541, 1000]];
/** The bars: half the track is this much skill. */
const BAR_HALF = 0.4;
/** Moving windows with fewer deposits than this are left out of the chart. */
const MIN_DEPOSITS = 5;
const POS = '#6ea0dc';
const NEG = '#c8615a';
const INK = '#97a3ad';
const AXIS = 'rgba(200, 210, 220, 0.35)';
const BAND = 'rgba(200, 210, 220, 0.13)';

interface Factor { id: string; group: string; better: string; stated: boolean }
interface Index {
  format: number; span_ma: number; cells: number; factors: Factor[]; ground_file: string;
  types: Record<string, { deposits: number; districts: number; deposits_file: string; expected_file: string }>;
  windows: [number, number][];
  built_from: { riftsclimate_commit: string | null; script_state: string; data_written: string };
}
interface DepositsFile extends WindowDeposits { type: string; id: string[]; name: string[]; age_ma: number[]; lon: number[]; lat: number[] }

const state = {
  type: 'Kimberlite', young: 0, old: 1000, factor: '', sort: 'group' as 'group' | 'skill',
  reversed: new Set<string>(), moving: 100,
};

let index: Index;
let ground: WindowGround;
let deps: DepositsFile;
let results = new Map<string, FactorResult>();
let whole = new Map<string, FactorResult>();

// --- loading ----------------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  if (!(raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b)) return raw.buffer;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function load(): Promise<void> {
  index = await fetchMaybeGzippedJSON(`${BASE}/index.json`) as Index;
  if (index.format !== FORMAT) {
    throw new Error(`The archive is format ${index.format}; this page reads format ${FORMAT}. `
      + 'Rerun prep/prep_riftsclimate_window.py.');
  }
  const buf = await fetchBytes(`${BASE}/${index.ground_file}`);
  const n = index.cells;
  const f32 = (k: number) => new Float32Array(buf, k * 4 * n, n);
  const ranks = index.factors.map((_, k) => new Uint32Array(buf, (3 + k) * 4 * n, n));
  ground = { from: f32(0), to: f32(1), area: f32(2), ranks, maxRank: ranks.map((r) => r.reduce((a, b) => Math.max(a, b), 0)) };
  if (!(state.type in index.types)) state.type = Object.keys(index.types)[0];
  await loadType();
}

async function loadType(): Promise<void> {
  deps = await fetchMaybeGzippedJSON(`${BASE}/${index.types[state.type].deposits_file}`) as DepositsFile;
  deps.age = deps.age_ma;
  whole = computeAll(0, index.span_ma);
}

// --- the tests ----------------------------------------------------------------------------------

function computeAll(young: number, old: number): Map<string, FactorResult> {
  const w = cellWeights(ground, young, old);
  const out = new Map<string, FactorResult>();
  index.factors.forEach((f, k) => out.set(f.id, factorTest(ground, k, w, deps, f.id, young, old, index.span_ma)));
  return out;
}

/** The skill as shown: reversed factors have the opposite sign (and shares 1 - share). */
function shown(id: string, r: FactorResult | undefined): number | null {
  if (!r || r.skill == null) return null;
  return state.reversed.has(id) ? -r.skill : r.skill;
}

function betterText(f: Factor): string {
  if (!state.reversed.has(f.id)) return f.better;
  return `reversed: the opposite of "${f.better}"`;
}

// --- page -----------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function fmt(v: number | null): string {
  return v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`;
}

function setupControls(): void {
  const sel = $<HTMLSelectElement>('type');
  for (const t of Object.keys(index.types)) {
    const o = el('option', '', TYPE_LABEL[t] ?? t);
    o.value = t;
    sel.append(o);
  }
  sel.value = state.type;
  sel.addEventListener('change', async () => { state.type = sel.value; await loadType(); update(); });

  const young = $<HTMLInputElement>('young');
  const old = $<HTMLInputElement>('old');
  const commit = () => {
    let a = Number(young.value);
    let b = Number(old.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { update(); return; }
    if (a > b) [a, b] = [b, a];
    setWindow(a, b);
  };
  for (const inp of [young, old]) {
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  }
  const presets = $('presets');
  for (const [a, b] of PRESETS) {
    const btn = el('button', 'btn', `${a}-${b} Ma`);
    btn.addEventListener('click', () => setWindow(a, b));
    presets.append(btn);
  }
  for (const s of ['group', 'skill'] as const) {
    const btn = $<HTMLButtonElement>(`sort-${s}`);
    btn.addEventListener('click', () => { state.sort = s; renderList(); });
  }
  $('reverse').addEventListener('click', () => {
    if (state.reversed.has(state.factor)) state.reversed.delete(state.factor); else state.reversed.add(state.factor);
    renderList();
    renderDetail();
    writeHash();
  });
  const moving = $<HTMLInputElement>('moving');
  moving.value = String(state.moving);
  moving.addEventListener('change', () => {
    const v = Math.round(Number(moving.value) / 10) * 10;
    state.moving = Math.min(index.span_ma, Math.max(10, Number.isFinite(v) ? v : 100));
    moving.value = String(state.moving);
    renderThroughTime();
    writeHash();
  });
  wireWindowChart();
  addEventListener('resize', () => { drawAges(); renderDetail(); });
}

function setWindow(young: number, old: number): void {
  const span = index.span_ma;
  young = Math.max(0, Math.min(span, Math.round(young * 10) / 10));
  old = Math.max(0, Math.min(span, Math.round(old * 10) / 10));
  if (old - young < 1) old = Math.min(span, young + 1);
  if (old - young < 1) young = old - 1;
  state.young = young;
  state.old = old;
  update();
}

let pending = 0;
/** Recompute every factor for the window (once per frame while dragging). */
function update(): void {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    results = computeAll(state.young, state.old);
    $<HTMLInputElement>('young').value = String(state.young);
    $<HTMLInputElement>('old').value = String(state.old);
    drawAges();
    renderCounts();
    renderList();
    renderDetail();
    writeHash();
  });
}

function renderCounts(): void {
  const all = deps.age.filter((a) => inWindow(a, state.young, state.old, index.span_ma)).length;
  const r = results.get(state.factor) ?? [...results.values()][0];
  const w = cellWeights(ground, state.young, state.old);
  const wAll = cellWeights(ground, 0, index.span_ma);
  let a = 0;
  let b = 0;
  for (let i = 0; i < w.length; i++) { a += w[i]; b += wAll[i]; }
  $('counts').textContent = `${all} of ${deps.age.length} ${TYPE_LABEL[state.type] ?? state.type} in ${state.young}-${state.old} Ma`
    + ` (${r.districts} districts); ${(100 * a / b).toFixed(0)}% of the record's continental area x time. `
    + `5% level: ${ref95(r.districts).toFixed(3)} counting districts, ${ref95(r.deposits).toFixed(3)} counting deposits.`;
}

// --- the factor list --------------------------------------------------------------------------

function renderList(): void {
  const list = $('factors');
  const rows: HTMLElement[] = [];
  let factors = [...index.factors];
  if (state.sort === 'skill') {
    factors.sort((a, b) => (shown(b.id, results.get(b.id)) ?? -9) - (shown(a.id, results.get(a.id)) ?? -9));
  } else {
    const groups = [...new Set(index.factors.map((f) => f.group))];
    factors = groups.flatMap((g) => index.factors.filter((f) => f.group === g));
  }
  let lastGroup = '';
  for (const f of factors) {
    if (state.sort === 'group' && f.group !== lastGroup) {
      rows.push(el('div', 'group-head', f.group));
      lastGroup = f.group;
    }
    rows.push(factorRow(f));
  }
  list.replaceChildren(...rows);
  $<HTMLButtonElement>('sort-group').classList.toggle('btn-on', state.sort === 'group');
  $<HTMLButtonElement>('sort-skill').classList.toggle('btn-on', state.sort === 'skill');
}

function factorRow(f: Factor): HTMLElement {
  const r = results.get(f.id);
  const s = shown(f.id, r);
  const full = shown(f.id, whole.get(f.id));
  const row = el('div', `factor${f.id === state.factor ? ' factor-on' : ''}`);
  const name = el('div', 'factor-name');
  name.append(el('span', '', f.id));
  name.append(el('span', 'factor-better', ` ${betterText(f)}${f.stated ? '' : ' (no direction stated in advance)'}`));
  const track = el('div', 'track');
  const pct = (v: number) => 50 + Math.max(-50, Math.min(50, v / BAR_HALF * 50));
  if (r && r.districts) {
    const ref = ref95(r.districts);
    const band = el('div', 'track-band');
    Object.assign(band.style, { left: `${pct(-ref)}%`, width: `${pct(ref) - pct(-ref)}%` });
    track.append(band);
  }
  if (s != null) {
    const bar = el('div', 'bar');
    Object.assign(bar.style, { left: `${Math.min(50, pct(s))}%`, width: `${Math.abs(pct(s) - 50)}%`, background: s < 0 ? NEG : POS });
    track.append(bar);
  }
  if (full != null) {
    const tick = el('div', 'track-whole');
    tick.style.left = `${pct(full)}%`;
    track.append(tick);
  }
  const val = el('div', 'factor-skill', fmt(s));
  const n = el('div', 'factor-n', r ? `${r.deposits} / ${r.districts}` : '');
  row.title = `${f.id}: ${betterText(f)}. Skill ${fmt(s)} in ${state.young}-${state.old} Ma `
    + `(${r?.deposits ?? 0} deposits, ${r?.districts ?? 0} districts; 5% level ${ref95(r?.districts ?? 0).toFixed(3)} `
    + `counting districts); 0-${index.span_ma} Ma ${fmt(full)}.`;
  row.addEventListener('click', () => { state.factor = f.id; renderList(); renderDetail(); writeHash(); });
  row.append(name, track, val, n);
  return row;
}

// --- the chosen factor: Molchan diagram and skill through time --------------------------------

function renderDetail(): void {
  const f = index.factors.find((x) => x.id === state.factor)!;
  const r = results.get(f.id)!;
  const s = shown(f.id, r);
  $('detail-title').textContent = f.id;
  $('detail-better').textContent = `${betterText(f)}${f.stated ? ' (direction stated in advance)' : ' (no direction stated in advance: shown this way by default)'}`;
  $('reverse').textContent = state.reversed.has(f.id) ? 'Back to the stated direction' : 'Reverse the direction';
  $('detail-skill').textContent = `Skill ${fmt(s)} in ${state.young}-${state.old} Ma; ${r.deposits} deposits, ${r.districts} districts; `
    + `5% level ${ref95(r.districts).toFixed(3)} counting districts, ${ref95(r.deposits).toFixed(3)} counting deposits. `
    + `0-${index.span_ma} Ma: ${fmt(shown(f.id, whole.get(f.id)))}.`;
  drawMolchan(r, state.reversed.has(f.id));
  renderThroughTime();
}

function canvasCtx(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const w = c.clientWidth;
  const h = c.clientHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  return { ctx, w, h };
}

function drawMolchan(r: FactorResult, reversed: boolean): void {
  const { ctx, w, h } = canvasCtx($<HTMLCanvasElement>('molchan'));
  const L = 40; const R = 10; const T = 8; const B = 30;
  const X = (v: number) => L + v * (w - L - R);
  const Y = (v: number) => T + (1 - v) * (h - T - B);
  ctx.strokeStyle = AXIS;
  ctx.strokeRect(X(0), Y(1), X(1) - X(0), Y(0) - Y(1));
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(1)); ctx.lineTo(X(1), Y(0)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(String(v), X(v), Y(0) + 4);
  ctx.fillText('share of the window\'s ground rated higher', X(0.5), Y(0) + 16);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of [0, 0.5, 1]) ctx.fillText(String(v), X(0) - 4, Y(v));
  ctx.save();
  ctx.translate(10, Y(0.5)); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('share of deposits missed', 0, 0);
  ctx.restore();
  const n = r.shares.length;
  if (!n || r.skill == null) return;
  const s = Array.from(r.shares, (v) => (reversed ? 1 - v : v)).sort((a, b) => a - b);
  // the curve: after searching ground up to share s[i], the deposits above it are missed
  ctx.beginPath();
  ctx.moveTo(X(0), Y(1));
  s.forEach((v, i) => { ctx.lineTo(X(v), Y(1 - i / n)); ctx.lineTo(X(v), Y(1 - (i + 1) / n)); });
  ctx.lineTo(X(1), Y(0));
  ctx.lineTo(X(0), Y(1));
  ctx.fillStyle = (reversed ? -r.skill : r.skill) >= 0 ? 'rgba(110, 160, 220, 0.25)' : 'rgba(200, 97, 90, 0.25)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(0), Y(1));
  s.forEach((v, i) => { ctx.lineTo(X(v), Y(1 - i / n)); ctx.lineTo(X(v), Y(1 - (i + 1) / n)); });
  ctx.strokeStyle = (reversed ? -r.skill : r.skill) >= 0 ? POS : NEG;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineWidth = 1;
}

interface MovingPoint { young: number; old: number; skill: number | null; deposits: number; districts: number }
let moving: MovingPoint[] = [];

function renderThroughTime(): void {
  const f = index.factors.find((x) => x.id === state.factor)!;
  const k = index.factors.indexOf(f);
  const width = state.moving;
  moving = [];
  for (let a = 0; a + width <= index.span_ma + 1e-9; a += 10) {
    const w = cellWeights(ground, a, a + width);
    const r = factorTest(ground, k, w, deps, f.id, a, a + width, index.span_ma);
    moving.push({ young: a, old: a + width, skill: shown(f.id, r), deposits: r.deposits, districts: r.districts });
  }
  drawThroughTime(-1);
}

function drawThroughTime(hover: number): void {
  const c = $<HTMLCanvasElement>('through');
  const { ctx, w, h } = canvasCtx(c);
  const L = 50; const R = 10; const T = 8; const B = 30;
  const span = index.span_ma;
  const X = (v: number) => L + v / span * (w - L - R);
  const vals = moving.filter((p) => p.skill != null && p.deposits >= MIN_DEPOSITS);
  const hi = Math.max(0.3, ...vals.map((p) => Math.abs(p.skill!) + 0.02), ...vals.map((p) => ref95(p.districts)));
  const lim = Math.ceil(hi * 10) / 10;
  const Y = (v: number) => T + (lim - v) / (2 * lim) * (h - T - B);
  // the chosen window
  ctx.fillStyle = 'rgba(255, 176, 32, 0.10)';
  ctx.fillRect(X(state.young), T, X(state.old) - X(state.young), h - T - B);
  // the 5% band (districts), per moving window
  ctx.fillStyle = BAND;
  ctx.beginPath();
  let started = false;
  const band = vals.map((p) => [X((p.young + p.old) / 2), ref95(p.districts)] as const);
  band.forEach(([x, r]) => { if (!started) { ctx.moveTo(x, Y(r)); started = true; } else ctx.lineTo(x, Y(r)); });
  [...band].reverse().forEach(([x, r]) => ctx.lineTo(x, Y(-r)));
  ctx.closePath();
  if (band.length) ctx.fill();
  // axes
  ctx.strokeStyle = AXIS;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(span), Y(0)); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let a = 0; a <= span; a += 100) ctx.fillText(String(a), X(a), h - B + 4);
  ctx.fillText(`middle of a ${state.moving} Myr window (Ma)`, X(span / 2), h - B + 16);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of [-lim, -lim / 2, 0, lim / 2, lim]) ctx.fillText(v.toFixed(2), X(0) - 4, Y(v));
  ctx.save();
  ctx.translate(9, Y(0)); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('skill', 0, 0);
  ctx.restore();
  // the skill, broken where a window has too few deposits
  ctx.strokeStyle = POS;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pen = false;
  for (const p of moving) {
    const ok = p.skill != null && p.deposits >= MIN_DEPOSITS;
    if (!ok) { pen = false; continue; }
    const x = X((p.young + p.old) / 2);
    if (pen) ctx.lineTo(x, Y(p.skill!)); else ctx.moveTo(x, Y(p.skill!));
    pen = true;
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  const readout = $('through-readout');
  if (hover >= 0 && moving[hover]) {
    const p = moving[hover];
    const x = X((p.young + p.old) / 2);
    ctx.strokeStyle = 'rgba(230, 235, 240, 0.5)';
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
    if (p.skill != null && p.deposits >= MIN_DEPOSITS) {
      ctx.fillStyle = '#e6ebf0';
      ctx.beginPath(); ctx.arc(x, Y(p.skill), 4, 0, 2 * Math.PI); ctx.fill();
    }
    readout.textContent = `${p.young}-${p.old} Ma: skill ${p.deposits >= MIN_DEPOSITS ? fmt(p.skill) : '- (too few deposits)'}; `
      + `${p.deposits} deposits, ${p.districts} districts; 5% level ${ref95(p.districts).toFixed(3)} counting districts. Click to use this window.`;
  } else {
    readout.textContent = 'Hover for a window\'s numbers; click to use it.';
  }
}

function wireThroughTime(): void {
  const c = $<HTMLCanvasElement>('through');
  const at = (e: PointerEvent) => {
    const L = 50; const R = 10;
    const age = (e.offsetX - L) / (c.clientWidth - L - R) * index.span_ma;
    let best = -1; let d = Infinity;
    moving.forEach((p, i) => { const m = Math.abs((p.young + p.old) / 2 - age); if (m < d) { d = m; best = i; } });
    return best;
  };
  c.addEventListener('pointermove', (e) => drawThroughTime(at(e)));
  c.addEventListener('pointerleave', () => drawThroughTime(-1));
  c.addEventListener('click', (e) => { const i = at(e); if (i >= 0) setWindow(moving[i].young, moving[i].old); });
}

// --- the window chooser: deposits per 10 Myr, the window shaded, its ends dragged ---------------

const AGE_L = 40;
const AGE_R = 10;

function ageX(c: HTMLCanvasElement, age: number): number {
  return AGE_L + age / index.span_ma * (c.clientWidth - AGE_L - AGE_R);
}

function xAge(c: HTMLCanvasElement, x: number): number {
  return (x - AGE_L) / (c.clientWidth - AGE_L - AGE_R) * index.span_ma;
}

function drawAges(): void {
  const c = $<HTMLCanvasElement>('ages');
  const { ctx, h } = canvasCtx(c);
  const T = 6; const B = 18;
  const span = index.span_ma;
  const bins = new Array(Math.ceil(span / 10)).fill(0);
  for (const a of deps.age) bins[Math.min(bins.length - 1, Math.floor(a / 10))]++;
  const top = Math.max(...bins);
  const Y = (v: number) => T + (1 - v / top) * (h - T - B);
  ctx.fillStyle = 'rgba(255, 176, 32, 0.12)';
  ctx.fillRect(ageX(c, state.young), T, ageX(c, state.old) - ageX(c, state.young), h - T - B);
  bins.forEach((n, i) => {
    if (!n) return;
    const inside = i * 10 + 5 >= state.young && i * 10 + 5 < state.old;
    ctx.fillStyle = inside ? 'rgba(216, 222, 228, 0.85)' : 'rgba(216, 222, 228, 0.3)';
    const x0 = ageX(c, i * 10) + 0.5;
    const x1 = ageX(c, i * 10 + 10) - 0.5;
    ctx.fillRect(x0, Y(n), Math.max(1, x1 - x0), Y(0) - Y(n));
  });
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 2;
  for (const a of [state.young, state.old]) {
    ctx.beginPath(); ctx.moveTo(ageX(c, a), T - 4); ctx.lineTo(ageX(c, a), h - B); ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let a = 0; a <= span; a += 100) ctx.fillText(`${a}`, ageX(c, a), h - B + 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(String(top), AGE_L - 4, Y(top));
  ctx.fillText('0', AGE_L - 4, Y(0));
}

function wireWindowChart(): void {
  const c = $<HTMLCanvasElement>('ages');
  let drag: { kind: 'young' | 'old' | 'move' | 'new'; start: number; young: number; old: number } | null = null;
  c.addEventListener('pointerdown', (e) => {
    const age = xAge(c, e.offsetX);
    const near = (a: number) => Math.abs(ageX(c, a) - e.offsetX) < 8;
    const kind = near(state.young) ? 'young' : near(state.old) ? 'old'
      : age > state.young && age < state.old ? 'move' : 'new';
    drag = { kind, start: age, young: state.young, old: state.old };
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove', (e) => {
    const age = xAge(c, e.offsetX);
    const near = Math.abs(ageX(c, state.young) - e.offsetX) < 8 || Math.abs(ageX(c, state.old) - e.offsetX) < 8;
    c.style.cursor = drag?.kind === 'move' ? 'grabbing' : near ? 'ew-resize'
      : age > state.young && age < state.old ? 'grab' : 'crosshair';
    if (!drag) return;
    const a = Math.round(age);
    if (drag.kind === 'young') setWindow(Math.min(a, state.old - 1), state.old);
    else if (drag.kind === 'old') setWindow(state.young, Math.max(a, state.young + 1));
    else if (drag.kind === 'move') {
      const width = drag.old - drag.young;
      const y = Math.max(0, Math.min(index.span_ma - width, drag.young + Math.round(age - drag.start)));
      setWindow(y, y + width);
    } else setWindow(Math.min(a, Math.round(drag.start)), Math.max(a, Math.round(drag.start)));
  });
  c.addEventListener('pointerup', () => { drag = null; });
}

// --- the window in the address, so a view can be shared ---------------------------------------

function writeHash(): void {
  const p = new URLSearchParams({ type: state.type, young: String(state.young), old: String(state.old), factor: state.factor,
    moving: String(state.moving) });
  if (state.reversed.size) p.set('reversed', [...state.reversed].join('|'));
  history.replaceState(null, '', `#${p}`);
}

function readHash(): void {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('type')) state.type = p.get('type')!;
  const y = Number(p.get('young')); const o = Number(p.get('old'));
  if (p.has('young') && p.has('old') && Number.isFinite(y) && Number.isFinite(o) && o > y) { state.young = y; state.old = o; }
  if (p.get('factor')) state.factor = p.get('factor')!;
  if (p.get('moving')) state.moving = Number(p.get('moving')) || 100;
  for (const r of (p.get('reversed') ?? '').split('|').filter(Boolean)) state.reversed.add(r);
}

// --- start ------------------------------------------------------------------------------------

async function start(): Promise<void> {
  readHash();
  try {
    await load();
  } catch (e) {
    const box = el('div', '', `Could not load the data: ${(e as Error).message}`);
    box.id = 'error';
    document.body.append(box);
    throw e;
  }
  if (!index.factors.some((f) => f.id === state.factor)) state.factor = index.factors[0].id;
  setupControls();
  wireThroughTime();
  const b = index.built_from;
  $('provenance').textContent = `Computed in this page from RiftsClimate ${b.riftsclimate_commit ?? '?'} `
    + `(prep/geode_window_export.py, ${b.script_state}; data written ${b.data_written}). ${index.cells} cells.`;
  results = computeAll(state.young, state.old);
  update();
  // for scripts/check_skillwindow.mjs: the same test in any window, without the page
  (window as unknown as { __skillwindow: unknown }).__skillwindow = {
    index, compute: (young: number, old: number) => Object.fromEntries([...computeAll(young, old)].map(([id, r]) => [
      id, { skill: r.skill, deposits: r.deposits, districts: r.districts }])),
    setType: async (t: string) => { state.type = t; await loadType(); update(); },
  };
  requestAnimationFrame(() => { document.body.dataset.ready = '1'; });
}

void start();
