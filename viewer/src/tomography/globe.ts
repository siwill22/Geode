import {
  Mesh, SphereGeometry, MeshBasicMaterial, ShaderMaterial, TextureLoader,
  NoColorSpace, RepeatWrapping, ClampToEdgeWrapping, LinearFilter,
  type Texture,
} from 'three';
import { passthroughColor } from '../core/material';
import { GEOGRAPHIC_GLSL } from '../core/glsl/geographic';
import { R_CMB, R_SURFACE, LIGHT_DIR } from '../core/constants';
import { PALETTE } from '../core/palette';

const SHARED_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * The surface sphere is masked rather than triangulated with a hole. Convert
 * the fragment's world position to lon/lat, sample the mask, and discard inside
 * the cut. Works identically for surfaces and lines, and costs nothing.
 *
 * Shading is a FIXED key light, not a headlight. A headlight lights every
 * visible point equally and the globe flattens into a disc; a fixed light gives
 * a terminator and a bright limb, which is what makes the curvature legible.
 */
const SURFACE_FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}

uniform sampler2D uMask;
uniform sampler2D uTopography;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uUseMask;
uniform float uUseTopography;
uniform vec3 uLightDir;
uniform float uShadeStrength;
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec2 uv = geographicToUV(worldToGeographic(vWorldPos));

  if (uUseMask > 0.5 && texture2D(uMask, uv).r > 0.5) discard;

  vec3 base = uUseTopography > 0.5 ? texture2D(uTopography, uv).rgb : uColor;

  // Half-Lambert: keeps the far side readable rather than crushing it to black,
  // while still giving a clear terminator.
  vec3 n = normalize(vNormal);
  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  float shade = mix(1.0, ndl * ndl, uShadeStrength);

  gl_FragColor = vec4(base * shade, uOpacity);
}
`;

export interface Surface {
  mesh: Mesh;
  material: ShaderMaterial;
  setTopography(tex: Texture | null): void;
}

export function createSurfaceSphere(maskTexture: Texture): Surface {
  const mat = new ShaderMaterial({
    vertexShader: SHARED_VERT,
    fragmentShader: SURFACE_FRAG,
    transparent: true,
    uniforms: {
      uMask: { value: maskTexture },
      uTopography: { value: null as Texture | null },
      uColor: { value: passthroughColor(PALETTE.ocean) },
      uOpacity: { value: 1.0 },
      uUseMask: { value: 1 },
      uUseTopography: { value: 0 },
      uLightDir: { value: LIGHT_DIR.clone() },
      uShadeStrength: { value: 0.42 },
    },
  });
  const mesh = new Mesh(new SphereGeometry(R_SURFACE, 256, 128), mat);
  mesh.renderOrder = 1;
  return {
    mesh,
    material: mat,
    setTopography(tex) {
      mat.uniforms.uTopography.value = tex;
      mat.uniforms.uUseTopography.value = tex ? 1 : 0;
    },
  };
}

export async function loadTopography(url: string): Promise<Texture> {
  const tex = await new TextureLoader().loadAsync(url);
  // NOT SRGBColorSpace. Declaring it sRGB makes three decode the texture into
  // the linear working space on sampling, but these shaders write gl_FragColor
  // straight to the framebuffer with no matching linear->sRGB re-encode, so the
  // decode is never undone and the whole globe comes out roughly gamma-2.2 too
  // dark. Everything here -- colormaps, passthroughColor, this texture -- moves
  // sRGB values through unchanged. Keep it that way.
  tex.colorSpace = NoColorSpace;
  tex.wrapS = RepeatWrapping;          // wraps at the antimeridian
  tex.wrapT = ClampToEdgeWrapping;     // must not wrap over the poles
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The core is never cut. It closes a full-depth cutaway; the floor cap closes
 * partial ones.
 *
 * Flat-shaded it read as a black disc, which made the scene look like a 2D
 * cutout. It takes the same fixed key light as the surface, plus a rim term
 * that traces the silhouette, so the curvature is unmistakable when you look
 * down into the cut.
 */
const CORE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform vec3 uLightDir;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorldPos);

  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  float diffuse = 0.28 + 0.72 * ndl * ndl;

  // Brightest where the surface turns away from the viewer: that traces the
  // limb and reads immediately as a sphere rather than a filled circle.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);

  gl_FragColor = vec4(uColor * diffuse + uRimColor * rim * 0.55, 1.0);
}
`;

export function createCoreSphere(): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: SHARED_VERT,
    fragmentShader: CORE_FRAG,
    uniforms: {
      uColor: { value: passthroughColor(0x5a4636) },
      uRimColor: { value: passthroughColor(0xd8a56a) },
      uLightDir: { value: LIGHT_DIR.clone() },
    },
  });
  return new Mesh(new SphereGeometry(R_CMB, 192, 96), mat);
}

/** Invisible target for raycasting vertex placement. */
export function createPickSphere(): Mesh {
  const m = new Mesh(
    new SphereGeometry(R_SURFACE, 128, 64),
    new MeshBasicMaterial({ visible: false }),
  );
  m.name = 'pick';
  return m;
}
