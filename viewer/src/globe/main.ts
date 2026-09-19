import { Clock, Color, Vector2, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { fetchCoastlineData, resolveCoastlineSet } from '../core/coastlines';
import { loadArchive, loadColormaps, loadManifest } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import { wireMultiGlobeMenu } from '../core/multiGlobeMenu';
import { GlobeInstance, type GlobeInstanceDeps, type NoDataStyle } from './globeInstance';
import { GLOBE_CONFIG } from '../generated/config';

// See deformation/main.ts for why this indirection exists: VITE_ARCHIVE_BASE
// is the seam a generated repo's build points at the shared central data
// host instead of a local archive/ tree -- see generator/scaffoldRepo.mjs.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = GLOBE_CONFIG.title;

// One shared camera for every tile -- see docs/adr/0022, tomography/main.ts's
// original comment on why a single OrbitControls this way keeps rotation/
// zoom locked together across an arbitrary number of tiles for free. No
// Plate Carrée toggle in v1 (see the plan doc's fixed tool menu).
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Themes are not yet wired into this wrapper's UI -- it boots on the
// default Theme's page colour. See docs/adr/0038 for the intended
// always-present control, and themelab/ for the built one.
renderer.setClearColor(new Color(resolveTheme(DEFAULT_THEME).page));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

// --- globe instances ---------------------------------------------------
//
// Instance bookkeeping lives in core/multiInstanceHost.ts (docs/adr/0022).
// Every instance shows the SAME dataset (this wrapper type is exactly one
// Model, per generator/recipeTypes.ts) -- Multi-Globe here is purely about
// comparing it at different ages side by side, gated entirely by whether
// the recipe declared `multiGlobe` (see core/tools.ts's MultiGlobeConfig).

const host = new MultiInstanceHost<GlobeInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: GlobeInstanceDeps;

/** Push `source`'s current age into every OTHER instance's own state --
 *  age is the only Synced Field this wrapper type offers (see CONTEXT.md). */
function broadcastAge(source: GlobeInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function createInstance(): GlobeInstance {
  return new GlobeInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
  });
}

function removeInstance(inst: GlobeInstance): void {
  host.remove(inst);
}

async function addInstance(): Promise<void> {
  const inst = createInstance();
  host.add(inst);
  await inst.boot();
  // A globe added while sync is active joins the synced group immediately,
  // rather than booting at age 0 and waiting for the next drag elsewhere.
  broadcastAge(host.lastEditOrFocused('age')!);
}

// --- Multi-Globe menu ------------------------------------------------------
//
// Markup always present in the static HTML (see globe.html) so
// scaffoldRepo.mjs never has to template it per recipe -- same convention
// `ui.tools` already uses (GlobeUI shows/hides its own controls at
// runtime). wireMultiGlobeMenu leaves it hidden entirely when the recipe
// didn't ask for it -- see core/multiGlobeMenu.ts.

// Kept as a module-level reference (not just inside wireMultiGlobeMenu)
// because the __geode test hook's setSyncAge() below also needs to keep
// the checkbox's visual state consistent with a change it drives directly
// through `host`, bypassing the checkbox's own change event entirely.
const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;

wireMultiGlobeMenu(
  GLOBE_CONFIG.multiGlobe,
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

// --- interaction ---------------------------------------------------------
//
// Anchored Point (see docs/adr/0011, docs/adr/0016): shift-click queries the
// currently-displayed variable at the clicked cell. Needs a tile hit AND
// that tile's own NDC once more than one globe can be on screen -- mirrors
// climate/main.ts's identical hitTest/ndcFor pattern.

function hitTest(clientX: number, clientY: number): { inst: GlobeInstance; rect: Rect } | null {
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

  const entry = archive.models.find((m) => m.id === GLOBE_CONFIG.modelId);
  if (!entry) {
    throw new Error(`archive.json has no model '${GLOBE_CONFIG.modelId}' -- `
      + 'check generated/config.ts against the current catalog');
  }
  const manifest = await loadManifest(ARCHIVE, entry.path);

  const coastlineSet = resolveCoastlineSet(archive, manifest);
  let coastlineData = null;
  let creditCoastlines: string | null = null;
  if (coastlineSet) {
    try {
      coastlineData = await fetchCoastlineData(ARCHIVE, coastlineSet.geometry, coastlineSet.rotations);
      creditCoastlines = manifest.reconstruction_model
        ? `coastlines ${manifest.reconstruction_model} (native rotations)`
        : 'coastlines';
    } catch {
      coastlineData = null; // a layer, not a prerequisite -- the globe still works
    }
  }

  deps = {
    archiveBase: ARCHIVE, archive, colormaps, manifest, coastlineData, creditCoastlines,
    tools: GLOBE_CONFIG.tools, title: GLOBE_CONFIG.title,
  };

  const first = createInstance();
  host.add(first);
  await first.boot();

  if (window.__globe) window.__globe.ready = true;
}

// --- test hook ---------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts, same shape as
// window.__climate/window.__deformation. Flat methods target the FIRST
// instance ("primary"), same convention window.__geode/__climate use; the
// ...On(index, ...) methods target a specific instance.

declare global {
  interface Window { __globe?: Record<string, unknown> }
}

function primary(): GlobeInstance { return host.instances[0]; }

window.__globe = {
  ready: false,
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
    return { age: inst.view.age, variable: inst.variable?.id };
  },
  stats: () => ({
    model: primary().manifest?.id,
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
