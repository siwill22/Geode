import { Clock, Color, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { fetchCoastlineData, resolveCoastlineSet } from '../core/coastlines';
import { loadArchive, loadColormaps, loadManifest } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import { GlobeInstance, type NoDataStyle } from './globeInstance';
import { GLOBE_CONFIG } from '../generated/config';

// See deformation/main.ts for why this indirection exists: VITE_ARCHIVE_BASE
// is the seam a generated repo's build points at the shared central data
// host instead of a local archive/ tree -- see generator/scaffoldRepo.mjs.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

document.title = GLOBE_CONFIG.title;

// One globe, one camera, one Model -- no multi-globe support and no Plate
// Carrée toggle in v1 (see the plan doc's fixed tool menu).
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

let instance: GlobeInstance;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
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

  instance = new GlobeInstance(camera, {
    archiveBase: ARCHIVE, archive, colormaps, manifest, coastlineData, creditCoastlines,
    tools: GLOBE_CONFIG.tools, title: GLOBE_CONFIG.title,
  });
  await instance.boot();

  renderer.domElement.addEventListener('click', (ev) => {
    const ndcX = (ev.clientX / innerWidth) * 2 - 1;
    const ndcY = -(ev.clientY / innerHeight) * 2 + 1;
    const sample = instance.pickPoint(ndcX, ndcY);
    if (sample) instance.ui.showQueryResult(sample, instance.variable);
  });

  if (window.__globe) window.__globe.ready = true;
}

// --- test hook ---------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts, same shape as
// window.__climate/window.__deformation.

declare global {
  interface Window { __globe?: Record<string, unknown> }
}

window.__globe = {
  ready: false,
  setAge: (age: number) => { instance.applyAge(age); instance.ui.refreshDisplay(); },
  setVariable: async (id: string) => {
    await instance.setVariable(id);
    instance.ui.refreshDisplay();
  },
  setNoDataStyle: (style: NoDataStyle) => {
    instance.setNoDataStyle(style);
    instance.ui.refreshDisplay();
  },
  pickPoint: (ndcX: number, ndcY: number) => instance.pickPoint(ndcX, ndcY),
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
