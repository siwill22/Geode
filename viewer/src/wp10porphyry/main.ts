import { Clock, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  createProjectionCamera, createProjectionControls, isFlat, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { wireMapOrientationDrag } from '../core/mapOrientationDrag';
import { wireProjectionToggle } from '../core/projectionToggle';
import { loadArchive, loadColormaps } from '../core/volume';
import type { PointsPayload } from '../core/pointOverlay';
import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';
import type { RiftsIndex } from '../riftsclimate/types';
import { Wp10Instance } from './wp10Instance';
import type { BoundariesFile, BoxesFile, FindsFile, WalkersFile, Wp10Index } from './types';

/**
 * The RiftsClimate WP10 porphyry Cu viewer: where porphyries form through time (per
 * rung of the ladder), the simulated porphyries following Kesler & Wilkinson's
 * burial-exhumation walk, the real porphyries, and Kesler & Wilkinson-style charts.
 * The same engine and page furniture as riftsclimate.html; the map fills the window
 * left of the charts panel.
 */

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;
const BACKGROUND = 0x0b0d10;
const START_PROJECTION: ProjectionMode = 'robinson';

let camera: Camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(BACKGROUND);
Object.assign(renderer.domElement.style, { position: 'fixed', left: '0', top: '0' });
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);
const clock = new Clock();
let instance: Wp10Instance | null = null;

function mapSize(): { w: number; h: number } {
  return { w: Math.max(200, innerWidth - (instance?.charts.width ?? 0)), h: innerHeight };
}

function rebuildCamera(mode: ProjectionMode): Camera {
  controls.dispose();
  const { w, h } = mapSize();
  camera = createProjectionCamera(mode, w / h);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  // A flat map is turned, not slid (ADR-0058).
  if (isFlat(mode)) controls.enablePan = false;
  needsRender();
  return camera;
}

wireMapOrientationDrag(renderer.domElement, {
  getCamera: () => camera,
  getMode: () => instance?.view.projection ?? 'globe',
  getOrientation: () => instance?.orientation ?? [0, 0, 0, 1],
}, (q) => instance?.setOrientation(q), { longitudeOnly: true, horizontalWheel: true });

let dirty = true;
const needsRender = () => { dirty = true; };

function loop(): void {
  requestAnimationFrame(loop);
  if (controls.update(clock.getDelta())) dirty = true;
  if (!instance) return;
  if (instance.animating) dirty = true;
  if (!dirty) return;
  dirty = false;
  instance.render(renderer);
}

/** The map fills the window left of the charts panel. */
function layout(): void {
  const { w, h } = mapSize();
  renderer.setSize(w, h);
  updateProjectionCameraAspect(camera, w / h);
  instance?.resize({ x: 0, y: 0, width: w, height: h });
  needsRender();
}
addEventListener('resize', layout);

let pointerDownAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { pointerDownAt = { x: ev.clientX, y: ev.clientY }; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  const moved = pointerDownAt ? Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y) : Infinity;
  pointerDownAt = null;
  if (moved > 5) return;
  instance?.clickAt(ev.clientX, ev.clientY);
  needsRender();
});
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (ev.buttons) return;
  instance?.hoverAt(ev.clientX, ev.clientY);
});
renderer.domElement.addEventListener('pointerleave', () => instance?.hoverOut());

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const [index, rifts] = await Promise.all([
    fetchMaybeGzippedJSON(`${ARCHIVE}/riftsclimate/wp10/index.json`) as Promise<Wp10Index>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/riftsclimate/index.json`) as Promise<RiftsIndex>,
  ]);
  const model = rifts.models.find((m) => m.id === index.plate_model);
  if (!model) throw new Error(`plate model ${index.plate_model} is not in riftsclimate/index.json`);
  const [colormaps, boxes, walkers, finds, points, boundaries] = await Promise.all([
    loadColormaps(ARCHIVE, archive.colormaps),
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.boxes}`) as Promise<BoxesFile>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.walkers}`) as Promise<WalkersFile>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.finds}`) as Promise<FindsFile>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/${model.points}`) as Promise<PointsPayload>,
    index.files.boundaries
      ? fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.boundaries}`) as Promise<BoundariesFile>
      : Promise.resolve(null),
  ]);

  instance = new Wp10Instance(camera, {
    archiveBase: ARCHIVE, colormaps, index, rifts, boxes, walkers, finds, points, boundaries, rebuildCamera,
    onLayout: layout,
  }, needsRender);
  instance.setCameraAspect(camera);
  layout();
  await instance.boot();
  instance.setProjection(START_PROJECTION);
  layout();

  const toggle = document.getElementById('projection-toggle');
  if (toggle) instance.ui.mountProjectionToggle(toggle);
  const inst = instance;
  wireProjectionToggle(toggle, () => inst.view.projection, (m) => { inst.setProjection(m); layout(); });
  (window as unknown as { __wp10: Wp10Instance }).__wp10 = instance;
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
