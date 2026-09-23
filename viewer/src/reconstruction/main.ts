import { Clock, Color, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { loadArchive } from '../core/volume';
import { loadReconstructionManifest } from '../core/reconstructions';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  isFlat, type ProjectionMode,
} from '../core/projection';
import { wireProjectionToggle } from '../core/projectionToggle';
import { MapOrientationControl } from '../core/mapOrientationControl';
import { wireMapOrientationDrag } from '../core/mapOrientationDrag';
import { orientationQuaternion, type Quaternion } from '../core/rotation';
import { showSamplePopup, hideSamplePopup } from '../core/samplePopup';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { wireMultiGlobeMenu } from '../core/multiGlobeMenu';
import { ReconstructionInstance, type ReconstructionInstanceDeps } from './reconstructionInstance';
import { RECONSTRUCTION_CONFIG } from '../generated/reconstructionConfig';

// See deformation/main.ts for why this indirection exists: VITE_ARCHIVE_BASE
// is the seam a generated repo's build points at the shared central data
// host instead of a local archive/ tree -- see generator/scaffoldRepo.mjs.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = RECONSTRUCTION_CONFIG.title;

// One Reconstruction Model, no comparison dropdown -- see
// reconstructionGroup/main.ts for the multi-reconstruction sibling. See
// globe/main.ts's identical comment: one shared camera for every tile.
// `camera`/`controls` are reassigned wholesale by setProjection() below, not
// reconfigured in place -- see climate/main.ts's identical comment
// (docs/adr/0003).
let projectionMode: ProjectionMode = 'globe';
let camera: Camera = createProjectionCamera(projectionMode, innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Themes are not yet wired into this wrapper's UI -- it boots on the
// default Theme's page colour. See docs/adr/0038 for the intended
// always-present control, and themelab/ for the built one.
renderer.setClearColor(new Color(resolveTheme(DEFAULT_THEME).page));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls(projectionMode, camera, renderer.domElement);

/** Switch every globe on screen to `mode` at once -- Projection is global,
 *  never per-instance (docs/adr/0003) -- see climate/main.ts's identical
 *  function. */
function setProjection(mode: ProjectionMode): void {
  if (mode === projectionMode) return;
  projectionMode = mode;

  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  // Map Orientation is dragged directly on the map itself (see
  // wireMapOrientationDrag() below) -- OrbitControls' own pan would
  // otherwise try to interpret the identical drag on the same element.
  if (isFlat(mode)) controls.enablePan = false;

  for (const inst of host.instances) inst.setProjection(mode, camera);
  orientationControl.setVisible(isFlat(mode));
}

// --- Map Orientation -- see CONTEXT.md's Map Orientation entry -----------
//
// Global, exactly like Projection above (one shared rotation for every
// tile), and independent of it: meaningless in Globe (OrbitControls already
// free-orbits there), so it only does anything for a flat Projection. The
// default is off pole-up on purpose -- Phase 5 of this session's Map
// Orientation plan: centred toward Southern Africa/Gondwana, this viewer's
// own paleomagnetic-pole dataset and GAPWaP path focus, so the south pole
// reads in the map's interior rather than pinned to its edge from the very
// first flat view, with no drag required.
const DEFAULT_ORIENTATION: Quaternion = orientationQuaternion(20, -30, 0);
let qOrient: Quaternion = DEFAULT_ORIENTATION;

/** The one place Map Orientation actually changes -- drags, the compass
 *  widget's own reset, and the __reconstruction test hook all funnel
 *  through this so the three stay in sync. */
function applyOrientation(q: Quaternion): void {
  qOrient = q;
  orientationControl.setOrientation(q);
  for (const inst of host.instances) inst.setOrientation(q);
}

// The compass is a read-only indicator now (see MapOrientationControl's own
// doc comment) -- the actual drag happens on the map itself, right below.
const orientationControl = new MapOrientationControl(DEFAULT_ORIENTATION, applyOrientation);
Object.assign(orientationControl.el.style, {
  position: 'fixed', left: '12px', bottom: '12px', zIndex: '15',
});
orientationControl.setVisible(isFlat(projectionMode));
document.body.appendChild(orientationControl.el);

wireMapOrientationDrag(
  renderer.domElement,
  { getCamera: () => camera, getMode: () => projectionMode, getOrientation: () => qOrient },
  applyOrientation,
);

// --- globe instances -- see globe/main.ts's identical comment ----------

const host = new MultiInstanceHost<ReconstructionInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: ReconstructionInstanceDeps;

function broadcastAge(source: ReconstructionInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function createInstance(): ReconstructionInstance {
  return new ReconstructionInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onSelectSample: (self, record, citation) => {
      if (record) showSamplePopup(record, citation, () => self.clearSelection());
      else hideSamplePopup();
    },
  });
}

function removeInstance(inst: ReconstructionInstance): void {
  host.remove(inst);
}

