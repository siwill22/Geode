import {
  ShaderMaterial, DoubleSide, Vector3, Color, LinearSRGBColorSpace,
  type Texture, type Data3DTexture,
} from 'three';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';
import { PROJECTION_UNIFORM, type ProjectionMode } from './projection';

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
${GEOGRAPHIC_GLSL}

uniform vec4 uRefQuat;
varying vec3 vGeoPos;

void main() {
  // vGeoPos: this vertex's TRUE, unrotated position -- what the fragment
  // shader samples the volume/mask against, always. gl_Position: this
  // vertex's REFERENCE-PLATE-ROTATED position -- where it actually renders.
  // Reanchoring the view must not reanchor the DATA (see docs/adr/0030 and
  // ADR-0001: a volume is never reconstructed), only where it's drawn --
  // splitting these here is what keeps that true.
  vGeoPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 rotated = rotateByQuat(uRefQuat, position);
  vec4 wp = modelMatrix * vec4(rotated, 1.0);
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
uniform sampler2D uValidMask;
uniform vec3  uGrid;         // nlon, nlat, ndepth
uniform float uDepthMin;     // km -- the MODEL's valid range, not the mantle's
uniform float uDepthMax;
uniform float uSliceDepthKm;  // km -- used only when uUseSliceDepth > 0.5
uniform float uUseSliceDepth; // 0 = derive depth from world position (wall/floor), 1 = fixed slice depth
uniform float uClipLo;       // encoded 0..1 space
uniform float uClipHi;
uniform vec3  uNoDataColor;
uniform vec3  uSparseNoDataColor;
uniform float uNoDataSentinel;   // encoded 0..1 space; <0 disables this check
uniform float uSparseNoDataMode; // 0 = colour fill (uSparseNoDataColor), 1 = discard (transparent)
uniform float uUseMask;      // 0 = ignore, 1 = keep inside cut, -1 = keep outside
uniform float uUseValidMask; // 0 = ignore, 1 = discard where uValidMask < 0.5
uniform float uValidMaskOceanFallback; // 1 = paint class-0 colour instead of discarding (see below)
uniform float uOpacity;
uniform float uSteps;   // 0 = continuous ramp, else this many discrete bands
uniform float uDebug;   // 0 off, 1 pDep, 2 lat, 3 raw sample
uniform float uProjectionMode; // 0 = globe (sphere), 1 = plate carree (flat plane) -- see core/projection.ts

varying vec3 vGeoPos;

void main() {
  vec2 ll = uProjectionMode > 0.5 ? worldToGeographicFlat(vGeoPos) : worldToGeographic(vGeoPos);

  if (uUseMask != 0.0) {
    float m = texture(uMask, geographicToUV(ll)).r;
    // uUseMask > 0: this surface exists only inside the cut (floor).
    // uUseMask < 0: this surface exists only outside it (globe surface).
    if (uUseMask > 0.0 ? (m < 0.5) : (m > 0.5)) discard;
  }

  // A per-texel validity mask, for a model that doesn't cover the whole
  // sphere (e.g. a continental-only climate run) -- distinct from uMask
  // above (a static cutaway polygon): this one is per-age data, sourced the
  // same way as the primary field itself. Same "say so, don't fabricate"
  // principle as the no-data-depth branch below, just along the horizontal
  // axis instead of the vertical one. See climateInstance.ts.
  if (uUseValidMask > 0.5) {
    float valid = texture(uValidMask, geographicToUV(ll)).r;
    if (valid < 0.5) {
      // A continental-only model's own coverage gap is, by definition, ocean
      // for a Koppen-shaped categorical variable (class 0 is always "Ocean"
      // -- see class_names' own authored convention, checked in
      // climateInstance.ts's applyClip()) -- painting that class's colour
      // here instead of leaving the fragment unwritten keeps the model's own
      // coverage gap from reading as a hole in the sphere (DoubleSide
      // geometry means a discarded near-side fragment otherwise exposes the
      // far hemisphere straight through the globe). Every other variable
      // (temperature, precipitation, ...) has no such fallback value to
      // assume, so it still discards.
      if (uValidMaskOceanFallback > 0.5 && uSteps >= 2.0) {
        gl_FragColor = vec4(texture(uColormap, vec2(0.5 / uSteps, 0.5)).rgb, uOpacity);
        return;
      }
      discard;
    }
  }

  // A depth slice supplies its depth directly instead of deriving it from
  // where the fragment sits in space -- see depthSlice.ts. Every other
  // volume surface (wall, floor) leaves uUseSliceDepth at 0 and this reduces
  // to the original line.
  float depth = uUseSliceDepth > 0.5 ? uSliceDepthKm : worldDepthKm(vGeoPos);

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

  // A per-texel NO-DATA sentinel (byte 255; see ADR-0005), for a model
  // where absence of data is the common case rather than a thin edge case
  // -- distinct from the depth-out-of-range branch above, which every model
  // already had. Disabled (uNoDataSentinel < 0) for any model that doesn't
  // declare one, so a legitimate encoded value here is never mistaken for
  // absence; a separate colour uniform from uNoDataColor so this toggle can
  // never bleed into the unrelated depth-range case above.
  //
  // The threshold must sit strictly between byte 254 (the highest value
  // real data ever clamps to) and byte 255 (the sentinel): those two are
  // only 1/255 = 0.00392 apart in this normalised space. A 0.004 margin
  // here first shipped wider than that gap and caught byte 254 too,
  // silently discarding every texel clamped to the top of its own clip
  // range as if it were absent -- confirmed by decoding the actual written
  // bytes, the same discipline the Koppen off-by-one fix used, after a real
  // render showed data going transparent where its encoded bytes were
  // fine. 0.002 sits exactly between the two.
  if (uNoDataSentinel >= 0.0 && v > uNoDataSentinel - 0.002) {
    if (uSparseNoDataMode > 0.5) discard;
    gl_FragColor = vec4(uSparseNoDataColor, uOpacity);
    return;
  }

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

  // Discrete bands: quantise the ramp coordinate, not the colour, so the bands
  // are cut in the same clipped space the smooth ramp uses and the boundaries
  // land on round fractions of the clip range.
  //
  // Sample each band at its CENTRE. Sampling at the edge would read the colour
  // of the boundary between two bands -- a value that belongs to neither and
  // that shifts as the band count changes. min() rather than a clamp after the
  // fact because t == 1.0 floors to n and would otherwise wrap past the last
  // band into the ramp's final texel.
  if (uSteps >= 2.0) {
    t = (min(floor(t * uSteps), uSteps - 1.0) + 0.5) / uSteps;
  }

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
      uValidMask: { value: null as Texture | null },
      uGrid: { value: new Vector3(360, 181, 192) },
      uDepthMin: { value: 0 },
      uDepthMax: { value: 2840 },
      uSliceDepthKm: { value: 0 },
      uUseSliceDepth: { value: 0 },
      uClipLo: { value: 0 },
      uClipHi: { value: 1 },
      uNoDataColor: { value: passthroughColor(0x555555) },
      uSparseNoDataColor: { value: passthroughColor(0x555555) },
      uNoDataSentinel: { value: -1 },
      uSparseNoDataMode: { value: 0 },
      uUseMask: { value: 0 },
      uUseValidMask: { value: 0 },
      uValidMaskOceanFallback: { value: 0 },
      uOpacity: { value: 1 },
      uSteps: { value: 0 },
      uDebug: { value: 0 },
      uProjectionMode: { value: 0 },
      uRefQuat: { value: [0, 0, 0, 1] },
    },
  });
}

