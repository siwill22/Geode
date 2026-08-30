import {
  Scene, PerspectiveCamera, WebGLRenderer, Raycaster, Vector2, Vector3,
  Color, type Data3DTexture, type ShaderMaterial,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  R_CMB, R_SURFACE, densifyPolygon, lonLatToVec3, radiusToDepth, vec3ToLonLat,
  type LonLat,
} from './constants';
import {
  createCoreSphere, createPickSphere, createSurfaceSphere, loadTopography,
} from './globe';
import { createMaskTexture } from './mask';
import { Cutaway, removedFraction } from './cutaway';
import { Coastlines, loadCoastlines } from './coastlines';
import { setMaskMode } from './material';
import {
  FrameCache, loadArchive, loadColormaps, loadManifest,
  makeColormapTexture, nearestFrame, physicalToEncoded,
} from './volume';
import { BoundaryOverlay } from './boundaries';
import { DEFAULT_ISOSURFACE, Isosurface, type IsosurfaceState } from './isosurface';
import { UI, type SurfaceMode, type ToolMode, type ViewState } from './ui';
import type { ArchiveIndex, ColormapData, CutawayState, Manifest, VariableInfo } from './types';

const ARCHIVE = import.meta.env.VITE_ARCHIVE_BASE ?? '/archive';

// --- scene ------------------------------------------------------------------

const scene = new Scene();
scene.background = new Color(0x0b0d10);

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
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Clamp zoom so the camera cannot enter the core.
controls.minDistance = R_CMB + 0.15;
controls.maxDistance = 12;
// A globe should stay centred; panning it off-axis is never wanted here.
controls.enablePan = false;

const maskTexture = createMaskTexture();
const core = createCoreSphere();
const surface = createSurfaceSphere(maskTexture);
const pick = createPickSphere();
const cutaway = new Cutaway(maskTexture);
const isosurface = new Isosurface();

scene.add(core, surface.mesh, pick, cutaway.wall, cutaway.floor,
  cutaway.outline, cutaway.handles, isosurface.mesh);

const boundaries = new BoundaryOverlay(camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  boundaries.resize();
});

// --- state ------------------------------------------------------------------

const cut: CutawayState = {
  vertices: [], closed: false, depthKm: 2890, inverted: false,
};

const view: ViewState = {
  modelId: '', variableId: '', colormap: 'RdBu',
  clipMin: -2, clipMax: 2, symmetricClip: true,
  reconstructionAge: 0, cutDepthKm: 2890, inverted: false,
  surfaceOpacity: 1, surfaceMode: 'topography', showBoundaries: true,
  tool: 'drag', iso: { ...DEFAULT_ISOSURFACE },
};

let archive: ArchiveIndex;
let colormaps: ColormapData;
let manifest: Manifest;
let variable: VariableInfo;
let coastlines: Coastlines | null = null;
let topography: import('three').Texture | null = null;
let ui: UI;

const frames = new FrameCache(ARCHIVE);
/**
 * Guards against a fast scrub landing an older frame after a newer one. Every
 * age change takes a ticket; a load whose ticket is stale is discarded rather
 * than applied, because fetches do not necessarily complete in issue order.
 */
let ageToken = 0;

// --- material plumbing ------------------------------------------------------

function volumeMaterials(): ShaderMaterial[] {
  return [cutaway.wallMaterial, cutaway.floorMaterial];
}

function applyColormap(name: string): void {
  const cm = colormaps[name];
  if (!cm) return;
  const tex = makeColormapTexture(cm.colors);
  for (const m of volumeMaterials()) m.uniforms.uColormap.value = tex;
}

function applyClip(): void {
  const lo = physicalToEncoded(variable, view.clipMin);
  const hi = physicalToEncoded(variable, view.clipMax);
  for (const m of volumeMaterials()) {
    m.uniforms.uClipLo.value = lo;
    m.uniforms.uClipHi.value = hi;
  }
}

/**
 * Isovalues are entered in physical units but the shader marches the encoded
 * 0..1 field, so the conversion happens here -- through the same
 * physicalToEncoded the colour clip uses, so an isovalue and a clip bound with
 * the same number mean the same thing.
 */
