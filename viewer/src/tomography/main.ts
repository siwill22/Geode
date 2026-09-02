import {
  Color, PerspectiveCamera, Vector2, Vector3, WebGLRenderer,
  type Data3DTexture,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { R_CMB, R_SURFACE, lonLatToVec3, radiusToDepth } from '../core/constants';
import { PALETTE } from '../core/palette';
import { loadTopography } from './globe';
import { fetchCoastlineData } from '../core/coastlines';
import {
  loadArchive, loadColormaps, nearestFrame,
} from '../core/volume';
import { GlobeInstance, type GlobeInstanceDeps } from './instance';
import { tileGrid, type Rect } from '../core/layout';
import type { IsosurfaceState } from './isosurface';
import { sinkingDepthKm, type DepthSliceState } from '../core/depthSlice';
import type { SurfaceMode } from './ui';

// Where the data lives. Defaults to the archive shipped beside the app, under
// whatever base path the build was given ('/' in dev, '/Geode/' on Pages).
// VITE_ARCHIVE_BASE overrides it with an absolute URL, which is the seam for
// moving the volumes to object storage later without touching the app -- the
// only extra requirement then is CORS headers on the data host.
const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? `${import.meta.env.BASE_URL}archive`;

// --- shared renderer, camera, controls --------------------------------------
//
// One canvas, one camera, one OrbitControls for every globe on screen: that is
// the whole trick that makes rotation and zoom stay locked together across an
// arbitrary number of tiles, for free, rather than something to synchronise by
// hand. Each globe gets its own Scene and is rendered into its own region of
// this canvas every frame (see animate()).

const camera = new PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 50);
camera.position.set(2.6, 1.4, 2.2);

// Logarithmic depth: the cutaway floor sits at the base of the volume (2840 km)
// while the core sits at the CMB (2890 km), only 0.008 world units apart, and a
// conventional depth buffer with a near plane small enough to let the camera
// approach the globe cannot separate them -- they z-fight into concentric bands.
const renderer = new WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Clamp zoom so the camera cannot enter the core.
controls.minDistance = R_CMB + 0.15;
controls.maxDistance = 12;
// A globe should stay centred; panning it off-axis is never wanted here.
controls.enablePan = false;

// --- globe instances ---------------------------------------------------

const instances: GlobeInstance[] = [];
let layoutRects: Rect[] = [];
let deps: GlobeInstanceDeps;
let defaultModelId = '';

/** The globe that OrbitControls' enabled state and Enter/Escape/dblclick act
 *  on: whichever globe was last clicked, or whose panel last changed tool. */
let focusedInstance: GlobeInstance;

// --- cross-globe sync ---------------------------------------------------
//
// Rotation/zoom are locked across every globe for free (one shared camera).
// Age and depth-slice are not -- each instance owns its own ViewState -- so
// linking them is an explicit broadcast: a user edit on one instance pushes
// the new value into every OTHER instance's own state and re-runs that
// instance's own applyAge()/applyDepthSlice(), reusing its existing
// per-model guards (nearestFrame clamping, the tomography-only sinking-mode
// check, the shader's own out-of-range no-data colour) unchanged. Kept as
// two independent flags, matching the existing precedent that cutaway,
// isosurface and depth-slice are manually independent rather than
// auto-coupled -- comparing two different ages on purpose still has to work.

let syncAge = false;
let syncDepthSlice = false;

/**
 * Whichever instance most recently had its age / depth-slice edited --
 * separate from focusedInstance on purpose. focusedInstance is set by
 * clicking a globe's canvas tile or switching its cutaway tool; a user
 * configuring a globe's age or depth slice typically does that entirely
 * through that globe's OWN panel, without ever clicking its canvas tile, so
 * focusedInstance can easily still be some OTHER globe. Snapping from the
 * wrong one when a sync toggle switches on would silently clobber whatever
 * was just configured -- which is exactly the bug this was chasing. Falls
 * back to focusedInstance until an edit has actually happened.
 */
let lastAgeEdit: GlobeInstance | null = null;
let lastDepthSliceEdit: GlobeInstance | null = null;

