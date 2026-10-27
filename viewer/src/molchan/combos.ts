import type { ComboEntry, ComboGain, ComboRankedFile } from './types';
import { nameSlots, slotFills } from './types';

/**
 * The side-panel blocks for step 3 of RiftsClimate's ladder (combinations with equal weights),
 * below the Molchan diagram: the best-of-all choice against the no-effect fake worlds, how much
 * each factor adds, and every combination ranked. Every number is RiftsClimate's
 * (prep/geode_combo_export.py); nothing is computed here but the drawing.
 */

export interface ComboPanelCallbacks {
  /** Show this map (a ComboMap id). */
  onPickMap(id: string): void;
  /** Every combination of the type, ranked (fetched once per type). */
  loadRanked(type: string): Promise<ComboRankedFile>;
}

const DOT = 'rgba(170, 178, 188, 0.75)';
const REAL = '#ffb020';
const AXIS = 'rgba(200, 210, 220, 0.45)';
const INK = '#97a3ad';
/** Rows listed at once in the ranked list (the filter finds the rest). */
const LIST_ROWS = 300;
/** The gain bars: half the track is this much regional skill. */
const GAIN_HALF = 0.1;

export class ComboPanel {
  readonly blocks: HTMLDivElement[];
  private readonly worldsCanvas: HTMLCanvasElement;
  private readonly worldsText: HTMLDivElement;
  private readonly gainsEl: HTMLDivElement;
  private readonly gainsNote: HTMLDivElement;
  private readonly gainButtons: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly listNote: HTMLDivElement;
  private readonly filter: HTMLInputElement;
  private entry: ComboEntry | null = null;
  private type = '';
  private current = '';
  private gainSkill = 'regional';
  private ranked: ComboRankedFile | null = null;

  constructor(private readonly cb: ComboPanelCallbacks) {
    const wb = div('chart-block');
    const wt = div('chart-title');
    wt.textContent = 'The best-of-all choice against fake worlds';
    this.worldsCanvas = document.createElement('canvas');
    this.worldsCanvas.className = 'chart-canvas combo-worlds-canvas';
    this.worldsText = div('chart-note');
    wb.append(wt, this.worldsCanvas, this.worldsText);

    const gb = div('chart-block');
    const gt = div('chart-title combo-title-row');
    const gtt = document.createElement('span');
    gtt.textContent = 'How much each factor adds';
    this.gainButtons = div('combo-buttons');
    gt.append(gtt, this.gainButtons);
    this.gainsEl = div('molchan-factors');
    this.gainsNote = div('chart-note');
    gb.append(gt, this.gainsEl, this.gainsNote);

    const lb = div('chart-block');
    const lt = div('chart-title');
    lt.textContent = 'Every combination, ranked by regional skill';
    this.filter = document.createElement('input');
    this.filter.type = 'search';
    this.filter.className = 'combo-filter';
    this.filter.placeholder = 'filter, e.g. craton edge + evaporite';
    this.filter.addEventListener('input', () => this.renderList());
    this.listEl = div('combo-list');
    this.listNote = div('chart-note');
    lb.append(lt, this.filter, this.listEl, this.listNote);

    this.blocks = [wb, gb, lb];
    addEventListener('resize', () => this.drawWorlds());
  }

  setVisible(on: boolean): void {
    for (const b of this.blocks) b.style.display = on ? '' : 'none';
    if (on) this.drawWorlds();
  }

  /** The deposit type's results, and the map on screen. */
  setData(type: string, entry: ComboEntry, current: string): void {
    const typeChanged = type !== this.type;
    this.type = type;
    this.entry = entry;
    this.current = current;
    if (!(this.gainSkill in entry.gains)) this.gainSkill = 'regional';
    this.drawWorlds();
    this.renderGains();
    if (typeChanged) {
      this.ranked = null;
      this.listEl.replaceChildren();
      this.listNote.textContent = 'loading every combination ...';
      void this.cb.loadRanked(type).then((r) => {
        if (this.type !== type) return;
        this.ranked = r;
        this.renderList();
      });
    } else {
      this.renderList();
    }
  }

