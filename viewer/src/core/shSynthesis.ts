/**
 * Spherical-harmonic synthesis of an internal potential field (a lithospheric
 * magnetic field model, or anything else written as Gauss coefficients) onto
 * points or onto a Geode grid.
 *
 * Conventions match pyshtools SHMagCoeffs.expand, which is the parity
 * reference (scripts/check_sh_synthesis.mjs):
 *   - Schmidt semi-normalised associated Legendre functions, no
 *     Condon-Shortley phase;
 *   - V = r0 * sum_l (r0/r)^(l+1) sum_m [g cos(m phi) + h sin(m phi)] P_lm(cos theta);
 *   - B = -grad V, returned as (Br, Btheta, Bphi): radial positive outward,
 *     theta positive southward (colatitude increasing), phi positive eastward;
 *   - a degree window keeps lmin <= l <= lmax and drops everything else.
 *
 * Geometry is exact on the sphere: r is an absolute geocentric radius, each
 * model keeps its own reference radius r0, so two models evaluated at the same
 * r are compared like-for-like even when their r0 differ.
 *
 * Grids follow the Geode Archive layout (core/volume.ts texelIndex): longitude
 * fastest, cell-centred from -180; latitude as gridline rows from -90 to +90
 * inclusive. A grid of nlon x nlat can go straight into a DepthSlice.
 */

/** Gauss coefficients in the triangular layout index(l, m) = l(l+1)/2 + m.
 *  Units are whatever the source uses (nT for field models). */
export interface ShCoeffs {
  lmax: number;
  /** Reference radius of the coefficients, metres. */
  r0: number;
  g: Float64Array;
  h: Float64Array;
}

export interface DegreeWindow {
  lmin: number;
  lmax: number;
}

export interface FieldVector {
  br: number;
  btheta: number;
  bphi: number;
}

export type ShComponent = 'br' | 'btheta' | 'bphi';

export const shIndex = (l: number, m: number): number => (l * (l + 1)) / 2 + m;
export const shCount = (lmax: number): number => ((lmax + 1) * (lmax + 2)) / 2;

export function emptyCoeffs(lmax: number, r0: number): ShCoeffs {
  const n = shCount(lmax);
  return { lmax, r0, g: new Float64Array(n), h: new Float64Array(n) };
}

/** The window a model can actually honour: the requested one clipped to the
 *  degrees the model defines. */
export function clampWindow(c: ShCoeffs, win: DegreeWindow): DegreeWindow {
  return { lmin: Math.max(0, win.lmin), lmax: Math.min(c.lmax, win.lmax) };
}

/** The common band of two models under a requested window: the degrees both
 *  define. Difference, swipe, correlation and profiles are all computed over
 *  this band so truncation is never mistaken for disagreement. */
export function commonBand(a: ShCoeffs, b: ShCoeffs, win: DegreeWindow): DegreeWindow {
  return { lmin: Math.max(0, win.lmin), lmax: Math.min(a.lmax, b.lmax, win.lmax) };
}

/** a - b, both taken to the same reference radius first. Coefficients are
 *  rescaled from b's r0 to a's r0 degree by degree (g' = g (r0b/r0a)^(l+2)),
 *  so the difference is exact at every radius, not only at r0. */
export function subtractCoeffs(a: ShCoeffs, b: ShCoeffs): ShCoeffs {
  const lmax = Math.min(a.lmax, b.lmax);
  const out = emptyCoeffs(lmax, a.r0);
  const ratio = b.r0 / a.r0;
  for (let l = 0; l <= lmax; l++) {
    const s = Math.pow(ratio, l + 2);
    for (let m = 0; m <= l; m++) {
      const k = shIndex(l, m);
      out.g[k] = a.g[k] - s * b.g[k];
      out.h[k] = a.h[k] - s * b.h[k];
    }
  }
  return out;
}

