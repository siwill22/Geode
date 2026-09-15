import { Clock, Vector3, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { loadArchive, loadColormaps } from '../core/volume';
import { fetchMaybeGzippedJSON } from '../../vendor/deep-time-map/js/gzipFetch.js';
import { BACKGROUND, PaleobioInstance } from './paleobioInstance';
import type { PaleobioIndex } from './types';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

let camera: Camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(BACKGROUND);
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);
const clock = new Clock();

let instance: PaleobioInstance | null = null;

/**
 * Swap in a camera and controls for a Projection.
 *
 * Both are rebuilt, never reconfigured: Globe wants a perspective camera with
 * free orbit, a flat map wants an orthographic one with pan and zoom and no
 * rotation (ADR-0003). The old controls must be disposed or their listeners
 * keep driving a camera nothing renders with any more.
 */
function rebuildCamera(mode: ProjectionMode): Camera {
  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  needsRender();
  return camera;
}

/**
 * Put the camera over a lon/lat at a given distance.
 *
 * The outward normal at (lon, lat) in the render frame -- the same
 * (cos lat cos lon, cos lat sin lon, sin lat) convention the rest of the
 * pipeline uses, mapped to three.js's y-up axes. OrbitControls keeps its target
 * at the origin, so positioning the camera along that normal is all that framing
 * a region requires.
 */
function frameOn(lon: number, lat: number, distance: number): void {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const dir = new Vector3(
    Math.cos(la) * Math.cos(lo),
    Math.sin(la),
    -Math.cos(la) * Math.sin(lo),
  ).normalize();
  camera.position.copy(dir.multiplyScalar(distance));
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update(0);
  needsRender();
}

// Frame-coalescing: the panels, the overlays and OrbitControls all ask for
// repaints independently, and drawing three canvases per request would do the
// same work several times per frame.
let dirty = true;
const needsRender = () => { dirty = true; };

function loop(): void {
  requestAnimationFrame(loop);
  if (controls.update(clock.getDelta())) dirty = true;
  if (!dirty || !instance) return;
  dirty = false;
  instance.render(renderer);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  instance?.resize();
  needsRender();
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const [colormaps, index] = await Promise.all([
    loadColormaps(ARCHIVE, archive.colormaps),
    fetchMaybeGzippedJSON(`${ARCHIVE}/paleobio/index.json`) as Promise<PaleobioIndex>,
  ]);

  instance = new PaleobioInstance(camera, {
    archiveBase: ARCHIVE, archive, colormaps, index, dataBase: `${ARCHIVE}/paleobio`,
    frameOn, rebuildCamera,
  }, needsRender);
  instance.setCameraAspect(camera);
  instance.resize();
  await instance.boot();
  needsRender();
}

boot().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement('div');
  box.id = 'error';
  box.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
  document.body.appendChild(box);
});

loop();
