import {
  MOUSE, OrthographicCamera, PerspectiveCamera, PlaneGeometry, SphereGeometry,
  type BufferGeometry, type Camera,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DEG, R_SURFACE, eastNorthAt, lonLatToVec3, vec3ToLonLat,
} from './constants';
import { rotateVector, type Quaternion } from './rotation';

/**
 * How a volume-draped surface is mapped onto the screen -- see CONTEXT.md's
 * Projection entry and docs/adr/0003-plate-carree-as-first-alternate-projection.md.
 * Only these two exist today; more (Robinson, Mollweide, Spilhaus) are
 * expected later.
 */
export type ProjectionMode = 'globe' | 'plateCarree';

/** Consumed by core/material.ts's uProjectionMode uniform -- must match the
 *  branch there and in GEOGRAPHIC_GLSL's worldToGeographic/worldToGeographicFlat. */
export const PROJECTION_UNIFORM: Record<ProjectionMode, number> = {
  globe: 0,
  plateCarree: 1,
};

const PLATE_CARREE_MAP_WIDTH = 2 * Math.PI * R_SURFACE;
const PLATE_CARREE_MAP_HEIGHT = Math.PI * R_SURFACE;
const PLATE_CARREE_MARGIN = 1.15;

/**
 * Geometry for a volume-draped surface at `radius` in the given Projection.
 * A sphere needs many segments to read as smoothly curved; a flat plane's
 * fragment shader is exact under linear interpolation regardless of vertex
 * density (see worldToGeographicFlat), so 1x1 is enough -- there is no
 * curvature to approximate.
 *
 * `radius` bigger than R_SURFACE pushes a sphere surface radially outward to
 * avoid z-fighting between coincident layers (see climateInstance.ts's
 * OVERLAY_R). A flat plane has no radial direction, so the same intent is
 * expressed as a Z offset instead, at the map's fixed canonical width/height
 * -- scaling the plane's extent by `radius`, as an earlier version of this
 * did, changes its SIZE, not its depth, and does nothing to separate
 * coincident layers.
 */
export function createSurfaceGeometry(mode: ProjectionMode, radius: number = R_SURFACE): BufferGeometry {
  if (mode === 'globe') return new SphereGeometry(radius, 256, 128);
  const geo = new PlaneGeometry(PLATE_CARREE_MAP_WIDTH, PLATE_CARREE_MAP_HEIGHT, 1, 1);
  geo.translate(0, 0, radius - R_SURFACE);
  return geo;
}

/**
 * (lon, lat) degrees -> world position on the flat Plate Carrée plane, the
 * exact inverse of GEOGRAPHIC_GLSL's worldToGeographicFlat -- the CPU-side
 * counterpart for anything positioned per-vertex/per-instance rather than
 * per-fragment (wind glyphs/streaks; see core/windGlyphs.ts,
 * core/windStreaks.ts). `z` is the Plate Carrée equivalent of lonLatToVec3's
 * radius: a small constant offset, not a scale, keeps coincident layers
 * apart the same way createSurfaceGeometry's does.
 */
export function lonLatToFlatVec3(lon: number, lat: number, z = 0): [number, number, number] {
  return [lon * DEG * R_SURFACE, lat * DEG * R_SURFACE, z];
}

function isIdentity(q: Quaternion): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/**
 * Reanchor a TRUE (lon, lat) into a Reference Plate rotation's frame, then
 * reproject the result onto the flat Plate Carrée plane -- the Plate
 * Carrée counterpart of rotating a Globe sphere point by the SAME 3D
 * quaternion directly (see core/rotation.ts's docs/adr/0030 comments). A
 * flat plane's own Cartesian position isn't a 3D direction, so rotating IT
 * directly warps the map instead of reanchoring content (see
 * docs/plans/reference-plate.md's "Known issue" postmortem) -- this
 * instead rotates the TRUE point on the sphere, then reprojects the
 * ROTATED result back onto the flat map, exactly like redrawing a map
 * after the globe underneath it turned. Identity `qRef` (Reference Plate
 * 0, the overwhelmingly common case) short-circuits to the exact
 * bit-identical lonLatToFlatVec3(lon, lat, z) rather than round-tripping
 * through trig for no reason. Used by windStreaks.ts's respawn()/advect().
 */
export function referencePlateFlatPosition(
  lon: number, lat: number, qRef: Quaternion, z = 0,
): [number, number, number] {
  if (isIdentity(qRef)) return lonLatToFlatVec3(lon, lat, z);
  const [x0, y0, z0] = lonLatToVec3(lon, lat, 1);
  const [x1, y1, z1] = rotateVector(qRef, x0, y0, z0);
  const rotated = vec3ToLonLat(x1, y1, z1);
  return lonLatToFlatVec3(rotated.lon, rotated.lat, z);
}

/**
 * Like referencePlateFlatPosition(), but also reanchors a local tangent
 * direction -- `(u, v)` in the physical east/north sense (constants.ts's
 * eastNorthAt), e.g. wind components -- for a caller that needs an on-map
 * direction as well as a position (windGlyphs.ts's arrows). The rotated
 * tangent is decomposed back onto the ROTATED location's own east/north
 * basis: the flat map's own screen axes (FLAT_EAST/FLAT_NORTH) are fixed
 * and never rotate -- only which physical (u, v) is displayed against them
 * does, exactly the same "content moves, display frame doesn't" split the
 * position round-trip above makes.
 */
