import { Clock, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { loadArchive, loadColormaps } from '../core/volume';
import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';
import { RiftsInstance } from './riftsclimateInstance';
import type { DepositValues, FieldCatalogue, RiftsIndex } from './types';

/**
 * The RiftsClimate deposit viewer: every deposit in the WP5 analysis, the
 * model inputs behind them (coastlines, BRIDGE climate, defamation
 * deformation, Jackson & MacDonald margins), and a click-through panel of each
 * deposit's values against the other deposits. Built on the same engine as
 * paleobio.html (PointOverlay, Coastlines, DepthSlice, the Projection host).
 */

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;
const BACKGROUND = 0x0b0d10;

let camera: Camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(BACKGROUND);
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);
const clock = new Clock();
let instance: RiftsInstance | null = null;

/** New camera and controls per Projection (ADR-0003); the old controls are
 *  disposed so their listeners stop driving a camera nothing renders with. */
function rebuildCamera(mode: ProjectionMode): Camera {
  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  needsRender();
  return camera;
}

let dirty = true;
const needsRender = () => { dirty = true; };

function loop(): void {
  requestAnimationFrame(loop);
  if (controls.update(clock.getDelta())) dirty = true;
  if (!instance) return;
  // A fanned-out pile animates open; keep drawing until it settles.
  if (instance.animating) dirty = true;
  if (!dirty) return;
  dirty = false;
  instance.render(renderer);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  instance?.resize();
  needsRender();
});

// Click-vs-drag, as reconstruction/main.ts: a press that did not move is a
// click on a deposit; anything that moved is an orbit or pan.
let pointerDownAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (ev) => {
  pointerDownAt = { x: ev.clientX, y: ev.clientY };
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  const moved = pointerDownAt
    ? Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y)
    : Infinity;
  pointerDownAt = null;
  if (moved > 5) return;
  instance?.clickAt(ev.clientX, ev.clientY);
});
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (ev.buttons) return; // dragging the globe, not hovering
  instance?.hoverAt(ev.clientX, ev.clientY);
});
renderer.domElement.addEventListener('pointerleave', () => instance?.hoverOut());

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const index = await fetchMaybeGzippedJSON(`${ARCHIVE}/riftsclimate/index.json`) as RiftsIndex;
  const [colormaps, catalogue, values] = await Promise.all([
    loadColormaps(ARCHIVE, archive.colormaps),
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.fields}`) as Promise<FieldCatalogue>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.values}`) as Promise<DepositValues>,
  ]);

  instance = new RiftsInstance(camera, {
    archiveBase: ARCHIVE, archive, colormaps, index, catalogue, values, rebuildCamera,
  }, needsRender);
  instance.setCameraAspect(camera);
  instance.resize();
  await instance.boot();
  (window as unknown as { __rifts: RiftsInstance }).__rifts = instance;
  document.body.dataset.ready = '1';
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
