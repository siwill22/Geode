import {
  BufferGeometry, BufferAttribute, Mesh, SphereGeometry, ShaderMaterial,
  LineLoop, Points, FrontSide, type Texture,
} from 'three';
import {
  R_SURFACE, densifyPolygon, depthToRadius, lonLatToVec3, type LonLat,
} from '../core/constants';
import { createVolumeSurfaceMaterial, passthroughColor, setMaskMode } from '../core/material';
import { GEOGRAPHIC_GLSL } from '../core/glsl/geographic';
import { rasteriseMask, MASK_W, MASK_H } from '../core/mask';
import type { CutawayState } from '../core/types';

const WALL_ROWS = 128;
/** Keeps the floor clear of the volume's last depth sample -- see update(). */
const VALID_RANGE_MARGIN_KM = 8;
const MAX_BOUNDARY = 4096;

/**
 * Hide the polygon overlay where the globe is in the way.
 *
 * The outline and handles sit just outside the sphere at R_SURFACE * 1.002 so
 * they do not z-fight with the surface they trace. That lift is also why the
 * depth buffer cannot be relied on to hide them: the globe surface is a
 * transparent material, so it renders in three.js's transparent pass AFTER the
 * opaque overlay, and the overlay's far-side pixels are already in the frame by
 * then. The polygon stayed visible straight through the planet.
 *
 * So cull geometrically instead, by the same criterion the plate-boundary
 * overlay uses. THE HORIZON IS NOT AT dot == 0. That would be the limit for an
 * orthographic camera; under perspective at distance d the visible cap ends
 * where dot(n, viewDir) == R/d -- at d = 2.6 R that is 67 degrees, not 90. Using
 * zero leaves a ring of far-side polygon painted over the near limb, which is
 * both wrong and looks like a rendering artefact rather than a maths error.
 *
 * R_SURFACE, not the 1.002 radius: what occludes the overlay is the globe.
 */
const HORIZON_GLSL = /* glsl */`
bool beyondHorizon(vec3 p) {
  float d = length(cameraPosition);
  return dot(normalize(p), cameraPosition / d) < ${R_SURFACE.toFixed(6)} / d;
}
`;

const OVERLAY_VERT = /* glsl */`
${GEOGRAPHIC_GLSL}
uniform float uSize;
// See CONTEXT.md's Reference Plate entry and docs/adr/0030 -- rotates this
// polygon marker the same way createVolumeSurfaceMaterial's VERT rotates
// the wall/floor it outlines (core/material.ts), so the drawn cut and its
// own boundary/handles never visibly detach from each other once
// Reference Plate != 0. Identity by default, a no-op.
uniform vec4 uRefQuat;
varying vec3 vWorldPos;
void main() {
  vec3 rotated = rotateByQuat(uRefQuat, position);
  vWorldPos = (modelMatrix * vec4(rotated, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotated, 1.0);
  gl_PointSize = uSize;
}
`;

const OVERLAY_FRAG = /* glsl */`
${HORIZON_GLSL}
uniform vec3 uColor;
varying vec3 vWorldPos;
void main() {
  if (beyondHorizon(vWorldPos)) discard;
  gl_FragColor = vec4(uColor, 1.0);
}
`;

function createOverlayMaterial(color: number, size: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: OVERLAY_VERT,
    fragmentShader: OVERLAY_FRAG,
    uniforms: {
      uColor: { value: passthroughColor(color) },
      uSize: { value: size },
      uRefQuat: { value: [0, 0, 0, 1] },
    },
  });
}

/**
 * Walls, floor and the in-progress polygon overlay.
 *
 * The wall carries TRUE 3D world positions, so the shader converts each
 * fragment to spherical coordinates directly and the section narrows correctly
 * toward the centre. Geometry is allocated once at max size and the position
 * attribute updated in place, so vertex drags do not reallocate.
 */
export class Cutaway {
  readonly wall: Mesh;
  readonly floor: Mesh;
  readonly outline: LineLoop;
  readonly handles: Points;

  private wallGeom: BufferGeometry;
  private wallPos: Float32Array;
  private outlinePos: Float32Array;
  private handlePos: Float32Array;
  private maskData: Uint8Array;

