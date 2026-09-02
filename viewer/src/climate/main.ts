import { Clock, Color, PerspectiveCamera, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { R_SURFACE, lonLatToVec3 } from '../core/constants';
import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import { tileGrid, type Rect } from '../core/layout';
import {
  ClimateInstance, type ClimateInstanceDeps, type ClimateLayer, type WindStyle,
} from './climateInstance';

// See main.ts for why this indirection exists: VITE_ARCHIVE_BASE is the seam
// for pointing at a CDN instead of the archive shipped beside the app.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

// --- shared renderer / camera / controls ------------------------------------
//
// One canvas, one camera, one OrbitControls for every globe on screen -- see
// tomography/main.ts, which this now mirrors: that single shared camera is
// the whole trick that keeps rotation/zoom locked together across an
// arbitrary number of tiles for free, rather than something to synchronise
// by hand. Each globe gets its own Scene and is rendered into its own region
// of this canvas every frame (see animate()). No log depth buffer, unlike
// tomography: there's no core to z-fight against here -- the field IS the
// surface.

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

// --- globe instances ---------------------------------------------------

const instances: ClimateInstance[] = [];
let layoutRects: Rect[] = [];
let deps: ClimateInstanceDeps;
let climateModelId = '';
let paleogeographyModelId = '';

/** Whichever globe was most recently clicked -- used only as the
 *  sync-broadcast fallback source when a sync toggle turns on with no prior
 *  edit yet (see setSyncAge/setSyncMonth). Climate has no per-instance tool
 *  state, so unlike tomography's focusedInstance this drives nothing else:
 *  no OrbitControls enable/disable, no keyboard-shortcut target. */
let focusedInstance: ClimateInstance;

// --- cross-globe sync ---------------------------------------------------
//
// Rotation/zoom are locked across every globe for free (one shared camera).
// Age and month are not -- each instance owns its own view state -- so
// linking them is an explicit broadcast, mirroring tomography/main.ts's
// broadcastAge/broadcastDepthSlice exactly. Layer, variable, clip range and
// wind style are deliberately NOT synced (no toggle exists for them): the
// point of multiple globes is as much "compare two different things at the
// same time" (Temperature vs. Precipitation) as "compare the same thing at
// two different times," and only the latter needs linking.

let syncAge = false;
let syncMonth = false;

/**
 * Whichever instance most recently had its age / month edited -- separate
 * from focusedInstance on purpose. focusedInstance is set by clicking a
 * globe's canvas tile; a user configuring a globe's age or month typically
 * does that entirely through that globe's OWN panel, without ever clicking
 * its canvas tile, so focusedInstance can easily still be some OTHER globe.
 * Snapping from the wrong one when a sync toggle switches on would silently
 * clobber whatever was just configured. Falls back to focusedInstance until
 * an edit has actually happened. See tomography/main.ts's
 * lastAgeEdit/lastDepthSliceEdit for the identical reasoning.
 */
let lastAgeEdit: ClimateInstance | null = null;
let lastMonthEdit: ClimateInstance | null = null;

/** Push `source`'s current age into every OTHER instance's own state. The
 *  one place this logic lives -- called from the UI callback (a real slider
 *  drag), from the test hook, from turning a sync flag on, and from a globe
 *  being added while a sync is active. */
function broadcastAge(source: ClimateInstance): void {
  lastAgeEdit = source;
  if (!syncAge) return;
  const age = source.view.age;
  for (const inst of instances) {
    if (inst === source) continue;
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  }
}

function broadcastMonth(source: ClimateInstance): void {
  lastMonthEdit = source;
  if (!syncMonth) return;
  const month = source.view.month;
  for (const inst of instances) {
    if (inst === source) continue;
    inst.applyMonth(month);
    inst.ui.refreshDisplay();
  }
}

function relayout(): void {
  layoutRects = tileGrid(instances.length, innerWidth, innerHeight);
  instances.forEach((inst, i) => inst.applyLayout(layoutRects[i]));
}

function createInstance(label: string): ClimateInstance {
  return new ClimateInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onMonthChange: (self) => broadcastMonth(self),
  }, label);
}

