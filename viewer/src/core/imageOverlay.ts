/**
 * An equirectangular image draped over the globe: a gravity or gradient grid
 * pre-rendered to a shaded greyscale PNG, or any other raster too large for
 * a DepthSlice. DepthSlice samples a 3D texture, and MAX_3D_TEXTURE_SIZE is
 * only 2048 on many GPUs; a 2D texture goes to MAX_TEXTURE_SIZE (16384 on
 * most desktops), which a 2 arc-minute global image (10800 wide) needs.
 *
 * The image covers `extent` = [lonMin, lonMax, latMin, latMax] degrees, pixel
 * registered, row 0 at latMax. Outside it the overlay is transparent -- the
 * Sandwell & Smith grids stop at +-80 degrees, and stretching them to the
 * poles would invent data.
 *
 * Single-channel: uploaded as R8 with mipmaps (a 10800 x 4800 image is ~70 MB
 * of GPU memory that way, ~280 MB as RGBA), drawn as grey. Globe only.
 */
import {
  LinearFilter, LinearMipmapLinearFilter, Mesh, NoColorSpace, RedFormat, RepeatWrapping,
  ClampToEdgeWrapping, ShaderMaterial, SphereGeometry, TextureLoader, Vector4,
  type Texture, type WebGLRenderer,
} from 'three';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';
import { R_SURFACE } from './constants';
import type { SwipeSide } from './material';

const VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}
uniform sampler2D uImage;
uniform vec4 uExtent;      // lonMin, lonMax, latMin, latMax (degrees)
uniform float uOpacity;
uniform float uSwipeSide;  // see core/material.ts setSwipe()
uniform float uSwipeX;
varying vec3 vPos;

void main() {
  if (uSwipeSide != 0.0 && (gl_FragCoord.x - uSwipeX) * uSwipeSide > 0.0) discard;
  vec2 ll = degrees(worldToGeographic(vPos));
  if (ll.y < uExtent.z || ll.y > uExtent.w) discard;
  vec2 uv = vec2((ll.x - uExtent.x) / (uExtent.y - uExtent.x),
                 (ll.y - uExtent.z) / (uExtent.w - uExtent.z));
  // u jumps 1 -> 0 across the antimeridian, so the screen-space derivative
  // there is ~1 and the sampler would pick the coarsest mip -- a visible seam.
  // Take the derivative the short way round instead.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  if (abs(dx.x) > 0.5) dx.x -= sign(dx.x);
  if (abs(dy.x) > 0.5) dy.x -= sign(dy.x);
  float g = textureGrad(uImage, uv, dx, dy).r;
  gl_FragColor = vec4(vec3(g), uOpacity);
}
`;

export type Extent = [number, number, number, number];

export class ImageOverlay {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  /** `radius` sits the overlay just clear of a field at R_SURFACE (the
   *  climate hillshade precedent); pass R_SURFACE to put it underneath a
   *  translucent field drawn slightly above instead. */
  constructor(radius = R_SURFACE * 1.0006) {
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uImage: { value: null as Texture | null },
        uExtent: { value: new Vector4(-180, 180, -90, 90) },
        uOpacity: { value: 0.5 },
        uSwipeSide: { value: 0 },
        uSwipeX: { value: 0 },
      },
    });
    this.mesh = new Mesh(new SphereGeometry(radius, 512, 256), this.material);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  setImage(tex: Texture | null, extent: Extent = [-180, 180, -90, 90]): void {
    this.material.uniforms.uImage.value = tex;
    (this.material.uniforms.uExtent.value as Vector4).set(...extent);
    this.mesh.visible = !!tex;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
  }

  setRadius(radius: number): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = new SphereGeometry(radius, 512, 256);
    old.dispose();
  }

  setSwipe(side: SwipeSide, xDevicePx = 0): void {
    this.material.uniforms.uSwipeSide.value = side === 'off' ? 0 : side === 'left' ? 1 : -1;
    this.material.uniforms.uSwipeX.value = xDevicePx;
  }
}

export interface OverlayLevel {
  file: string;
  width: number;
  height: number;
}

/** Pick the finest level the GPU can hold as one texture. */
export function chooseOverlayLevel(renderer: WebGLRenderer, levels: Record<string, OverlayLevel>): OverlayLevel {
  const max = renderer.capabilities.maxTextureSize;
  const fits = Object.values(levels)
    .filter((l) => l.width <= max && l.height <= max)
    .sort((a, b) => b.width - a.width);
  if (!fits.length) throw new Error(`no overlay level fits MAX_TEXTURE_SIZE ${max}`);
  return fits[0];
}

/** Load a greyscale overlay image as a mipmapped R8 texture. Values pass
 *  through unchanged (no sRGB decode), like every other texture here -- see
 *  tomography/globe.ts loadTopography(). */
export async function loadOverlayTexture(url: string): Promise<Texture> {
  const tex = await new TextureLoader().loadAsync(url);
  tex.colorSpace = NoColorSpace;
  tex.format = RedFormat;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