  // --- the best-of-all choice against the fake worlds ----------------------------------------

  private drawWorlds(): void {
    const e = this.entry;
    const c = this.worldsCanvas;
    if (!e || !c.clientWidth) return;
    const rows = Object.entries(e.worlds);
    const cssW = c.clientWidth;
    const rowH = 34;
    const cssH = 22 + rows.length * rowH;
    c.style.height = `${cssH}px`;
    const dpr = Math.min(devicePixelRatio, 2);
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const all = rows.flatMap(([, w]) => [w.real, ...w.worlds.filter((x): x is number => x != null)]);
    const lo = Math.min(-0.05, Math.floor(Math.min(...all) * 20) / 20);
    const hi = Math.max(0.4, Math.ceil(Math.max(...all) * 20) / 20);
    const L = 62;
    const R = 10;
    const X = (v: number) => L + (v - lo) / (hi - lo) * (cssW - L - R);
    ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
    const text: string[] = [];
    rows.forEach(([name, w], k) => {
      const y = 8 + k * rowH + rowH / 2;
      ctx.fillStyle = INK;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, L - 8, y);
      ctx.strokeStyle = AXIS;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(lo), y);
      ctx.lineTo(X(hi), y);
      ctx.stroke();
      const vals = w.worlds.filter((x): x is number => x != null).sort((a, b) => a - b);
      // Fake worlds as dots, stacked a little where they crowd.
      const seen = new Map<number, number>();
      for (const v of vals) {
        const px = Math.round(X(v) / 4);
        const n = seen.get(px) ?? 0;
        seen.set(px, n + 1);
        ctx.beginPath();
        ctx.arc(X(v), y - 4 - (n % 4) * 3.2, 2.2, 0, 2 * Math.PI);
        ctx.fillStyle = DOT;
        ctx.fill();
      }
      ctx.strokeStyle = REAL;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(X(w.real), y - 13);
      ctx.lineTo(X(w.real), y + 6);
      ctx.stroke();
      const above = vals.filter((v) => v >= w.real).length;
      const med = vals.length ? vals[Math.floor((vals.length - 1) / 2)] / 2 + vals[Math.ceil((vals.length - 1) / 2)] / 2 : NaN;
      text.push(vals.length
        ? `${cap(name)} skill: real ${w.real.toFixed(3)}; ${vals.length} fake worlds, median ${med.toFixed(3)}, `
          + `highest ${vals[vals.length - 1].toFixed(3)}; ${above} of ${vals.length} reach the real one `
          + `(without later collision: real ${w.real_nc.toFixed(3)}).`
        : `${cap(name)} skill: real ${w.real.toFixed(3)} (without later collision ${w.real_nc.toFixed(3)}); `
          + 'no fake worlds yet, so no chance level.');
    });
    // Axis ticks under the last row.
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const yAxis = 8 + rows.length * rowH;
    for (let v = Math.ceil(lo * 10) / 10; v <= hi + 1e-9; v += 0.1) {
      ctx.fillText(v.toFixed(1), X(v), yAxis);
    }
    this.worldsText.textContent = `${text.join(' ')} Orange: the real record. Grey dots: fake worlds with no effect `
      + 'built in, each searched exactly as the real one. Regional: each deposit set aside ranked against its own '
      + 'region\'s continental area; global: against all continental area.';
  }

  // --- how much each factor adds ---------------------------------------------------------------

  private renderGains(): void {
    const e = this.entry;
    if (!e) return;
    this.gainButtons.replaceChildren(...Object.keys(e.gains).map((k) => {
      const b = document.createElement('button');
      b.className = `combo-button${k === this.gainSkill ? ' combo-button-on' : ''}`;
      b.textContent = k;
      b.addEventListener('click', () => { this.gainSkill = k; this.renderGains(); });
      return b;
    }));
    const rows = [...(e.gains[this.gainSkill] ?? [])].sort((a, b) => b.gain - a.gain);
    this.gainsEl.replaceChildren(...rows.map((g) => this.gainRow(g)));
    const n = rows[0]?.worlds ?? 0;
    this.gainsNote.textContent = 'The average change in regional skill when the factor is added to a combination '
      + `that lacks it (step 3). The bar runs from 0 (the middle); half the track is ${GAIN_HALF}. `
      + (n ? `The grey band runs from the median to the highest gain in ${n} fake worlds with no effect built in; `
        + 'in brackets, how many of them reach the real gain.'
        : 'No fake worlds yet for this type, so no chance level is drawn.');
  }

  private gainRow(g: ComboGain): HTMLDivElement {
    const row = div('molchan-factor combo-gain');
    const name = div('molchan-factor-name');
    name.textContent = nameSlots(this.entry ?? undefined, g.factor);
    const track = div('molchan-bar-track');
    const pct = (v: number) => 50 + Math.max(-50, Math.min(50, v / GAIN_HALF * 50));
    if (g.median != null && g.highest != null) {
      const band = div('combo-band');
      Object.assign(band.style, { left: `${pct(g.median)}%`, width: `${Math.max(0.5, pct(g.highest) - pct(g.median))}%` });
      track.appendChild(band);
    }
    const bar = div(`molchan-bar combo-bar${g.gain < 0 ? ' molchan-bar-neg' : ''}`);
    Object.assign(bar.style, { left: `${Math.min(50, pct(g.gain))}%`, width: `${Math.abs(pct(g.gain) - 50)}%` });
    track.appendChild(bar);
    const val = div('molchan-factor-skill combo-gain-value');
    val.textContent = `${sign(g.gain)}${g.at_or_above != null ? ` (${g.at_or_above})` : ''}`;
    const slot = /^@new idea (\d)$/.exec(g.factor);
    const fills = slot && this.entry
      ? '\n' + Object.entries(slotFills(this.entry, slot[1])).map(([r, f]) => `made without ${r}: ${f}`).join('\n') : '';
    row.title = `${name.textContent}: gain ${sign(g.gain)}; fake worlds median ${g.median?.toFixed(3) ?? '-'}, `
      + `highest ${g.highest?.toFixed(3) ?? '-'}; ${g.at_or_above ?? '-'} of ${g.worlds} reach it${fills}`;
    row.append(name, track, val);
    return row;
  }

  // --- every combination, ranked ----------------------------------------------------------------

  private renderList(): void {
    const r = this.ranked;
    const e = this.entry;
    if (!r || !e) return;
    const words = this.filter.value.toLowerCase().split('+').map((w) => w.trim()).filter(Boolean);
    const rows: HTMLDivElement[] = [];
    let found = 0;
    for (let i = 0; i < r.combination.length; i++) {
      const c = nameSlots(e, r.combination[i]);
      const lc = c.toLowerCase();
      if (words.length && !words.every((w) => lc.includes(w))) continue;
      found++;
      if (rows.length >= LIST_ROWS) continue;
      const id = r.map[i];
      const row = div(`combo-row${id ? ' combo-row-map' : ''}${id && id === this.current ? ' combo-row-current' : ''}`);
      const rank = div('combo-rank');
      rank.textContent = String(i + 1);
      const name = div('combo-name');
      name.textContent = c;
      const sk = div('combo-skill');
      sk.textContent = sign(r.skill[i] ?? NaN);
      row.title = e.regions.map((g) => `${g}: ${sign(r.by_region[g]?.[i] ?? NaN)}`).join('\n')
        + (id ? '\nClick to show its map.' : '\nNo map written for this one.');
      if (id) row.addEventListener('click', () => this.cb.onPickMap(id));
      row.append(rank, name, sk);
      rows.push(row);
    }
    this.listEl.replaceChildren(...rows);
    this.listNote.textContent = `${found} of ${r.combination.length} combinations${words.length ? ' match' : ''}`
      + `${found > LIST_ROWS ? `, the first ${LIST_ROWS} listed` : ''}. Highlighted rows have a map: click one to `
      + 'show it. Hover a row for its skill in each region set aside. Skill chosen this way is inflated by the '
      + 'choosing; the best-of-all choice above is the fair measure.';
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

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
