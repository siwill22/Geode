import { Clock, Color, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import { tileGrid, type Rect } from '../core/layout';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import {
  ValdesInstance, type ValdesInstanceDeps, type ValdesLayer, type VectorStyle,
} from './valdesInstance';

// See climate/main.ts for why this indirection exists: VITE_ARCHIVE_BASE is
// the seam for pointing at a CDN instead of the archive shipped beside the app.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

let projectionMode: ProjectionMode = 'globe';
let camera: Camera = createProjectionCamera(projectionMode, innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls(projectionMode, camera, renderer.domElement);

function setProjection(mode: ProjectionMode): void {
  if (mode === projectionMode) return;
  projectionMode = mode;
  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);
  for (const inst of instances) inst.setProjection(mode, camera);
}

// --- globe instances ---------------------------------------------------

const instances: ValdesInstance[] = [];
let layoutRects: Rect[] = [];
let deps: ValdesInstanceDeps;
/** This instance is the sole home for Valdes/BRIDGE (see
 *  docs/adr/0008-valdes-bridge-gets-its-own-instance.md) -- exactly one
 *  Monthly and one Ocean Depth model exist, found by TYPE rather than a
 *  fixed id, so a rename or resolution bump on the prep side never needs a
 *  matching code change here. */
let monthlyModelId = '';
let oceanDepthModelId = '';

let focusedInstance: ValdesInstance;

// --- cross-globe age sync ------------------------------------------------
//
// Only age is syncable -- unlike climate.html's month, Valdes/BRIDGE's two
// Layers don't share a layer-index meaning (Monthly's is calendar month,
// Ocean Depth's is real depth), so a synced "same number, different axis"
// control would be misleading rather than useful. Rotation/zoom are locked
// for free via the one shared camera, same as every other multi-globe
// viewer in this project.

let syncAge = false;

let lastAgeEdit: ValdesInstance | null = null;

function broadcastAge(source: ValdesInstance): void {
  lastAgeEdit = source;
  if (!syncAge) return;
  const age = source.view.age;
  for (const inst of instances) {
    if (inst === source) continue;
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  }
}

function relayout(): void {
  layoutRects = tileGrid(instances.length, innerWidth, innerHeight);
  instances.forEach((inst, i) => inst.applyLayout(layoutRects[i]));
}

function createInstance(label: string): ValdesInstance {
  const inst = new ValdesInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
  }, label);
  inst.setProjection(projectionMode, camera);
  return inst;
}

function setSyncAge(on: boolean): void {
  syncAge = on;
  const cb = document.getElementById('sync-age') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastAge(lastAgeEdit ?? focusedInstance);
}

document.getElementById('sync-age')?.addEventListener('change', (e) => {
  setSyncAge((e.target as HTMLInputElement).checked);
});

