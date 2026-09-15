import {
  Color, PerspectiveCamera, Vector2, Vector3, WebGLRenderer,
  type Data3DTexture,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { LIGHT_DIR, R_CMB, R_SURFACE, lonLatToVec3, radiusToDepth } from '../core/constants';
import { PALETTE } from '../core/palette';
import { loadTopography } from './globe';
import { fetchCoastlineData } from '../core/coastlines';
import {
  loadArchive, loadColormaps, nearestFrame,
} from '../core/volume';
import { GlobeInstance, type GlobeInstanceDeps } from './instance';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import type { IsosurfaceState } from './isosurface';
import { sinkingDepthKm, type DepthSliceState } from '../core/depthSlice';
import type { SurfaceMode } from './ui';
import type { ArchiveIndex } from '../core/types';

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
//
// Instance bookkeeping (the array, tileGrid() relayout, focus, and the
// Synced Field broadcast registry) lives in core/multiInstanceHost.ts --
// see docs/adr/0022. What's left here is tomography-specific: which fields
// are actually syncable (age, depth-slice -- see below), and focus driving
// OrbitControls' enabled state / which instance Enter/Escape/dblclick act
// on, which only makes sense for a viewer with per-instance tool state.

const host = new MultiInstanceHost<GlobeInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: GlobeInstanceDeps;
let defaultModelId = '';

// --- cross-globe sync ---------------------------------------------------
//
// Rotation/zoom are locked across every globe for free (one shared camera).
// Age and depth-slice are Synced Fields (see CONTEXT.md) -- each instance
// owns its own ViewState, so linking them is an explicit broadcast through
// the host: a user edit on one instance pushes the new value into every
// OTHER instance's own state and re-runs that instance's own
// applyAge()/applyDepthSlice(), reusing its existing per-model guards
// (nearestFrame clamping, the tomography-only sinking-mode check, the
// shader's own out-of-range no-data colour) unchanged. Kept as two
// independent fields, matching the existing precedent that cutaway,
// isosurface and depth-slice are manually independent rather than
// auto-coupled -- comparing two different ages on purpose still has to work.

/**
 * Push `source`'s current age into every OTHER instance's own state. This is
 * the one place that logic lives -- called from the UI callback (a real
 * slider drag), from the test hook that edits one instance directly, from
 * turning a sync flag on, and from a globe being added while a sync is
 * active.
 */
function broadcastAge(source: GlobeInstance): void {
  host.broadcast('age', source, source.view.reconstructionAge, (inst, age) => {
    inst.applyAge(age);
    refreshGUI(inst);
  });
}

function broadcastDepthSlice(source: GlobeInstance): void {
  host.broadcast('depthSlice', source, { ...source.view.depthSlice }, (inst, state) => {
    Object.assign(inst.view.depthSlice, state);
    inst.applyDepthSlice();
    refreshGUI(inst);
  });
}

/** Same "Synced Field" pattern as age/depth slice. `setReferencePlate` is a
 *  plain state setter, not a lil-gui-bound field, so the follower's own
 *  displayed text also needs an explicit push -- refreshGUI()'s
 *  controllersRecursive() walk never touches ReferencePlateControl's native
 *  input (see core/referencePlateControl.ts). */
function broadcastReferencePlate(source: GlobeInstance): void {
  host.broadcast('referencePlate', source, source.view.referencePlateId, (inst, plateId) => {
    inst.setReferencePlate(plateId);
    inst.ui.setReferencePlateValue(plateId);
    refreshGUI(inst);
  });
}

function relayout(): void {
  host.relayout();
}

function createInstance(label: string, startCollapsed = false): GlobeInstance {
  let inst!: GlobeInstance;
  inst = new GlobeInstance(camera, deps, {
    onFocus: (self) => {
      host.focused = self;
      controls.enabled = !self.toolActive(modifierHeld);
    },
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onDepthSliceChange: (self) => broadcastDepthSlice(self),
    onReferencePlateChange: (self) => broadcastReferencePlate(self),
  }, label, startCollapsed);
  return inst;
}

/** Used by both the toolbar checkbox and the test hook, so "snap every other
 *  globe to the focused one's value" lives in exactly one place. */
function setSyncAge(on: boolean): void {
  host.setSync('age', on);
  const cb = document.getElementById('sync-age') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastAge(host.lastEditOrFocused('age')!);
}

function setSyncDepthSlice(on: boolean): void {
  host.setSync('depthSlice', on);
  const cb = document.getElementById('sync-depth') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastDepthSlice(host.lastEditOrFocused('depthSlice')!);
}

function setSyncReferencePlate(on: boolean): void {
  host.setSync('referencePlate', on);
  const cb = document.getElementById('sync-reference') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastReferencePlate(host.lastEditOrFocused('referencePlate')!);
}

document.getElementById('sync-age')?.addEventListener('change', (e) => {
  setSyncAge((e.target as HTMLInputElement).checked);
});
document.getElementById('sync-depth')?.addEventListener('change', (e) => {
  setSyncDepthSlice((e.target as HTMLInputElement).checked);
});
document.getElementById('sync-reference')?.addEventListener('change', (e) => {
  setSyncReferencePlate((e.target as HTMLInputElement).checked);
});

async function addInstance(): Promise<void> {
  // Collapsed by default -- see UI's own startCollapsed doc comment. Also
  // applies to every globe the Atlantic/depth-slice presets add this way,
  // which is a real improvement there too: those presets already configure
  // each globe correctly on their own, so an open panel repeating settings
  // the preset just set is pure screen clutter, not information.
  const inst = createInstance(`Globe ${host.instances.length + 1}`, true);
  host.add(inst);
  await inst.boot(defaultModelId);
  // A globe added while a sync is active joins the synced group immediately,
  // rather than booting at age 0 / the default depth-slice and waiting for
  // the next drag elsewhere to catch it up.
  broadcastAge(host.lastEditOrFocused('age')!);
  broadcastDepthSlice(host.lastEditOrFocused('depthSlice')!);
  broadcastReferencePlate(host.lastEditOrFocused('referencePlate')!);
}

function removeInstance(inst: GlobeInstance): void {
  host.remove(inst);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  relayout();
});

