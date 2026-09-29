/**
 * A 2D scalar field computed in the browser (core/shSynthesis.ts, or a
 * difference of two maps) as a texture a DepthSlice can paint, without the
 * uint8 quantisation of Archive frames: at uint8 a +-400 nT map steps in
 * ~3 nT, which bands visibly once the colour range is narrowed to +-10 nT.
 *
 * The values go up as half floats, normalised to [0, 1] over the map's own
 * [min, max] -- the same "encoded 0..1" space the shared material samples and
 * clips in, so material.ts needs no float path. Half floats are filterable on
 * every WebGL2 device (full floats need OES_texture_float_linear) and step in
 * ~1/2048 of the map's span, finer than the 256-entry colour ramp.
 *
 * Layout is the Geode Archive one: longitude fastest, cell-centred from -180;
 * latitude as gridline rows -90..+90.
 */
import {
  ClampToEdgeWrapping, Data3DTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat,
  RepeatWrapping, type ShaderMaterial, type Vector3,
} from 'three';

export interface FieldTexture {
  texture: Data3DTexture;
  /** Physical value at encoded 0 and 1. */
  encodeMin: number;
  encodeMax: number;
}

export function makeFieldTexture(values: Float32Array, nlon: number, nlat: number): FieldTexture {
  if (values.length !== nlon * nlat) {
    throw new Error(`field has ${values.length} values, grid is ${nlon} x ${nlat}`);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const half = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) half[i] = DataUtils.toHalfFloat((values[i] - lo) / span);

  const tex = new Data3DTexture(half, nlon, nlat, 1);
  tex.format = RedFormat;
  tex.type = HalfFloatType;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 2;
  tex.needsUpdate = true;
  return { texture: tex, encodeMin: lo, encodeMax: hi };
}

/** Bind a field texture to a DepthSlice's material as a one-layer volume and
 *  set its colour range in physical units. */
export function bindFieldTexture(mat: ShaderMaterial, field: FieldTexture, nlon: number, nlat: number): void {
  mat.uniforms.uVolume.value = field.texture;
  (mat.uniforms.uGrid.value as Vector3).set(nlon, nlat, 1);
  // One layer: any depth inside a non-degenerate range samples it.
  mat.uniforms.uDepthMin.value = 0;
  mat.uniforms.uDepthMax.value = 1;
  mat.uniforms.uSliceDepthKm.value = 0;
}

export function setFieldRange(mat: ShaderMaterial, field: FieldTexture, lo: number, hi: number): void {
  const span = field.encodeMax - field.encodeMin;
  mat.uniforms.uClipLo.value = (lo - field.encodeMin) / span;
  mat.uniforms.uClipHi.value = (hi - field.encodeMin) / span;
}

/**
 * A symmetric colour range +-c for a signed field: the area-weighted
 * `quantile` of |value| over the whole globe, rounded up to 1, 2, 2.5 or
 * 5 x 10^k. Global on purpose: the range is a function of the map alone
 * (model, component, altitude, degree window), so it never shifts while the
 * camera moves.
 *
 * Area-weighted because the grid is equiangular: a gridline row at latitude
 * phi stands for a band of area proportional to cos(phi), so an unweighted
 * percentile would let the crowded polar rows set the range. The pole rows
 * get the area of their half-width cap.
 */
export function niceSymmetricRange(values: Float32Array, nlon: number, nlat: number, quantile = 0.99): number {
  const dLat = Math.PI / (nlat - 1);
  // Subsample to at most ~200k values; the percentile of a smooth field does
  // not need all of them.
  const stride = Math.max(1, Math.floor((nlon * nlat) / 200_000));
  const abs: number[] = [];
  const wts: number[] = [];
  for (let j = 0; j < nlat; j++) {
    const lat = -Math.PI / 2 + j * dLat;
    const w = j === 0 || j === nlat - 1 ? 1 - Math.cos(dLat / 2) : Math.cos(lat) * Math.sin(dLat / 2) * 2;
    for (let i = (j * nlon) % stride; i < nlon; i += stride) {
      const v = values[j * nlon + i];
      if (Number.isFinite(v)) { abs.push(Math.abs(v)); wts.push(w); }
    }
  }
  if (!abs.length) return 1;
  const order = abs.map((_, k) => k).sort((a, b) => abs[a] - abs[b]);
  const total = wts.reduce((s, w) => s + w, 0);
  let acc = 0;
  let q = abs[order[order.length - 1]];
  for (const k of order) {
    acc += wts[k];
    if (acc >= quantile * total) { q = abs[k]; break; }
  }
  return niceCeil(q);
}

export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x * (1 - 1e-12)) return m * p;
  return 10 * p;
}