/** Used by both the toolbar checkbox and the test hook, so "snap every other
 *  globe to the focused one's value" lives in exactly one place. */
function setSyncAge(on: boolean): void {
  syncAge = on;
  const cb = document.getElementById('sync-age') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastAge(lastAgeEdit ?? focusedInstance);
}

function setSyncMonth(on: boolean): void {
  syncMonth = on;
  const cb = document.getElementById('sync-month') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastMonth(lastMonthEdit ?? focusedInstance);
}

document.getElementById('sync-age')?.addEventListener('change', (e) => {
  setSyncAge((e.target as HTMLInputElement).checked);
});
document.getElementById('sync-month')?.addEventListener('change', (e) => {
  setSyncMonth((e.target as HTMLInputElement).checked);
});

async function addInstance(): Promise<void> {
  const inst = createInstance(`Globe ${instances.length + 1}`);
  instances.push(inst);
  relayout();
  await inst.boot(climateModelId, paleogeographyModelId);
  // A globe added while a sync is active joins the synced group immediately,
  // rather than booting at age 0 / month 0 and waiting for the next drag
  // elsewhere to catch it up.
  broadcastAge(lastAgeEdit ?? focusedInstance);
  broadcastMonth(lastMonthEdit ?? focusedInstance);
}

function removeInstance(inst: ClimateInstance): void {
  if (instances.length <= 1) return; // always leave one globe on screen
  const idx = instances.indexOf(inst);
  if (idx < 0) return;
  instances.splice(idx, 1);
  inst.dispose();
  if (focusedInstance === inst) focusedInstance = instances[0];
  if (lastAgeEdit === inst) lastAgeEdit = null;
  if (lastMonthEdit === inst) lastMonthEdit = null;
  relayout();
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  relayout();
});

document.getElementById('add-globe')?.addEventListener('click', () => {
  void addInstance();
});

// --- interaction ---------------------------------------------------------
//
// The camera and canvas are shared, but unlike tomography there is no
// per-instance TOOL state competing with OrbitControls for the same drag
// gesture (no cutaway drawing here) and no raycasting -- OrbitControls
// already owns 100% of pointer interaction with nothing to fight it. A
// click only needs to know which tile it landed in, purely to update
// `focusedInstance` for the sync fallback above.

function hitTest(clientX: number, clientY: number): ClimateInstance | null {
  for (let i = 0; i < instances.length; i++) {
    const r = layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return instances[i];
    }
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) focusedInstance = hit;
});

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

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

  deps = {
    archiveBase: ARCHIVE, archive, colormaps, coastlineData,
  };

  const climateModel = archive.models.find((m) => m.type === 'climate')?.id;
  const paleogeographyModel = archive.models.find((m) => m.type === 'paleogeography')?.id;
  if (!climateModel) throw new Error('archive.json has no model of type "climate"');
  if (!paleogeographyModel) throw new Error('archive.json has no model of type "paleogeography"');
  climateModelId = climateModel;
  paleogeographyModelId = paleogeographyModel;

  const first = createInstance('Globe 1');
  instances.push(first);
  focusedInstance = first;
  relayout();
  await first.boot(climateModelId, paleogeographyModelId);

  if (window.__climate) window.__climate.ready = true;
}

// --- test hook --------------------------------------------------------------
// Drives the viewer from ad-hoc verification scripts. No automated suite
// currently targets climate.html (scripts/shoot.mjs only covers index.html),
// so this shape is free to evolve -- kept close to window.__geode's
// multi-globe additions for consistency rather than out of any hard
// requirement.
//
// The flat methods (setAge, setMonth, setLayer, ...) all target the FIRST
// instance, same "primary()" convention as window.__geode, for backward
// compatibility with single-globe verification scripts written before this
// change. The ...On(index, ...) methods target a specific instance.

