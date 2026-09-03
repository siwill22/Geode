import { DEG } from './constants';
import { fetchVariableBytes, texelToPhysical } from './volume';
import type { Manifest, VariableInfo } from './types';

export interface TimeSeriesPoint {
  age: number;
  /** Area-weighted global mean, or NaN if every texel at this Frame was
   *  masked/no-data -- callers must skip NaN points (a gap), not plot them
   *  as zero. */
  mean: number;
}

/** How many Frames to fetch/reduce at once -- bounded so a 100+ Frame model
 *  doesn't fire that many simultaneous requests, but high enough that this
 *  doesn't read as one-request-at-a-time slow. Not tied to FrameCache's
 *  FRAME_LIMIT (GPU-residency concern, irrelevant here -- see
 *  fetchVariableBytes's own doc comment). */
const CONCURRENCY = 8;

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The area-weighted (cos(lat)) global mean of `variable` at every Frame in
 * `manifest`, one point per Frame, in Frame order (not necessarily sorted by
 * age -- see manifest.frames).
 *
 * Reads ONE fixed layer per Frame -- index (ndepth - 1), which is the
 * Annual mean for a climate manifest (prep_climate.py always appends it
 * last) and the only layer for a single-layer one (paleogeography) -- not
 * whichever month `view.month` currently selects. A time-series overview
 * answers "how does the long-term mean move through geological time", a
 * different question from "what does this one season look like right now";
 * tying it to the scrubbable month would also mean recomputing on every
 * month drag, for a chart meant to be computed once and left alone.
 *
 * Honours the model's own validity mask if it has one (manifest.mask_variable,
 * e.g. Pohl's continental-only coverage) -- an unmasked mean would silently
 * average in whatever garbage bytes fill the ocean texels of a run that never
 * computed them, the same "say so, don't fabricate" principle the shader's
 * own uValidMask enforces on screen. The mask has no depth axis of its own
 * (broadcast identically across every layer at prep time -- see
 * loadMask2D's doc comment), so it's read from its own layer 0 regardless of
 * which layer `variable` itself is being read from.
 */
export async function computeTimeSeries(
  archiveBase: string, modelId: string, manifest: Manifest, variable: VariableInfo,
  resolutionId: string = manifest.default_resolution,
): Promise<TimeSeriesPoint[]> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId);
  if (!res) throw new Error(`${modelId}: no resolution ${resolutionId}`);
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const layerOffset = (ndepth - 1) * plane;
  const maskVar = manifest.mask_variable;
  const sentinel = manifest.no_data_sentinel;

  return mapPool(manifest.frames, CONCURRENCY, async (frame) => {
    const [valueBytes, maskBytes] = await Promise.all([
      fetchVariableBytes(archiveBase, modelId, manifest, variable.id, frame.id, resolutionId),
      maskVar
        ? fetchVariableBytes(archiveBase, modelId, manifest, maskVar, frame.id, resolutionId)
        : Promise.resolve(null),
    ]);

    let weightSum = 0;
    let valueSum = 0;
    for (let j = 0; j < nlat; j++) {
      const lat = -90 + (j * 180) / (nlat - 1);
      const w = Math.cos(lat * DEG);
      const rowBase = j * nlon;
      for (let i = 0; i < nlon; i++) {
        // Mirrors material.ts's uValidMask check (byte >= 128 -- half of
        // 255 -- is the raw-byte equivalent of the shader's `valid >= 0.5`
        // on the GPU-normalised sample).
        if (maskBytes && maskBytes[rowBase + i] < 128) continue;
        const byte = valueBytes[layerOffset + rowBase + i];
        if (sentinel !== undefined && byte === sentinel) continue;
        valueSum += w * texelToPhysical(variable, byte);
        weightSum += w;
      }
    }
    return { age: frame.age_ma, mean: weightSum > 0 ? valueSum / weightSum : NaN };
  });
}
