import { Color, OrthographicCamera, Scene, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Camera } from 'three';

import { R_SURFACE } from '../core/constants';
import { loadArchive } from '../core/volume';
import { loadReconstructionManifest, reconstructionAssetUrl } from '../core/reconstructions';
import {
  createProjectionCamera, createProjectionControls, isFlat,
  updateProjectionCameraAspect, type ProjectionMode,
} from '../core/projection';
import { wireProjectionToggle } from '../core/projectionToggle';
import { OldMapOverlay } from './oldMapOverlay';
import { OldMapUI, type OldMapToggle, type OldMapViewState } from './oldMapUi';
import { BoundaryOverlay } from '../core/boundaries';
import { MountainSeries } from './mountains';
import { VolcanoSeries } from './volcanoes';
import { makePaper } from './paper';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;
const RECONSTRUCTION_ID = 'merdith2021';

document.title = 'Geode — Old Map';

/**
 * The Old Map viewer: a plate reconstruction drawn as an aged engraved chart.
 * See docs/plans/old-map-viewer.md, and docs/adr/0037 for the one rule that
 * decides the rest of the design.
 *
 * ---- Why the globe camera is ORTHOGRAPHIC here ---------------------------
 *
 * Every other Globe wrapper uses core's perspective camera. This one does not,
 * for two reasons that happen to agree.
 *
 * The aesthetic one: an atlas plate is an orthographic disc of ink on a full
 * page. Perspective foreshortening reads as a rendered 3-D ball, which is the
 * look this viewer is trying not to have.
 *
 * The load-bearing one: deep-time-map's `PolygonLayer` fills a continent that
 * straddles the limb by clamping its hidden vertices onto the limb, and its
 * `clampToLimb` puts them on the GREAT CIRCLE perpendicular to the view axis.
 * That is the horizon only under an orthographic camera; under perspective the
 * horizon is a smaller circle at dot = R/d, so clamped vertices would still be
 * behind it and get dropped, and the coastline would close across the globe.
 * `ThreeProjector.axis` therefore returns undefined for a perspective camera on
 * purpose (see its own comment), and this wrapper supplies an orthographic one
 * so the clamping is exact. The coastline path here is not merely drawn -- it is
 * also the CLIP for the wash and the rings, so a malformed ring would put the
 * ink in the wrong place, not just draw a wrong outline.
 */

const state: OldMapViewState = {
  age: 0, showWash: true, showRings: true, showMountains: true,
  showVolcanoes: true, showTrenches: false,
};

// Robinson by default: it is the projection the reference notebook renders in
// (pygmt `N25c`), so the page opens on the look it is reproducing. The Globe and
// Plate Carree are a click away on the cycle button.
let mode: ProjectionMode = 'robinson';

/** Orthographic for Globe (see above); core's own camera for the flat
 *  Projections, which are already orthographic and already framed correctly. */
function makeCamera(m: ProjectionMode, aspect: number): Camera {
  if (m !== 'globe') return createProjectionCamera(m, aspect);
  // A little over a diameter, so the disc sits on the page with a margin.
  const h = R_SURFACE * 2.35;
  const camera = new OrthographicCamera(
    -(h * aspect) / 2, (h * aspect) / 2, h / 2, -h / 2, 0.01, 50);
  camera.position.set(2.6, 1.4, 2.2);
  camera.lookAt(0, 0, 0);
  camera.userData.projectionMode = 'globe';
  return camera;
}

