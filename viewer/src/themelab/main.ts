import { Clock, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { loadArchive } from '../core/volume';
import { loadReconstructionManifest } from '../core/reconstructions';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { wireMultiGlobeMenu } from '../core/multiGlobeMenu';
import { ALL_THEMES, DEFAULT_THEME, type ThemeId } from '../core/theme';
import { ThemeLabInstance, type ThemeLabInstanceDeps } from './themeLabInstance';
import { RECONSTRUCTION_CONFIG } from '../generated/reconstructionConfig';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = 'Geode Theme Lab';

const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// No setClearColor here, unlike every other wrapper. Each instance clears its
// own scissor rect with its own Theme's page colour -- see
// ThemeLabInstance.render(). autoClear off for the same reason: an automatic
// full-canvas clear would wipe the tile drawn immediately before this one.
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

const host = new MultiInstanceHost<ThemeLabInstance>(
  () => ({ width: innerWidth, height: innerHeight }),
);
let deps: ThemeLabInstanceDeps;

function broadcastAge(source: ThemeLabInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

/**
 * Which Theme a newly added globe should start on: the next one in the table
 * that nothing on screen is already showing.
 *
 * Cycling rather than copying the focused instance is the whole ergonomics of
 * this viewer -- "+ Add globe" is how you put two Themes side by side, and a
 * new tile identical to the one beside it would make that a two-step operation
 * every single time. Falls back to cycling by index once every Theme is up.
 */
function nextUnusedTheme(): ThemeId {
  const used = new Set(host.instances.map((i) => i.view.themeId));
  const free = ALL_THEMES.find((t) => !used.has(t.id));
  return free ? free.id : ALL_THEMES[host.instances.length % ALL_THEMES.length].id;
}

function createInstance(): ThemeLabInstance {
  return new ThemeLabInstance(camera, deps, {
    onRemove: (self) => { host.remove(self); },
    onAgeChange: (self) => broadcastAge(self),
  });
}

async function addInstance(themeId?: ThemeId): Promise<ThemeLabInstance> {
  const wanted = themeId ?? nextUnusedTheme();
  const inst = createInstance();
  inst.view.themeId = wanted;
  host.add(inst);
  await inst.boot();
  inst.ui.refreshDisplay();
  broadcastAge(host.lastEditOrFocused('age') ?? inst);
  return inst;
}

const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

wireMultiGlobeMenu(
  { syncAge: true },
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
  const id = RECONSTRUCTION_CONFIG.reconstructionId;
  const entry = (archive.reconstruction_models ?? []).find((r) => r.id === id);
  if (!entry) {
    throw new Error(`archive.json has no reconstruction_models entry '${id}'`);
  }
  const manifest = await loadReconstructionManifest(ARCHIVE, entry.path);
  deps = { archiveBase: ARCHIVE, manifest, title: 'Theme' };

  // core/theme.ts's applyChromeLightness() is deliberately NOT called here.
  // It stamps one Lightness on the whole page, which is right for every
  // wrapper with a single global Theme and meaningless in this one: each tile
  // has its own. The per-tile chrome follows its own instance instead, in
  // ThemeLabUI.setThemeInfo(). The lil-gui panels stay dark throughout, which
  // is legible on every Theme because they carry their own opaque background.

  // Age syncs by default here, unlike other wrappers: two globes at different
  // ages are comparing reconstructions, and this viewer is comparing Themes.
  host.setSync('age', true);
  if (syncAgeCheckbox) syncAgeCheckbox.checked = true;

  await addInstance(DEFAULT_THEME);

  if (window.__themelab) window.__themelab.ready = true;
}

declare global {
  interface Window { __themelab?: Record<string, unknown> }
}

function primary(): ThemeLabInstance { return host.instances[0]; }

window.__themelab = {
  ready: false,
  themeIds: () => ALL_THEMES.map((t) => t.id),
  setTheme: (id: ThemeId, index = 0) => {
    const inst = host.instances[index];
    inst.applyThemeId(id);
    inst.ui.refreshDisplay();
  },
  setAge: (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  addGlobe: (id?: ThemeId) => addInstance(id),
  removeGlobe: (index = host.instances.length - 1) => {
    const inst = host.instances[index];
    if (inst) host.remove(inst);
  },
  globeCount: () => host.instances.length,
  instanceState: (index: number) => {
    const inst = host.instances[index];
    return {
      themeId: inst.view.themeId,
      age: inst.view.age,
      page: inst.theme.page,
      land: inst.theme.land,
      outline: inst.theme.outline,
      weight: inst.theme.weight,
    };
  },
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  clock.getDelta();

  // Scissor test is always on here, even for a single globe: the per-instance
  // clear in render() must not reach outside its own tile.
  renderer.setScissorTest(true);
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