/**
 * Push `source`'s current age into every OTHER instance's own state. This is
 * the one place that logic lives -- called from the UI callback (a real
 * slider drag), from the test hook that edits one instance directly, from
 * turning a sync flag on, and from a globe being added while a sync is
 * active. All of those are "this instance's age changed," which is exactly
 * what this function is for -- it also records `source` as the sync
 * reference regardless of whether syncAge happens to be on at the moment.
 */
function broadcastAge(source: GlobeInstance): void {
  lastAgeEdit = source;
  if (!syncAge) return;
  const age = source.view.reconstructionAge;
  for (const inst of instances) {
    if (inst === source) continue;
    inst.applyAge(age);
    refreshGUI(inst);
  }
}

function broadcastDepthSlice(source: GlobeInstance): void {
  lastDepthSliceEdit = source;
  if (!syncDepthSlice) return;
  const state = { ...source.view.depthSlice };
  for (const inst of instances) {
    if (inst === source) continue;
    Object.assign(inst.view.depthSlice, state);
    inst.applyDepthSlice();
    refreshGUI(inst);
  }
}

function relayout(): void {
  layoutRects = tileGrid(instances.length, innerWidth, innerHeight);
  instances.forEach((inst, i) => inst.applyLayout(layoutRects[i]));
}

function createInstance(label: string): GlobeInstance {
  let inst!: GlobeInstance;
  inst = new GlobeInstance(camera, deps, {
    onFocus: (self) => {
      focusedInstance = self;
      controls.enabled = !self.toolActive(modifierHeld);
    },
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onDepthSliceChange: (self) => broadcastDepthSlice(self),
  }, label);
  return inst;
}

/** Used by both the toolbar checkbox and the test hook, so "snap every other
 *  globe to the focused one's value" lives in exactly one place. */
function setSyncAge(on: boolean): void {
  syncAge = on;
  const cb = document.getElementById('sync-age') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastAge(lastAgeEdit ?? focusedInstance);
}

function setSyncDepthSlice(on: boolean): void {
  syncDepthSlice = on;
  const cb = document.getElementById('sync-depth') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastDepthSlice(lastDepthSliceEdit ?? focusedInstance);
}

document.getElementById('sync-age')?.addEventListener('change', (e) => {
  setSyncAge((e.target as HTMLInputElement).checked);
});
document.getElementById('sync-depth')?.addEventListener('change', (e) => {
  setSyncDepthSlice((e.target as HTMLInputElement).checked);
});

async function addInstance(): Promise<void> {
  const inst = createInstance(`Globe ${instances.length + 1}`);
  instances.push(inst);
  relayout();
  await inst.boot(defaultModelId);
  // A globe added while a sync is active joins the synced group immediately,
  // rather than booting at age 0 / the default depth-slice and waiting for
  // the next drag elsewhere to catch it up.
  broadcastAge(lastAgeEdit ?? focusedInstance);
  broadcastDepthSlice(lastDepthSliceEdit ?? focusedInstance);
}

function removeInstance(inst: GlobeInstance): void {
  if (instances.length <= 1) return; // always leave one globe on screen
  const idx = instances.indexOf(inst);
  if (idx < 0) return;
  instances.splice(idx, 1);
  inst.dispose();
  if (focusedInstance === inst) focusedInstance = instances[0];
  if (lastAgeEdit === inst) lastAgeEdit = null;
  if (lastDepthSliceEdit === inst) lastDepthSliceEdit = null;
  relayout();
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  relayout();
});

document.getElementById('add-globe')?.addEventListener('click', () => {
  void addInstance();
});

document.getElementById('hint-toggle')?.addEventListener('click', () => {
  const hint = document.getElementById('hint');
  if (hint) hint.hidden = !hint.hidden;
});

// --- interaction -------------------------------------------------------
//
// The camera and canvas are shared, so pointer events are routed by which
// tile they landed in rather than assumed to belong to a single globe.

const ptr = new Vector2();
let modifierHeld = false;

function hitTest(clientX: number, clientY: number): { inst: GlobeInstance; rect: Rect } | null {
  for (let i = 0; i < instances.length; i++) {
    const r = layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: instances[i], rect: r };
    }
  }
  return null;
}