function makeControls(m: ProjectionMode, camera: Camera): OrbitControls {
  if (m !== 'globe') return createProjectionControls(m, camera, renderer.domElement);
  // core's globe branch sets min/maxDistance, which drive a PERSPECTIVE dolly
  // and do nothing to an orthographic camera -- OrbitControls zooms that by
  // .zoom instead. So this configures zoom bounds rather than distance ones.
  const c = new OrbitControls(camera, renderer.domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.08;
  c.enableRotate = true;
  c.enablePan = false;
  c.minZoom = 0.5;
  c.maxZoom = 12;
  return c;
}

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Fully transparent: the paper canvas below is the background, and the WebGL
// layer exists only to own the camera. Nothing geographic is drawn in it.
renderer.setClearColor(new Color(0x000000), 0);
document.body.appendChild(renderer.domElement);

let camera = makeCamera(mode, innerWidth / innerHeight);
let controls = makeControls(mode, camera);

const overlay = new OldMapOverlay(camera);
overlay.setCamera(camera, mode);

/**
 * Debug only: the resolved subduction zones the mountain rule was evaluated
 * against in prep. Off by default.
 *
 * Its own BoundaryOverlay rather than anything this wrapper draws, because that
 * class already knows how to resolve a frame, project it in every Projection and
 * break it at the seam -- and because the point of a debug layer is to be the
 * SAME boundaries every other viewer shows, not a second rendering of them that
 * could differ.
 *
 * Every non-subduction type is stroked in `transparent`, which the library
 * honours as a colour rather than a flag. Ridges and transforms would otherwise
 * crowd a chart whose whole subject is the trenches.
 */
const boundaries = new BoundaryOverlay(camera as never);
boundaries.visible = false;
let trenchesLoaded = false;

const ui = new OldMapUI(state, {
  onAge: (age) => applyAge(age),
  onToggle: (key, on) => applyToggle(key, on),
}, 'Old Map');

function applyToggle(key: OldMapToggle, on: boolean): void {
  if (key === 'showWash') overlay.showWash = on;
  else if (key === 'showRings') overlay.showRings = on;
  else if (key === 'showMountains') overlay.showMountains = on;
  else if (key === 'showVolcanoes') overlay.showVolcanoes = on;
  else {
    boundaries.visible = on;
    // Loaded on first use rather than at boot: this is a debug layer and its
    // frames are 29 MB of GeoJSON that a normal session never asks for.
    if (on && !trenchesLoaded) void loadTrenches();
  }
}

// --- paper ---------------------------------------------------------------
// Its own canvas under everything, rebuilt only on resize -- see paper.ts on
// why it is page space rather than map space.
const paperCanvas = document.createElement('canvas');
Object.assign(paperCanvas.style, {
  position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
  zIndex: '-1', pointerEvents: 'none',
});
document.body.appendChild(paperCanvas);
const paperCtx = paperCanvas.getContext('2d')!;

function rebuildPaper(): void {
  const dpr = Math.min(devicePixelRatio, 2);
  paperCanvas.width = Math.round(innerWidth * dpr);
  paperCanvas.height = Math.round(innerHeight * dpr);
  const sheet = makePaper(paperCanvas.width, paperCanvas.height);
  paperCtx.setTransform(1, 0, 0, 1, 0, 0);
  paperCtx.drawImage(sheet, 0, 0);
}
rebuildPaper();

// --- projection ----------------------------------------------------------

function applyProjection(next: ProjectionMode): void {
  mode = next;
  controls.dispose();
  camera = makeCamera(mode, innerWidth / innerHeight);
  controls = makeControls(mode, camera);
  overlay.setCamera(camera, mode);
  boundaries.setCamera(camera, mode);
  refreshToggle();
}

const refreshToggle = wireProjectionToggle(
  document.getElementById('projection-toggle'),
  () => mode,
  (next) => applyProjection(next),
);

function applyAge(age: number): void {
  state.age = age;
  overlay.setAge(age);
  if (trenchesLoaded) void boundaries.setAge(age);
  const n = mountains?.countAt(age) ?? 0;
  ui.setTimeInfo(`${age.toFixed(0)} Ma — ${n} range${n === 1 ? '' : 's'}`);
}

async function loadTrenches(): Promise<void> {
  if (trenchesLoaded || !boundariesUrl) return;
  trenchesLoaded = true;
  ui.setStatus('loading subduction zones…');
  const hide = { stroke: 'transparent', width: 0, label: '' };
  await boundaries.load(boundariesUrl, {
    subduction: { stroke: '#8c2f16', width: 2.0, label: 'Subduction zone' },
    ridge: hide,
    transform: hide,
    other: hide,
  });
  boundaries.setCamera(camera, mode);
  await boundaries.setAge(state.age);
  ui.setStatus('');
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  overlay.setRect({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  boundaries.setRect({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  rebuildPaper();
});

let mountains: MountainSeries | null = null;
let volcanoes: VolcanoSeries | null = null;
let boundariesUrl: string | null = null;

async function boot(): Promise<void> {
  ui.setStatus('loading…');
  const archive = await loadArchive(ARCHIVE);
  const entry = (archive.reconstruction_models ?? []).find((r) => r.id === RECONSTRUCTION_ID);
  if (!entry) {
    throw new Error(`archive.json has no reconstruction_models entry '${RECONSTRUCTION_ID}' -- `
      + 'run prep/prep_reconstruction.py --model Merdith2021, then prep/build_archive_index.py');
  }
  const manifest = await loadReconstructionManifest(ARCHIVE, entry.path);
  if (!manifest.oldmap) {
    throw new Error(`${RECONSTRUCTION_ID} has no "oldmap" export -- run prep/prep_oldmap.py`);
  }

  await overlay.loadCoastlines(
    reconstructionAssetUrl(ARCHIVE, manifest, manifest.oldmap.continents!));
  mountains = await MountainSeries.load(
    reconstructionAssetUrl(ARCHIVE, manifest, manifest.oldmap.mountains));
  overlay.setMountains(mountains);
  // Optional: an older export predates the volcano pass, and the map is still
  // a map without it.
  if (manifest.oldmap.volcanoes) {
    volcanoes = await VolcanoSeries.load(
      reconstructionAssetUrl(ARCHIVE, manifest, manifest.oldmap.volcanoes));
    overlay.setVolcanoes(volcanoes);
  }

  boundariesUrl = manifest.has_boundaries && manifest.boundaries
    ? reconstructionAssetUrl(ARCHIVE, manifest, manifest.boundaries) : null;

  ui.setAgeRange(manifest.oldmap.age_min, manifest.oldmap.age_max, 1);
  ui.setCredit(`${manifest.name} — ${manifest.citation}`);
  applyAge(0);
  ui.refreshDisplay();
  ui.setStatus('');
  if (window.__oldmap) window.__oldmap.ready = true;
}

// --- test hook -----------------------------------------------------------
declare global {
  interface Window { __oldmap?: Record<string, unknown> }
}

window.__oldmap = {
  ready: false,
  setAge: (age: number) => { applyAge(age); ui.refreshDisplay(); },
  setProjection: (m: ProjectionMode) => applyProjection(m),
  getProjection: () => mode,
  setLayer: (key: OldMapToggle, on: boolean) => {
    state[key] = on;
    applyToggle(key, on);
    ui.refreshDisplay();
  },
  mountainAudit: () => overlay.auditMountains(),
  scale: () => overlay.scalePixelsPerKm,
  sliverAudit: () => overlay.auditSlivers(),
  // Drives the camera the way the scroll wheel does, so the zoom assertion
  // exercises the real path rather than poking the scale directly.
  setZoom: (z: number) => {
    const c = camera as unknown as { zoom: number; updateProjectionMatrix(): void };
    c.zoom = z;
    c.updateProjectionMatrix();
  },
  stats: () => ({
    age: state.age,
    projection: mode,
    isFlat: isFlat(mode),
    mountains: mountains?.countAt(state.age) ?? 0,
    volcanoes: volcanoes?.countsAt(state.age) ?? null,
    trenches: boundaries.visible,
    decayMyr: mountains?.decayMyr ?? null,
    model: mountains?.model ?? null,
  }),
};

// The WebGL layer draws nothing; it exists so the camera and OrbitControls are
// the same machinery every other wrapper uses. Rendering an empty scene each
// frame keeps that canvas transparent rather than holding a stale one.
const emptyScene = new Scene();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(emptyScene, camera);
  overlay.draw();
  boundaries.draw();
}

boot().catch((e) => {
  console.error(e);
  ui.setStatus('');
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
