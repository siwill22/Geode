import {
  Color, PerspectiveCamera, Vector2, Vector3, WebGLRenderer,
  type Data3DTexture,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { LIGHT_DIR, R_CMB, R_SURFACE, lonLatToVec3, radiusToDepth } from '../core/constants';
import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { loadTopography } from './globe';
import { fetchCoastlineData } from '../core/coastlines';
import {
  loadArchive, loadColormaps, nearestFrame,
} from '../core/volume';
import { GlobeInstance, type GlobeInstanceDeps } from './instance';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import type { IsosurfaceState } from './isosurface';
import {
  DEFAULT_DEPTH_SLICE, SINKING_RATE_PRESETS, canUseSinkingMode, sinkingDepthKm,
  type DepthSliceState,
} from '../core/depthSlice';
import type { SurfaceMode } from './ui';
import type { ArchiveIndex } from '../core/types';
import { MANTLE_CONFIG, type CameraView, type ViewPresetConfig } from '../generated/mantleConfig';

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
// Themes are not yet wired into this wrapper's UI -- it boots on the
// default Theme's page colour. See docs/adr/0038 for the intended
// always-present control, and themelab/ for the built one.
renderer.setClearColor(new Color(resolveTheme(DEFAULT_THEME).page));
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
    onModelChange: () => updateCredit(),
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
  updateCredit(); // boot() loads boundaries after its Model, so once more here
  // A globe added while a sync is active joins the synced group immediately,
  // rather than booting at age 0 / the default depth-slice and waiting for
  // the next drag elsewhere to catch it up.
  broadcastAge(host.lastEditOrFocused('age')!);
  broadcastDepthSlice(host.lastEditOrFocused('depthSlice')!);
  broadcastReferencePlate(host.lastEditOrFocused('referencePlate')!);
}