/** NDC for a point, relative to one tile rather than the whole window. */
function ndcFor(rect: Rect, clientX: number, clientY: number): Vector2 {
  ptr.x = ((clientX - rect.x) / rect.width) * 2 - 1;
  ptr.y = -((clientY - rect.y) / rect.height) * 2 + 1;
  return ptr;
}

/** The shared camera's aspect has to match a tile before that tile's picking
 *  or projection maths runs against it -- the render loop otherwise leaves it
 *  set to whichever tile was rendered last. */
function focusCameraOn(rect: Rect): void {
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}

/** GPlates-style: an explicit tool mode, with a modifier key to rotate the
 *  globe without leaving the current tool. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
function isModifier(e: KeyboardEvent): boolean {
  return IS_MAC ? e.key === 'Meta' : e.key === 'Control';
}

addEventListener('keydown', (e) => {
  if (isModifier(e)) { modifierHeld = true; controls.enabled = true; }
  if (e.key === 'Enter') focusedInstance.onKeyEnter();
  if (e.key === 'Escape') focusedInstance.onKeyEscape();
});
addEventListener('keyup', (e) => {
  if (isModifier(e)) {
    modifierHeld = false;
    controls.enabled = !focusedInstance.toolActive(modifierHeld);
  }
});
// Holding a modifier and switching apps can swallow the keyup.
addEventListener('blur', () => {
  modifierHeld = false;
  controls.enabled = !focusedInstance.toolActive(modifierHeld);
});

/**
 * Make modifier-drag ROTATE the globe rather than pan it, and pick which
 * instance the click landed in before OrbitControls (already listening on the
 * same canvas) reads `controls.enabled`.
 *
 * OrbitControls maps "left drag + ctrl/meta/shift" to PAN, and panning a globe
 * slides it sideways off-centre instead of spinning it on its axis -- which is
 * not what the modifier is for here. The check happens only on pointerdown, so
 * intercepting that one event is enough: swallow the original and re-issue an
 * identical event with the modifier flags cleared, which OrbitControls then
 * reads as an ordinary rotate.
 */
const SYNTHETIC = '__geodeSynthetic';
renderer.domElement.addEventListener('pointerdown', (ev: PointerEvent) => {
  if ((ev as never as Record<string, boolean>)[SYNTHETIC]) return;

  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) {
    focusedInstance = hit.inst;
    controls.enabled = !hit.inst.toolActive(modifierHeld);
  }

  if (!modifierHeld || !hit || hit.inst.view.tool === 'drag') return;
  ev.stopImmediatePropagation();
  ev.preventDefault();
  const clone = new PointerEvent('pointerdown', {
    pointerId: ev.pointerId, pointerType: ev.pointerType, isPrimary: ev.isPrimary,
    clientX: ev.clientX, clientY: ev.clientY, button: ev.button, buttons: ev.buttons,
    bubbles: true, cancelable: true, composed: true,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  });
  (clone as never as Record<string, boolean>)[SYNTHETIC] = true;
  renderer.domElement.dispatchEvent(clone);
}, true);

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  focusCameraOn(hit.rect);
  hit.inst.onPointerDown(ndcFor(hit.rect, ev.clientX, ev.clientY), modifierHeld, ev.clientX, ev.clientY);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  focusCameraOn(hit.rect);
  hit.inst.onPointerMove(ndcFor(hit.rect, ev.clientX, ev.clientY), modifierHeld);
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  focusCameraOn(hit.rect);
  hit.inst.onPointerUp(ndcFor(hit.rect, ev.clientX, ev.clientY), modifierHeld, ev.clientX, ev.clientY);
});