document.getElementById('add-globe')?.addEventListener('click', () => {
  void addInstance();
});

document.getElementById('globe-menu-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('globe-menu');
  if (menu) menu.hidden = !menu.hidden;
});

document.getElementById('hint-toggle')?.addEventListener('click', () => {
  const hint = document.getElementById('hint');
  if (hint) hint.hidden = !hint.hidden;
});

// --- presets -------------------------------------------------------------
//
// "Start Here" menu: canned starting points for someone who has never opened
// the viewer before. Each one drives the same public instance API a user
// action would (selectModel/applySurfaceMode/applyIso/closePolygon), so a
// preset can never leave state a manual click couldn't also produce.

document.getElementById('preset-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('presets');
  if (menu) menu.hidden = !menu.hidden;
});

function hidePresetsMenu(): void {
  const menu = document.getElementById('presets');
  if (menu) menu.hidden = true;
}

/** A single square cut, in lon/lat degrees, sized to the ocean gap between
 *  South America's east coast (to about -35 lon) and Africa's west coast
 *  (from about -15 lon) -- deliberately smaller than the visible hemisphere,
 *  so both coastlines stay on screen as a frame around the cut rather than
 *  the cut consuming the whole view. Reused identically across all three
 *  globes so the models line up for comparison. */
const ATLANTIC_CUT_POLYGON: [number, number][] = [
  [-55, 35], [-5, 35], [-5, -35], [-55, -35],
];
/** All the way to the base of the volume, so the cut reveals the full column
 *  rather than just the shallow mantle. */
const ATLANTIC_CUT_DEPTH_KM = 2890;

function applyCutawayPolygon(inst: GlobeInstance, verts: [number, number][], depthKm: number): void {
  inst.cut.vertices = verts.map(([lon, lat]) => ({ lon, lat }));
  inst.view.cutDepthKm = depthKm;
  inst.closePolygon();
  refreshGUI(inst);
}

/** Matched by id, not a "muller" name fragment -- a fragment match was tried
 *  first and broke the moment the catalog grew a Muller2019 deformation/
 *  age-heat-flux family (`muller2019-deformation`, `muller2019-age-heatflux`):
 *  `archive.models.find()` returns the FIRST match in catalog order, which
 *  is now one of those (alphabetically before `opt1`), not the intended
 *  Muller 2022 OPT1 convection model -- this preset was silently loading a
 *  2D tomography-type age/heat-flux field and turning on isosurfaces over
 *  it. `opt1`'s id is stable and unique; matching it directly is the same
 *  convention `applyPresetDepthSliceComparison()` already uses for
 *  'reveal'/'uup07' below. */
