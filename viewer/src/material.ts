import {
  ShaderMaterial, DoubleSide, Vector3, Color, LinearSRGBColorSpace,
  type Texture, type Data3DTexture,
} from 'three';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';

/**
 * Specify a colour that lands on screen as the literal hex given.
 *
 * These are raw ShaderMaterials writing gl_FragColor directly, so they never
 * receive the linear->sRGB output conversion three.js injects into its own
 * materials. `new Color(hex)` would convert the hex from sRGB into the linear
 * working space, and that darker value would then be written verbatim --
 * 0x555555 arriving on screen as 0x171717. Declaring the hex as already being
 * in the working space keeps it untouched, which matches how the colormap
 * texture bytes flow through this pipeline.
 */
export function passthroughColor(hex: number): Color {
  return new Color().setHex(hex, LinearSRGBColorSpace);
}

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * One material for every volume-sampled surface: the cutaway walls, the floor
 * cap, and later the standalone profiles and depth slices. The geometry is the
 * only thing that changes, so the fragment shader works purely from world
 * position -- there is no flat texture being stretched and therefore no
 * convergence distortion as the section narrows toward the centre.
 */
const FRAG = /* glsl */ `
precision highp sampler3D;

${GEOGRAPHIC_GLSL}

uniform sampler3D uVolume;
uniform sampler2D uColormap;
uniform sampler2D uMask;
uniform vec3  uGrid;         // nlon, nlat, ndepth
uniform float uDepthMin;     // km -- the MODEL's valid range, not the mantle's
uniform float uDepthMax;
uniform float uClipLo;       // encoded 0..1 space
uniform float uClipHi;
uniform vec3  uNoDataColor;
uniform float uUseMask;      // 0 = ignore, 1 = keep inside cut, -1 = keep outside
uniform float uOpacity;
uniform float uDebug;   // 0 off, 1 pDep, 2 lat, 3 raw sample

varying vec3 vWorldPos;

void main() {
  vec2 ll = worldToGeographic(vWorldPos);

  if (uUseMask != 0.0) {
    float m = texture(uMask, geographicToUV(ll)).r;
    // uUseMask > 0: this surface exists only inside the cut (floor).
    // uUseMask < 0: this surface exists only outside it (globe surface).
    if (uUseMask > 0.0 ? (m < 0.5) : (m > 0.5)) discard;
  }

  float depth = worldDepthKm(vWorldPos);

  // Outside the model's valid depth range: say so, don't fabricate. The half
  // kilometre of slack matters: the floor cap is placed exactly at the base of
  // the volume, so without it float rounding tips those fragments into the
  // no-data branch and paints the whole cutaway floor grey.
  if (depth < uDepthMin - 0.5 || depth > uDepthMax + 0.5) {
    gl_FragColor = vec4(uNoDataColor, uOpacity);
    return;
  }

  vec3 uvw = volumeUVW(ll, depth, uDepthMin, uDepthMax, uGrid);
  float v = texture(uVolume, uvw).r;

  if (uDebug > 0.5) {
    // Display-only, so restating the normalisations here is harmless; the
    // sampling that has to agree with the isosurface goes through volumeUVW.
    float pLat = (ll.y + PI * 0.5) / PI;
    float pDep = clamp((depth - uDepthMin) / (uDepthMax - uDepthMin), 0.0, 1.0);
    float d = uDebug < 1.5 ? pDep : (uDebug < 2.5 ? pLat : v);
    gl_FragColor = vec4(vec3(d), 1.0);
    return;
  }

  float t = clamp((v - uClipLo) / (uClipHi - uClipLo), 0.0, 1.0);
  gl_FragColor = vec4(texture(uColormap, vec2(t, 0.5)).rgb, uOpacity);
}
`;

export type MaskMode = 'none' | 'inside' | 'outside';

export function createVolumeSurfaceMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
    transparent: false,
    uniforms: {
      uVolume: { value: null as Data3DTexture | null },
      uColormap: { value: null as Texture | null },
      uMask: { value: null as Texture | null },
      uGrid: { value: new Vector3(360, 181, 192) },
      uDepthMin: { value: 0 },
      uDepthMax: { value: 2840 },
      uClipLo: { value: 0 },
      uClipHi: { value: 1 },
      uNoDataColor: { value: passthroughColor(0x555555) },
      uUseMask: { value: 0 },
      uOpacity: { value: 1 },
      uDebug: { value: 0 },
    },
  });
}

export function setMaskMode(mat: ShaderMaterial, mode: MaskMode): void {
  mat.uniforms.uUseMask.value =
    mode === 'none' ? 0 : mode === 'inside' ? 1 : -1;
}