export function referencePlateFlatSample(
  lon: number, lat: number, u: number, v: number, qRef: Quaternion, z = 0,
): { position: [number, number, number]; direction: [number, number, number] } {
  if (isIdentity(qRef)) return { position: lonLatToFlatVec3(lon, lat, z), direction: [u, v, 0] };
  const { east, north } = eastNorthAt(lon, lat);
  const dx0 = u * east[0] + v * north[0];
  const dy0 = u * east[1] + v * north[1];
  const dz0 = u * east[2] + v * north[2];
  const [px0, py0, pz0] = lonLatToVec3(lon, lat, 1);
  const [px1, py1, pz1] = rotateVector(qRef, px0, py0, pz0);
  const [dx1, dy1, dz1] = rotateVector(qRef, dx0, dy0, dz0);
  const rotated = vec3ToLonLat(px1, py1, pz1);
  const { east: east2, north: north2 } = eastNorthAt(rotated.lon, rotated.lat);
  const u2 = dx1 * east2[0] + dy1 * east2[1] + dz1 * east2[2];
  const v2 = dx1 * north2[0] + dy1 * north2[1] + dz1 * north2[2];
  return { position: lonLatToFlatVec3(rotated.lon, rotated.lat, z), direction: [u2, v2, 0] };
}

/**
 * The flat plane's east/north tangent directions -- unlike eastNorthAt's
 * sphere version, these are the SAME everywhere (no meridian convergence, no
 * pole degeneracy), which is the one respect in which reprojecting
 * position-per-sample onto Plate Carrée is simpler than the sphere, not just
 * different.
 */
export const FLAT_EAST: readonly [number, number, number] = [1, 0, 0];
export const FLAT_NORTH: readonly [number, number, number] = [0, 1, 0];

/** World-unit height of the orthographic frustum that contains the whole
 *  2:1 Plate Carrée map at `aspect`, plus a little headroom -- a "fit by
 *  height" alone would crop the map's width on any tile squarer than 2:1
 *  (every climate tile is roughly square), so this fits by whichever
 *  dimension is the binding constraint, the same idea as CSS
 *  `object-fit: contain`. */
function plateCarreeFrustumHeight(aspect: number): number {
  return Math.max(PLATE_CARREE_MAP_HEIGHT, PLATE_CARREE_MAP_WIDTH / aspect) * PLATE_CARREE_MARGIN;
}

/** A fresh camera for `mode`, framed at a sensible starting view. Globe and
 *  Plate Carrée need genuinely different camera types (perspective/orbit vs.
 *  orthographic/pan -- see ADR-0003), so switching Projection always means
 *  building a new camera object, never reconfiguring the old one in place. */
export function createProjectionCamera(mode: ProjectionMode, aspect: number): Camera {
  if (mode === 'globe') {
    const camera = new PerspectiveCamera(45, aspect, 0.01, 50);
    camera.position.set(2.6, 1.4, 2.2);
    return camera;
  }
  const h = plateCarreeFrustumHeight(aspect);
  const camera = new OrthographicCamera(-(h * aspect) / 2, (h * aspect) / 2, h / 2, -h / 2, 0.01, 50);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  return camera;
}

/** Keep a Projection camera's frustum matched to the current aspect ratio,
 *  at whatever zoom/distance the user has already dialled in -- the
 *  Plate-Carrée equivalent of a perspective camera's `camera.aspect = ...`.
 *  A no-op for a PerspectiveCamera passed the same aspect it already has;
 *  three.js only needs updateProjectionMatrix() after left/right/top/bottom
 *  or aspect actually change. */
export function updateProjectionCameraAspect(camera: Camera, aspect: number): void {
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera instanceof OrthographicCamera) {
    const h = plateCarreeFrustumHeight(aspect);
    camera.left = -(h * aspect) / 2;
    camera.right = (h * aspect) / 2;
    camera.top = h / 2;
    camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
  }
}

/** OrbitControls configured for `mode`: free orbit + dolly-zoom for Globe,
 *  or pan + zoom with no rotation for Plate Carrée -- an undistorted flat
 *  map has no "orbit" to speak of. OrbitControls dollies a PerspectiveCamera
 *  but drives an OrthographicCamera's .zoom on scroll instead, which is
 *  exactly the zoom-without-perspective-change a flat map needs, so no
 *  separate zoom implementation is required. Always a new instance, never a
 *  reconfigured old one -- see createProjectionCamera's own doc comment. */
export function createProjectionControls(
  mode: ProjectionMode, camera: Camera, domElement: HTMLElement,
): OrbitControls {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  if (mode === 'globe') {
    controls.enableRotate = true;
    controls.enablePan = false;
    controls.minDistance = R_SURFACE + 0.1;
    controls.maxDistance = 12;
  } else {
    controls.enableRotate = false;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.minZoom = 0.4;
    controls.maxZoom = 8;
    // OrbitControls' default LEFT-button action is ROTATE, with a built-in
    // Ctrl/Meta/Shift modifier swap to PAN -- with enableRotate false, plain
    // left-drag hit the disabled ROTATE branch and did nothing, so panning
    // only worked while holding a modifier. Remapping LEFT to PAN directly
    // makes plain drag pan, matching a flat map's expected interaction.
    controls.mouseButtons.LEFT = MOUSE.PAN;
  }
  return controls;
}
