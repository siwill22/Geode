import { Clock, Color, Vector2, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { loadArchive, loadColormaps } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { wireMultiGlobeMenu } from '../core/multiGlobeMenu';
import { GroupGlobeInstance, type GroupGlobeInstanceDeps, type NoDataStyle } from './groupGlobeInstance';
import { GROUP_GLOBE_CONFIG } from '../generated/groupConfig';

// See globe/main.ts for why this indirection exists: VITE_ARCHIVE_BASE
// points a generated repo's build at the shared central data host instead
// of a local archive/ tree.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = GROUP_GLOBE_CONFIG.title;

// See globe/main.ts's identical comment: one shared camera for every tile.
// No Plate Carrée toggle in v1.5 (matches single-model-globe's own scope).
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

// --- globe instances ---------------------------------------------------
//
// See globe/main.ts's identical comment: instance bookkeeping lives in
// core/multiInstanceHost.ts (docs/adr/0022). Every instance starts on the
// SAME grid cell (defaultAxisA/defaultAxisB) but can switch its own
// dropdowns independently -- Multi-Globe here compares either different
// ages of the same cell, or different cells at the synced same age.

const host = new MultiInstanceHost<GroupGlobeInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: GroupGlobeInstanceDeps;

function broadcastAge(source: GroupGlobeInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function createInstance(): GroupGlobeInstance {
  return new GroupGlobeInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
  });
}

function removeInstance(inst: GroupGlobeInstance): void {
  host.remove(inst);
}

async function addInstance(): Promise<void> {
  const inst = createInstance();
  host.add(inst);
  await inst.boot();
  broadcastAge(host.lastEditOrFocused('age')!);
}

// --- Multi-Globe menu -- see globe/main.ts's identical section -----------

// See globe/main.ts's identical comment: kept module-level for the
// __geode test hook's setSyncAge() below.
const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

wireMultiGlobeMenu(
  GROUP_GLOBE_CONFIG.multiGlobe,
  () => { void addInstance(); },
  (enabled) => { host.setSync('age', enabled); },
  (enabled) => {
    host.setSync('age', enabled);
    broadcastAge(host.lastEditOrFocused('age')!);
  },
);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  host.relayout();
});

// --- interaction --------------------------------------------------------
// Anchored Point (see docs/adr/0011, docs/adr/0016) -- same tile-aware
// shift-click gesture as globe/main.ts.

function hitTest(clientX: number, clientY: number): { inst: GroupGlobeInstance; rect: Rect } | null {
  for (let i = 0; i < host.instances.length; i++) {
    const r = host.layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: host.instances[i], rect: r };
    }
  }
  return null;
}

const ptr = new Vector2();
function ndcFor(rect: Rect, clientX: number, clientY: number): Vector2 {
  ptr.x = ((clientX - rect.x) / rect.width) * 2 - 1;
  ptr.y = -((clientY - rect.y) / rect.height) * 2 + 1;
  return ptr;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) host.focused = hit.inst;
  if (ev.shiftKey) controls.enabled = false;
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  controls.enabled = true;
  if (!ev.shiftKey) return;
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  updateProjectionCameraAspect(camera, hit.rect.width / hit.rect.height);
  void hit.inst.queryPointAt(ndcFor(hit.rect, ev.clientX, ev.clientY)).then((sample) => {
    if (sample) hit.inst.ui.showQueryResult(sample, hit.inst.variable);
  });
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  deps = {
    archiveBase: ARCHIVE,
    archive,
    colormaps,
    tools: GROUP_GLOBE_CONFIG.tools,
    title: GROUP_GLOBE_CONFIG.title,
    axisALabel: GROUP_GLOBE_CONFIG.axisALabel,
    axisBLabel: GROUP_GLOBE_CONFIG.axisBLabel,
    grid: GROUP_GLOBE_CONFIG.grid,
    defaultAxisA: GROUP_GLOBE_CONFIG.defaultAxisA,
    defaultAxisB: GROUP_GLOBE_CONFIG.defaultAxisB,
  };

  const first = createInstance();
  host.add(first);
  await first.boot();

  if (window.__groupGlobe) window.__groupGlobe.ready = true;
}

// --- test hook ---------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts, same shape as
// window.__globe/window.__climate. Flat methods target the FIRST instance
// ("primary"); the ...On(index, ...) methods target a specific instance.

declare global {
  interface Window { __groupGlobe?: Record<string, unknown> }
}

function primary(): GroupGlobeInstance { return host.instances[0]; }

window.__groupGlobe = {
  ready: false,
  setAxisA: async (v: string) => { await primary().setAxisA(v); primary().ui.refreshDisplay(); },
  setAxisB: async (v: string) => { await primary().setAxisB(v); primary().ui.refreshDisplay(); },
  setAge: (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setVariable: async (id: string) => {
    await primary().setVariable(id);
    primary().ui.refreshDisplay();
  },
  setNoDataStyle: (style: NoDataStyle) => {
    primary().setNoDataStyle(style);
    primary().ui.refreshDisplay();
  },
  queryPointAt: (ndcX: number, ndcY: number) => primary().queryPointAt(new Vector2(ndcX, ndcY)),
  probeScreen: (o: { nx?: number; ny?: number } = {}) => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    renderer.render(primary().scene, camera);
    const x = Math.round(((o.nx ?? 0) * 0.5 + 0.5) * (w - 1));
    const y = Math.round(((o.ny ?? 0) * 0.5 + 0.5) * (h - 1));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { x, y, rgb: [px[0], px[1], px[2]] };
  },
  getGui: () => primary().ui.gui,
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
    return { age: inst.view.age, axisA: inst.view.axisA, axisB: inst.view.axisB, variable: inst.variable?.id };
  },
  stats: () => ({
    model: primary().manifest?.id,
    axisA: primary().view.axisA,
    axisB: primary().view.axisB,
    variable: primary().variable?.id,
    age: primary().view.age,
    clip: [primary().view.clipMin, primary().view.clipMax],
    noDataStyle: primary().view.noDataStyle,
    globeCount: host.instances.length,
  }),
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
