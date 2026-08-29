import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter,
  RepeatWrapping, ClampToEdgeWrapping, DataTexture, RGBAFormat,
} from 'three';
import type { ArchiveIndex, ColormapData, Manifest, VariableInfo } from './types';

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
 * Load one volume as a Data3DTexture.
 *
 * Memory order is longitude fastest, then latitude, then depth -- which is what
 * Data3DTexture expects for (width, height, depth). RepeatWrapping on S so that
 * profiles crossing the antimeridian interpolate across the seam; clamp on T
 * and R so the poles and the top/bottom levels do not wrap into each other.
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
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());

  const expected = res.nlon * res.nlat * res.ndepth;
  if (buf.length !== expected) {
    throw new Error(`${path}: got ${buf.length} bytes, expected ${expected}`);
  }

  const tex = new Data3DTexture(buf, res.nlon, res.nlat, res.ndepth);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Physical value -> the 0..1 space the shader clips in. */
export function physicalToEncoded(v: VariableInfo, x: number): number {
  return (x - v.encode_min) / (v.encode_max - v.encode_min);
}