/**
 * Schmidt semi-normalised P_lm(cos theta), dP_lm/dtheta, and P_lm / sin(theta)
 * (for m >= 1) for one colatitude. All three are carried through the same
 * recursions, so none divides by sin(theta) and all are finite at the poles.
 *
 *   P_00 = 1, P_11 = sin, P_mm = sqrt((2m-1)/(2m)) sin P_{m-1,m-1}
 *   P_lm = [(2l-1) cos P_{l-1,m} - sqrt((l-1)^2 - m^2) P_{l-2,m}] / sqrt(l^2 - m^2)
 *
 * Q_lm = P_lm / sin obeys the same l-recursion, started from
 * Q_11 = 1 and Q_mm = sqrt((2m-1)/(2m)) P_{m-1,m-1}.
 */
export function schmidtLegendre(
  lmax: number,
  theta: number,
  p: Float64Array,
  dp: Float64Array,
  q: Float64Array,
): void {
  const x = Math.cos(theta);
  const s = Math.sin(theta);
  p[0] = 1;
  dp[0] = 0;
  q[0] = 0;
  // Diagonal P_mm and its derivative.
  for (let m = 1; m <= lmax; m++) {
    const kPrev = shIndex(m - 1, m - 1);
    const k = shIndex(m, m);
    const f = m === 1 ? 1 : Math.sqrt((2 * m - 1) / (2 * m));
    p[k] = f * s * p[kPrev];
    dp[k] = f * (x * p[kPrev] + s * dp[kPrev]);
    q[k] = f * p[kPrev];
  }
  // Up each column m.
  for (let m = 0; m <= lmax; m++) {
    for (let l = m + 1; l <= lmax; l++) {
      const k = shIndex(l, m);
      const k1 = shIndex(l - 1, m);
      const a = (2 * l - 1) / Math.sqrt(l * l - m * m);
      if (l === m + 1) {
        p[k] = a * x * p[k1];
        dp[k] = a * (x * dp[k1] - s * p[k1]);
        q[k] = a * x * q[k1];
      } else {
        const k2 = shIndex(l - 2, m);
        const b = Math.sqrt((l - 1) * (l - 1) - m * m) / Math.sqrt(l * l - m * m);
        p[k] = a * x * p[k1] - b * p[k2];
        dp[k] = a * (x * dp[k1] - s * p[k1]) - b * dp[k2];
        q[k] = a * x * q[k1] - b * q[k2];
      }
    }
  }
}

/** (r0/r)^(l+2) for l = 0..lmax. */
function radialScale(r0: number, r: number, lmax: number): Float64Array {
  const out = new Float64Array(lmax + 1);
  const ratio = r0 / r;
  let v = ratio * ratio;
  for (let l = 0; l <= lmax; l++) {
    out[l] = v;
    v *= ratio;
  }
  return out;
}

/** Field vector at one point. r in metres, lat/lon in degrees. */
export function evaluatePoint(
  c: ShCoeffs,
  r: number,
  latDeg: number,
  lonDeg: number,
  window: DegreeWindow,
): FieldVector {
  const win = clampWindow(c, window);
  const out = { br: 0, btheta: 0, bphi: 0 };
  if (win.lmax < win.lmin) return out;
  const n = shCount(win.lmax);
  const p = new Float64Array(n);
  const dp = new Float64Array(n);
  const q = new Float64Array(n);
  schmidtLegendre(win.lmax, ((90 - latDeg) * Math.PI) / 180, p, dp, q);
  const scale = radialScale(c.r0, r, win.lmax);
  const phi = (lonDeg * Math.PI) / 180;
  for (let m = 0; m <= win.lmax; m++) {
    const cm = Math.cos(m * phi);
    const sm = Math.sin(m * phi);
    for (let l = Math.max(m, win.lmin); l <= win.lmax; l++) {
      const k = shIndex(l, m);
      const gc = c.g[k] * cm + c.h[k] * sm;
      const gs = c.g[k] * sm - c.h[k] * cm;
      out.br += (l + 1) * scale[l] * gc * p[k];
      out.btheta -= scale[l] * gc * dp[k];
      if (m > 0) out.bphi += scale[l] * m * gs * q[k];
    }
  }
  return out;
}

