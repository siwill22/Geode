import { Clock, Color, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
} from '../core/projection';
import {
  DeformationInstance, type DeformationInstanceDeps, type DeformationLayer,
  type NoDataStyle, type ReconstructionConfig,
} from './deformationInstance';

// See tomography/climate main.ts for why this indirection exists:
// VITE_ARCHIVE_BASE is the seam for pointing at a CDN instead of the archive
// shipped beside the app.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

// Cosmetic only -- which reconstruction_model string gets a pretty label.
// An unlisted value still works, just labelled with its raw manifest string.
// This must NEVER be used to decide which coastlines pair with a Model --
// that comes from archive.native_coastlines, keyed by the manifest's own
// reconstruction_model field (see boot() below and
// docs/adr/0004-per-run-coastline-rotations.md), so a Model's coastlines
// always match what its own config actually reconstructed against rather
// than a hand-maintained id->coastlines table that can drift out of sync.
const DISPLAY_NAMES: Record<string, string> = {
  Muller2019: 'Müller et al. 2019',
  Cao2024: 'Cao et al. 2024',
};

// One globe, one camera -- no multi-globe support in v1 (out of scope, see
// the plan doc) and no Plate Carrée toggle, so the camera/controls here are
// built once and never replaced, unlike tomography/climate's main.ts.
const camera = createProjectionCamera('globe', innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

let instance: DeformationInstance;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
});

// A deformation run always ships as a Deformation + Age & Heat Flux Model
// pair sharing one id prefix (see prep_deformation.py) -- that pairing
// convention is this viewer's own structure, unlike the reconstruction a
// run used, which is never assumed and always read from the manifest.
const DEFORMATION_SUFFIX = '-deformation';
const AGE_HEATFLUX_SUFFIX = '-age-heatflux';

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  const reconstructions: ReconstructionConfig[] = [];
  for (const dm of archive.models) {
    if (!dm.id.endsWith(DEFORMATION_SUFFIX)) continue;
    const prefix = dm.id.slice(0, -DEFORMATION_SUFFIX.length);
    const ageHeatfluxId = `${prefix}${AGE_HEATFLUX_SUFFIX}`;
    if (!archive.models.find((m) => m.id === ageHeatfluxId)) continue; // incomplete ingest

    const reconstructionModel = dm.reconstruction_model;
    if (!reconstructionModel) {
      console.warn(`model '${dm.id}' has no reconstruction_model -- re-run `
        + 'prep_deformation.py to regenerate its manifest. Skipping.');
      continue;
    }

    const label = DISPLAY_NAMES[reconstructionModel] ?? reconstructionModel;
    const entry = archive.native_coastlines?.[reconstructionModel.toLowerCase()];
    let coastlineData = null;
    if (entry) {
      try {
        coastlineData = await fetchCoastlineData(ARCHIVE, entry.geometry, entry.rotations);
      } catch {
        coastlineData = null; // a layer, not a prerequisite -- the globe still works
      }
    }
    reconstructions.push({
      id: prefix, label,
      deformationModelId: dm.id, ageHeatfluxModelId: ageHeatfluxId,
      coastlineData, creditCoastlines: `coastlines ${label} (native rotations)`,
    });
  }
  if (reconstructions.length === 0) {
    throw new Error('archive.json has no usable deformation runs -- run prep_deformation.py');
  }

  const deps: DeformationInstanceDeps = { archiveBase: ARCHIVE, archive, colormaps };

  instance = new DeformationInstance(camera, deps);
  await instance.boot(reconstructions);

  if (window.__deformation) window.__deformation.ready = true;
}

// --- test hook ---------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts, same shape as
// window.__climate/window.__geode.

declare global {
  interface Window { __deformation?: Record<string, unknown> }
}

window.__deformation = {
  ready: false,
  setAge: (age: number) => { instance.applyAge(age); instance.ui.refreshDisplay(); },
  setReconstruction: async (id: string) => {
    await instance.setReconstruction(id);
    instance.ui.refreshDisplay();
  },
  setLayer: async (layer: DeformationLayer) => {
    await instance.setLayer(layer);
    instance.ui.refreshDisplay();
  },
  setVariable: async (id: string) => {
    await instance.setVariable(id);
    instance.ui.refreshDisplay();
  },
  setNoDataStyle: (style: NoDataStyle) => {
    instance.setNoDataStyle(style);
    instance.ui.refreshDisplay();
  },
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
    reconstruction: instance.view.reconstruction,
    layer: instance.view.layer,
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
