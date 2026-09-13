import {
  BackSide, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3,
  type Camera, type Color, type Data3DTexture,
} from 'three';
import { GEOGRAPHIC_GLSL } from '../core/glsl/geographic';
import { passthroughColor } from '../core/material';
import { depthToRadius, LIGHT_DIR } from '../core/constants';

/**
 * The proxy sphere is scaled slightly beyond the shell it stands for.
 *
 * It is a tessellated sphere, so its faces chord INSIDE the true sphere, worst
 * at the silhouette -- exactly where the shell is thinnest and most interesting.
 * The march interval comes from an analytic ray/sphere intersection, so the
 * proxy only has to guarantee coverage; oversizing it costs nothing and closes
 * the sliver at the limb.
 */
const PROXY_SLACK = 1.02;

/** Ceiling on the marched sample count. The shader's loop bound must be const. */
export const MAX_STEPS = 512;

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * Two isosurfaces, found by raymarching the volume.
 *
 * Every other volume-sampled surface in Geode is a real piece of geometry with
 * the field evaluated on it. An isosurface is the opposite: the geometry is what
 * we are looking for, so each ray steps through the shell until the field
 * crosses an isovalue, then bisects to find where.
 *
 * Both isovalues are tested in ONE march. That is not only cheaper than two
 * passes -- it also makes the depth ordering between the two surfaces correct by
 * construction, since whichever crosses first along the ray is the one drawn.
 * They can never intersect: one bounds `v < cold`, the other `v > hot`.
 */
