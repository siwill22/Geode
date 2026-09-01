import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, NearestFilter,
  RepeatWrapping, ClampToEdgeWrapping, DataTexture, RGBAFormat,
} from 'three';
import type {
  ArchiveIndex, ColormapData, FrameInfo, Manifest, VariableInfo,
} from './types';

export async function loadArchive(base: string): Promise<ArchiveIndex> {
  const r = await fetch(`${base}/archive.json`);
  if (!r.ok) throw new Error(`archive.json: ${r.status}`);
  return r.json();
}

export async function loadManifest(base: string, path: string): Promise<Manifest> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export async function loadColormaps(base: string, path: string): Promise<ColormapData> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/**
 * Build the 256x1 colour ramp texture.
 *
 * The .cpt files already carry all 256 entries, so prep copies them verbatim
 * and we upload them verbatim -- no interpolation anywhere. These maps are
 * perceptually uniform because of their specific sampling; re-deriving them
 * from a sparse subset would quietly destroy that.
 */
export function makeColormapTexture(colors: [number, number, number][]): DataTexture {
  const n = colors.length;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4 + 0] = colors[i][0];
    data[i * 4 + 1] = colors[i][1];
    data[i * 4 + 2] = colors[i][2];
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, n, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function resolvePath(m: Manifest, variable: string, frame: string): string {
  return m.path_template
    .replace('{variable}', variable)
    .replace('{resolution}', m.default_resolution)
    .replace('{frame}', frame);
}

/**
 * Fetch a volume's bytes, transparently un-gzipping a `.bin.gz` frame.
 *
 * The deployed archive stores volumes gzipped (prep/pack_deploy.mjs) because a
 * CDN will not compress application/octet-stream for us, and these files halve.
 * The manifest's path_template carries the `.gz`, so nothing else has to know.
 *
 * The extension alone is NOT enough to decide whether to decompress. A server
 * may serve a .gz file with `Content-Encoding: gzip`, in which case the browser
 * has already decoded it by the time we see the bytes -- and decompressing
 * again fails. Browsers strip Content-Encoding from the readable headers, so we
 * cannot ask; instead we look for the gzip magic number in the bytes we
 * actually got. That is correct under either transport, which is what lets the
 * dev server and GitHub Pages disagree about this without anyone noticing.
 */
