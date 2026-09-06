import { Clock, Color, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { loadArchive } from '../core/volume';
import { createProjectionCamera, createProjectionControls, updateProjectionCameraAspect } from '../core/projection';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { ReconstructionGroupInstance, type ReconstructionGroupInstanceDeps } from './reconstructionGroupInstance';
import { RECONSTRUCTION_GROUP_CONFIG } from '../generated/reconstructionGroupConfig';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = RECONSTRUCTION_GROUP_CONFIG.title;

// Several Reconstruction Models switched by dropdown -- see
// reconstruction/main.ts for the single-model sibling. See globe/main.ts's
// identical comment: one shared camera for every tile.
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

// --- globe instances -- see globe/main.ts's identical comment ----------

const host = new MultiInstanceHost<ReconstructionGroupInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: ReconstructionGroupInstanceDeps;

function broadcastAge(source: ReconstructionGroupInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function createInstance(): ReconstructionGroupInstance {
  return new ReconstructionGroupInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
  });
}

function removeInstance(inst: ReconstructionGroupInstance): void {
  host.remove(inst);
}

async function addInstance(): Promise<void> {
  const inst = createInstance();
  host.add(inst);
  await inst.boot();
  broadcastAge(host.lastEditOrFocused('age')!);
}

// --- Multi-Globe toolbar -- see globe/main.ts's identical section -------

const toolbar = document.getElementById('toolbar');
const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

if (RECONSTRUCTION_GROUP_CONFIG.multiGlobe) {
  if (toolbar) toolbar.hidden = false;
  document.getElementById('add-globe')?.addEventListener('click', () => {
    void addInstance();
  });
  if (syncAgeCheckbox) {
    syncAgeCheckbox.checked = RECONSTRUCTION_GROUP_CONFIG.multiGlobe.syncAge;
    host.setSync('age', RECONSTRUCTION_GROUP_CONFIG.multiGlobe.syncAge);
    syncAgeCheckbox.addEventListener('change', (e) => {
      host.setSync('age', (e.target as HTMLInputElement).checked);
      broadcastAge(host.lastEditOrFocused('age')!);
    });
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  host.relayout();
});

renderer.domElement.addEventListener('pointerdown', (ev) => {
  for (let i = 0; i < host.instances.length; i++) {
    const r = host.layoutRects[i];
    if (r && ev.clientX >= r.x && ev.clientX < r.x + r.width
      && ev.clientY >= r.y && ev.clientY < r.y + r.height) {
      host.focused = host.instances[i];
      break;
    }
  }
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const all = archive.reconstruction_models ?? [];
  const entries = RECONSTRUCTION_GROUP_CONFIG.reconstructionIds.map((id) => {
    const e = all.find((r) => r.id === id);
    if (!e) {
      throw new Error(`archive.json has no reconstruction_models entry '${id}' -- `
        + 'check generated/reconstructionGroupConfig.ts against the current catalog');
    }
    return e;
  });

  deps = { archiveBase: ARCHIVE, entries, title: RECONSTRUCTION_GROUP_CONFIG.title };

  const first = createInstance();
  host.add(first);
  await first.boot();

  if (window.__reconstructionGroup) window.__reconstructionGroup.ready = true;
}

// --- test hook ---------------------------------------------------------
declare global {
  interface Window { __reconstructionGroup?: Record<string, unknown> }
}

function primary(): ReconstructionGroupInstance { return host.instances[0]; }

window.__reconstructionGroup = {
  ready: false,
  setAge: (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setReconstruction: async (id: string) => {
    await primary().setReconstruction(id);
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
  setReconstructionOn: async (index: number, id: string) => {
    const inst = host.instances[index];
    await inst.setReconstruction(id);
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