const FRAG = /* glsl */ `
precision highp sampler3D;

${GEOGRAPHIC_GLSL}

uniform sampler3D uVolume;
uniform vec3  uGrid;            // nlon, nlat, ndepth
uniform float uDepthMin;        // the MODEL's valid range, km
uniform float uDepthMax;
uniform float uRadiusOuter;     // the marched shell, world units
uniform float uRadiusInner;
uniform vec2  uIso;             // encoded 0..1 space: x = cold, y = hot
uniform vec2  uEnabled;         // 0 or 1 per surface
uniform vec3  uColdColor;
uniform vec3  uHotColor;
uniform vec3  uLightDir;
uniform float uSteps;
uniform float uNormalEps;       // world units
uniform mat4  uProjectionMatrix;   // three injects viewMatrix, but not this one
uniform vec4  uRefQuat;         // see CONTEXT.md's Reference Plate entry and docs/adr/0030

varying vec3 vWorldPos;

const int STEP_LIMIT = ${MAX_STEPS};
const int BISECTIONS = 8;

/**
 * p arrives in DISPLAY space (the ray this shader marches never moves --
 * only which volume texel each point along it samples does). Un-rotating it
 * by uRefQuat's conjugate before the geographic lookup recovers which TRUE
 * point that display position corresponds to, exactly the fragment-shader
 * side of core/material.ts's Plate Carrée fix (see
 * docs/plans/reference-plate.md) -- except every point here is already a
 * genuine 3D position (raymarched, not a flat map's Cartesian encoding of
 * lon/lat), so the round-trip is the plain 3D rotation, no lon/lat
 * conversion needed either side of it.
 *
 * Doing this INSIDE sampleVolume (rather than rotating ro/rd once in
 * main()) is what keeps every caller -- marchSegment(), refine(),
 * gradient() -- correct for free: they all reason entirely in DISPLAY
 * space (ray parameter t along the unrotated camera ray), so pHit, the
 * lighting normal, and the depth written at the end are automatically in
 * the right place for the scene's other Reference-Plate-rotated geometry
 * (coastlines, cutaway walls) to sort and align against -- only the
 * TEXTURE LOOKUP itself needs to land on the true, unrotated data.
 */
float sampleVolume(vec3 p) {
  vec3 pTrue = rotateByQuat(conjugateQuat(uRefQuat), p);
  vec2 ll = worldToGeographic(pTrue);
  vec3 uvw = volumeUVW(ll, worldDepthKm(pTrue), uDepthMin, uDepthMax, uGrid);
  return texture(uVolume, uvw).r;
}

/** Ray parameters of the two intersections with a sphere centred on the origin. */
bool raySphere(vec3 ro, vec3 rd, float R, out float t0, out float t1) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  t0 = -b - s;
  t1 = -b + s;
  return true;
}

bool crosses(float a, float b, float iso) {
  return (a - iso) * (b - iso) <= 0.0;
}

/**
 * Bisect the bracketing step. Without this the surface is quantised to the step
 * size and terraces visibly, which reads as structure in the data.
 */
float refine(vec3 ro, vec3 rd, float ta, float va, float tb, float iso) {
  for (int i = 0; i < BISECTIONS; i++) {
    float tm = 0.5 * (ta + tb);
    float vm = sampleVolume(ro + rd * tm);
    if (crosses(va, vm, iso)) {
      tb = tm;
    } else {
      ta = tm;
      va = vm;
    }
  }
  return 0.5 * (ta + tb);
}

bool marchSegment(
  vec3 ro, vec3 rd, vec2 seg, float dt, out float tHit, out float isHot
) {
  tHit = 0.0;
  isHot = 0.0;
  if (seg.y <= seg.x) return false;

  float tPrev = seg.x;
  float vPrev = sampleVolume(ro + rd * tPrev);

  for (int i = 1; i <= STEP_LIMIT; i++) {
    float t = min(seg.x + dt * float(i), seg.y);
    float v = sampleVolume(ro + rd * t);

    bool hitCold = uEnabled.x > 0.5 && crosses(vPrev, v, uIso.x);
    bool hitHot  = uEnabled.y > 0.5 && crosses(vPrev, v, uIso.y);
    if (hitCold || hitHot) {
      // Both thresholds inside a single step. Under the linear interpolation
      // the step already assumes, the one nearer the entry value comes first.
      bool takeHot = hitHot
        && (!hitCold || abs(vPrev - uIso.y) < abs(vPrev - uIso.x));
      tHit = refine(ro, rd, tPrev, vPrev, t, takeHot ? uIso.y : uIso.x);
      isHot = takeHot ? 1.0 : 0.0;
      return true;
    }

    tPrev = t;
    vPrev = v;
    if (t >= seg.y) break;
  }
  return false;
}

/**
 * Central differences in WORLD space, not texture space. Differencing in
 * texture space would need the Jacobian of the spherical mapping, which is
 * singular at the poles -- the normals there would be wrong in a way that looks
 * like a lighting artefact rather than a bug.
 */
vec3 gradient(vec3 p, float e) {
  return vec3(
    sampleVolume(p + vec3(e, 0.0, 0.0)) - sampleVolume(p - vec3(e, 0.0, 0.0)),
    sampleVolume(p + vec3(0.0, e, 0.0)) - sampleVolume(p - vec3(0.0, e, 0.0)),
    sampleVolume(p + vec3(0.0, 0.0, e)) - sampleVolume(p - vec3(0.0, 0.0, e))
  );
}

void main() {
  if (uEnabled.x + uEnabled.y < 0.5) discard;

  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - cameraPosition);

  float o0, o1;
  if (!raySphere(ro, rd, uRadiusOuter, o0, o1) || o1 <= 0.0) discard;
  o0 = max(o0, 0.0);

  // The inner radius punches a hole through the shell, so a ray that enters it
  // is marched as two intervals: in to the hole, then -- only if nothing was
  // found -- out the far side.
  float i0, i1;
  bool inner = raySphere(ro, rd, uRadiusInner, i0, i1) && i1 > 0.0;
  vec2 segA = vec2(o0, inner ? clamp(i0, o0, o1) : o1);
  vec2 segB = inner ? vec2(clamp(i1, o0, o1), o1) : vec2(0.0, -1.0);

  // One step size for the whole traversal, so the sampling density does not
  // change between the near and far halves of the shell.
  float dt = max((o1 - o0) / max(uSteps, 1.0), 1e-6);

  float tHit, isHot;
  if (!marchSegment(ro, rd, segA, dt, tHit, isHot)
      && !marchSegment(ro, rd, segB, dt, tHit, isHot)) discard;

  vec3 pHit = ro + rd * tHit;

  // The cold surface encloses low values, so its outward normal follows the
  // gradient; the hot surface encloses high ones, so its outward normal opposes
  // it. On a first hit from outside, both end up facing the camera.
  vec3 g = gradient(pHit, uNormalEps);
  vec3 n = length(g) < 1e-8 ? -rd : normalize(isHot > 0.5 ? -g : g);

  vec3 base = isHot > 0.5 ? uHotColor : uColdColor;
  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
  gl_FragColor = vec4(base * (0.32 + 0.68 * ndl * ndl) + base * rim * 0.35, 1.0);

  // The hit is found by marching, so the fragment MUST report the hit's depth.
  // Left at the rasterised proxy depth the isosurface would sort against the
  // core, walls and floor by the position of a sphere it is nowhere near, and
  // would punch straight through the core.
  //
  // Writing gl_FragDepth also disables early depth testing, which is what makes
  // an oversized back-face proxy safe: fragments behind the core still reach
  // this shader and can resolve in front of it.
  //
  // THIS IS THE ORDINARY NDC DEPTH, NOT three.js's LOGARITHMIC ONE, and that is
  // deliberate. The renderer is constructed with logarithmicDepthBuffer: true,
  // but every material in this viewer is a hand-written ShaderMaterial and none
  // of them include <logdepthbuf_vertex> / <logdepthbuf_fragment>, so none of
  // them write a log depth -- they all leave gl_FragCoord.z alone. The flag is
  // therefore inert for this scene, and a fragment that helpfully wrote the
  // log2 curve would be comparing itself against a completely different depth
  // encoding: at a typical camera distance it evaluates to ~0.26 where the
  // walls and floor sit at ~0.99, so the isosurface would win every depth test
  // and float in front of everything. Match the scene, not the flag; if the
  // other materials ever adopt the log chunks, this has to move with them.
  vec4 clip = uProjectionMatrix * viewMatrix * vec4(pHit, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
}
`;