async function addInstance(): Promise<void> {
  const inst = createInstance();
  host.add(inst);
  await inst.boot();
  // Reconcile to whatever Projection/Map Orientation is already ambient --
  // boot() leaves a fresh instance at ITS OWN default (globe, identity),
  // same reconciliation broadcastAge() already does for Reconstruction Age.
  inst.setProjection(projectionMode, camera);
  inst.setOrientation(qOrient);
  broadcastAge(host.lastEditOrFocused('age')!);
}

// --- Multi-Globe menu -- see globe/main.ts's identical section -----------

// See globe/main.ts's identical comment: kept module-level for the
// __geode test hook's setSyncAge() below.
const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

wireMultiGlobeMenu(
  RECONSTRUCTION_CONFIG.multiGlobe,
  () => { void addInstance(); },
  (enabled) => { host.setSync('age', enabled); },
  (enabled) => {
    host.setSync('age', enabled);
    broadcastAge(host.lastEditOrFocused('age')!);
  },
);

wireProjectionToggle(
  document.getElementById('projection-toggle'),
  () => projectionMode,
  (mode) => setProjection(mode),
);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  host.relayout();
});

/** Which tile (if any) a screen position falls on -- shared by tile-focus
 *  below and by the click-vs-drag sample-site picking further down. */
function hitTestTile(clientX: number, clientY: number):
{ inst: ReconstructionInstance; localX: number; localY: number } | null {
  for (let i = 0; i < host.instances.length; i++) {
    const r = host.layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: host.instances[i], localX: clientX - r.x, localY: clientY - r.y };
    }
  }
  return null;
}

// Click-vs-drag: a plain click (no movement between pointerdown and
// pointerup) selects a sample site/VGP; anything that moved more than a few
// pixels is an ordinary orbit/pan/Map-Orientation drag instead -- same 5px
// threshold tomography/instance.ts's own click-vs-drag tool handling uses.
// No modifier key to gate on (unlike climate/main.ts's shift/alt querying),
// but neither OrbitControls nor wireMapOrientationDrag need to be disabled
// for this: both already treat a near-zero-movement gesture as a no-op.
let pointerDownAt: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (ev) => {
  pointerDownAt = { x: ev.clientX, y: ev.clientY };
  const hit = hitTestTile(ev.clientX, ev.clientY);
  if (hit) host.focused = hit.inst;
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  const moved = pointerDownAt
    ? Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y)
    : Infinity;
  pointerDownAt = null;
  if (moved > 5) return;
  const hit = hitTestTile(ev.clientX, ev.clientY);
  hit?.inst.selectSampleAt(hit.localX, hit.localY);
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const entry = (archive.reconstruction_models ?? []).find((r) => r.id === RECONSTRUCTION_CONFIG.reconstructionId);
  if (!entry) {
    throw new Error(`archive.json has no reconstruction_models entry '${RECONSTRUCTION_CONFIG.reconstructionId}' -- `
      + 'check generated/reconstructionConfig.ts against the current catalog');
  }
  const manifest = await loadReconstructionManifest(ARCHIVE, entry.path);

  deps = {
    archiveBase: ARCHIVE, archive, manifest, title: RECONSTRUCTION_CONFIG.title,
  };

  const first = createInstance();
  host.add(first);
  await first.boot();
  first.setProjection(projectionMode, camera);
  first.setOrientation(qOrient);

  if (window.__reconstruction) window.__reconstruction.ready = true;
}

// --- test hook ---------------------------------------------------------
declare global {
  interface Window { __reconstruction?: Record<string, unknown> }
}

function primary(): ReconstructionInstance { return host.instances[0]; }

window.__reconstruction = {
  ready: false,
  setAge: (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  addGlobe: () => addInstance(),
  removeGlobe: (index = host.instances.length - 1) => {
    const inst = host.instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => host.instances.length,
  setSyncAge: (on: boolean) => {
    host.setSync('age', on);
    if (syncAgeCheckbox) syncAgeCheckbox.checked = on;
    broadcastAge(host.lastEditOrFocused('age')!);
  },
  getSyncState: () => ({ syncAge: host.isSynced('age') }),
  setAgeOn: (index: number, age: number) => {
    const inst = host.instances[index];
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  instanceState: (index: number) => {
    const inst = host.instances[index];
    return { age: inst.view.age, reconstruction: inst.manifest?.id };
  },
  stats: () => ({
    reconstruction: primary().manifest?.id,
    age: primary().view.age,
    hasBoundaries: primary().manifest?.has_boundaries,
    globeCount: host.instances.length,
  }),
  setProjection: (mode: ProjectionMode) => setProjection(mode),
  getProjection: () => projectionMode,
  setOrientation: (centerLon: number, centerLat: number, rollDeg = 0) => {
    applyOrientation(orientationQuaternion(centerLon, centerLat, rollDeg));
  },
  resetOrientation: () => applyOrientation(DEFAULT_ORIENTATION),
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  clock.getDelta();

  renderer.setScissorTest(host.instances.length > 1);
  for (let i = 0; i < host.instances.length; i++) {
    const rect = host.layoutRects[i];
    if (!rect) continue;
    updateProjectionCameraAspect(camera, rect.width / rect.height);
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    host.instances[i].render(renderer);
  }
  renderer.setScissorTest(false);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