async function addInstance(): Promise<void> {
  const inst = createInstance(`Globe ${instances.length + 1}`);
  instances.push(inst);
  relayout();
  try {
    await inst.boot(monthlyModelId, oceanDepthModelId);
  } catch (e) {
    console.error(e);
    inst.ui.setStatus(`failed to load: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  broadcastAge(lastAgeEdit ?? focusedInstance);
}

function removeInstance(inst: ValdesInstance): void {
  if (instances.length <= 1) return;
  const idx = instances.indexOf(inst);
  if (idx < 0) return;
  instances.splice(idx, 1);
  inst.dispose();
  if (focusedInstance === inst) focusedInstance = instances[0];
  if (lastAgeEdit === inst) lastAgeEdit = null;
  relayout();
  if (projectionToggle) primary().ui.mountProjectionToggle?.(projectionToggle);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  relayout();
});

document.getElementById('add-globe')?.addEventListener('click', () => {
  void addInstance();
});

// --- projection toggle -----------------------------------------------------

const projectionToggle = document.getElementById('projection-toggle');

const PROJECTION_ICON_GLOBE = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9"/>
  <ellipse cx="12" cy="12" rx="4" ry="9"/>
  <path d="M3 12h18"/>
  <path d="M4.5 7.5c4 2 10.5 2 14.5 0"/>
  <path d="M4.5 16.5c4-2 10.5-2 14.5 0"/>
</svg>`.trim();
const PROJECTION_ICON_FLAT = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="1.5"/>
  <path d="M3 10h18"/>
  <path d="M3 14h18"/>
  <path d="M9 6v12"/>
  <path d="M15 6v12"/>
</svg>`.trim();

function updateProjectionToggle(): void {
  if (!projectionToggle) return;
  const flat = projectionMode === 'plateCarree';
  projectionToggle.innerHTML = flat ? PROJECTION_ICON_GLOBE : PROJECTION_ICON_FLAT;
  const label = flat ? 'Switch to Globe projection' : 'Switch to Plate Carrée projection';
  projectionToggle.setAttribute('aria-label', label);
  projectionToggle.setAttribute('title', label);
}
updateProjectionToggle();

projectionToggle?.addEventListener('click', () => {
  setProjection(projectionMode === 'globe' ? 'plateCarree' : 'globe');
  updateProjectionToggle();
});

// --- interaction ---------------------------------------------------------

function hitTest(clientX: number, clientY: number): ValdesInstance | null {
  for (let i = 0; i < instances.length; i++) {
    const r = layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return instances[i];
    }
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) focusedInstance = hit;
});

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  let coastlineData = null;
  if (archive.scotese_coastlines) {
    try {
      coastlineData = await fetchCoastlineData(
        ARCHIVE, archive.scotese_coastlines.geometry, archive.scotese_coastlines.rotations,
      );
    } catch {
      coastlineData = null;
    }
  }

  deps = { archiveBase: ARCHIVE, archive, colormaps, coastlineData };

  const monthly = archive.models.find((m) => m.type === 'climate-monthly')?.id;
  const oceanDepth = archive.models.find((m) => m.type === 'climate-ocean-depth')?.id;
  if (!monthly) throw new Error('archive.json has no model of type "climate-monthly"');
  if (!oceanDepth) throw new Error('archive.json has no model of type "climate-ocean-depth"');
  monthlyModelId = monthly;
  oceanDepthModelId = oceanDepth;

  const first = createInstance('Globe 1');
  instances.push(first);
  focusedInstance = first;
  relayout();
  if (projectionToggle) first.ui.mountProjectionToggle?.(projectionToggle);
  await first.boot(monthlyModelId, oceanDepthModelId);

  if (window.__valdes) window.__valdes.ready = true;
}

// --- test hook --------------------------------------------------------------

declare global {
  interface Window { __valdes?: Record<string, unknown> }
}

function primary(): ValdesInstance { return instances[0]; }

window.__valdes = {
  ready: false,
  setAge: async (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setLayer: async (layer: ValdesLayer) => {
    const inst = primary();
    await inst.setLayer(layer);
    inst.ui.refreshDisplay();
  },
  setVariable: async (id: string) => {
    const inst = primary();
    await inst.setVariable(id);
    inst.ui.refreshDisplay();
  },
  setLayerIndex: (index: number) => {
    const inst = primary();
    inst.applyLayerIndex(index);
    inst.ui.refreshDisplay();
  },
  setVectorField: async (id: string | null) => {
    const inst = primary();
    await inst.setVectorField(id);
    inst.ui.refreshDisplay();
  },
  setShowVector: (v: boolean) => {
    const inst = primary();
    inst.setVectorVisible(v);
    inst.ui.refreshDisplay();
  },
  setVectorStyle: (v: VectorStyle) => {
    const inst = primary();
    inst.setVectorStyle(v);
    inst.ui.refreshDisplay();
  },
  addGlobe: () => addInstance(),
  removeGlobe: (index = instances.length - 1) => {
    const inst = instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => instances.length,
  setSyncAge,
  getSyncState: () => ({ syncAge }),
  stats: () => {
    const inst = primary();
    return {
      model: inst.manifest?.id,
      layer: inst.layer,
      variable: inst.variable?.id,
      age: inst.view.age,
      layerIndex: inst.view.layerIndex,
      clip: [inst.view.clipMin, inst.view.clipMax],
      vectorFieldId: inst.view.vectorFieldId,
      showVector: inst.view.showVector,
      vectorStyle: inst.view.vectorStyle,
      globeCount: instances.length,
    };
  },
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  renderer.setScissorTest(instances.length > 1);
  const dt = clock.getDelta();
  for (let i = 0; i < instances.length; i++) {
    const rect = layoutRects[i];
    if (!rect) continue;
    updateProjectionCameraAspect(camera, rect.width / rect.height);
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    instances[i].tick(dt);
    instances[i].render(renderer);
  }
  renderer.setScissorTest(false);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre id="error">${String(e)}</pre>`,
  );
});
animate();