/**
 * Which physical extreme is warm-coloured. Temperature-like variables put
 * red at the high end (hot); velocity-like variables (seismic Vp/Vs, flow
 * speed) put red at the LOW end instead -- a fast anomaly is a cold one, so
 * blue has to track the high value there, not the low one.
 */
export type IsoPolarity = 'hot' | 'fast';

const LOW_COLOR = 0x4d7fd6;  // blue
const HIGH_COLOR = 0xd6553a; // red/orange

export interface IsosurfaceState {
  coldEnabled: boolean;
  hotEnabled: boolean;
  /** Isovalues in the variable's own physical units. */
  coldValue: number;
  hotValue: number;
  /** The shell searched, in km. NOT the Cutaway's cut depth -- see CONTEXT.md. */
  depthMinKm: number;
  depthMaxKm: number;
  steps: number;
}

export const DEFAULT_ISOSURFACE: IsosurfaceState = {
  coldEnabled: false,
  hotEnabled: false,
  coldValue: -1,
  hotValue: 1,
  // Not the full shell. Any isovalue that resolves lower-mantle structure also
  // wraps the globe in a solid lithospheric shell, because the shallow mantle
  // is an order of magnitude more variable -- the first run would show an
  // opaque ball and nothing else. GPlates' own tutorial tells users to pull the
  // outer radius in for exactly this reason.
  depthMinKm: 200,
  depthMaxKm: 2800,
  steps: 128,
};