renderer.domElement.addEventListener('dblclick', (ev) => {
  hitTest(ev.clientX, ev.clientY)?.inst.onDblClick();
});

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  const archive = await loadArchive(ARCHIVE);
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  let topography = null;
  try {
    topography = await loadTopography(`${ARCHIVE}/surface/topography.jpg`);
  } catch {
    topography = null; // fall back to flat colour rather than failing to boot
  }

  let coastlineData = null;
  try {
    coastlineData = await fetchCoastlineData(
      ARCHIVE, archive.coastlines.geometry, archive.coastlines.rotations,
    );
  } catch {
    coastlineData = null;
  }

  deps = {
    archiveBase: ARCHIVE,
    archive,
    colormaps,
    topography,
    coastlineData,
    boundariesUrl: archive.boundaries ? `${ARCHIVE}/${archive.boundaries}` : null,
  };
  defaultModelId = archive.models.find((m) => m.id === 'reveal')?.id ?? archive.models[0].id;

  const first = createInstance('Globe 1');
  instances.push(first);
  focusedInstance = first;
  relayout();
  await first.boot(defaultModelId);

  if (window.__geode) window.__geode.ready = true;
}

// --- test hook --------------------------------------------------------------
// Drives the viewer from scripts/shoot.mjs so the render-dependent acceptance
// criteria can actually be checked rather than assumed.
//
// All of it targets the FIRST globe. That is deliberate, not a stopgap: with
// exactly one instance on screen -- the state this whole harness boots into
// and the state every existing shot was designed for -- that instance's tile
// is the entire canvas, so every probe here (which reads pixels straight off
// `renderer.domElement`) behaves exactly as it did before multi-globe support
// existed. A second globe never changes what these checks see.

declare global {
  interface Window { __geode?: Record<string, unknown> }
}

function primary(): GlobeInstance { return instances[0]; }

function setCamera(o: { lon: number; lat: number; dist: number }): void {
  const [x, y, z] = lonLatToVec3(o.lon, o.lat, o.dist);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  controls.update();
}

