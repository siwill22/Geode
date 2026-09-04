import type { Data3DTexture } from 'three';
import type { LonLat } from './constants';
import type { FrameByteCache } from './frameByteCache';
import { CONCURRENCY, mapPool } from './timeSeries';
import { cellCenter, texelIndex, texelToPhysical } from './volume';
import type { Manifest, ResolutionInfo, VariableInfo } from './types';

/**
 * One cell's value at one Frame -- the unit both Anchored Point query shapes
 * (Month Profile, Age Series) return one array of. `cell` is the sampled
 * cell's own centre (from texelIndex/cellCenter's shared nearest-neighbour
 * convention), not the raw `LonLat` a caller asked for -- at 1 degree
 * resolution the two can visibly disagree, so a caller/UI can show both. See
 * CONTEXT.md's Anchored Point entry and ADR-0011.
 */
export interface CellSample {
  cell: LonLat;
  /** NaN if this cell was masked or held the no-data sentinel at this Frame
   *  -- never a fabricated value, mirroring core/timeSeries.ts's rule. */
  value: number;
}

/** Honours the same validity-mask/sentinel convention core/timeSeries.ts
 *  applies -- byte >= 128 is valid (mirrors material.ts's uValidMask
 *  check), and a sentinel byte (Manifest.no_data_sentinel) is invalid
 *  regardless of the mask. Both are optional: a Model with neither declared
 *  passes every cell through. */
export interface NoDataRule {
  maskBytes?: Uint8Array | null;
  sentinel?: number;
}

function isInvalid(idx: number, byte: number, rule?: NoDataRule): boolean {
  if (!rule) return false;
  if (rule.maskBytes && rule.maskBytes[idx] < 128) return true;
  if (rule.sentinel !== undefined && byte === rule.sentinel) return true;
  return false;
}

/**
 * Month Profile: every layer of `variable`'s currently-loaded Frame (Months
 * plus Annual, or whatever `res.ndepth` holds) at the grid cell nearest
 * `at`. Synchronous and CPU-only -- `tex` is the same Data3DTexture
 * FrameCache already handed the caller for rendering, so this costs no
 * network request beyond what displaying that Frame already paid for.
 *
 * Does NOT exclude categorical Variables (Koppen): unlike Time Series's
 * area-weighted mean, this never combines cells, so a class-index Variable
 * is exactly as queryable as a continuous one -- see ADR-0011.
 */
export function monthProfile(
  tex: Data3DTexture, res: ResolutionInfo, variable: VariableInfo, at: LonLat,
  rule?: NoDataRule,
): CellSample[] {
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const idx = texelIndex(nlon, nlat, at.lon, at.lat);
  const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));
  const data = tex.image.data as Uint8Array;

  const out: CellSample[] = new Array(ndepth);
  for (let d = 0; d < ndepth; d++) {
    const byte = data[d * plane + idx];
    out[d] = { cell, value: isInvalid(idx, byte, rule) ? NaN : texelToPhysical(variable, byte) };
  }
  return out;
}

/**
 * Age Series (point): one value per Frame of `manifest`, at the grid cell
 * nearest `at`, Annual layer only -- same reasoning as
 * core/timeSeries.ts's computeTimeSeries: a "how has this cell changed
 * across geological time" question, not tied to whichever Month the
 * scrubbable slider currently shows.
 *
 * Reads Frame bytes through `cache` (core/frameByteCache.ts), the same
 * shared cache computeTimeSeries uses, so a session with both a Time Series
 * panel and an Anchored Point open on the same (model, variable,
 * resolution) fetches each Frame's bytes once, not twice.
 */
export async function ageSeries(
  cache: FrameByteCache, manifest: Manifest, variable: VariableInfo, at: LonLat,
  resolutionId: string = manifest.default_resolution,
): Promise<(CellSample & { age: number })[]> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId);
  if (!res) throw new Error(`${manifest.id}: no resolution ${resolutionId}`);
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const layerOffset = (ndepth - 1) * plane;
  const maskVar = manifest.mask_variable;
  const sentinel = manifest.no_data_sentinel;

  const idx = texelIndex(nlon, nlat, at.lon, at.lat);
  const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));

  return mapPool(manifest.frames, CONCURRENCY, async (frame) => {
    const [valueBytes, maskBytes] = await Promise.all([
      cache.get(manifest, variable.id, frame.id, resolutionId),
      maskVar ? cache.get(manifest, maskVar, frame.id, resolutionId) : Promise.resolve(null),
    ]);
    const byte = valueBytes[layerOffset + idx];
    const invalid = isInvalid(idx, byte, { maskBytes, sentinel });
    return { age: frame.age_ma, cell, value: invalid ? NaN : texelToPhysical(variable, byte) };
  });
}
