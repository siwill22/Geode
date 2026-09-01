import { Color, PerspectiveCamera, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { R_SURFACE, lonLatToVec3 } from '../core/constants';
import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import type { ColormapData } from '../core/types';
import {
  ClimateInstance, DEFAULT_OVERLAY_OPACITY, DEFAULT_WIND_VISIBLE,
  type ClimateInstanceDeps, type ClimateLayer,
} from './climateInstance';
import { ClimateUI, type ClimateViewState } from './climateUi';

// See main.ts for why this indirection exists: VITE_ARCHIVE_BASE is the seam
// for pointing at a CDN instead of the archive shipped beside the app.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

// --- renderer / camera ------------------------------------------------------
// One globe, one page: no shared-camera tiling, no scissor juggling, no log
// depth buffer (there's no core to z-fight against -- the field IS the
// surface). See viewer/src/tomography/main.ts for the multi-globe tomography
// version this deliberately does not reuse.

const camera = new PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 50);
camera.position.set(2.6, 1.4, 2.2);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = R_SURFACE + 0.1;
controls.maxDistance = 12;
controls.enablePan = false;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

let instance: ClimateInstance;
let ui: ClimateUI;
let state: ClimateViewState;
let colormaps: ColormapData;

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  let coastlineData = null;
  if (archive.scotese_coastlines) {
    try {
      coastlineData = await fetchCoastlineData(
        ARCHIVE, archive.scotese_coastlines.geometry, archive.scotese_coastlines.rotations,
      );
    } catch {
      coastlineData = null; // a layer, not a prerequisite -- the globe still works
    }
  }

  const deps: ClimateInstanceDeps = {
    archiveBase: ARCHIVE, archive, colormaps, coastlineData,
  };

  const climateModelId = archive.models.find((m) => m.type === 'climate')?.id;
  const paleogeographyModelId = archive.models.find((m) => m.type === 'paleogeography')?.id;
  if (!climateModelId) throw new Error('archive.json has no model of type "climate"');
  if (!paleogeographyModelId) throw new Error('archive.json has no model of type "paleogeography"');

  instance = new ClimateInstance(camera, deps);

  state = {
    layer: 'climate', variable: 'T', age: 0, month: 0, clipMin: 0, clipMax: 1,
    overlayOpacity: DEFAULT_OVERLAY_OPACITY, showWind: DEFAULT_WIND_VISIBLE,
  };
  ui = new ClimateUI(state, {
    onLayer: async (layer) => {
      await instance.setLayer(layer);
      state.variable = instance.variable.id;
      ui.setLayerVariables(instance.manifest.variables);
      ui.setVariable(instance.variable, colormaps[instance.variable.default_colormap]);
      ui.refreshDisplay();
    },
    onVariable: async (id) => {
      await instance.setVariable(id);
      ui.setVariable(instance.variable, colormaps[instance.variable.default_colormap]);
    },
    onAge: (age) => instance.applyAge(age),
    onMonth: (month) => instance.applyMonth(month),
    onClip: (lo, hi) => instance.applyClip(lo, hi),
    onOverlayOpacity: (v) => instance.setOverlayOpacity(v),
    onShowWind: (v) => instance.setWindVisible(v),
  });

  ui.setStatus('loading...');
  await instance.boot(climateModelId, paleogeographyModelId);

  // Both layers share one age slider; its range only needs setting once,
  // from whichever layer is active at boot (climate, 0-540 Ma) -- switching
  // layers later does not change the slider's bounds, since paleogeography
  // spans the same range.
  const ages = instance.manifest.frames.map((f) => f.age_ma);
  ui.setAgeRange(Math.min(...ages), Math.max(...ages));
  state.variable = instance.variable.id;
  ui.setLayerVariables(instance.manifest.variables);
  ui.setVariable(instance.variable, colormaps[instance.variable.default_colormap]);
  instance.applyMonth(state.month);
  ui.setTimeInfo(`age ${state.age.toFixed(0)} Ma`);
  ui.setStatus('');

  if (window.__climate) window.__climate.ready = true;
}

// --- test hook ---------------------------------------------------------
// Mirrors window.__geode's shape (see main.ts) for the parts that carry over.

declare global {
  interface Window { __climate?: Record<string, unknown> }
}

window.__climate = {
  ready: false,
  setAge: async (age: number) => {
    state.age = age;
    instance.applyAge(age);
    ui.setTimeInfo(`age ${age.toFixed(0)} Ma`);
    ui.refreshDisplay();
  },
  setLayer: async (layer: ClimateLayer) => {
    state.layer = layer;
    await instance.setLayer(layer);
    state.variable = instance.variable.id;
    ui.setLayerVariables(instance.manifest.variables);
    ui.setVariable(instance.variable, colormaps[instance.variable.default_colormap]);
    ui.refreshDisplay();
  },
  setVariable: async (id: string) => {
    state.variable = id;
    await instance.setVariable(id);
    ui.setVariable(instance.variable, colormaps[instance.variable.default_colormap]);
    ui.refreshDisplay();
  },
  setMonth: (month: number) => {
    state.month = month;
    instance.applyMonth(month);
    ui.refreshDisplay();
  },
  setOverlayOpacity: (v: number) => {
    state.overlayOpacity = v;
    instance.setOverlayOpacity(v);
    ui.refreshDisplay();
  },
  setShowWind: (v: boolean) => {
    state.showWind = v;
    instance.setWindVisible(v);
    ui.refreshDisplay();
  },
  setCamera: (o: { lon: number; lat: number; dist: number }) => {
    const [x, y, z] = lonLatToVec3(o.lon, o.lat, o.dist);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    controls.update();
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
  stats: () => ({
    model: instance.manifest?.id,
    layer: instance.layer,
    variable: instance.variable?.id,
    age: state.age,
    month: state.month,
    clip: [state.clipMin, state.clipMax],
    overlayOpacity: state.overlayOpacity,
    showWind: state.showWind,
  }),
};

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  instance?.render(renderer);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre id="error">${String(e)}</pre>`,
  );
});
animate();