declare global {
  interface Window { __climate?: Record<string, unknown> }
}

function primary(): ClimateInstance { return instances[0]; }

window.__climate = {
  ready: false,
  setAge: async (age: number) => {
    const inst = primary();
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setLayer: async (layer: ClimateLayer) => {
    const inst = primary();
    await inst.setLayer(layer);
    inst.ui.refreshDisplay();
  },
  setVariable: async (id: string) => {
    const inst = primary();
    await inst.setVariable(id);
    inst.ui.refreshDisplay();
  },
  setMonth: (month: number) => {
    const inst = primary();
    inst.applyMonth(month);
    inst.ui.refreshDisplay();
    broadcastMonth(inst);
  },
  setOverlayOpacity: (v: number) => {
    const inst = primary();
    inst.setOverlayOpacity(v);
    inst.ui.refreshDisplay();
  },
  setShowWind: (v: boolean) => {
    const inst = primary();
    inst.setWindVisible(v);
    inst.ui.refreshDisplay();
  },
  setWindStyle: (v: WindStyle) => {
    const inst = primary();
    inst.setWindStyle(v);
    inst.ui.refreshDisplay();
  },
  setWindScale: (v: number) => {
    const inst = primary();
    inst.setWindScale(v);
    inst.ui.refreshDisplay();
  },
  setWindDensity: (v: number) => {
    const inst = primary();
    inst.setWindDensity(v);
    inst.ui.refreshDisplay();
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
    renderer.render(primary().scene, camera);
    const x = Math.round(((o.nx ?? 0) * 0.5 + 0.5) * (w - 1));
    const y = Math.round(((o.ny ?? 0) * 0.5 + 0.5) * (h - 1));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { x, y, rgb: [px[0], px[1], px[2]] };
  },
  addGlobe: () => addInstance(),
  removeGlobe: (index = instances.length - 1) => {
    const inst = instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => instances.length,
  setSyncAge,
  setSyncMonth,
  getSyncState: () => ({ syncAge, syncMonth }),
  /** Apply age/month to a SPECIFIC instance, not just primary() -- needed to
   *  test whether an edit on globe 2 does/doesn't propagate to globe 1.
   *  Broadcasts exactly like a real slider drag would, via the same
   *  broadcastAge()/broadcastMonth() the UI callback uses. */
  setAgeOn: (index: number, age: number) => {
    const inst = instances[index];
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setMonthOn: (index: number, month: number) => {
    const inst = instances[index];
    inst.applyMonth(month);
    inst.ui.refreshDisplay();
    broadcastMonth(inst);
  },
  instanceState: (index: number) => {
    const inst = instances[index];
    return { age: inst.view.age, month: inst.view.month, layer: inst.view.layer };
  },
  stats: () => {
    const inst = primary();
    return {
      model: inst.manifest?.id,
      layer: inst.layer,
      variable: inst.variable?.id,
      age: inst.view.age,
      month: inst.view.month,
      clip: [inst.view.clipMin, inst.view.clipMax],
      overlayOpacity: inst.view.overlayOpacity,
      showWind: inst.view.showWind,
      windStyle: inst.view.windStyle,
      windScale: inst.view.windScale,
      windDensity: inst.view.windDensity,
      globeCount: instances.length,
    };
  },
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  renderer.setScissorTest(instances.length > 1);
  const dt = clock.getDelta();
  for (let i = 0; i < instances.length; i++) {
    const rect = layoutRects[i];
    if (!rect) continue;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    // three.js scales viewport/scissor by devicePixelRatio itself, the same
    // way it treats setSize -- these are CSS pixels, like the rect.
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    instances[i].tick(dt);
    instances[i].render(renderer);
  }
  renderer.setScissorTest(false);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre id="error">${String(e)}</pre>`,
  );
});
animate();
