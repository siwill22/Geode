import { Clock, Color, Vector2, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { loadArchive, loadColormaps } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import { GroupGlobeInstance, type NoDataStyle } from './groupGlobeInstance';
import { GROUP_GLOBE_CONFIG } from '../generated/groupConfig';

// See globe/main.ts for why this indirection exists: VITE_ARCHIVE_BASE
// points a generated repo's build at the shared central data host instead
// of a local archive/ tree.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = GROUP_GLOBE_CONFIG.title;

// One globe, one camera -- no multi-globe support and no Plate Carrée
// toggle in v1.5 (matches single-model-globe's own scope).
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

let instance: GroupGlobeInstance;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
});

const ptr = new Vector2();
function ndcFor(clientX: number, clientY: number): Vector2 {
  ptr.x = (clientX / innerWidth) * 2 - 1;
  ptr.y = -(clientY / innerHeight) * 2 + 1;
  return ptr;
}

// Anchored Point (see docs/adr/0011, docs/adr/0016) -- same shift-click
// gesture as globe/main.ts and climate/main.ts, for the same reason (a
// plain click fights OrbitControls).
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.shiftKey) controls.enabled = false;
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  controls.enabled = true;
  if (!ev.shiftKey || !instance) return;
  void instance.queryPointAt(ndcFor(ev.clientX, ev.clientY)).then((sample) => {
    if (sample) instance.ui.showQueryResult(sample, instance.variable);
  });
});

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  instance = new GroupGlobeInstance(camera, {
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
  });
  await instance.boot();

  if (window.__groupGlobe) window.__groupGlobe.ready = true;
}

// --- test hook ---------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts, same shape as
// window.__globe/window.__climate.

declare global {
  interface Window { __groupGlobe?: Record<string, unknown> }
}

window.__groupGlobe = {
  ready: false,
  setAxisA: async (v: string) => { await instance.setAxisA(v); instance.ui.refreshDisplay(); },
  setAxisB: async (v: string) => { await instance.setAxisB(v); instance.ui.refreshDisplay(); },
  setAge: (age: number) => { instance.applyAge(age); instance.ui.refreshDisplay(); },
  setVariable: async (id: string) => {
    await instance.setVariable(id);
    instance.ui.refreshDisplay();
  },
  setNoDataStyle: (style: NoDataStyle) => {
    instance.setNoDataStyle(style);
    instance.ui.refreshDisplay();
  },
  queryPointAt: (ndcX: number, ndcY: number) => instance.queryPointAt(new Vector2(ndcX, ndcY)),
  probeScreen: (o: { nx?: number; ny?: number } = {}) => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    renderer.render(instance.scene, camera);
    const x = Math.round(((o.nx ?? 0) * 0.5 + 0.5) * (w - 1));
    const y = Math.round(((o.ny ?? 0) * 0.5 + 0.5) * (h - 1));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { x, y, rgb: [px[0], px[1], px[2]] };
  },
  getGui: () => instance.ui.gui,
  stats: () => ({
    model: instance.manifest?.id,
    axisA: instance.view.axisA,
    axisB: instance.view.axisB,
    variable: instance.variable?.id,
    age: instance.view.age,
    clip: [instance.view.clipMin, instance.view.clipMax],
    noDataStyle: instance.view.noDataStyle,
  }),
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  clock.getDelta();
  if (instance) instance.render(renderer);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
