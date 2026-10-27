import { Clock, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  createProjectionCamera, createProjectionControls, isFlat, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { wireMapOrientationDrag } from '../core/mapOrientationDrag';
import { wireProjectionToggle } from '../core/projectionToggle';
import { loadArchive, loadColormaps } from '../core/volume';
import { fetchMaybeGzippedJSON } from '../../vendor/petrify/js/gzipFetch.js';
import type { RiftsIndex } from '../riftsclimate/types';
import type { BoundariesFile } from '../wp10porphyry/types';
import { MolchanInstance } from './molchanInstance';
import type { GeneratedMarginsFile, MolchanBoxesFile, MolchanDepositsFile, MolchanIndex } from './types';

/**
 * The RiftsClimate Molchan viewer: the inputs of the one-factor Molchan test (the ground
 * through time, the deposits, the margin lines) and its Molchan diagram. The same engine and
 * page furniture as wp10porphyry.html; the map fills the window left of the diagram panel.
 */

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;
const BACKGROUND = 0x0b0d10;
const START_PROJECTION: ProjectionMode = 'robinson';
/** The archive format this page reads (prep_riftsclimate_molchan.py FORMAT). */
const MOLCHAN_FORMAT = 5;

/** An error whose message is meant for the reader: shown without a stack trace. */
class ReadableError extends Error {}

let camera: Camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(BACKGROUND);
Object.assign(renderer.domElement.style, { position: 'fixed', left: '0', top: '0' });
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);
const clock = new Clock();
let instance: MolchanInstance | null = null;

function mapSize(): { w: number; h: number } {
  return { w: Math.max(200, innerWidth - (instance?.panel.width ?? 0)), h: innerHeight };
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

/** The map fills the window left of the diagram panel. */
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
    fetchMaybeGzippedJSON(`${ARCHIVE}/riftsclimate/molchan/index.json`) as Promise<MolchanIndex>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/riftsclimate/index.json`) as Promise<RiftsIndex>,
  ]);
  const fmt = index.format ?? 1;
  if (fmt !== MOLCHAN_FORMAT) {
    throw new ReadableError(`The Molchan archive (archive/riftsclimate/molchan/) is format ${fmt}; this page `
      + `reads format ${MOLCHAN_FORMAT}. Rebuild it (env -u PYTHONPATH conda run -n riftsclimate python `
      + 'prep/prep_riftsclimate_molchan.py) or update the viewer code, then reload.');
  }
  const [colormaps, boxes, deposits, boundaries, generated] = await Promise.all([
    loadColormaps(ARCHIVE, archive.colormaps),
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.boxes}`) as Promise<MolchanBoxesFile>,
    fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.deposits}`) as Promise<MolchanDepositsFile>,
    index.files.boundaries
      ? fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.boundaries}`) as Promise<BoundariesFile>
      : Promise.resolve(null),
    index.files.generated_margins
      ? fetchMaybeGzippedJSON(`${ARCHIVE}/${index.files.generated_margins}`) as Promise<GeneratedMarginsFile>
      : Promise.resolve(null),
  ]);

  instance = new MolchanInstance(camera, {
    archiveBase: ARCHIVE, colormaps, index, rifts, boxes, deposits, boundaries, generated, rebuildCamera, onLayout: layout,
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
  (window as unknown as { __molchan: MolchanInstance }).__molchan = instance;
  document.body.dataset.ready = '1';
  needsRender();
}

boot().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement('div');
  box.id = 'error';
  box.textContent = String(err instanceof ReadableError ? err.message
    : err instanceof Error ? err.stack ?? err.message : err);
  document.body.appendChild(box);
});

loop();
