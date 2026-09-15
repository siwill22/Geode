import { Clock, Color, Vector2, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import { tileGrid, type Rect } from '../core/layout';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { wireProjectionToggle } from '../core/projectionToggle';
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

document.getElementById('globe-menu-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('globe-menu');
  if (menu) menu.hidden = !menu.hidden;
});

// --- projection toggle -----------------------------------------------------

const projectionToggle = document.getElementById('projection-toggle');

// Shared with climate -- see core/projectionToggle.ts for the icons and why
// this stopped being a two-state toggle written out per wrapper.
const refreshProjectionToggle = wireProjectionToggle(
  projectionToggle,
  () => projectionMode,
  (mode) => setProjection(mode),
);

// --- interaction ---------------------------------------------------------

function hitTest(clientX: number, clientY: number): { inst: ValdesInstance; rect: Rect } | null {
  for (let i = 0; i < instances.length; i++) {
    const r = layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: instances[i], rect: r };
    }
  }
  return null;
}

/** NDC for a point, relative to one tile rather than the whole window --
 *  mirrors climate/main.ts's own ndcFor(). */
const ptr = new Vector2();
function ndcFor(rect: Rect, clientX: number, clientY: number): Vector2 {
  ptr.x = ((clientX - rect.x) / rect.width) * 2 - 1;
  ptr.y = -((clientY - rect.y) / rect.height) * 2 + 1;
  return ptr;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) focusedInstance = hit.inst;
  // Alt-click seeds a Tracked Particle (docs/plans/tracked-particle-
  // seeding.md) -- disable orbiting for the gesture's duration, same
  // reasoning as climate/main.ts's shift/alt handling: with orbiting off,
  // nothing competes for the click-vs-drag distinction.
  if (ev.altKey) controls.enabled = false;
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  controls.enabled = true; // unconditional: an alt-release mid-drag must not wedge orbiting off
  if (!ev.altKey) return;
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  updateProjectionCameraAspect(camera, hit.rect.width / hit.rect.height);
  hit.inst.addTrackedParticleAt(ndcFor(hit.rect, ev.clientX, ev.clientY));
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
  // See climate/main.ts's identical hook: a screenshot check can't click
  // through a cycle to reach the third Projection.
  setProjection: (mode: ProjectionMode) => {
    setProjection(mode);
    refreshProjectionToggle();
  },
  getProjection: () => projectionMode,
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
  /** Bypasses the alt-click raycast entirely -- see climate/main.ts's own
   *  addTrackedParticle() test hook for why. */
  addTrackedParticle: (lon: number, lat: number) => {
    primary().trackedParticles.add({ lon, lat });
  },
  clearTrackedParticles: () => primary().clearTrackedParticles(),
  trackedParticleCount: () => primary().trackedParticles.count,
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