function applyIso(): void {
  if (variable) {
    isosurface.setEncodedIso(
      physicalToEncoded(variable, view.iso.coldValue),
      physicalToEncoded(variable, view.iso.hotValue),
    );
  }
  isosurface.update(view.iso);
}

function applyVolume(tex: Data3DTexture): void {
  const res = manifest.resolutions.find(
    (r) => r.id === manifest.default_resolution,
  )!;
  for (const m of volumeMaterials()) {
    m.uniforms.uVolume.value = tex;
    (m.uniforms.uGrid.value as Vector3).set(res.nlon, res.nlat, res.ndepth);
    m.uniforms.uDepthMin.value = manifest.depth_min_km;
    m.uniforms.uDepthMax.value = manifest.depth_max_km;
  }
  isosurface.setVolume(tex);
  isosurface.setGrid(res.nlon, res.nlat, res.ndepth);
  isosurface.setModelDepthRange(manifest.depth_min_km, manifest.depth_max_km);
  cutaway.setVolumeDepthRange(manifest.depth_max_km);
  rebuildCutaway();
  setMaskMode(cutaway.wallMaterial, 'none');
  setMaskMode(cutaway.floorMaterial, 'inside');
  cutaway.floorMaterial.uniforms.uMask.value = maskTexture;
}

/** Ramps whose polarity matches what a high value means for this variable. */
function colormapOptions(v: VariableInfo): string[] {
  const want = (v.high_means ?? 'fast') === 'hot' ? 'warm' : 'cool';
  return Object.keys(colormaps).filter((n) => {
    const c = colormaps[n];
    return c.diverging ? c.high_end === want : true;
  });
}

async function selectVariable(id: string): Promise<void> {
  variable = manifest.variables.find((v) => v.id === id) ?? manifest.variables[0];
  ui.setStatus(`loading ${manifest.name} / ${variable.name}...`);

  const frame = nearestFrame(manifest, view.reconstructionAge);
  frames.pin(manifest, variable.id, frame.id);
  applyVolume(await frames.get(manifest, variable.id, frame.id));

  view.colormap = variable.default_colormap;
  ui.setVariable(variable);
  ui.setColormapOptions(colormapOptions(variable), view.colormap);
  applyColormap(view.colormap);
  applyClip();
  applyIso();
  updateTimeInfo();
  frames.prefetchNeighbours(manifest, variable.id, frame.id);
  ui.setStatus('');
}

async function selectModel(id: string): Promise<void> {
  const entry = archive.models.find((m) => m.id === id)!;
  view.modelId = id;
  ui.setStatus(`loading ${entry.name}...`);
  manifest = await loadManifest(ARCHIVE, entry.path);
  variable = manifest.variables.find((v) => v.id === manifest.default_variable)
    ?? manifest.variables[0];
  ui.setModel(manifest, variable);
  await selectVariable(variable.id);
}

/**
 * One control fades the whole crust: the surface sphere and the coastline
 * layers that sit just above it. This is how the isosurfaces are seen -- the
 * cutaway is not required, and a partly-faded globe with fully opaque
 * continents painted on it would hide exactly the interior being looked for.
 */
function setSurfaceOpacity(v: number): void {
  view.surfaceOpacity = v;
  surface.material.uniforms.uOpacity.value = v;
  coastlines?.setOpacity(v);
}

function applySurfaceMode(m: SurfaceMode): void {
  view.surfaceMode = m;
  surface.setTopography(m === 'topography' ? topography : null);
  if (coastlines) coastlines.landVisible = m === 'land';
}

/**
 * Topography is present-day. Reconstructing to any other age leaves it showing
 * today's continents under yesterday's coastlines, which is worse than useless,
 * so move to the land fill -- which does reconstruct -- and say why rather than
 * silently changing what is drawn.
 */
function reconcileSurfaceWithAge(age: number): void {
  if (age > 0 && view.surfaceMode === 'topography') {
    applySurfaceMode('land');
    ui.setSurfaceMode('land');
    ui.setStatus('topography is present-day; switched to land fill');
  } else if (age === 0 && view.surfaceMode === 'land' && topography) {
    ui.setStatus('');
  }
}