export interface GridSpec {
  nlon: number;
  nlat: number;
}

export interface GridResult {
  nlon: number;
  nlat: number;
  br?: Float32Array;
  btheta?: Float32Array;
  bphi?: Float32Array;
}

/**
 * Synthesise the requested components on a Geode grid at radius r (metres).
 *
 * Per latitude row: the Legendre sums collapse the l dimension into two
 * Fourier coefficients per order m, then a direct cosine/sine sum over a
 * precomputed table gives every longitude. That is O(nlat * lmax^2) for the
 * Legendre part and O(nlat * nlon * lmax) for the longitude part -- about
 * 0.3 G multiply-adds per component at lmax 300 on a 0.25 degree grid, which
 * is why this is meant to run in a worker.
 */
export function synthesizeGrid(
  c: ShCoeffs,
  r: number,
  window: DegreeWindow,
  grid: GridSpec,
  components: ShComponent[] = ['br'],
): GridResult {
  const { nlon, nlat } = grid;
  const win = clampWindow(c, window);
  const want = new Set(components);
  const res: GridResult = { nlon, nlat };
  for (const comp of want) res[comp] = new Float32Array(nlon * nlat);
  if (win.lmax < win.lmin) return res;

  const L = win.lmax;
  const n = shCount(L);
  const p = new Float64Array(n);
  const dp = new Float64Array(n);
  const q = new Float64Array(n);
  const scale = radialScale(c.r0, r, L);

  // cos/sin(m * phi_i) for phi_i = -pi + (i + 0.5) * 2pi / nlon, read as
  // table[(m * i) mod nlon] after shifting the phase of each order once.
  const cosT = new Float64Array(nlon);
  const sinT = new Float64Array(nlon);
  for (let j = 0; j < nlon; j++) {
    cosT[j] = Math.cos((2 * Math.PI * j) / nlon);
    sinT[j] = Math.sin((2 * Math.PI * j) / nlon);
  }
  const phi0 = -Math.PI + Math.PI / nlon;

  // Per-order Fourier coefficients of each component along one row:
  // f(phi) = sum_m A_m cos(m phi) + B_m sin(m phi).
  const A = { br: new Float64Array(L + 1), btheta: new Float64Array(L + 1), bphi: new Float64Array(L + 1) };
  const B = { br: new Float64Array(L + 1), btheta: new Float64Array(L + 1), bphi: new Float64Array(L + 1) };

  for (let jLat = 0; jLat < nlat; jLat++) {
    const lat = -90 + (180 * jLat) / (nlat - 1);
    schmidtLegendre(L, ((90 - lat) * Math.PI) / 180, p, dp, q);
    for (let m = 0; m <= L; m++) {
      let rg = 0, rh = 0, tg = 0, th = 0, pg = 0, ph = 0;
      for (let l = Math.max(m, win.lmin); l <= L; l++) {
        const k = shIndex(l, m);
        const sg = scale[l] * c.g[k];
        const sh = scale[l] * c.h[k];
        rg += (l + 1) * sg * p[k];
        rh += (l + 1) * sh * p[k];
        tg -= sg * dp[k];
        th -= sh * dp[k];
        pg += m * sg * q[k];
        ph += m * sh * q[k];
      }
      // Br, Btheta: g cos + h sin.  Bphi: m (g sin - h cos) Q.
      // Shift each order's phase so the table can start at longitude phi0.
      const c0 = Math.cos(m * phi0);
      const s0 = Math.sin(m * phi0);
      // a cos(m(phi0+d)) + b sin(m(phi0+d)) = (a c0 + b s0) cos(md) + (b c0 - a s0) sin(md)
      A.br[m] = rg * c0 + rh * s0;
      B.br[m] = rh * c0 - rg * s0;
      A.btheta[m] = tg * c0 + th * s0;
      B.btheta[m] = th * c0 - tg * s0;
      // Bphi = pg sin - ph cos  ->  a = -ph, b = pg
      A.bphi[m] = -ph * c0 + pg * s0;
      B.bphi[m] = pg * c0 + ph * s0;
    }
    for (const comp of want) {
      const out = res[comp]!;
      const Am = A[comp];
      const Bm = B[comp];
      const row = jLat * nlon;
      for (let i = 0; i < nlon; i++) {
        let v = 0;
        let idx = 0;
        for (let m = 0; m <= L; m++) {
          v += Am[m] * cosT[idx] + Bm[m] * sinT[idx];
          idx += i;
          if (idx >= nlon) idx %= nlon;
        }
        out[row + i] = v;
      }
    }
  }
  return res;
}