function findMullerModel(): ArchiveIndex['models'][number] | undefined {
  return deps.archive.models.find((m) => m.id === 'opt1');
}

/**
 * Reset per-instance display state a preset must never inherit from whatever
 * a previous preset or manual edit left on screen -- Reference Plate and the
 * outer-surface rendering style/opacity. Each preset below calls this for
 * every instance it touches, BEFORE layering its own specific surfaceMode on
 * top, so a preset always looks the same regardless of prior state. Reported
 * live (2026-09-13): switching presets after setting a non-zero Reference
 * Plate left it non-zero in the new preset, and the REVEAL/UU-P07 depth-slice
 * preset never set surfaceMode at all, silently inheriting whatever an
 * earlier preset left it at.
 */
function resetInstanceDisplayDefaults(inst: GlobeInstance): void {
  inst.setReferencePlate(0);
  inst.ui.setReferencePlateValue(0);
  inst.setSurfaceOpacity(1);
}

/** Preset 1: a single globe on the Muller et al. 2022 convection model, with
 *  the outer surface hidden and both isosurfaces on, so the mantle structure
 *  is the very first thing visible. */
async function applyPresetConvection(): Promise<void> {
  while (host.instances.length > 1) removeInstance(host.instances[host.instances.length - 1]);
  const inst = host.instances[0];
  host.focused = inst;

  const model = findMullerModel();
  if (model) await inst.selectModel(model.id);

  resetInstanceDisplayDefaults(inst);
  inst.applySurfaceMode('none');
  // A cutaway left open from an earlier preset (the Atlantic comparison)
  // would otherwise still be cut into whatever this preset shows -- same
  // "each preset must reset what an earlier one might have left dirty"
  // reasoning as the depth-slice reset below, just for a different piece of
  // per-instance state. onKeyEscape() is the same reset the Escape key
  // itself drives.
  inst.onKeyEscape();
  // selectModel()'s own reconcileDepthSliceWithModel() only clears
  // sinkingEnabled on a non-tomography model, not `enabled` itself -- a
  // depth slice left on from an earlier preset (e.g. the REVEAL/UU-P07
  // depth-slice comparison) would otherwise still paint an opaque
  // constant-depth sphere at R_SURFACE over the isosurfaces this preset
  // means to show.
  inst.view.depthSlice.enabled = false;
  inst.applyDepthSlice();
  inst.view.iso.coldEnabled = true;
  inst.view.iso.hotEnabled = true;
  inst.applyIso();
  refreshGUI(inst);
}

/** Preset 2: one globe per real, STANDALONE seismic tomography model
 *  (skipping the dev fixtures), each cut open over the same Atlantic square
 *  so REVEAL/SEMUCB-WM1/UU-P07 can be compared side by side in the same
 *  region. `type === 'tomography'` alone is not enough to mean "a seismic
 *  inversion" any more -- Cao2024/Muller2019's Age & Heat Flux family
 *  members also reuse that type tag for an unrelated, incidental rendering-
 *  pipeline reason (same ADR-0018 caveat as convection), so without the
 *  reconstruction_model/comparison_role exclusion below this preset quietly
 *  grew from 3 globes to 5, mixing REVEAL/SEMUCB-WM1/UU-P07 with unrelated
 *  deformation-family products the moment that family was added to the
 *  catalog. A standalone model (no declared family axis) is what "real
 *  tomography model" actually means here. */
async function applyPresetAtlanticComparison(): Promise<void> {
  const models = deps.archive.models.filter(
    (m) => m.type === 'tomography' && !m.id.startsWith('fixture-')
      && !m.reconstruction_model && !m.comparison_role,
  );
  if (models.length === 0) return;

  while (host.instances.length > models.length) removeInstance(host.instances[host.instances.length - 1]);
  while (host.instances.length < models.length) await addInstance();
  relayout();

  for (let i = 0; i < models.length; i++) {
    const inst = host.instances[i];
    await inst.selectModel(models[i].id);
    resetInstanceDisplayDefaults(inst);
    // A consistent surface across all three, regardless of what each
    // instance's surface happened to be left at by earlier interaction (e.g.
    // the convection preset's "none") -- the point of this preset is a
    // like-for-like comparison.
    inst.applySurfaceMode('topography');
    // A depth slice left ENABLED from an earlier preset (the REVEAL/UU-P07
    // depth-slice comparison) paints its own opaque constant-depth sphere
    // regardless of the cutaway -- the cutaway polygon still gets recorded
    // (closePolygon() below doesn't care), but visually the depth slice's
    // settings are what's showing, not the cutaway this preset means to
    // demonstrate. Same "each preset must reset what an earlier one left
    // dirty" reasoning as the Convection preset's own identical reset, and
    // the onKeyEscape() calls those two presets make for a cutaway left
    // open by THIS one.
    inst.view.depthSlice.enabled = false;
    inst.applyDepthSlice();
    applyCutawayPolygon(inst, ATLANTIC_CUT_POLYGON, ATLANTIC_CUT_DEPTH_KM);
    refreshGUI(inst);
  }
  host.focused = host.instances[0];
  // One shared camera for every tile: point it at the Atlantic so the cut
  // this preset just made is actually the thing on screen, not a coincidence
  // of wherever the camera happened to be left.
  setCamera({ lon: -30, lat: 0, dist: 3.0 });
}