/**
 * Report the age each layer is really showing.
 *
 * Coastlines interpolate continuously, boundary frames step in 1 Myr and the
 * convection volume in 20 Myr, so the three rarely agree with the slider or with
 * each other. Snapping silently would let someone read a 40 Ma mantle as a
 * 37 Ma one.
 */
function updateTimeInfo(): void {
  if (!manifest || manifest.frames.length < 2) { ui.setTimeInfo(''); return; }
  const age = view.reconstructionAge;
  const vol = nearestFrame(manifest, age).age_ma;
  const parts = [`age ${age.toFixed(1)} Ma`, `mantle ${vol.toFixed(0)} Ma`];
  if (boundaries.frameTime !== null) {
    parts.push(`boundaries ${boundaries.frameTime.toFixed(0)} Ma`);
  }
  ui.setTimeInfo(parts.join('  ·  '));
}

/**
 * One age drives every time-dependent layer. Each snaps to what it has:
 * coastlines are rotated continuously, boundaries and the volume take their
 * nearest frame.
 */
function applyAge(age: number): void {
  view.reconstructionAge = age;
  const token = ++ageToken;

  coastlines?.setAge(age);
  reconcileSurfaceWithAge(age);
  void boundaries.setAge(age, () => { if (token === ageToken) updateTimeInfo(); });

  if (manifest && manifest.frames.length > 1) {
    const frame = nearestFrame(manifest, age);
    frames.pin(manifest, variable.id, frame.id);
    void frames.get(manifest, variable.id, frame.id).then((tex) => {
      // A slower earlier request must not overwrite a faster later one.
      if (token !== ageToken) return;
      for (const m of volumeMaterials()) m.uniforms.uVolume.value = tex;
      // The isosurface marches its own copy of the binding, so it has to be
      // repointed too or it keeps rendering the frame the walls have left.
      isosurface.setVolume(tex);
      frames.prefetchNeighbours(manifest, variable.id, frame.id);
    }).catch((e) => ui.setStatus(String(e)));
  }
  updateTimeInfo();
}

// --- cutaway ----------------------------------------------------------------

function rebuildCutaway(): void {
  cut.depthKm = view.cutDepthKm;
  cut.inverted = view.inverted;
  cutaway.update(cut);
  // The overlay has no depth buffer, so it culls against the same raster the
  // surface shader discards on. Re-read it: update() replaces the array.
  boundaries.setMask(cut.closed ? cutaway.mask : null);
}

function closePolygon(): void {
  if (cut.vertices.length < 3) return;
  cut.closed = true;
  // Seed `inverted` so the SMALLER region is removed. Sticky from here on:
  // never recomputed on vertex drag, so dragging past the half-sphere point
  // cannot flip the cut out from under the user.
  const frac = removedFraction(densifyPolygon(cut.vertices, 0.5));
  cut.inverted = frac > 0.5;
  view.inverted = cut.inverted;
  ui.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  rebuildCutaway();
}

// --- interaction ------------------------------------------------------------

const raycaster = new Raycaster();
const ptr = new Vector2();
let modifierHeld = false;
let downPos: { x: number; y: number } | null = null;
let dragVertex = -1;

function pickLonLat(ev: PointerEvent): LonLat | null {
  ptr.x = (ev.clientX / innerWidth) * 2 - 1;
  ptr.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ptr, camera);
  const hit = raycaster.intersectObject(pick, false)[0];
  if (!hit) return null;
  const p = hit.point;
  return vec3ToLonLat(p.x, p.y, p.z);
}