function removeInstance(inst: GlobeInstance): void {
  host.remove(inst);
  updateCredit();
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
// "Start here" menu: canned starting points for someone who has never opened
// the viewer before. Each one drives the same public instance API a user
// action would (selectModel/applySurfaceMode/applyIso/closePolygon), so a
// preset can never leave state a manual click couldn't also produce.
//
// Two kinds (CONTEXT.md):
//   - View Presets show the loaded Model a particular way -- isosurfaces, a
//     cutaway, a depth slice through time. They name no Model, so they work
//     on any Archive, including one holding a single imported Model.
//   - Comparison Presets set up specific Models side by side. Each is listed
//     only when every Model it needs is in this Archive.
// The menu is rebuilt each time it opens, so its labels name the Model
// actually loaded and nothing on it can silently do nothing.

interface Preset {
  label: string;
  sub: string;
  apply: () => Promise<void>;
}

/** A single square cut, in lon/lat degrees, sized to the ocean gap between
 *  South America's east coast (to about -35 lon) and Africa's west coast
 *  (from about -15 lon) -- deliberately smaller than the visible hemisphere,
 *  so both coastlines stay on screen as a frame around the cut rather than
 *  the cut consuming the whole view. Reused identically across all globes
 *  so the models line up for comparison. */
const ATLANTIC_CUT_POLYGON: [number, number][] = [
  [-55, 35], [-5, 35], [-5, -35], [-55, -35],
];
/** All the way to the base of the volume, so the cut reveals the full column
 *  rather than just the shallow mantle. */
const ATLANTIC_CUT_DEPTH_KM = 2890;
const ATLANTIC_CAMERA = { lon: -30, lat: 0, dist: 3.0 };

/** At age 0 sinking mode places the slice at 0 km -- inside some models'
 *  near-surface cutoff (UU-P07's is 5 km), which reads as "broken" (flat
 *  no-data grey) rather than "not sunk yet". 50 Ma puts the slice in the
 *  upper mantle (600 km at 1.2 cm/yr), inside every model's depth range. */
const SINKING_START_AGE = 50;

function applyCutawayPolygon(inst: GlobeInstance, verts: [number, number][], depthKm: number): void {
  inst.cut.vertices = verts.map(([lon, lat]) => ({ lon, lat }));
  inst.view.cutDepthKm = depthKm;
  inst.closePolygon();
  refreshGUI(inst);
}

/**
 * Reset per-instance display state a preset must never inherit from whatever
 * a previous preset or manual edit left on screen: Reference Plate, outer
 * surface opacity, an open cutaway (onKeyEscape(), the same reset the Escape
 * key drives) and the depth slice. selectModel()'s own reconcile only clears
 * sinking mode on a non-tomography Model, not the slice itself, and a slice
 * left on paints an opaque sphere over whatever the next preset shows. Age
 * goes back to 0 Ma for the same reason: a preset looks the same whatever
 * came before it. Reported live (2026-09-13): switching presets after setting a non-zero
 * Reference Plate left it non-zero in the new preset.
 */
function resetInstanceDisplayDefaults(inst: GlobeInstance): void {
  inst.setReferencePlate(0);
  inst.ui.setReferencePlateValue(0);
  inst.setSurfaceOpacity(1);
  inst.applyAge(0);
  inst.onKeyEscape();
  inst.view.depthSlice.enabled = false;
  inst.view.depthSlice.sinkingEnabled = false;
  inst.applyDepthSlice();
  inst.view.iso.coldEnabled = false;
  inst.view.iso.hotEnabled = false;
  inst.applyIso();
}

/** Exactly `n` globes, keeping the first ones and their Models. */
async function setGlobeCount(n: number): Promise<void> {
  while (host.instances.length > n) removeInstance(host.instances[host.instances.length - 1]);
  while (host.instances.length < n) await addInstance();
  relayout();
}

/** A View Preset starts from one globe, on whatever Model it already shows.
 *  Syncs are dropped: they only mean something with a second globe. */
async function singleGlobe(): Promise<GlobeInstance> {
  await setGlobeCount(1);
  setSyncAge(false);
  setSyncDepthSlice(false);
  const inst = host.instances[0];
  host.focused = inst;
  resetInstanceDisplayDefaults(inst);
  return inst;
}

// The view steps, shared by View Presets and the Comparison Presets built
// from them.

function showIsosurfaces(inst: GlobeInstance): void {
  inst.applySurfaceMode('none');
  inst.view.iso.coldEnabled = true;
  inst.view.iso.hotEnabled = true;
  inst.applyIso();
  refreshGUI(inst);
}

function showCutaway(inst: GlobeInstance, verts: [number, number][], depthKm: number): void {
  inst.applySurfaceMode('topography');
  applyCutawayPolygon(inst, verts, depthKm);
}

/** A coloured depth slice in place of the outer surface, its depth tied to
 *  age by van der Meer et al. 2010's 1.2 cm/yr (the default rate), so the
 *  age slider walks the slice down through the mantle. */
function showSinkingSlice(inst: GlobeInstance): void {
  inst.applySurfaceMode('none');
  const ds = inst.view.depthSlice;
  const rate = SINKING_RATE_PRESETS.find((p) => p.id === DEFAULT_DEPTH_SLICE.sinkingPreset)!;
  ds.sinkingPreset = rate.id;
  ds.rateUpperCmPerYr = rate.upperCmPerYr;
  ds.rateLowerCmPerYr = rate.lowerCmPerYr;
  ds.enabled = true;
  ds.sinkingEnabled = true;
  inst.applyDepthSlice();
  refreshGUI(inst);
}

/** "slow & fast" for seismic velocity, "cold & hot" for temperature -- the
 *  same naming the isosurface controls use (ui.ts setVariable). */
function isoPairLabel(inst: GlobeInstance): string {
  return (inst.variable?.high_means ?? 'fast') === 'fast' ? 'slow & fast' : 'cold & hot';
}

/** All three, with their default geography, unless the config says which. */
const VIEW_PRESETS: ViewPresetConfig[] = MANTLE_CONFIG.viewPresets
  ?? [{ kind: 'isosurfaces' }, { kind: 'cutaway' }, { kind: 'sinking-slice' }];

function viewPreset(cfg: ViewPresetConfig, inst: GlobeInstance): Preset | null {
  const name = inst.modelEntry?.name ?? 'this model';
  const look = (camera?: CameraView) => { if (camera) setCamera(camera); };
  switch (cfg.kind) {
    case 'isosurfaces':
      return {
        label: 'Isosurfaces',
        sub: `${name}, surface hidden, ${isoPairLabel(inst)} isosurfaces`,
        apply: async () => { showIsosurfaces(await singleGlobe()); look(cfg.camera); },
      };
    case 'cutaway': {
      const custom = cfg.polygon !== undefined;
      return {
        label: 'Cutaway',
        sub: `${name}, cut open to ${cfg.depthKm ? `${cfg.depthKm} km` : 'the core-mantle boundary'}`
          + ` under ${cfg.region ?? (custom ? 'the chosen region' : 'the Atlantic')}`,
        apply: async () => {
          showCutaway(await singleGlobe(), cfg.polygon ?? ATLANTIC_CUT_POLYGON,
            cfg.depthKm ?? ATLANTIC_CUT_DEPTH_KM);
          look(cfg.camera ?? (custom ? undefined : ATLANTIC_CAMERA));
        },
      };
    }
    case 'sinking-slice':
      // Sinking mode maps age to depth, which only means something for a
      // present-day image of the mantle (canUseSinkingMode), not a model
      // with its own time axis.
      if (!canUseSinkingMode(inst.manifest)) return null;
      return {
        label: 'Depth slice through time',
        sub: `${name}, slice depth follows age at 1.2 cm/yr -- drag the age slider`,
        apply: async () => {
          const g = await singleGlobe();
          showSinkingSlice(g);
          g.applyAge(cfg.startAge ?? SINKING_START_AGE);
          refreshGUI(g);
          look(cfg.camera);
        },
      };
  }
}

function viewPresets(): Preset[] {
  const inst = host.instances[0];
  return VIEW_PRESETS.map((cfg) => viewPreset(cfg, inst)).filter((p): p is Preset => p !== null);
}

type ModelEntry = ArchiveIndex['models'][number];

function modelById(id: string): ModelEntry | undefined {
  return deps.archive.models.find((m) => m.id === id);
}

/** Real, STANDALONE seismic tomography models. `type === 'tomography'` alone
 *  is not enough: Cao2024/Muller2019's Age & Heat Flux family members reuse
 *  that type tag for an incidental rendering reason (same ADR-0018 caveat as
 *  convection), and without the reconstruction_model/comparison_role
 *  exclusion the Atlantic comparison grew from 3 globes to 5 the moment that
 *  family joined the catalog. */
function standaloneTomography(): ModelEntry[] {
  return deps.archive.models.filter(
    (m) => m.type === 'tomography' && !m.id.startsWith('fixture-')
      && !m.reconstruction_model && !m.comparison_role,
  );
}

function comparisonPresets(): Preset[] {
  const presets: Preset[] = [];
  if (MANTLE_CONFIG.comparisonPresets === false) return presets;

  // Matched by id, not a "muller" name fragment: a fragment match picked a
  // Muller2019 age/heat-flux model once that family joined the catalog.
  const opt1 = modelById('opt1');
  if (opt1) {
    presets.push({
      label: 'Mantle convection',
      sub: `${opt1.name}, surface hidden, hot & cold isosurfaces`,
      apply: async () => {
        const inst = await singleGlobe();
        await inst.selectModel(opt1.id);
        resetInstanceDisplayDefaults(inst);
        showIsosurfaces(inst);
      },
    });
  }

  const tomo = standaloneTomography();
  if (tomo.length >= 2) {
    presets.push({
      label: 'Compare tomography models',
      sub: `${tomo.length} globes (${tomo.map((m) => m.name).join(', ')}), Atlantic cutaway`,
      apply: async () => {
        await setGlobeCount(tomo.length);
        setSyncAge(false);
        setSyncDepthSlice(false);
        for (let i = 0; i < tomo.length; i++) {
          const inst = host.instances[i];
          await inst.selectModel(tomo[i].id);
          resetInstanceDisplayDefaults(inst);
          showCutaway(inst, ATLANTIC_CUT_POLYGON, ATLANTIC_CUT_DEPTH_KM);
        }
        host.focused = host.instances[0];
        // One shared camera for every tile, pointed at the cut.
        setCamera(ATLANTIC_CAMERA);
      },
    });
  }

  const pair = [modelById('reveal'), modelById('uup07')];
  if (pair[0] && pair[1]) {
    const [a, b] = pair as ModelEntry[];
    presets.push({
      label: 'Compare depth slices',
      sub: `${a.name} & ${b.name}, locked to age, synced depth slice & time`,
      apply: async () => {
        await setGlobeCount(2);
        setSyncAge(false);
        setSyncDepthSlice(false);
        for (const [i, m] of [a, b].entries()) {
          const inst = host.instances[i];
          await inst.selectModel(m.id);
          resetInstanceDisplayDefaults(inst);
          showSinkingSlice(inst);
        }
        host.focused = host.instances[0];
        host.instances[0].applyAge(SINKING_START_AGE);
        refreshGUI(host.instances[0]);
        // Synced AFTER both globes are set up: setSyncAge/setSyncDepthSlice
        // immediately broadcast the focused instance's current values, so
        // turning them on first would push a half-configured globe's
        // defaults onto the other.
        setSyncAge(true);
        setSyncDepthSlice(true);
      },
    });
  }
  return presets;
}

function renderPresetsMenu(menu: HTMLElement): void {
  menu.replaceChildren();
  const groups: [string, Preset[]][] = [
    ['Start here', viewPresets()],
    ['Compare', comparisonPresets()],
  ];
  for (const [title, presets] of groups) {
    if (presets.length === 0) continue;
    const heading = document.createElement('div');
    heading.className = 'presets-title';
    heading.textContent = title;
    menu.append(heading);
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.textContent = p.label;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = p.sub;
      btn.append(sub);
      btn.addEventListener('click', () => {
        menu.hidden = true;
        void p.apply();
      });
      menu.append(btn);
    }
  }
}

