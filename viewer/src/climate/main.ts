import { Clock, Color, Vector2, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { lonLatToVec3 } from '../core/constants';
import { PALETTE } from '../core/palette';
import { fetchCoastlineData } from '../core/coastlines';
import { loadArchive, loadColormaps } from '../core/volume';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
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
//
// `camera`/`controls` are reassigned wholesale by setProjection() below, not
// reconfigured in place -- Globe and Plate Carrée need different camera
// types (perspective/orbit vs. orthographic/pan), see core/projection.ts and
// docs/adr/0003-plate-carree-as-first-alternate-projection.md.

let projectionMode: ProjectionMode = 'globe';
let camera: Camera = createProjectionCamera(projectionMode, innerWidth / innerHeight);

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(PALETTE.background));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls(projectionMode, camera, renderer.domElement);

/** Switch every globe on screen to `mode` at once -- Projection is global,
 *  never per-instance (see docs/adr/0003). Rebuilds the shared camera and
 *  controls, then hands the new camera to each live instance alongside its
 *  own geometry rebuild. */
function setProjection(mode: ProjectionMode): void {
  if (mode === projectionMode) return;
  projectionMode = mode;

  controls.dispose();
  camera = createProjectionCamera(mode, innerWidth / innerHeight);
  controls = createProjectionControls(mode, camera, renderer.domElement);

  for (const inst of host.instances) inst.setProjection(mode, camera);
}

// --- globe instances ---------------------------------------------------
//
// Instance bookkeeping (the array, tileGrid() relayout, focus, and the
// Synced Field broadcast registry) lives in core/multiInstanceHost.ts --
// see docs/adr/0022. What's left here is climate-specific: which fields
// are actually syncable (age, month -- see below), and side effects that
// only make sense for a Layer/Variable-bearing viewer (legend visibility,
// the projection toggle's single mount point).

const host = new MultiInstanceHost<ClimateInstance>(() => ({ width: innerWidth, height: innerHeight }));
let deps: ClimateInstanceDeps;
// Every registered model of type 'climate' (plural: unlike a single fixed
// climate simulation, `view.climateModelId` now lets each instance pick
// among them) -- see ClimateInstance.boot()'s own plural signature.
let climateModelIds: string[] = [];
let paleogeographyModelId = '';

// --- cross-globe sync ---------------------------------------------------
//
// Rotation/zoom are locked across every globe for free (one shared camera).
// Age and month are Synced Fields (see CONTEXT.md) -- each instance owns
// its own view state, so linking them is an explicit broadcast through the
// host. Layer, variable, clip range and wind style are deliberately NOT
// syncable (no toggle exists for them): the point of multiple globes is as
// much "compare two different things at the same time" (Temperature vs.
// Precipitation) as "compare the same thing at a different time," and only
// the latter needs linking.

/** Push `source`'s current age into every OTHER instance's own state. The
 *  one place this logic lives -- called from the UI callback (a real slider
 *  drag), from the test hook, from turning a sync flag on, and from a globe
 *  being added while a sync is active. */
function broadcastAge(source: ClimateInstance): void {
  host.broadcast('age', source, source.view.age, (inst, age) => {
    inst.applyAge(age);
    inst.ui.refreshDisplay();
  });
}

function broadcastMonth(source: ClimateInstance): void {
  host.broadcast('month', source, source.view.month, (inst, month) => {
    inst.applyMonth(month);
    inst.ui.refreshDisplay();
  });
}

/** When two or more globes show the SAME categorical variable at once
 *  (today: only Koppen -- every model that has one uses the identical
 *  class list and 'koppen' colormap, see prep_bridge.py's reuse of
 *  prep_climate.py's own compute_koppen()/KOPPEN_CLASS_NAMES), duplicate
 *  legends add nothing -- so only the FIRST such globe (in `instances`
 *  order, i.e. "Globe 1" before "Globe 2") keeps its legend; every other
 *  categorical-showing globe hides its own. Non-categorical legends are
 *  never touched. Recomputed from scratch on every call rather than
 *  tracking a delta -- cheap for a handful of globes, and self-correcting
 *  (a globe that stops showing Koppen, or is removed, un-hides whichever
 *  globe is now first without any extra bookkeeping). Called from
 *  ClimateInstance's onDisplayChange hook (variable/layer/climate-model
 *  changed) and from addInstance()/removeInstance() (the SET of globes
 *  itself changed). */