function nearestVertex(ev: PointerEvent): number {
  const ll = pickLonLat(ev);
  if (!ll) return -1;
  let best = -1;
  let bestD = 6; // degrees
  for (let i = 0; i < cut.vertices.length; i++) {
    const v = cut.vertices[i];
    const d = Math.hypot(v.lat - ll.lat, (v.lon - ll.lon) * Math.cos(v.lat * Math.PI / 180));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * GPlates-style: an explicit tool mode, with a modifier key to rotate the globe
 * without leaving the current tool. A cutaway routinely wraps around the limb,
 * so rotating mid-polygon has to be possible or large polygons are undrawable.
 */
function toolActive(): boolean {
  return view.tool !== 'drag' && !modifierHeld;
}

/** Command on macOS, Control elsewhere -- matching GPlates. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
function isModifier(e: KeyboardEvent): boolean {
  return IS_MAC ? e.key === 'Meta' : e.key === 'Control';
}

addEventListener('keydown', (e) => {
  if (isModifier(e)) { modifierHeld = true; controls.enabled = true; }
  if (e.key === 'Enter') closePolygon();
  if (e.key === 'Escape') { cut.vertices = []; cut.closed = false; rebuildCutaway(); }
});
addEventListener('keyup', (e) => {
  if (isModifier(e)) { modifierHeld = false; controls.enabled = !toolActive(); }
});
// Holding a modifier and switching apps can swallow the keyup.
addEventListener('blur', () => {
  modifierHeld = false;
  controls.enabled = !toolActive();
});

/**
 * Make modifier-drag ROTATE the globe rather than pan it.
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
  if (!modifierHeld || view.tool === 'drag') return;
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
  if (!toolActive()) return;
  downPos = { x: ev.clientX, y: ev.clientY };
  if (view.tool === 'edit') dragVertex = nearestVertex(ev);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!toolActive() || dragVertex < 0) return;
  const ll = pickLonLat(ev);
  if (!ll) return;
  cut.vertices[dragVertex] = ll;
  rebuildCutaway();
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!toolActive() || !downPos) { downPos = null; dragVertex = -1; return; }
  const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
  downPos = null;
  if (dragVertex >= 0) { dragVertex = -1; return; }
  if (moved > 5) return;

  if (view.tool === 'draw') {
    const ll = pickLonLat(ev);
    if (!ll) return;
    if (cut.closed) { cut.vertices = []; cut.closed = false; }
    cut.vertices.push(ll);
    rebuildCutaway();
  } else if (view.tool === 'edit') {
    const i = nearestVertex(ev);
    if (i >= 0) { cut.vertices.splice(i, 1); rebuildCutaway(); }
  }
});

renderer.domElement.addEventListener('dblclick', () => {
  if (view.tool === 'draw') closePolygon();
});

// --- export -----------------------------------------------------------------

function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * The boundaries live on a separate 2D canvas, so a screenshot has to composite
 * the two or it silently drops a layer the user can see on screen.
 */
function exportPNG(): void {
  renderer.render(scene, camera);
  boundaries.draw();
  const gl = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = gl.width;
  out.height = gl.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(gl, 0, 0);
  ctx.drawImage(boundaries.canvas, 0, 0, out.width, out.height);
  out.toBlob((b) => b && download('geode.png', b));
}

function exportPolygon(): void {
  const ring = cut.vertices.map((v) => [v.lon, v.lat]);
  if (ring.length) ring.push(ring[0]);
  const gj = {
    type: 'Feature',
    properties: { cut_depth_km: cut.depthKm, inverted: cut.inverted },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
  download('cutaway.geojson', new Blob([JSON.stringify(gj, null, 2)],
    { type: 'application/geo+json' }));
}

function importPolygon(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.geojson,.json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const gj = JSON.parse(await f.text());
    const coords = gj.geometry?.coordinates?.[0] ?? gj.coordinates?.[0];
    if (!coords) return;
    cut.vertices = coords
      .slice(0, coords.length - 1)
      .map((c: number[]) => ({ lon: c[0], lat: c[1] }));
    if (typeof gj.properties?.inverted === 'boolean') {
      view.inverted = gj.properties.inverted;
    }
    cut.closed = true;
    rebuildCutaway();
  };
  input.click();
}

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  archive = await loadArchive(ARCHIVE);
  colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  view.modelId = archive.models.find((m) => m.id === 'reveal')?.id
    ?? archive.models[0].id;

  ui = new UI(view, archive, Object.keys(colormaps), {
    onModel: (id) => void selectModel(id),
    onVariable: (id) => void selectVariable(id),
    onColormap: (n) => applyColormap(n),
    onClip: () => applyClip(),
    onAge: (age) => applyAge(age),
    onCutDepth: () => rebuildCutaway(),
    onInvert: () => rebuildCutaway(),
    onSurfaceOpacity: (v) => setSurfaceOpacity(v),
    onSurfaceMode: (m) => { applySurfaceMode(m); ui.setStatus(''); },
    onBoundaries: (on) => { boundaries.visible = on; },
    onIsosurface: () => applyIso(),
    onTool: () => { controls.enabled = !toolActive(); },
    onClear: () => { cut.vertices = []; cut.closed = false; rebuildCutaway(); },
    onExportPNG: exportPNG,
    onExportPolygon: exportPolygon,
    onImportPolygon: importPolygon,
  });

  ui.setAgeRange(archive.coastlines.age_min, archive.coastlines.age_max);
  await selectModel(view.modelId);

  if (archive.boundaries) {
    ui.setStatus('loading plate boundaries...');
    try {
      await boundaries.load(`${ARCHIVE}/${archive.boundaries}`);
      await boundaries.setAge(view.reconstructionAge);
    } catch {
      // Boundaries are a layer, not a prerequisite; the globe still works.
    }
  }

  ui.setStatus('loading topography...');
  try {
    topography = await loadTopography(`${ARCHIVE}/surface/topography.jpg`);
  } catch {
    topography = null;   // fall back to flat colour rather than failing to boot
  }

  ui.setStatus('loading coastlines...');
  coastlines = await loadCoastlines(
    ARCHIVE, archive.coastlines.geometry, archive.coastlines.rotations, maskTexture,
  );
  scene.add(coastlines.lines, coastlines.land);
  coastlines.setAge(view.reconstructionAge);
  setSurfaceOpacity(view.surfaceOpacity);   // coastlines only exist from here
  applySurfaceMode(topography ? view.surfaceMode : 'flat');
  ui.setStatus('');
  updateTimeInfo();

  rebuildCutaway();
  if (window.__geode) window.__geode.ready = true;
}

// --- test hook --------------------------------------------------------------
// Drives the viewer from scripts/shoot.mjs so the render-dependent acceptance
// criteria can actually be checked rather than assumed.

declare global {
  interface Window { __geode?: Record<string, unknown> }
}

function setCamera(o: { lon: number; lat: number; dist: number }): void {
  // Use the shared convention rather than restating it, so the camera cannot
  // drift out of sync with the geometry.
  const [x, y, z] = lonLatToVec3(o.lon, o.lat, o.dist);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  controls.update();
}

function refreshGUI(): void {
  ui?.gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

window.__geode = {
  ready: false,
  setAge: async (a: number) => {
    applyAge(a);
    // Settle the async layers so a screenshot taken straight after this shows
    // the age that was asked for rather than whatever was up before.
    if (manifest && manifest.frames.length > 1) {
      await frames.get(manifest, variable.id, nearestFrame(manifest, a).id);
    }
    await boundaries.setAge(a);
    updateTimeInfo();
    refreshGUI();
  },
  setBoundaries: (on: boolean) => {
    view.showBoundaries = on;
    boundaries.visible = on;
    refreshGUI();
  },
  /**
   * Decode one voxel of the volume texture that is CURRENTLY BOUND.
   *
   * Reads the array actually uploaded to the GPU, so it answers "which frame is
   * on screen", not "which frame did we mean to load". That is the question the
   * drift fixture exists to ask: at 0 Ma its blob sits on the prime meridian and
   * at 200 Ma at 100 E, so a frame off by one -- or a reversed series -- shows
   * up as a number here rather than as a plausible-looking render.
   */
  probeVolume: (lon: number, lat: number, depthKm: number) => {
    const tex = cutaway.wallMaterial.uniforms.uVolume.value as Data3DTexture;
    const data = tex.image.data as Uint8Array;
    const res = manifest.resolutions.find(
      (r) => r.id === manifest.default_resolution,
    )!;
    const i = ((Math.round(((lon + 180) / 360) * res.nlon) % res.nlon) + res.nlon)
      % res.nlon;
    const j = Math.max(0, Math.min(res.nlat - 1,
      Math.round(((lat + 90) / 180) * (res.nlat - 1))));
    const t = (depthKm - manifest.depth_min_km)
      / (manifest.depth_max_km - manifest.depth_min_km);
    const k = Math.max(0, Math.min(res.ndepth - 1,
      Math.round(t * (res.ndepth - 1))));
    const code = data[k * res.nlat * res.nlon + j * res.nlon + i];
    return {
      code,
      value: variable.encode_min
        + (code / 255) * (variable.encode_max - variable.encode_min),
      units: variable.units,
    };
  },
  /**
   * Test the projector's horizon directly, at the boundary condition.
   *
   * This is the one part that could not be borrowed from deep-time-map: its
   * reference projector is orthographic, where the visible cap ends at
   * dot(v, camDir) = 0, but under perspective it ends at R/d. The tempting
   * check -- "is anything drawn outside the silhouette" -- does NOT catch the
   * mistake: points between the two horizons are behind the tangent circle and
   * project INSIDE the disc, painting the far side over the near one. So probe
   * the projector at three known angles instead.
   *
   * `beyond` is the discriminator: past the true horizon but well short of 90
   * degrees, so an orthographic test would wrongly accept it.
   */
  probeHorizon: () => {
    boundaries.projector.update(innerWidth, innerHeight);
    const d = camera.position.length();
    const c = camera.position.clone().normalize();
    // three.js -> geographic is the inverse of (gx, gy, gz) -> (gx, gz, -gy).
    const g = [c.x, -c.z, c.y];
    // Any unit vector perpendicular to g.
    const t = Math.abs(g[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let p = [
      g[1] * t[2] - g[2] * t[1],
      g[2] * t[0] - g[0] * t[2],
      g[0] * t[1] - g[1] * t[0],
    ];
    const pn = Math.hypot(p[0], p[1], p[2]);
    p = p.map((x) => x / pn);

    // The cutaway also returns null, for a different and correct reason. Lift it
    // so this measures the horizon alone.
    const savedMask = boundaries.projector.mask;
    boundaries.projector.mask = null;

    const at = (theta: number) => {
      const cs = Math.cos(theta), sn = Math.sin(theta);
      return boundaries.projector.project([
        g[0] * cs + p[0] * sn, g[1] * cs + p[1] * sn, g[2] * cs + p[2] * sn,
      ]) !== null;
    };
    const thetaH = Math.acos(Math.min(1, R_SURFACE / d));
    const out = {
      cameraDistance: d,
      horizonDeg: (thetaH * 180) / Math.PI,
      inside: at(thetaH - 0.02),       // must be true
      outside: at(thetaH + 0.02),      // must be false
      beyond: at(thetaH + (Math.PI / 2 - thetaH) * 0.5), // must be false
    };
    boundaries.projector.mask = savedMask;
    return out;
  },
  probeBoundaries: () => ({
    age: view.reconstructionAge,
    frameTime: boundaries.frameTime,
    timeRange: boundaries.timeRange,
    visible: boundaries.visible,
    volumeFrame: manifest ? nearestFrame(manifest, view.reconstructionAge) : null,
  }),
  setSurfaceMode: (m: SurfaceMode) => { applySurfaceMode(m); refreshGUI(); },
  setSurfaceOpacity: (v: number) => { setSurfaceOpacity(v); refreshGUI(); },
  setModel: async (id: string) => { await selectModel(id); refreshGUI(); },
  setVariable: async (id: string) => { await selectVariable(id); refreshGUI(); },
  setCutDepth: (km: number) => {
    view.cutDepthKm = km; rebuildCutaway(); refreshGUI();
  },
  setCamera,
  setDebug: (mode: number) => {
    for (const m of volumeMaterials()) m.uniforms.uDebug.value = mode;
  },
  setVisible: (o: Record<string, boolean>) => {
    if ('wall' in o) cutaway.wall.visible = o.wall;
    if ('floor' in o) cutaway.floor.visible = o.floor;
    if ('core' in o) core.visible = o.core;
    if ('surface' in o) surface.mesh.visible = o.surface;
    if ('isosurface' in o) isosurface.mesh.visible = o.isosurface;
  },
  setIsosurface: (o: Partial<IsosurfaceState>) => {
    Object.assign(view.iso, o);
    applyIso();
    refreshGUI();
    return { ...view.iso, shell: isosurface.shell };
  },
  /**
   * Measure the isosurface's drawn silhouette and report it as a RADIUS.
   *
   * This is the check the fixtures were built for. fixture-ramp is linear in
   * depth from -1 at 0 km to +1 at 2840 km, so an isosurface at value V is
   * exactly a sphere at depth (V+1)/2 x 2840 -- a number that can be predicted
   * before rendering and compared against. Half a texel of depth is ~15 km, or
   * several pixels at a normal camera distance, so this also decides whether
   * the isosurface samples the volume the same way the cutaway wall does:
   * both invert the one volumeUVW, and a second convention would land here.
   *
   * Everything else in the scene is hidden first. A single lit pixel of core or
   * coastline inside the frame would be counted as isosurface and inflate the
   * radius, which is precisely the kind of quietly-wrong number this exists to
   * avoid producing.
   *
   * Pass 'core' instead to measure the core sphere, whose radius is the constant
   * R_CMB. That calibrates this measurement against something already known, so
   * a disagreement can be attributed to the isosurface rather than to the ruler.
   */
  probeSilhouette: (target: 'isosurface' | 'core' = 'isosurface') => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;

    const keep = target === 'core' ? core : isosurface.mesh;
    const others = [
      core, surface.mesh, cutaway.wall, cutaway.floor, cutaway.outline,
      cutaway.handles, coastlines?.lines, coastlines?.land, isosurface.mesh,
    ].filter((o) => !!o && o !== keep) as import('three').Object3D[];
    const wasVisible = others.map((o) => o.visible);
    for (const o of others) o.visible = false;
    const keptVisible = keep.visible;
    keep.visible = true;

    renderer.render(scene, camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    others.forEach((o, i) => { o.visible = wasVisible[i]; });
    keep.visible = keptVisible;

    // The clear colour goes through three's colour management, so read the
    // background from a corner rather than assuming the hex it was set from.
    const bg = [px[0], px[1], px[2]];

    // Screen position of the globe's centre, in the bottom-left pixel frame
    // readPixels uses.
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
      // The two isosurface colours are strongly and oppositely saturated, so
      // the blue/red comparison classifies them without a distance metric.
      if (b > r) cold++; else hotN++;
      const x = i % w; const y = Math.floor(i / w);
      sx += x; sy += y;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rMax) rMax = d;
    }

    // Pixels -> world radius. A sphere of radius R at camera distance d has a
    // silhouette at angular radius asin(R/d) from the view axis, and a pinhole
    // camera puts angle theta at (h/2) * tan(theta) / tan(fov/2) pixels.
    const d = camera.position.length();
    const toRadius = (rPx: number) => d * Math.sin(
      Math.atan((rPx / (h / 2)) * Math.tan((camera.fov * Math.PI) / 360)),
    );

    // Two estimators of the same silhouette. The extreme-pixel radius is valid
    // even when the disc runs off the edge of the frame; the area estimator is
    // not, but it averages over the whole boundary and so is far less sensitive
    // to any one edge pixel. Report both in pixels as well, because the
    // antialiased edge biases the count by a fraction of a pixel and only a
    // pixel figure can be calibrated against a known object.
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
      shell: isosurface.shell,
    };
  },
  /**
   * How many pixels of isosurface poke up through the cutaway floor.
   *
   * The silhouette measurement above is limited by the screen: at a normal
   * camera distance one pixel of radius is ~17 km of depth, so it cannot resolve
   * half a depth texel (~7 km) -- which is exactly the error a second, subtly
   * different copy of the sampling convention would produce.
   *
   * This measurement is not pixel-limited. The floor cap is a sphere placed at
   * depthToRadius(cutDepthKm), so sweeping the cut depth and watching for the
   * moment the isosurface disappears behind it locates the isosurface against a
   * known radius, to whatever precision the sweep is run at. It also couples the
   * two samplers directly: the floor reads the volume through volumeUVW, and the
   * flip happens where the isosurface says the same field has the same value.
   *
   * The volume surfaces are put into debug mode so they render greyscale; that
   * makes "is this pixel isosurface" a question about chroma rather than about
   * which end of a diverging colormap a blue pixel came from.
   *
   * Only a small box at the centre of the frame is counted. The camera has to
   * be aimed into the cut, and restricting the count keeps the answer a local
   * radius comparison between two concentric spheres -- independent of the
   * polygon's shape and of whatever is drawn out at the limb.
   */
  probeIsoAboveFloor: (halfBoxPx = 20) => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;

    const hide = [
      core, surface.mesh, cutaway.outline, cutaway.handles,
      coastlines?.lines, coastlines?.land,
    ].filter(Boolean) as import('three').Object3D[];
    const wasVisible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const wasDebug = cutaway.wallMaterial.uniforms.uDebug.value as number;
    for (const m of volumeMaterials()) m.uniforms.uDebug.value = 1;

    const o = new Vector3(0, 0, 0).project(camera);
    const cx = Math.round((o.x * 0.5 + 0.5) * (w - 1));
    const cy = Math.round((o.y * 0.5 + 0.5) * (h - 1));
    const x0 = Math.max(0, cx - halfBoxPx);
    const y0 = Math.max(0, cy - halfBoxPx);
    const bw = Math.min(w, cx + halfBoxPx + 1) - x0;
    const bh = Math.min(h, cy + halfBoxPx + 1) - y0;

    renderer.render(scene, camera);
    const px = new Uint8Array(bw * bh * 4);
    gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);

    hide.forEach((o2, i) => { o2.visible = wasVisible[i]; });
    for (const m of volumeMaterials()) m.uniforms.uDebug.value = wasDebug;

    let chromatic = 0;
    for (let i = 0; i < bw * bh; i++) {
      if (px[i * 4 + 2] - px[i * 4] > 30) chromatic++;
    }
    return { chromatic, boxPixels: bw * bh, cutDepthKm: view.cutDepthKm };
  },
  /**
   * The colour of the fully composed scene at one NDC point.
   *
   * Used to check that the isosurface writes the depth of its HIT rather than of
   * its proxy sphere. The proxy is a back-face sphere, so its rasterised depth
   * lies behind the core; leave gl_FragDepth alone and the core wins the depth
   * test at the centre of the globe even though the isosurface is in front of it.
   */
  probeScreen: (o: { nx?: number; ny?: number } = {}) => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    renderer.render(scene, camera);
    const x = Math.round(((o.nx ?? 0) * 0.5 + 0.5) * (w - 1));
    const y = Math.round(((o.ny ?? 0) * 0.5 + 0.5) * (h - 1));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { x, y, rgb: [px[0], px[1], px[2]] };
  },
  probeFloor: () => ({
    floorVisible: cutaway.floor.visible,
    floorRadius: cutaway.floor.scale.x,
    coreRadius: R_CMB,
    wallVisible: cutaway.wall.visible,
    depthMax: manifest?.depth_max_km,
  }),
  setPolygon: (o: { verts: [number, number][]; depthKm: number }) => {
    cut.vertices = o.verts.map(([lon, lat]) => ({ lon, lat }));
    view.cutDepthKm = o.depthKm;
    closePolygon();
  },
  /**
   * Sample the wall straight down from the surface and report where the
   * no-data grey ends. Confirms the shader greys exactly the depths outside
   * the model's valid range rather than fabricating values there.
   */
  probeNoData: () => {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const px = new Uint8Array(w * h * 4);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // Report every neutral grey present, so a band rendered at the wrong
    // brightness shows up as a value rather than simply being absent.
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
      model: manifest?.id,
      validFrom: manifest?.depth_min_km,
      cutDepthKm: view.cutDepthKm,
      expectedGrey: '#555555',
      neutralGreysFound: top,
    };
  },
  stats: () => ({
    model: manifest?.id,
    variable: variable?.id,
    depthRange: [manifest?.depth_min_km, manifest?.depth_max_km],
    clip: [view.clipMin, view.clipMax],
    inverted: cut.inverted,
    vertices: cut.vertices.length,
    coastlineSegments:
      (coastlines?.lines.geometry.drawRange.count ?? 0) / 2,
  }),
};

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  // Redrawn every frame: the overlay is in screen space, so it is stale the
  // moment the camera moves.
  boundaries.draw();
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre id="error">${String(e)}</pre>`,
  );
});
animate();
