import {
  MOUSE, OrthographicCamera, PerspectiveCamera, PlaneGeometry, SphereGeometry,
  type BufferGeometry, type Camera,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { R_SURFACE } from './constants';

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

/**
 * Geometry for a volume-draped surface at `radius` in the given Projection.
 * A sphere needs many segments to read as smoothly curved; a flat plane's
 * fragment shader is exact under linear interpolation regardless of vertex
 * density (see worldToGeographicFlat), so 1x1 is enough -- there is no
 * curvature to approximate.
 */
export function createSurfaceGeometry(mode: ProjectionMode, radius: number = R_SURFACE): BufferGeometry {
  return mode === 'globe'
    ? new SphereGeometry(radius, 256, 128)
    : new PlaneGeometry(2 * Math.PI * radius, Math.PI * radius, 1, 1);
}

const PLATE_CARREE_MAP_WIDTH = 2 * Math.PI * R_SURFACE;
const PLATE_CARREE_MAP_HEIGHT = Math.PI * R_SURFACE;
const PLATE_CARREE_MARGIN = 1.15;

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