/** Set this material's Reference Plate rotation -- `q` must already be a
 *  RENDER-frame quaternion (core/rotation.ts's toRenderFrameRotation()), not
 *  the raw geographic-frame one referenceRotationAt() returns. See
 *  docs/adr/0030. */
export function setReferenceRotation(mat: ShaderMaterial, q: readonly [number, number, number, number]): void {
  mat.uniforms.uRefQuat.value = q;
}

/** Switch this material's worldToGeographic branch -- see core/projection.ts.
 *  Geometry is a separate concern (see DepthSlice.setProjection()); this only
 *  flips which inverse the fragment shader uses to turn a fragment's world
 *  position back into (lon, lat). */
export function setProjectionMode(mat: ShaderMaterial, mode: ProjectionMode): void {
  mat.uniforms.uProjectionMode.value = PROJECTION_UNIFORM[mode];
}

export function setMaskMode(mat: ShaderMaterial, mode: MaskMode): void {
  mat.uniforms.uUseMask.value =
    mode === 'none' ? 0 : mode === 'inside' ? 1 : -1;
}

/** How a per-texel NO-DATA sentinel is painted -- see ADR-0005. Not every
 *  model has one; setNoDataSentinel(mat, undefined) disables the check
 *  entirely regardless of which style is set here. */
export type NoDataStyle = 'transparent' | 'grey' | 'white';

/** Declare which byte (0-255, from the manifest's own `no_data_sentinel`) a
 *  volume reserves for "no value here" -- undefined for a model that
 *  doesn't reserve one, which disables the check so a legitimate encoded
 *  value can never be mistaken for absence. */
export function setNoDataSentinel(mat: ShaderMaterial, sentinel: number | undefined): void {
  mat.uniforms.uNoDataSentinel.value = sentinel === undefined ? -1 : sentinel / 255;
}

export function setNoDataStyle(mat: ShaderMaterial, style: NoDataStyle): void {
  mat.uniforms.uSparseNoDataMode.value = style === 'transparent' ? 1 : 0;
  mat.uniforms.uSparseNoDataColor.value =
    passthroughColor(style === 'white' ? 0xffffff : 0xcccccc);
}

/** Set/clear this material's per-texel validity mask -- see uValidMask's
 *  shader-side doc comment. `texture` null both disables the check and
 *  clears the uniform, so a stale texture from a previously-active model
 *  never lingers bound once masking turns off. */
export function setValidMask(mat: ShaderMaterial, texture: Texture | null): void {
  mat.uniforms.uValidMask.value = texture;
  mat.uniforms.uUseValidMask.value = texture ? 1 : 0;
}