  /**
   * The rasterised cutaway, for consumers that have to cull against it on the
   * CPU rather than in a shader -- the boundary overlay, which has no depth
   * buffer. Re-read it after every update(): the array is replaced, not mutated.
   */
  get mask(): Uint8Array { return this.maskData; }

  /**
   * Deepest depth the loaded volume is valid to. The cut is clamped to this so
   * the floor cap never sits below the data: at a full-depth cut the cap would
   * otherwise land at 2890 km, outside REVEAL's 2840 km range, and the shader
   * would correctly paint it no-data grey -- straight over the core sphere.
   */
  private volumeMaxDepthKm = 2890;

  constructor(private maskTexture: Texture) {
    this.wallPos = new Float32Array(MAX_BOUNDARY * WALL_ROWS * 3);
    this.wallGeom = new BufferGeometry();
    this.wallGeom.setAttribute('position', new BufferAttribute(this.wallPos, 3));
    this.wallGeom.setIndex(new BufferAttribute(
      new Uint32Array((MAX_BOUNDARY - 1) * (WALL_ROWS - 1) * 6), 1,
    ));
    this.wall = new Mesh(this.wallGeom, createVolumeSurfaceMaterial());
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 2;

    // The floor is a full sphere at the cut radius, masked to keep only what
    // lies inside the cut. That avoids triangulating a spherical polygon while
    // reusing the same material as the walls.
    const floorMat = createVolumeSurfaceMaterial();
    // The floor is a whole sphere, so DoubleSide would draw its far hemisphere
    // as well as its near one. Only the outward face is ever looked at.
    floorMat.side = FrontSide;
    setMaskMode(floorMat, 'inside');
    floorMat.uniforms.uMask.value = maskTexture;
    this.floor = new Mesh(new SphereGeometry(1, 256, 128), floorMat);
    this.floor.renderOrder = 2;
    this.floor.visible = false;

    this.outlinePos = new Float32Array(MAX_BOUNDARY * 3);
    const outlineGeom = new BufferGeometry();
    outlineGeom.setAttribute('position', new BufferAttribute(this.outlinePos, 3));
    this.outline = new LineLoop(outlineGeom, createOverlayMaterial(0xffcc33, 1));
    this.outline.frustumCulled = false;

    this.handlePos = new Float32Array(256 * 3);
    const handleGeom = new BufferGeometry();
    handleGeom.setAttribute('position', new BufferAttribute(this.handlePos, 3));
    this.handles = new Points(handleGeom, createOverlayMaterial(0xffffff, 8));
    this.handles.frustumCulled = false;

    this.maskData = new Uint8Array(MASK_W * MASK_H);
  }

  setVolumeDepthRange(maxDepthKm: number): void {
    this.volumeMaxDepthKm = maxDepthKm;
  }

  get wallMaterial(): ShaderMaterial {
    return this.wall.material as ShaderMaterial;
  }

  get floorMaterial(): ShaderMaterial {
    return this.floor.material as ShaderMaterial;
  }

  /** Rotates the outline/handle overlay to match the wall/floor -- those
   *  already rotate via their own createVolumeSurfaceMaterial uRefQuat
   *  uniform (see GlobeInstance.volumeMaterials()), so without this the
   *  drawn polygon marker would visibly detach from the cut it outlines
   *  the moment Reference Plate != 0. `q` must already be a render-frame
   *  quaternion (core/rotation.ts's toRenderFrameRotation()). See
   *  CONTEXT.md's Reference Plate entry and docs/adr/0030. */
  setReferenceRotation(q: readonly [number, number, number, number]): void {
    (this.outline.material as ShaderMaterial).uniforms.uRefQuat.value = q;
    (this.handles.material as ShaderMaterial).uniforms.uRefQuat.value = q;
  }