document.getElementById('preset-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('presets');
  if (!menu || !deps || host.instances.length === 0) return; // still booting
  if (menu.hidden) renderPresetsMenu(menu);
  menu.hidden = !menu.hidden;
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

/**
 * The attribution line, built from what the archive states for what is
 * actually on screen: each globe's Model `source`, then the archive's
 * `sources` entry for each shared layer that loaded. It used to be fixed
 * HTML, which credited "mantle Muller et al. 2022" whichever model was shown
 * and kept naming topography and coastlines when they had failed to load.
 */
function updateCredit(): void {
  const el = document.getElementById('credit');
  if (!el || !deps) return;
  const sources = deps.archive.sources ?? {};
  const models = [...new Set(host.instances.map((i) => i.modelEntry?.source).filter(Boolean))];
  const layers: string[] = [];
  if (deps.topography && sources.surface) layers.push(`topography ${sources.surface}`);
  if (deps.coastlineData && sources.coastlines) layers.push(`coastlines ${sources.coastlines}`);
  if (host.instances.some((i) => i.boundariesLoaded) && sources.boundaries) {
    layers.push(`boundaries ${sources.boundaries}`);
  }
  el.textContent = [...models, ...layers].join(' \u00b7 ');
}

/** A non-blocking notice naming each layer that failed to load. */
function showMissingLayers(missing: string[]): void {
  if (!missing.length) return;
  for (const m of missing) console.warn(`layer not loaded: ${m}`);
  const box = document.createElement('div');
  box.id = 'layer-warning';
  box.setAttribute('role', 'status');
  box.textContent = `Not loaded, so not shown: ${missing.map((m) => m.split(' (')[0]).join(', ')}. `
    + 'The archive is incomplete -- see the browser console for the failed files.';
  const close = document.createElement('button');
  close.textContent = '\u00d7';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => box.remove());
  box.append(close);
  document.body.append(box);
}