function refreshLegendVisibility(): void {
  let shownCategorical = false;
  for (const inst of host.instances) {
    const isCategorical = !!inst.variable?.categorical;
    const visible = !isCategorical || !shownCategorical;
    inst.ui.setLegendVisible(visible);
    if (isCategorical && visible) shownCategorical = true;
  }
}

function createInstance(label: string, startCollapsed = false): ClimateInstance {
  const inst = new ClimateInstance(camera, deps, {
    onRemove: (self) => removeInstance(self),
    onAgeChange: (self) => broadcastAge(self),
    onMonthChange: (self) => broadcastMonth(self),
    onDisplayChange: () => refreshLegendVisibility(),
  }, label, startCollapsed);
  // A new instance always starts in ClimateInstance's own default (Globe) --
  // sync it to whichever Projection is currently active so a globe added
  // mid-Plate-Carrée-session doesn't boot as a mismatched sphere under the
  // shared orthographic camera.
  inst.setProjection(projectionMode, camera);
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

function setSyncMonth(on: boolean): void {
  host.setSync('month', on);
  const cb = document.getElementById('sync-month') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  broadcastMonth(host.lastEditOrFocused('month')!);
}

document.getElementById('sync-age')?.addEventListener('change', (e) => {
  setSyncAge((e.target as HTMLInputElement).checked);
});
document.getElementById('sync-month')?.addEventListener('change', (e) => {
  setSyncMonth((e.target as HTMLInputElement).checked);
});

async function addInstance(): Promise<void> {
  // Collapsed by default -- see ClimateUI's own startCollapsed doc comment.
  const inst = createInstance(`Globe ${host.instances.length + 1}`, true);
  host.add(inst);
  try {
    await inst.boot(climateModelIds, paleogeographyModelId);
  } catch (e) {
    // Unlike the FIRST globe's boot() (main.ts's own top-level boot(),
    // caught below with a page-wide #error -- appropriate there, since
    // nothing else works either if that one fails), a later globe failing
    // shouldn't take the whole page down: every other instance is fine, and
    // this one's own panel is right there to say so. Left in place (not
    // auto-removed) so "remove this globe" still works and the failure
    // stays visible rather than silently vanishing.
    console.error(e);
    inst.ui.setStatus(`failed to load: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  // A globe added while a sync is active joins the synced group immediately,
  // rather than booting at age 0 / month 0 and waiting for the next drag
  // elsewhere to catch it up.
  broadcastAge(host.lastEditOrFocused('age')!);
  broadcastMonth(host.lastEditOrFocused('month')!);
}

function removeInstance(inst: ClimateInstance): void {
  if (!host.remove(inst)) return; // always leave one globe on screen
  // The removed globe fires no hook of its own -- if it was the one keeping
  // a categorical legend visible, the next-first categorical globe (if any)
  // needs to pick it back up explicitly.
  refreshLegendVisibility();
  // Same story for the projection toggle, if the removed globe was the one
  // hosting it (see the "projection toggle" section below) -- dispose()
  // already detached it from the DOM entirely, so it needs a new home
  // regardless of whether idx happened to be 0.
  if (projectionToggle) primary().ui.mountProjectionToggle(projectionToggle);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  host.relayout();
});

document.getElementById('add-globe')?.addEventListener('click', () => {
  void addInstance();
});

// Collapsed by default -- see climate.html's own #globe-menu-toggle/
// #globe-menu CSS doc comment. Toggle-only (no outside-click auto-close):
// unlike index.html's "Start Here" presets menu, which closes itself the
// moment a preset is picked (a one-shot action), this menu's own controls
// (sync checkboxes) are meant to stay adjustable, so slamming it shut after
// every click would fight the user rather than help them.
document.getElementById('globe-menu-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('globe-menu');
  if (menu) menu.hidden = !menu.hidden;
});

// --- projection toggle -----------------------------------------------------
//
// One global control (see docs/adr/0003), not part of any instance's own
// ClimateUI panel -- ClimateUI is per-instance, but Projection applies to
// every globe on screen at once, like the shared camera it rides on. The
// single DOM node still lives here, but is physically mounted (not cloned)
// into whichever instance is currently "primary"'s own bottom bar, as its
// own standalone circle beside (not inside) the age-slider box -- see
// ClimateUI.mountProjectionToggle(). Re-mounted in boot() (first instance)
// and removeInstance() (primary may change).

const projectionToggle = document.getElementById('projection-toggle');

// Small inline sketches (graticule only -- no landmass shapes, since a
// stylised continent reads as a claim about geography this icon isn't
// making), not plain geometric glyphs either (a bare circle/rectangle
// character reads as unrelated to "map projection"). The icon swap below
// still encodes the click TARGET, just with each shape looking like a
// gridded globe/map rather than a random glyph.
const PROJECTION_ICON_GLOBE = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9"/>
  <ellipse cx="12" cy="12" rx="4" ry="9"/>
  <path d="M3 12h18"/>
  <path d="M4.5 7.5c4 2 10.5 2 14.5 0"/>
  <path d="M4.5 16.5c4-2 10.5-2 14.5 0"/>
</svg>`.trim();
const PROJECTION_ICON_FLAT = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="1.5"/>
  <path d="M3 10h18"/>
  <path d="M3 14h18"/>
  <path d="M9 6v12"/>
  <path d="M15 6v12"/>
</svg>`.trim();

function updateProjectionToggle(): void {
  if (!projectionToggle) return;
  const flat = projectionMode === 'plateCarree';
  // The icon shows what clicking switches TO, not the current shape --
  // flat now means the click target is Globe, so the icon is a globe.
  projectionToggle.innerHTML = flat ? PROJECTION_ICON_GLOBE : PROJECTION_ICON_FLAT;
  const label = flat ? 'Switch to Globe projection' : 'Switch to Plate Carrée projection';
  projectionToggle.setAttribute('aria-label', label);
  projectionToggle.setAttribute('title', label);
}
// Paint the real icon immediately -- climate.html's static markup only has
// a placeholder glyph so the button isn't empty before this module runs.
updateProjectionToggle();

projectionToggle?.addEventListener('click', () => {
  setProjection(projectionMode === 'globe' ? 'plateCarree' : 'globe');
  updateProjectionToggle();
});

// --- interaction ---------------------------------------------------------
//
// The camera and canvas are shared. Unlike tomography there is no
// per-instance TOOL state competing with OrbitControls for the same drag
// gesture (no cutaway drawing here) -- OrbitControls owns ordinary pointer
// interaction with nothing to fight it EXCEPT the one exception below:
// shift-click, Anchored Point's Month Profile query (see
// ClimateInstance.queryMonthProfileAt(), docs/plans/anchored-point-query.md).
// That gesture needs a tile hit AND that tile's own NDC, unlike the old
// click-just-to-focus-a-tile behaviour, which only needed the former.

function hitTest(clientX: number, clientY: number): { inst: ClimateInstance; rect: Rect } | null {
  for (let i = 0; i < host.instances.length; i++) {
    const r = host.layoutRects[i];
    if (r && clientX >= r.x && clientX < r.x + r.width
      && clientY >= r.y && clientY < r.y + r.height) {
      return { inst: host.instances[i], rect: r };
    }
  }
  return null;
}

/** NDC for a point, relative to one tile rather than the whole window --
 *  mirrors tomography/main.ts's own ndcFor(). */
const ptr = new Vector2();
function ndcFor(rect: Rect, clientX: number, clientY: number): Vector2 {
  ptr.x = ((clientX - rect.x) / rect.width) * 2 - 1;
  ptr.y = -((clientY - rect.y) / rect.height) * 2 + 1;
  return ptr;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hit) host.focused = hit.inst;
  // Shift owns this gesture entirely -- disable orbiting for its duration
  // so a shift-drag can't ALSO spin the globe underneath the query. No
  // movement threshold needed to tell a shift-click from a shift-drag: with
  // orbiting off, nothing competes for the gesture either way (unlike
  // tomography's tool modes, which need to keep dragging live).
  if (ev.shiftKey) controls.enabled = false;
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  controls.enabled = true; // unconditional: a shift-release mid-drag must not wedge orbiting off
  if (!ev.shiftKey) return;
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  // The shared camera's aspect is left matching whichever tile animate()
  // rendered last -- same reasoning as tomography's own focusCameraOn().
  updateProjectionCameraAspect(camera, hit.rect.width / hit.rect.height);
  void hit.inst.queryMonthProfileAt(ndcFor(hit.rect, ev.clientX, ev.clientY), ev.clientX, ev.clientY);
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

  // 'climate-monthly' (Valdes/BRIDGE's Atmosphere Layer -- see docs/adr/0008)
  // is included here alongside the plain 'climate' type: that ADR moved
  // Valdes/BRIDGE to its own dedicated instance (valdes.html) specifically
  // because its NEW ocean-depth fields don't fit this viewer's month axis --
  // but its ORIGINAL month-indexed atmosphere fields (T, P, MSLP, sea ice,
  // wind) always did, and removing them from here entirely (rather than just
  // the genuinely incompatible ocean-depth Layer) went further than that
  // ADR's own reasoning required. 'climate-ocean-depth' stays valdes.html-only
  // -- annual-mean, real-depth data has no Month axis for THIS viewer's UI to
  // drive at all.
  const climateModels = archive.models
    .filter((m) => m.type === 'climate' || m.type === 'climate-monthly')
    .map((m) => m.id);
  const paleogeographyModel = archive.models.find((m) => m.type === 'paleogeography')?.id;
  if (climateModels.length === 0) throw new Error('archive.json has no model of type "climate"');
  if (!paleogeographyModel) throw new Error('archive.json has no model of type "paleogeography"');
  climateModelIds = climateModels;
  paleogeographyModelId = paleogeographyModel;

  const first = createInstance('Globe 1');
  host.add(first);
  if (projectionToggle) first.ui.mountProjectionToggle(projectionToggle);
  await first.boot(climateModelIds, paleogeographyModelId);

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

function primary(): ClimateInstance { return host.instances[0]; }

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
  setClimateModel: async (id: string) => {
    const inst = primary();
    await inst.setClimateModel(id);
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
  removeGlobe: (index = host.instances.length - 1) => {
    const inst = host.instances[index];
    if (inst) removeInstance(inst);
  },
  globeCount: () => host.instances.length,
  setSyncAge,
  setSyncMonth,
  getSyncState: () => ({ syncAge: host.isSynced('age'), syncMonth: host.isSynced('month') }),
  /** Apply age/month to a SPECIFIC instance, not just primary() -- needed to
   *  test whether an edit on globe 2 does/doesn't propagate to globe 1.
   *  Broadcasts exactly like a real slider drag would, via the same
   *  broadcastAge()/broadcastMonth() the UI callback uses. */
  setAgeOn: (index: number, age: number) => {
    const inst = host.instances[index];
    inst.applyAge(age);
    inst.ui.refreshDisplay();
    broadcastAge(inst);
  },
  setMonthOn: (index: number, month: number) => {
    const inst = host.instances[index];
    inst.applyMonth(month);
    inst.ui.refreshDisplay();
    broadcastMonth(inst);
  },
  setClimateModelOn: async (index: number, id: string) => {
    const inst = host.instances[index];
    await inst.setClimateModel(id);
    inst.ui.refreshDisplay();
  },
  setVariableOn: async (index: number, id: string) => {
    const inst = host.instances[index];
    await inst.setVariable(id);
    inst.ui.refreshDisplay();
  },
  climateModelIds: () => climateModelIds,
  instanceState: (index: number) => {
    const inst = host.instances[index];
    return {
      age: inst.view.age, month: inst.view.month, layer: inst.view.layer,
      climateModelId: inst.view.climateModelId,
    };
  },
  stats: () => {
    const inst = primary();
    return {
      model: inst.manifest?.id,
      layer: inst.layer,
      climateModelId: inst.view.climateModelId,
      variable: inst.variable?.id,
      age: inst.view.age,
      month: inst.view.month,
      clip: [inst.view.clipMin, inst.view.clipMax],
      overlayOpacity: inst.view.overlayOpacity,
      showWind: inst.view.showWind,
      windStyle: inst.view.windStyle,
      windScale: inst.view.windScale,
      windDensity: inst.view.windDensity,
      globeCount: host.instances.length,
    };
  },
};

const clock = new Clock();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  renderer.setScissorTest(host.instances.length > 1);
  const dt = clock.getDelta();
  for (let i = 0; i < host.instances.length; i++) {
    const rect = host.layoutRects[i];
    if (!rect) continue;
    updateProjectionCameraAspect(camera, rect.width / rect.height);
    // three.js scales viewport/scissor by devicePixelRatio itself, the same
    // way it treats setSize -- these are CSS pixels, like the rect.
    const glY = innerHeight - rect.y - rect.height;
    renderer.setViewport(rect.x, glY, rect.width, rect.height);
    renderer.setScissor(rect.x, glY, rect.width, rect.height);
    host.instances[i].tick(dt);
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