async function fetchVolumeBytes(path: string): Promise<Uint8Array> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());

  const gzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!path.endsWith('.gz') || !gzipped) return raw;

  const stream = new Blob([raw as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Load one volume as a Data3DTexture.
 *
 * Memory order is longitude fastest, then latitude, then depth -- which is what
 * Data3DTexture expects for (width, height, depth). RepeatWrapping on S so that
 * profiles crossing the antimeridian interpolate across the seam; clamp on T
 * and R so the poles and the top/bottom levels do not wrap into each other.
 *
 * Categorical variables (e.g. Köppen class) use NearestFilter instead: their
 * texel values are class indices, not samples of a continuous field, so
 * blending two neighbouring classes' bytes produces a meaningless third
 * class rather than an in-between physical value.
 */
export async function loadVolume(
  base: string,
  modelId: string,
  manifest: Manifest,
  variableId: string,
  frameId: string,
): Promise<Data3DTexture> {
  const res = manifest.resolutions.find((r) => r.id === manifest.default_resolution)!;
  const path = `${base}/models/${modelId}/${resolvePath(manifest, variableId, frameId)}`;
  const buf = await fetchVolumeBytes(path);

  const expected = res.nlon * res.nlat * res.ndepth;
  if (buf.length !== expected) {
    throw new Error(`${path}: got ${buf.length} bytes, expected ${expected}`);
  }

  const categorical = manifest.variables.find((v) => v.id === variableId)?.categorical ?? false;
  const filter = categorical ? NearestFilter : LinearFilter;

  const tex = new Data3DTexture(buf, res.nlon, res.nlat, res.ndepth);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = filter;
  tex.minFilter = filter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** The frame whose age is closest to `age`. Frames need not be evenly spaced. */
export function nearestFrame(m: Manifest, age: number): FrameInfo {
  let best = m.frames[0];
  let bestGap = Math.abs(best.age_ma - age);
  for (const f of m.frames) {
    const gap = Math.abs(f.age_ma - age);
    if (gap < bestGap) { best = f; bestGap = gap; }
  }
  return best;
}

/**
 * Volume frames, kept as GPU textures with an LRU bound.
 *
 * A convection series is one 12 MB texture per age, so it can neither be
 * preloaded whole nor re-fetched on every slider move. Four frames is enough to
 * hold the current one plus its neighbours in both directions, which is the
 * access pattern scrubbing actually produces.
 *
 * The frame on screen is pinned: evicting a texture still bound to a material's
 * uVolume would leave the wall sampling a disposed texture.
 */
const FRAME_LIMIT = 4;

export class FrameCache {
  private lru = new Map<string, Data3DTexture>();
  private inflight = new Map<string, Promise<Data3DTexture>>();
  private pinned: string | null = null;

  constructor(private base: string) {}

  private key(m: Manifest, variableId: string, frameId: string): string {
    return `${m.id}/${variableId}/${m.default_resolution}/${frameId}`;
  }

  async get(m: Manifest, variableId: string, frameId: string): Promise<Data3DTexture> {
    const k = this.key(m, variableId, frameId);

    const hit = this.lru.get(k);
    if (hit) {                       // refresh recency
      this.lru.delete(k);
      this.lru.set(k, hit);
      return hit;
    }
    const pending = this.inflight.get(k);
    if (pending) return pending;

    const p = loadVolume(this.base, m.id, m, variableId, frameId)
      .then((tex) => {
        this.lru.set(k, tex);
        this.inflight.delete(k);
        this.evict();
        return tex;
      })
      .catch((e) => { this.inflight.delete(k); throw e; });
    this.inflight.set(k, p);
    return p;
  }

  /** Mark a frame as on-screen so it survives eviction. */
  pin(m: Manifest, variableId: string, frameId: string): void {
    this.pinned = this.key(m, variableId, frameId);
  }

  /** Warm the neighbours of `frameId` in the background; failures are ignored. */
  prefetchNeighbours(m: Manifest, variableId: string, frameId: string): void {
    const i = m.frames.findIndex((f) => f.id === frameId);
    if (i < 0) return;
    for (const j of [i + 1, i - 1]) {
      if (j >= 0 && j < m.frames.length) {
        void this.get(m, variableId, m.frames[j].id).catch(() => {});
      }
    }
  }

  private evict(): void {
    for (const k of [...this.lru.keys()]) {
      if (this.lru.size <= FRAME_LIMIT) break;
      if (k === this.pinned) continue;
      this.lru.get(k)!.dispose();
      this.lru.delete(k);
    }
  }
}

/** Physical value -> the 0..1 space the shader clips in. */
export function physicalToEncoded(v: VariableInfo, x: number): number {
  return (x - v.encode_min) / (v.encode_max - v.encode_min);
}

/** A raw uint8 texel (0..255) -> the physical value it encodes. Inverse of
 *  physicalToEncoded's mapping, for CPU-side reads of a Data3DTexture's own
 *  backing buffer (see core/windGlyphs.ts) rather than the GPU shader path. */
export function texelToPhysical(v: VariableInfo, byte: number): number {
  return v.encode_min + (byte / 255) * (v.encode_max - v.encode_min);
}

/** (lon, lat) -> the flat index into one month's (nlat, nlon) plane. Mirrors
 *  geographic.ts's volumeUVW mapping exactly (see GEOGRAPHIC_GLSL): no
 *  half-texel offset on longitude (it wraps, no duplicate column), nearest
 *  gridline-registered row on latitude. Shared by every CPU-side consumer of
 *  a wind plane's raw bytes (core/windGlyphs.ts, core/windStreaks.ts) so the
 *  two can never drift apart on this mapping. */
export function texelIndex(nlon: number, nlat: number, lon: number, lat: number): number {
  const pLon = (lon + 180) / 360;
  let iLon = Math.floor(pLon * nlon) % nlon;
  if (iLon < 0) iLon += nlon;
  const pLat = (lat + 90) / 180;
  const jLat = Math.min(nlat - 1, Math.max(0, Math.round(pLat * (nlat - 1))));
  return jLat * nlon + iLon;
}