  /** Rebuild everything that derives from the cutaway state. */
  update(state: CutawayState): void {
    this.updateOverlay(state);

    const active = state.closed && state.vertices.length >= 3;
    this.wall.visible = active;
    this.floor.visible = active;
    if (!active) {
      this.maskData.fill(0);
      this.uploadMask();
      return;
    }

    const boundary = densifyPolygon(state.vertices, 0.5).slice(0, MAX_BOUNDARY);

    this.maskData = rasteriseMask(boundary, state.inverted);
    this.uploadMask();

    // Clamp to the volume's base rather than to R_CMB. Models end above the
    // CMB, and the core sphere covers the remaining few tens of km.
    //
    // The margin is not cosmetic. The floor is a tessellated sphere, so face
    // interiors chord very slightly inside the vertex radius; sitting exactly on
    // the deepest sample, that wobble straddles the valid-range boundary and the
    // shader paints alternating data and no-data bands across the whole floor.
    // A few km inside the data, every fragment is unambiguously in range.
    const deepest = this.volumeMaxDepthKm - VALID_RANGE_MARGIN_KM;
    const depthKm = Math.min(state.depthKm, deepest);

    this.buildWall(boundary, depthKm);
    this.floor.scale.setScalar(depthToRadius(depthKm));
  }

  private uploadMask(): void {
    const tex = this.maskTexture as Texture & { image: { data: Uint8Array } };
    tex.image.data.set(this.maskData);
    tex.needsUpdate = true;
  }

  private buildWall(boundary: LonLat[], depthKm: number): void {
    const n = boundary.length;
    const rTop = R_SURFACE;
    const rBot = depthToRadius(depthKm);

    let w = 0;
    for (let j = 0; j < WALL_ROWS; j++) {
      const t = j / (WALL_ROWS - 1);
      const r = rTop + (rBot - rTop) * t;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = lonLatToVec3(boundary[i].lon, boundary[i].lat, r);
        this.wallPos[w++] = x;
        this.wallPos[w++] = y;
        this.wallPos[w++] = z;
      }
    }

    const idx = this.wallGeom.getIndex()!.array as Uint32Array;
    let k = 0;
    for (let j = 0; j < WALL_ROWS - 1; j++) {
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n; // close the curtain around the loop
        const a = j * n + i, b = j * n + i2;
        const c = (j + 1) * n + i, d = (j + 1) * n + i2;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }

    (this.wallGeom.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.wallGeom.getIndex()!.needsUpdate = true;
    this.wallGeom.setDrawRange(0, k);
  }

  private updateOverlay(state: CutawayState): void {
    const verts = state.vertices;
    if (verts.length === 0) {
      this.outline.visible = false;
      this.handles.visible = false;
      return;
    }
    this.outline.visible = verts.length >= 2;
    this.handles.visible = true;

    // Densify the displayed outline too, so the user sees the great-circle path
    // that will actually be cut rather than straight chords in lon/lat.
    const shown = verts.length >= 3
      ? densifyPolygon(verts, 0.5)
      : verts.slice();
    const nOut = Math.min(shown.length, MAX_BOUNDARY);
    for (let i = 0; i < nOut; i++) {
      const [x, y, z] = lonLatToVec3(shown[i].lon, shown[i].lat, R_SURFACE * 1.002);
      this.outlinePos[i * 3] = x;
      this.outlinePos[i * 3 + 1] = y;
      this.outlinePos[i * 3 + 2] = z;
    }
    this.outline.geometry.setDrawRange(0, nOut);
    (this.outline.geometry.getAttribute('position') as BufferAttribute)
      .needsUpdate = true;

    const nH = Math.min(verts.length, 256);
    for (let i = 0; i < nH; i++) {
      const [x, y, z] = lonLatToVec3(verts[i].lon, verts[i].lat, R_SURFACE * 1.002);
      this.handlePos[i * 3] = x;
      this.handlePos[i * 3 + 1] = y;
      this.handlePos[i * 3 + 2] = z;
    }
    this.handles.geometry.setDrawRange(0, nH);
    (this.handles.geometry.getAttribute('position') as BufferAttribute)
      .needsUpdate = true;
  }
}

/** Area-weighted fraction of the sphere marked as removed. */
export function removedFraction(boundary: LonLat[]): number {
  const m = rasteriseMask(boundary, false);
  let filled = 0;
  let total = 0;
  for (let j = 0; j < MASK_H; j++) {
    const lat = -90 + ((j + 0.5) * 180) / MASK_H;
    const w = Math.cos((lat * Math.PI) / 180);
    total += w * MASK_W;
    const row = j * MASK_W;
    for (let i = 0; i < MASK_W; i++) if (m[row + i]) filled += w;
  }
  return filled / total;
}
