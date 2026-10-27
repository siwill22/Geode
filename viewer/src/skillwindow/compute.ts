/**
 * Step 1 of RiftsClimate's ladder (the plain Molchan test, one factor at a time) in a chosen time
 * window, from the ranks RiftsClimate wrote (its prep/geode_window_export.py, which defines the
 * test and computes the same numbers for a set of windows; scripts/check_skillwindow.mjs
 * compares them with these).
 *
 * In a window from `young` to `old` Ma:
 *  - every cell (one place at one time slice) whose slice overlaps the window counts, weighted
 *    by its area x the part of its slice inside the window;
 *  - the deposits counted are those with young <= age < old (the oldest end included at the
 *    end of the record);
 *  - a deposit's share = the share of the window's cells (by weight) rated higher than it, rated
 *    the same counting half; skill = 0.5 minus the mean share;
 *  - districts: deposits joined in chains of pairs within 200 km and 30 Myr, among those counted.
 *
 * Ranks: a cell's rank orders its rating among the cells' (even numbers, equal ratings equal); a
 * deposit's is the same even number when it equals a cell's rating, the odd number between
 * otherwise; 0 = not in that factor's test.
 */

export interface WindowGround {
  from: Float32Array;
  to: Float32Array;
  area: Float32Array;
  /** One rank array per factor, in the index's factor order. */
  ranks: Uint32Array[];
  /** The largest rank of each factor's cells (for the scratch arrays). */
  maxRank: number[];
}

export interface WindowDeposits {
  age: number[];
  /** factor id -> one rank per deposit. */
  ranks: Record<string, number[]>;
  pairs: [number, number][];
}

export interface FactorResult {
  /** Null when the window has no cells or no deposits for the factor. */
  skill: number | null;
  deposits: number;
  districts: number;
  /** Each counted deposit's share, in the deposits' order (for the Molchan diagram). */
  shares: Float64Array;
}

/** The 5% level for n independent deposits (Zechar & Jordan 2008). */
export function ref95(n: number): number {
  return n > 0 ? 1.645 / Math.sqrt(12 * n) : NaN;
}

/** Every cell's weight in the window: area x the part of its time slice inside it. */
export function cellWeights(g: WindowGround, young: number, old: number): Float64Array {
  const n = g.area.length;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const overlap = Math.min(g.to[i], old) - Math.max(g.from[i], young);
    if (overlap > 0) w[i] = g.area[i] * overlap;
  }
  return w;
}

/** Whether a deposit of this age is counted in the window. */
export function inWindow(age: number, young: number, old: number, span: number): boolean {
  return age >= young && (age < old || (old >= span && age <= old));
}

let scratch = new Float64Array(0);

/** One factor's test in the window, given the window's cell weights. */
export function factorTest(
  g: WindowGround, k: number, w: Float64Array, deps: WindowDeposits, factor: string,
  young: number, old: number, span: number,
): FactorResult {
  const rg = g.ranks[k];
  const size = g.maxRank[k] + 2;
  if (scratch.length < size) scratch = new Float64Array(size);
  const at = scratch;
  at.fill(0, 0, size);
  let total = 0;
  for (let i = 0; i < rg.length; i++) {
    const r = rg[i];
    if (r > 0 && w[i] > 0) { at[r] += w[i]; total += w[i]; }
  }
  const rd = deps.ranks[factor];
  const keep: number[] = [];
  for (let j = 0; j < rd.length; j++) {
    if (rd[j] > 0 && inWindow(deps.age[j], young, old, span)) keep.push(j);
  }
  const shares = new Float64Array(keep.length);
  if (total <= 0 || !keep.length) {
    return { skill: null, deposits: keep.length, districts: districts(deps.pairs, keep, rd.length), shares };
  }
  // weight rated higher than each rank: a running sum from the top
  const want = new Map<number, number>();
  for (const j of keep) want.set(rd[j], 0);
  let above = 0;
  for (let r = size - 1; r >= 1; r--) {
    if (want.has(r)) want.set(r, (above + 0.5 * at[r]) / total);
    above += at[r];
  }
  let sum = 0;
  keep.forEach((j, i) => { shares[i] = want.get(rd[j])!; sum += shares[i]; });
  return { skill: 0.5 - sum / keep.length, deposits: keep.length, districts: districts(deps.pairs, keep, rd.length), shares };
}

/** Districts among the kept deposits: chains of pairs within 200 km and 30 Myr. */
export function districts(pairs: [number, number][], keep: number[], n: number): number {
  const parent = new Int32Array(n).fill(-1);
  for (const j of keep) parent[j] = j;
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  let count = keep.length;
  for (const [a, b] of pairs) {
    if (parent[a] < 0 || parent[b] < 0) continue;
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) { parent[ra] = rb; count--; }
  }
  return count;
}