/** Preset 3: REVEAL next to UU-P07 -- two present-day tomography inversions,
 *  each showing a coloured depth slice instead of the outer surface, with
 *  both locked to age via the same published sinking rate and with time and
 *  depth slice synced across the two. Scrubbing either slider on either
 *  globe moves both together, so the same reconstructed depth is always
 *  being compared between the two models. */
async function applyPresetDepthSliceComparison(): Promise<void> {
  const reveal = deps.archive.models.find((m) => m.id === 'reveal');
  const uup07 = deps.archive.models.find((m) => m.id === 'uup07');
  const wanted = [reveal, uup07].filter((m): m is ArchiveIndex['models'][number] => !!m);
  if (wanted.length === 0) return;

  while (host.instances.length > wanted.length) removeInstance(host.instances[host.instances.length - 1]);
  while (host.instances.length < wanted.length) await addInstance();
  relayout();

  for (let i = 0; i < wanted.length; i++) {
    const inst = host.instances[i];
    await inst.selectModel(wanted[i].id);
    resetInstanceDisplayDefaults(inst);
    // Same reasoning as the Convection preset's own onKeyEscape() call -- a
    // cutaway left open from the Atlantic comparison would otherwise still
    // be cut into this depth-slice view.
    inst.onKeyEscape();
    // This preset shows a coloured depth slice IN PLACE OF the outer
    // surface -- previously left unset here, so an outer surface (e.g. the
    // Atlantic comparison's 'topography') silently kept covering the slice
    // until a manual edit turned it off.
    inst.applySurfaceMode('none');
    inst.view.depthSlice.enabled = true;
    // Both are tomography, so sinking mode (see canUseSinkingMode) applies to
    // either -- ties each one's own slice depth to the shared age via the
    // same published rate, rather than leaving one a fixed manual depth.
    inst.view.depthSlice.sinkingEnabled = true;
    inst.applyDepthSlice();
    refreshGUI(inst);
  }
  host.focused = host.instances[0];
  // At age 0 the sinking rate places the slice at 0 km -- inside UU-P07's own
  // near-surface cutoff (5 km), which reads as "broken" (flat no-data grey)
  // rather than "not sunk yet". 50 Ma puts the slice in the upper mantle,
  // comfortably inside both models' valid depth range, so the very first
  // thing shown actually demonstrates the feature.
  host.instances[0].applyAge(50);
  refreshGUI(host.instances[0]);
  // Synced AFTER both globes already have depth slice (and REVEAL's age) set:
  // setSyncAge/setSyncDepthSlice immediately broadcast the focused instance's
  // current values, so turning them on first would push a still-default
  // depth/age from a half-configured globe onto the other.
  setSyncAge(true);
  setSyncDepthSlice(true);
}

document.getElementById('preset-convection')?.addEventListener('click', () => {
  if (!deps) return; // still booting; the first globe isn't up yet
  hidePresetsMenu();
  void applyPresetConvection();
});

document.getElementById('preset-atlantic')?.addEventListener('click', () => {
  if (!deps) return;
  hidePresetsMenu();
  void applyPresetAtlanticComparison();
});

document.getElementById('preset-depthslice')?.addEventListener('click', () => {
  if (!deps) return;
  hidePresetsMenu();
  void applyPresetDepthSliceComparison();
});

// --- interaction -------------------------------------------------------
//
// The camera and canvas are shared, so pointer events are routed by which
// tile they landed in rather than assumed to belong to a single globe.