function refreshGUI(inst: GlobeInstance = primary()): void {
  inst.ui.gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

window.__geode = {
  ready: false,
  setAge: async (a: number) => {
    const inst = primary();
    inst.applyAge(a);
    // Settle the async layers so a screenshot taken straight after this shows
    // the age that was asked for rather than whatever was up before.
    await inst.settleAge(a);
    await inst.boundaries.setAge(a);
    inst.updateTimeInfo();
    refreshGUI(inst);
    broadcastAge(inst);
  },
  setBoundaries: (on: boolean) => {
    const inst = primary();
    inst.view.showBoundaries = on;
    inst.boundaries.visible = on;
    refreshGUI(inst);
  },
  probeVolume: (lon: number, lat: number, depthKm: number) => {
    const inst = primary();
    const tex = inst.cutaway.wallMaterial.uniforms.uVolume.value as Data3DTexture;
    const data = tex.image.data as Uint8Array;
    const res = inst.manifest.resolutions.find(
      (r) => r.id === inst.manifest.default_resolution,
    )!;
    const i = ((Math.round(((lon + 180) / 360) * res.nlon) % res.nlon) + res.nlon)
      % res.nlon;
    const j = Math.max(0, Math.min(res.nlat - 1,
      Math.round(((lat + 90) / 180) * (res.nlat - 1))));
    const t = (depthKm - inst.manifest.depth_min_km)
      / (inst.manifest.depth_max_km - inst.manifest.depth_min_km);
    const k = Math.max(0, Math.min(res.ndepth - 1,
      Math.round(t * (res.ndepth - 1))));
    const code = data[k * res.nlat * res.nlon + j * res.nlon + i];
    return {
      code,
      value: inst.variable.encode_min
        + (code / 255) * (inst.variable.encode_max - inst.variable.encode_min),
      units: inst.variable.units,
    };
  },
  probeHorizon: () => {
    const inst = primary();
    inst.boundaries.projector.update(innerWidth, innerHeight);
    const d = camera.position.length();
    const c = camera.position.clone().normalize();
    const g = [c.x, -c.z, c.y];
    const t = Math.abs(g[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let p = [
      g[1] * t[2] - g[2] * t[1],
      g[2] * t[0] - g[0] * t[2],
      g[0] * t[1] - g[1] * t[0],
    ];
    const pn = Math.hypot(p[0], p[1], p[2]);
    p = p.map((x) => x / pn);

    const savedMask = inst.boundaries.projector.mask;
    inst.boundaries.projector.mask = null;

    const at = (theta: number) => {
      const cs = Math.cos(theta), sn = Math.sin(theta);
      return inst.boundaries.projector.project([
        g[0] * cs + p[0] * sn, g[1] * cs + p[1] * sn, g[2] * cs + p[2] * sn,
      ]) !== null;
    };
    const thetaH = Math.acos(Math.min(1, R_SURFACE / d));
    const out = {
      cameraDistance: d,
      horizonDeg: (thetaH * 180) / Math.PI,
      inside: at(thetaH - 0.02),
      outside: at(thetaH + 0.02),
      beyond: at(thetaH + (Math.PI / 2 - thetaH) * 0.5),
    };
    inst.boundaries.projector.mask = savedMask;
    return out;
  },
  probeBoundaries: () => {
    const inst = primary();
    return {
      age: inst.view.reconstructionAge,
      frameTime: inst.boundaries.frameTime,
      timeRange: inst.boundaries.timeRange,
      visible: inst.boundaries.visible,
      volumeFrame: inst.manifest ? nearestFrame(inst.manifest, inst.view.reconstructionAge) : null,
    };
  },
  setSurfaceMode: (m: SurfaceMode) => {
    const inst = primary();
    inst.applySurfaceMode(m);
    refreshGUI(inst);
  },
  setSurfaceOpacity: (v: number) => {
    const inst = primary();
    inst.setSurfaceOpacity(v);
    refreshGUI(inst);
  },
  setModel: async (id: string) => {
    const inst = primary();
    await inst.selectModel(id);
    refreshGUI(inst);
  },
  /** Model on a SPECIFIC instance -- needed to give globe 2 a different
   *  (e.g. convection) model when testing that the sync broadcast doesn't
   *  override a follower's own tomography/convection guard. */
  setModelOn: async (index: number, id: string) => {
    const inst = instances[index];
    await inst.selectModel(id);
    refreshGUI(inst);
  },
  setVariable: async (id: string) => {
    const inst = primary();
    await inst.selectVariable(id);
    refreshGUI(inst);
  },
  setCutDepth: (km: number) => {
    const inst = primary();
    inst.view.cutDepthKm = km;
    inst.rebuildCutaway();
    refreshGUI(inst);
  },
  setCamera,
  setDebug: (mode: number) => {
    const inst = primary();
    for (const m of [
      inst.cutaway.wallMaterial, inst.cutaway.floorMaterial, inst.depthSlice.material,
    ]) {
      m.uniforms.uDebug.value = mode;
    }
  },
  setVisible: (o: Record<string, boolean>) => {
    const inst = primary();
    if ('wall' in o) inst.cutaway.wall.visible = o.wall;
    if ('floor' in o) inst.cutaway.floor.visible = o.floor;
    if ('core' in o) inst.core.visible = o.core;
    if ('surface' in o) inst.surface.mesh.visible = o.surface;
    if ('isosurface' in o) inst.isosurface.mesh.visible = o.isosurface;
    if ('depthSlice' in o) inst.depthSlice.mesh.visible = o.depthSlice;
  },
  /** Reset to no cutaway at all -- setPolygon({verts:[]}) does NOT do this,
   *  since closePolygon() returns early below 3 vertices and never rebuilds.
   *  Mirrors the Escape-key handler exactly. */
  clearPolygon: () => {
    const inst = primary();
    inst.onKeyEscape();
    refreshGUI(inst);
  },
  setIsosurface: (o: Partial<IsosurfaceState>) => {
    const inst = primary();
    Object.assign(inst.view.iso, o);
    inst.applyIso();
    refreshGUI(inst);
    return { ...inst.view.iso, shell: inst.isosurface.shell };
  },
  setDepthSlice: (o: Partial<DepthSliceState>) => {
    const inst = primary();
    Object.assign(inst.view.depthSlice, o);
    inst.applyDepthSlice();
    refreshGUI(inst);
    broadcastDepthSlice(inst);
    // Returned so shoot.mjs can see what the tomography/convection guard
    // actually did, rather than trusting the request was honoured verbatim.
    return { ...inst.view.depthSlice };
  },
  sinkingDepthKm: (age: number, upper: number, lower: number) => sinkingDepthKm(age, upper, lower),
  probeSilhouette: (target: 'isosurface' | 'core' = 'isosurface') => {
    const inst = primary();
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;

    const keep = target === 'core' ? inst.core : inst.isosurface.mesh;
    const others = [
      inst.core, inst.surface.mesh, inst.cutaway.wall, inst.cutaway.floor,
      inst.cutaway.outline, inst.cutaway.handles, inst.depthSlice.mesh,
      inst.coastlines?.lines, inst.coastlines?.land, inst.isosurface.mesh,
    ].filter((o) => !!o && o !== keep) as import('three').Object3D[];
    const wasVisible = others.map((o) => o.visible);
    for (const o of others) o.visible = false;
    const keptVisible = keep.visible;
    keep.visible = true;

    renderer.render(inst.scene, camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    others.forEach((o, i) => { o.visible = wasVisible[i]; });
    keep.visible = keptVisible;

    const bg = [px[0], px[1], px[2]];

    const o = new Vector3(0, 0, 0).project(camera);
    const cx = (o.x * 0.5 + 0.5) * w;
    const cy = (o.y * 0.5 + 0.5) * h;

    let n = 0; let cold = 0; let hotN = 0;
    let sx = 0; let sy = 0; let rMax = 0;
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4]; const g = px[i * 4 + 1]; const b = px[i * 4 + 2];
      if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) < 12) {
        continue;
      }
      n++;
      if (b > r) cold++; else hotN++;
      const x = i % w; const y = Math.floor(i / w);
      sx += x; sy += y;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rMax) rMax = d;
    }

    const d = camera.position.length();
    const toRadius = (rPx: number) => d * Math.sin(
      Math.atan((rPx / (h / 2)) * Math.tan((camera.fov * Math.PI) / 360)),
    );

    const radiusPx = n ? rMax : 0;
    const radiusPxFromArea = n ? Math.sqrt(n / Math.PI) : 0;

    return {
      pixels: n,
      coldPixels: cold,
      hotPixels: hotN,
      radiusPx,
      radiusPxFromArea,
      radius: toRadius(radiusPx),
      radiusFromArea: toRadius(radiusPxFromArea),
      depthFromAreaKm: n ? radiusToDepth(toRadius(radiusPxFromArea)) : null,
      depthKm: n ? radiusToDepth(toRadius(radiusPx)) : null,
      centroidOffsetX: n ? sx / n - cx : null,
      centroidOffsetY: n ? sy / n - cy : null,
      cameraDistance: d,
      fovDeg: camera.fov,
      viewportHeight: h,
      shell: inst.isosurface.shell,
    };
  },
  probeIsoAboveFloor: (halfBoxPx = 20) => {
    const inst = primary();
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;

    const hide = [
      inst.core, inst.surface.mesh, inst.cutaway.outline, inst.cutaway.handles,
      inst.depthSlice.mesh, inst.coastlines?.lines, inst.coastlines?.land,
    ].filter(Boolean) as import('three').Object3D[];
    const wasVisible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const wasDebug = inst.cutaway.wallMaterial.uniforms.uDebug.value as number;
    for (const m of [inst.cutaway.wallMaterial, inst.cutaway.floorMaterial]) {
      m.uniforms.uDebug.value = 1;
    }

    const o = new Vector3(0, 0, 0).project(camera);
    const cx = Math.round((o.x * 0.5 + 0.5) * (w - 1));
    const cy = Math.round((o.y * 0.5 + 0.5) * (h - 1));
    const x0 = Math.max(0, cx - halfBoxPx);
    const y0 = Math.max(0, cy - halfBoxPx);
    const bw = Math.min(w, cx + halfBoxPx + 1) - x0;
    const bh = Math.min(h, cy + halfBoxPx + 1) - y0;

    renderer.render(inst.scene, camera);
    const px = new Uint8Array(bw * bh * 4);
    gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);

    hide.forEach((o2, i) => { o2.visible = wasVisible[i]; });
    for (const m of [inst.cutaway.wallMaterial, inst.cutaway.floorMaterial]) {
      m.uniforms.uDebug.value = wasDebug;
    }

    let chromatic = 0;
    for (let i = 0; i < bw * bh; i++) {
      if (px[i * 4 + 2] - px[i * 4] > 30) chromatic++;
    }
    return { chromatic, boxPixels: bw * bh, cutDepthKm: inst.view.cutDepthKm };
  },
  probeScreen: (o: { nx?: number; ny?: number } = {}) => {
    const inst = primary();
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    renderer.render(inst.scene, camera);
    const x = Math.round(((o.nx ?? 0) * 0.5 + 0.5) * (w - 1));
    const y = Math.round(((o.ny ?? 0) * 0.5 + 0.5) * (h - 1));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { x, y, rgb: [px[0], px[1], px[2]] };
  },
  probeFloor: () => {
    const inst = primary();
    return {
      floorVisible: inst.cutaway.floor.visible,
      floorRadius: inst.cutaway.floor.scale.x,
      coreRadius: R_CMB,
      wallVisible: inst.cutaway.wall.visible,
      depthMax: inst.manifest?.depth_max_km,
    };
  },
  setColorSteps: (n: number) => {
    const inst = primary();
    inst.view.colorSteps = n;
    inst.applyColorSteps();
    return inst.view.colorSteps;
  },
  setPolygon: (o: { verts: [number, number][]; depthKm: number }) => {
    const inst = primary();
    inst.cut.vertices = o.verts.map(([lon, lat]) => ({ lon, lat }));
    inst.view.cutDepthKm = o.depthKm;
    inst.closePolygon();
  },
  probeNoData: () => {
    const inst = primary();
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const px = new Uint8Array(w * h * 4);
    renderer.render(inst.scene, camera);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const neutral = new Map<number, number>();
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      if (r === g && g === b && r > 0) {
        neutral.set(r, (neutral.get(r) ?? 0) + 1);
      }
    }
    const top = [...neutral.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([v, n]) => ({ value: v, hex: '#' + v.toString(16).padStart(2, '0').repeat(3), count: n }));
    return {
      model: inst.manifest?.id,
      validFrom: inst.manifest?.depth_min_km,
      cutDepthKm: inst.view.cutDepthKm,
      expectedGrey: '#555555',
      neutralGreysFound: top,
    };
  },
  addGlobe: () => addInstance(),
  removeGlobe: (index = instances.length - 1) => {
    const inst = instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => instances.length,
  setSyncAge,
  setSyncDepthSlice,
  getSyncState: () => ({ syncAge, syncDepthSlice }),
  /** Apply age to a SPECIFIC instance, not just primary() -- needed to test
   *  whether an edit on globe 2 does/doesn't propagate to globe 1. Broadcasts
   *  exactly like a real slider drag would, via the same broadcastAge() the
   *  UI callback uses. */
  setAgeOn: async (index: number, a: number) => {
    const inst = instances[index];
    inst.applyAge(a);
    await inst.settleAge(a);
    await inst.boundaries.setAge(a);
    inst.updateTimeInfo();
    refreshGUI(inst);
    broadcastAge(inst);
  },
  setDepthSliceOn: (index: number, o: Partial<DepthSliceState>) => {
    const inst = instances[index];
    Object.assign(inst.view.depthSlice, o);
    inst.applyDepthSlice();
    refreshGUI(inst);
    broadcastDepthSlice(inst);
    return { ...inst.view.depthSlice };
  },
  instanceState: (index: number) => {
    const inst = instances[index];
    return { age: inst.view.reconstructionAge, depthSlice: { ...inst.view.depthSlice } };
  },
  stats: () => {
    const inst = primary();
    return {
      model: inst.manifest?.id,
      variable: inst.variable?.id,
      depthRange: [inst.manifest?.depth_min_km, inst.manifest?.depth_max_km],
      clip: [inst.view.clipMin, inst.view.clipMax],
      inverted: inst.cut.inverted,
      vertices: inst.cut.vertices.length,
      coastlineSegments:
        (inst.coastlines?.lines.geometry.drawRange.count ?? 0) / 2,
      globeCount: instances.length,
    };
  },
};

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  renderer.setScissorTest(instances.length > 1);
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