/** Field intensity |B| from the three components of a grid result. */
export function intensity(res: GridResult): Float32Array {
  const { br, btheta, bphi } = res;
  if (!br || !btheta || !bphi) throw new Error('intensity needs br, btheta and bphi');
  const out = new Float32Array(br.length);
  for (let i = 0; i < br.length; i++) {
    out[i] = Math.hypot(br[i], btheta[i], bphi[i]);
  }
  return out;
}

/**
 * Total-field anomaly T = |F + b| - |F| of a lithospheric field b in a main
 * field F, both as (r, theta, phi) components at the same place -- the
 * definition in remit utils/grid.py components2tmi. Written as
 * (2 F.b + |b|^2) / (|F + b| + |F|), which is the same quantity without the
 * cancellation of subtracting two ~50 000 nT magnitudes.
 */
export function totalFieldAnomaly(
  fr: number, ft: number, fp: number,
  br: number, bt: number, bp: number,
): number {
  const num = 2 * (fr * br + ft * bt + fp * bp) + br * br + bt * bt + bp * bp;
  const den = Math.hypot(fr + br, ft + bt, fp + bp) + Math.hypot(fr, ft, fp);
  return den > 0 ? num / den : 0;
}

/** totalFieldAnomaly over two grid results of the same shape, each holding
 *  br, btheta and bphi (main field and lithospheric field). */
export function totalFieldAnomalyGrid(main: GridResult, crust: GridResult): Float32Array {
  const f = [main.br, main.btheta, main.bphi];
  const b = [crust.br, crust.btheta, crust.bphi];
  if (f.some((a) => !a) || b.some((a) => !a)) {
    throw new Error('totalFieldAnomalyGrid needs br, btheta and bphi for both fields');
  }
  const [fr, ft, fp] = f as Float32Array[];
  const [br, bt, bp] = b as Float32Array[];
  const out = new Float32Array(br.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = totalFieldAnomaly(fr[i], ft[i], fp[i], br[i], bt[i], bp[i]);
  }
  return out;
}

/** Lowes-Mauersberger spectrum R_l = (l+1) (r0/r)^(2l+4) sum_m (g^2 + h^2),
 *  for l = 0..lmax, at radius r (metres). Equal to pyshtools
 *  SHMagCoeffs.spectrum(function='total') when r = r0. */
export function lowesSpectrum(c: ShCoeffs, r: number): Float64Array {
  const out = new Float64Array(c.lmax + 1);
  const ratio = c.r0 / r;
  for (let l = 0; l <= c.lmax; l++) {
    let sum = 0;
    for (let m = 0; m <= l; m++) {
      const k = shIndex(l, m);
      sum += c.g[k] * c.g[k] + c.h[k] * c.h[k];
    }
    out[l] = (l + 1) * Math.pow(ratio, 2 * l + 4) * sum;
  }
  return out;
}

/** Degree correlation between two models, l = 0..min(lmax), after taking b
 *  to a's reference radius. NaN where either model has no power. */