export class Isosurface {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  /** The loaded model's valid range; the shell is clamped into it. */
  private modelDepthMinKm = 0;
  private modelDepthMaxKm = 2840;
  private state: IsosurfaceState = { ...DEFAULT_ISOSURFACE };

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Back faces, so the proxy still rasterises with the camera inside it --
      // which it is whenever the user zooms in past the shell.
      side: BackSide,
      transparent: false,
      uniforms: {
        uVolume: { value: null as Data3DTexture | null },
        uGrid: { value: new Vector3(360, 181, 192) },
        uDepthMin: { value: 0 },
        uDepthMax: { value: 2840 },
        uRadiusOuter: { value: depthToRadius(DEFAULT_ISOSURFACE.depthMinKm) },
        uRadiusInner: { value: depthToRadius(DEFAULT_ISOSURFACE.depthMaxKm) },
        uIso: { value: new Vector2(0.25, 0.75) },
        uEnabled: { value: new Vector2(0, 0) },
        uColdColor: { value: passthroughColor(LOW_COLOR) },
        uHotColor: { value: passthroughColor(HIGH_COLOR) },
        uLightDir: { value: LIGHT_DIR.clone() },
        uSteps: { value: DEFAULT_ISOSURFACE.steps },
        // ~25 km: a little over one depth level, so the difference spans real
        // structure rather than quantisation noise.
        uNormalEps: { value: 0.004 },
        uProjectionMatrix: { value: null },
        uRefQuat: { value: [0, 0, 0, 1] },
      },
    });

    this.mesh = new Mesh(new SphereGeometry(1, 128, 64), this.mat);
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (_r, _s, camera: Camera) => {
      // projectionMatrix is not among the uniforms three injects into a
      // fragment shader, and the hit point has to be projected there.
      this.mat.uniforms.uProjectionMatrix.value = camera.projectionMatrix;
    };
    this.applyRadii();
  }

  get material(): ShaderMaterial { return this.mat; }

  setVolume(tex: Data3DTexture): void {
    this.mat.uniforms.uVolume.value = tex;
  }

  setGrid(nlon: number, nlat: number, ndepth: number): void {
    (this.mat.uniforms.uGrid.value as Vector3).set(nlon, nlat, ndepth);
  }

  /** The model's valid depth range. The marched shell is clamped into it. */
  setModelDepthRange(minKm: number, maxKm: number): void {
    this.modelDepthMinKm = minKm;
    this.modelDepthMaxKm = maxKm;
    this.mat.uniforms.uDepthMin.value = minKm;
    this.mat.uniforms.uDepthMax.value = maxKm;
    this.applyRadii();
  }

  /** Isovalues arrive already mapped into the shader's encoded 0..1 space. */
  setEncodedIso(cold: number, hot: number): void {
    (this.mat.uniforms.uIso.value as Vector2).set(cold, hot);
  }

  /** See CONTEXT.md's Reference Plate entry and docs/adr/0030 -- `q` must
   *  already be a render-frame quaternion (core/rotation.ts's
   *  toRenderFrameRotation()). Unlike core/material.ts's volume-draped
   *  surfaces, this needs no Projection branch: this wrapper is Globe-only,
   *  and sampleVolume()'s un-rotate happens on a genuine 3D position either
   *  way (see the FRAG shader's own doc comment). */
  setReferenceRotation(q: readonly [number, number, number, number]): void {
    this.mat.uniforms.uRefQuat.value = q;
  }

  /**
   * 'hot' keeps the low value blue / high value red (temperature-like).
   * 'fast' swaps them: the low (slow) surface is red, the high (fast) one
   * is blue, since a fast seismic anomaly is a cold one.
   */
  setPolarity(highMeans: IsoPolarity): void {
    const swapped = highMeans === 'fast';
    (this.mat.uniforms.uColdColor.value as Color).set(swapped ? HIGH_COLOR : LOW_COLOR);
    (this.mat.uniforms.uHotColor.value as Color).set(swapped ? LOW_COLOR : HIGH_COLOR);
  }

  update(s: IsosurfaceState): void {
    this.state = { ...s };
    (this.mat.uniforms.uEnabled.value as Vector2).set(
      s.coldEnabled ? 1 : 0, s.hotEnabled ? 1 : 0,
    );
    this.mat.uniforms.uSteps.value = Math.min(MAX_STEPS, Math.max(8, s.steps));
    this.mesh.visible = s.coldEnabled || s.hotEnabled;
    this.applyRadii();
  }

  private applyRadii(): void {
    const top = Math.max(this.state.depthMinKm, this.modelDepthMinKm);
    const bot = Math.min(this.state.depthMaxKm, this.modelDepthMaxKm);
    const rOuter = depthToRadius(top);
    const rInner = depthToRadius(Math.max(bot, top + 1));
    this.mat.uniforms.uRadiusOuter.value = rOuter;
    this.mat.uniforms.uRadiusInner.value = rInner;
    this.mesh.scale.setScalar(rOuter * PROXY_SLACK);
  }

  /** Effective shell, after clamping. Reported by the test hooks. */
  get shell(): { outer: number; inner: number } {
    return {
      outer: this.mat.uniforms.uRadiusOuter.value as number,
      inner: this.mat.uniforms.uRadiusInner.value as number,
    };
  }
}