const ptr = new Vector2();
let modifierHeld = false;

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
  if (e.key === 'Enter') host.focused!.onKeyEnter();
  if (e.key === 'Escape') host.focused!.onKeyEscape();
});
addEventListener('keyup', (e) => {
  if (isModifier(e)) {
    modifierHeld = false;
    controls.enabled = !host.focused!.toolActive(modifierHeld);
  }
});
// Holding a modifier and switching apps can swallow the keyup.
addEventListener('blur', () => {
  modifierHeld = false;
  controls.enabled = !host.focused!.toolActive(modifierHeld);
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
    host.focused = hit.inst;
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
  host.add(first);
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

function primary(): GlobeInstance { return host.instances[0]; }

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
    const inst = host.instances[index];
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

    // Screen-space direction of the key light, so the pixels can be split into
    // the half that faces it and the half that does not. LIGHT_DIR is a world
    // direction; in view space its x,y ARE the screen axes, and y is up in both
    // that space and the bottom-up frame readPixels and cy already use.
    const lv = LIGHT_DIR.clone().transformDirection(camera.matrixWorldInverse);
    const lLen = Math.hypot(lv.x, lv.y);
    const lx = lLen > 1e-6 ? lv.x / lLen : 1;
    const ly = lLen > 1e-6 ? lv.y / lLen : 0;

    let n = 0; let cold = 0; let hotN = 0;
    let sx = 0; let sy = 0; let rMax = 0;
    let litSum = 0; let litN = 0; let unlitSum = 0; let unlitN = 0;
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
      // The rim term is symmetric about the disc centre, so splitting on this
      // axis cancels it and leaves the diffuse lobe -- which is the thing that
      // inverts when a surface is shaded with a normal pointing away from us.
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if ((x + 0.5 - cx) * lx + (y + 0.5 - cy) * ly > 0) { litSum += lum; litN++; }
      else { unlitSum += lum; unlitN++; }
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
      litMean: litN ? litSum / litN : 0,
      unlitMean: unlitN ? unlitSum / unlitN : 0,
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
  removeGlobe: (index = host.instances.length - 1) => {
    const inst = host.instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => host.instances.length,
  setSyncAge,
  setSyncDepthSlice,
  setSyncReferencePlate,
  getSyncState: () => ({
    syncAge: host.isSynced('age'),
    syncDepthSlice: host.isSynced('depthSlice'),
    syncReferencePlate: host.isSynced('referencePlate'),
  }),
  /** Apply a Reference Plate to a SPECIFIC instance, broadcasting exactly
   *  like a real ReferencePlateControl commit would -- the test-hook
   *  equivalent of setReferencePlateOn's age/depth-slice siblings below. */
  setReferencePlateOn: (index: number, plateId: number) => {
    const inst = host.instances[index];
    if (!inst) return;
    inst.setReferencePlate(plateId);
    inst.ui.setReferencePlateValue(plateId);
    refreshGUI(inst);
    broadcastReferencePlate(inst);
  },
  getReferencePlateOn: (index: number) => host.instances[index]?.view.referencePlateId ?? null,
  modelIds: () => host.instances.map((i) => i.view.modelId),
  /** Apply age to a SPECIFIC instance, not just primary() -- needed to test
   *  whether an edit on globe 2 does/doesn't propagate to globe 1. Broadcasts
   *  exactly like a real slider drag would, via the same broadcastAge() the
   *  UI callback uses. */
  setAgeOn: async (index: number, a: number) => {
    const inst = host.instances[index];
    inst.applyAge(a);
    await inst.settleAge(a);
    await inst.boundaries.setAge(a);
    inst.updateTimeInfo();
    refreshGUI(inst);
    broadcastAge(inst);
  },
  setDepthSliceOn: (index: number, o: Partial<DepthSliceState>) => {
    const inst = host.instances[index];
    Object.assign(inst.view.depthSlice, o);
    inst.applyDepthSlice();
    refreshGUI(inst);
    broadcastDepthSlice(inst);
    return { ...inst.view.depthSlice };
  },
  instanceState: (index: number) => {
    const inst = host.instances[index];
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
      globeCount: host.instances.length,
    };
  },
};

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  renderer.setScissorTest(host.instances.length > 1);
  for (let i = 0; i < host.instances.length; i++) {
    const rect = host.layoutRects[i];
    if (!rect) continue;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    // three.js scales viewport/scissor by devicePixelRatio itself, the same
    // way it treats setSize -- these are CSS pixels, like the rect.
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    host.instances[i].render(renderer);
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