/** The Archive as this site offers it: only the configured Models, in the
 *  configured order. Everything downstream (dropdowns, presets, credit)
 *  sees this copy, so an unoffered Model can't appear anywhere. */
function offeredModels(archive: ArchiveIndex): ArchiveIndex {
  const ids = MANTLE_CONFIG.models;
  if (!ids) return archive;
  const missing = ids.filter((id) => !archive.models.some((m) => m.id === id));
  if (missing.length) {
    throw new Error(`configured models not in archive.json: ${missing.join(', ')} `
      + `(has: ${archive.models.map((m) => m.id).join(', ')})`);
  }
  return { ...archive, models: ids.map((id) => archive.models.find((m) => m.id === id)!) };
}

async function boot(): Promise<void> {
  const archive = offeredModels(await loadArchive(ARCHIVE));
  const colormaps = await loadColormaps(ARCHIVE, archive.colormaps);

  // Layers the viewer can boot without, but must not drop silently: a
  // half-built archive otherwise shows a plausible empty globe under a
  // credit line naming data that never loaded.
  const missingLayers: string[] = [];

  let topography = null;
  try {
    topography = await loadTopography(`${ARCHIVE}/surface/topography.jpg`);
  } catch (e) {
    topography = null; // fall back to flat colour rather than failing to boot
    // An <img> load failure rejects with a bare Event, which says nothing.
    missingLayers.push(`topography (${e instanceof Error ? e.message : 'surface/topography.jpg failed to load'})`);
  }

  let coastlineData = null;
  try {
    coastlineData = await fetchCoastlineData(
      ARCHIVE, archive.coastlines.geometry, archive.coastlines.rotations,
    );
  } catch (e) {
    coastlineData = null;
    missingLayers.push(`coastlines (${String(e)})`);
  }
  showMissingLayers(missingLayers);
  if (window.__geode) window.__geode.missingLayers = missingLayers;

  deps = {
    archiveBase: ARCHIVE,
    archive,
    colormaps,
    topography,
    coastlineData,
    boundariesUrl: archive.boundaries ? `${ARCHIVE}/${archive.boundaries}` : null,
  };
  defaultModelId = MANTLE_CONFIG.defaultModel;
  if (!archive.models.some((m) => m.id === defaultModelId)) {
    // A site that lists its Models must name a real default; this repo's own
    // dev and test Archives (no `models` list) may simply lack it.
    if (MANTLE_CONFIG.models) throw new Error(`defaultModel "${defaultModelId}" is not among the offered models`);
    defaultModelId = archive.models[0].id;
  }

  const first = createInstance('Globe 1');
  host.add(first);
  await first.boot(defaultModelId);
  updateCredit();
  if (MANTLE_CONFIG.defaultCamera) setCamera(MANTLE_CONFIG.defaultCamera);

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
    if ('outline' in o) inst.cutaway.outline.visible = o.outline;
    if ('handles' in o) inst.cutaway.handles.visible = o.handles;
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
