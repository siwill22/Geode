import {
  BufferGeometry, BufferAttribute, Mesh, SphereGeometry, ShaderMaterial,
  LineLoop, LineBasicMaterial, Points, PointsMaterial, FrontSide, type Texture,
} from 'three';
import {
  R_SURFACE, densifyPolygon, depthToRadius, lonLatToVec3, type LonLat,
} from './constants';
import { createVolumeSurfaceMaterial, setMaskMode } from './material';
import { rasteriseMask, MASK_W, MASK_H } from './mask';
import type { CutawayState } from './types';

const WALL_ROWS = 128;
/** Keeps the floor clear of the volume's last depth sample -- see update(). */
const VALID_RANGE_MARGIN_KM = 8;
const MAX_BOUNDARY = 4096;

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
    this.outline = new LineLoop(
      outlineGeom, new LineBasicMaterial({ color: 0xffcc33 }),
    );
    this.outline.frustumCulled = false;

    this.handlePos = new Float32Array(256 * 3);
    const handleGeom = new BufferGeometry();
    handleGeom.setAttribute('position', new BufferAttribute(this.handlePos, 3));
    this.handles = new Points(
      handleGeom,
      new PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false }),
    );
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
