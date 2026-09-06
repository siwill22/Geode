import { Clock, Color, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { loadArchive } from '../core/volume';
import { loadReconstructionManifest } from '../core/reconstructions';
import { createProjectionCamera, createProjectionControls, updateProjectionCameraAspect } from '../core/projection';
import { MultiInstanceHost } from '../core/multiInstanceHost';
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
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

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
  });
}

function removeInstance(inst: ReconstructionInstance): void {
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

if (RECONSTRUCTION_CONFIG.multiGlobe) {
  if (toolbar) toolbar.hidden = false;
  document.getElementById('add-globe')?.addEventListener('click', () => {
    void addInstance();
  });
  if (syncAgeCheckbox) {
    syncAgeCheckbox.checked = RECONSTRUCTION_CONFIG.multiGlobe.syncAge;
    host.setSync('age', RECONSTRUCTION_CONFIG.multiGlobe.syncAge);
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
  const entry = (archive.reconstruction_models ?? []).find((r) => r.id === RECONSTRUCTION_CONFIG.reconstructionId);
  if (!entry) {
    throw new Error(`archive.json has no reconstruction_models entry '${RECONSTRUCTION_CONFIG.reconstructionId}' -- `
      + 'check generated/reconstructionConfig.ts against the current catalog');
  }
  const manifest = await loadReconstructionManifest(ARCHIVE, entry.path);

  deps = { archiveBase: ARCHIVE, manifest, title: RECONSTRUCTION_CONFIG.title };

  const first = createInstance();
  host.add(first);
  await first.boot();

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