export function degreeCorrelation(a: ShCoeffs, b: ShCoeffs): Float64Array {
  const lmax = Math.min(a.lmax, b.lmax);
  const out = new Float64Array(lmax + 1);
  const ratio = b.r0 / a.r0;
  for (let l = 0; l <= lmax; l++) {
    const s = Math.pow(ratio, l + 2);
    let ab = 0, aa = 0, bb = 0;
    for (let m = 0; m <= l; m++) {
      const k = shIndex(l, m);
      const bg = s * b.g[k];
      const bh = s * b.h[k];
      ab += a.g[k] * bg + a.h[k] * bh;
      aa += a.g[k] * a.g[k] + a.h[k] * a.h[k];
      bb += bg * bg + bh * bh;
    }
    out[l] = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : NaN;
  }
  return out;
}

/** Everything a map can be: a component of one model, or of the difference
 *  between two. */
export type FieldComponent = ShComponent | 'intensity' | 'tmi';

export interface FieldSpec {
  /** A registered model id, or [a, b] for the difference a - b. */
  model: string | [string, string];
  component: FieldComponent;
  /** Absolute radius, metres. */
  r: number;
  window: DegreeWindow;
  grid: GridSpec;
}

export interface FieldResult {
  values: Float32Array;
  nlon: number;
  nlat: number;
  /** The degree band actually synthesised, after clamping to what the
   *  model(s) define -- for a difference, the common band. */
  band: DegreeWindow;
}

/** Coefficients by id, plus the main field used for the total-field anomaly. */
export interface ModelLookup {
  get(id: string): ShCoeffs | undefined;
  /** The main-field model id (IGRF-13 at 2020.0 in the Curiesphere viewer). */
  mainFieldId: string;
}

function need(models: ModelLookup, id: string): ShCoeffs {
  const c = models.get(id);
  if (!c) throw new Error(`unknown SH model '${id}'`);
  return c;
}

function componentGrid(
  c: ShCoeffs, comp: FieldComponent, r: number, win: DegreeWindow, grid: GridSpec, models: ModelLookup,
): Float32Array {
  if (comp === 'br' || comp === 'btheta' || comp === 'bphi') {
    return synthesizeGrid(c, r, win, grid, [comp])[comp]!;
  }
  const all = synthesizeGrid(c, r, win, grid, ['br', 'btheta', 'bphi']);
  if (comp === 'intensity') return intensity(all);
  const main = need(models, models.mainFieldId);
  const f = synthesizeGrid(main, r, { lmin: 1, lmax: main.lmax }, grid, ['br', 'btheta', 'bphi']);
  return totalFieldAnomalyGrid(f, all);
}

/**
 * Synthesise one map. For a difference, Br / Btheta / Bphi are linear, so
 * they are synthesised once from the coefficient difference (exact at any
 * radius). |B| and the total-field anomaly are not: |A| - |B| is not |A - B|,
 * so those are synthesised per model over the common band and subtracted
 * point by point.
 */
export function computeField(spec: FieldSpec, models: ModelLookup): FieldResult {
  const { component: comp, r, grid } = spec;
  if (typeof spec.model === 'string') {
    const c = need(models, spec.model);
    const band = clampWindow(c, spec.window);
    return { values: componentGrid(c, comp, r, band, grid, models), ...grid, band };
  }
  const a = need(models, spec.model[0]);
  const b = need(models, spec.model[1]);
  const band = commonBand(a, b, spec.window);
  let values: Float32Array;
  if (comp === 'br' || comp === 'btheta' || comp === 'bphi') {
    values = componentGrid(subtractCoeffs(a, b), comp, r, band, grid, models);
  } else {
    values = componentGrid(a, comp, r, band, grid, models);
    const vb = componentGrid(b, comp, r, band, grid, models);
    for (let i = 0; i < values.length; i++) values[i] -= vb[i];
  }
  return { values, ...grid, band };
}
