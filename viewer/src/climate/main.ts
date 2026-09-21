import { Clock, Color, Vector2, WebGLRenderer, type Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { lonLatToVec3 } from '../core/constants';
import { DEFAULT_THEME, resolveTheme } from '../core/theme';
import { fetchCoastlineData } from '../core/coastlines';
import { loadStaticPolygonDataFor } from '../core/staticPolygons';
import { loadPaleolithologyUrlFor } from '../core/pointOverlay';
import { loadArchive, loadColormaps } from '../core/volume';
import type { Rect } from '../core/layout';
import { MultiInstanceHost } from '../core/multiInstanceHost';
import {
  createProjectionCamera, createProjectionControls, updateProjectionCameraAspect,
  type ProjectionMode,
} from '../core/projection';
import { wireProjectionToggle } from '../core/projectionToggle';
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
// Themes are not yet wired into this wrapper's UI -- it boots on the
// default Theme's page colour. See docs/adr/0038 for the intended
// always-present control, and themelab/ for the built one.
renderer.setClearColor(new Color(resolveTheme(DEFAULT_THEME).page));
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

document.getElementById('hint-toggle')?.addEventListener('click', () => {
  const hint = document.getElementById('hint');
  if (hint) hint.hidden = !hint.hidden;
});

// --- presets -------------------------------------------------------------
//
// "Start Here" menu, same convention as index.html/tomography/main.ts: each
// preset drives the same public instance API a user action would
// (setClimateModel/setVariable/setWindVisible/applyAge), so it can never
// leave state a manual click couldn't also produce.

document.getElementById('preset-toggle')?.addEventListener('click', () => {
  const menu = document.getElementById('presets');
  if (menu) menu.hidden = !menu.hidden;
});

function hidePresetsMenu(): void {
  const menu = document.getElementById('presets');
  if (menu) menu.hidden = true;
}

/** Preset 1: a single globe on the Li et al. 2022 model, showing
 *  precipitation with animated wind streaks at density 2.5, reconstructed to
 *  250 Ma. */
async function applyPresetWindStreaks(): Promise<void> {
  while (host.instances.length > 1) removeInstance(host.instances[host.instances.length - 1]);
  const inst = host.instances[0];
  host.focused = inst;

  const model = deps.archive.models.find((m) => m.id === 'climate-540myr');
  if (model) await inst.setClimateModel(model.id);
  await inst.setVariable('P');
  inst.setWindVisible(true);
  inst.setWindStyle('streak');
  inst.setWindDensity(2.5);
  inst.applyAge(250);
  inst.ui.refreshDisplay();
}

/** Preset 2: one globe per climate-family model (Li, Pohl, Valdes/BRIDGE),
 *  each showing the Koppen classification, side by side for comparison. */
async function applyPresetKoppenComparison(): Promise<void> {
  const wantedIds = ['climate-540myr', 'climate-pohl2022', 'bridge-valdes2021-monthly'];
  const models = wantedIds
    .map((id) => deps.archive.models.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m);
  if (models.length === 0) return;

  while (host.instances.length > models.length) removeInstance(host.instances[host.instances.length - 1]);
  while (host.instances.length < models.length) await addInstance();
  host.relayout();

  for (let i = 0; i < models.length; i++) {
    const inst = host.instances[i];
    await inst.setClimateModel(models[i].id);
    await inst.setVariable('KOPPEN');
    // Wind and age are orthogonal to a Koppen-zone comparison -- a wind
    // overlay or an age left over from an earlier preset (e.g. the Wind
    // Streaks preset's 250 Ma) would clutter the map and put the three
    // globes at mismatched times, defeating the side-by-side comparison this
    // preset is for. Reset both so every globe starts from the same,
    // uncluttered present-day view.
    inst.setWindVisible(false);
    inst.applyAge(0);
    inst.ui.refreshDisplay();
  }
  host.focused = host.instances[0];
  // Synced AFTER every globe already has age/month set to the same value
  // above -- setSyncAge/setSyncMonth immediately broadcast the focused
  // instance's CURRENT value to the others, so turning sync on first would
  // push a still-mid-preset value from a half-configured globe onto the
  // rest. A Koppen-zone comparison is only meaningful with every globe
  // looking at the same moment in time, so both are on by default here
  // (unlike the Wind Streaks preset, a single globe with nothing to sync).
  setSyncAge(true);
  setSyncMonth(true);
}

document.getElementById('preset-wind-streaks')?.addEventListener('click', () => {
  if (!deps) return; // still booting; the first globe isn't up yet
  hidePresetsMenu();
  void applyPresetWindStreaks();
});

document.getElementById('preset-koppen-comparison')?.addEventListener('click', () => {
  if (!deps) return;
  hidePresetsMenu();
  void applyPresetKoppenComparison();
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

// One cycling button over every Projection in PROJECTION_ORDER, shared with
// Valdes -- see core/projectionToggle.ts for the icons and why this stopped
// being a two-state toggle written out per wrapper.
const refreshProjectionToggle = wireProjectionToggle(
  projectionToggle,
  () => projectionMode,
  (mode) => setProjection(mode),
);

// --- interaction ---------------------------------------------------------
//
// The camera and canvas are shared. Unlike tomography there is no
// per-instance TOOL state competing with OrbitControls for the same drag
// gesture (no cutaway drawing here) -- OrbitControls owns ordinary pointer
// interaction with nothing to fight it EXCEPT two exceptions below:
// shift-click, dispatched by ClimateInstance.queryAt() to either Anchored
// Point's Month Profile query (queryMonthProfileAt(),
// docs/plans/anchored-point-query.md) or Plate-Frame Point
// (queryPlateFramePointAt(), docs/adr/0025, docs/adr/0026) depending on the
// instance's own `view.queryMode`; and alt-click, dispatched to
// ClimateInstance.addTrackedParticleAt() (docs/plans/tracked-particle-
// seeding.md). Alt was picked specifically because Shift is already taken
// by the query gesture -- reusing it would make one modifier mean two
// different things, the exact collision ADR-0016 avoided once already for
// Anchored Point vs. tomography's own Ctrl/Cmd convention. Both gestures
// need a tile hit AND that tile's own NDC, unlike the old
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
  // Shift/Alt each own their gesture entirely -- disable orbiting for its
  // duration so a modifier-drag can't ALSO spin the globe underneath the
  // query/seed. No movement threshold needed to tell a click from a drag:
  // with orbiting off, nothing competes for the gesture either way (unlike
  // tomography's tool modes, which need to keep dragging live).
  if (ev.shiftKey || ev.altKey) controls.enabled = false;
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  controls.enabled = true; // unconditional: a modifier release mid-drag must not wedge orbiting off
  if (!ev.shiftKey && !ev.altKey) return;
  const hit = hitTest(ev.clientX, ev.clientY);
  if (!hit) return;
  // The shared camera's aspect is left matching whichever tile animate()
  // rendered last -- same reasoning as tomography's own focusCameraOn().
  updateProjectionCameraAspect(camera, hit.rect.width / hit.rect.height);
  if (ev.altKey) void hit.inst.addTrackedParticleAt(ndcFor(hit.rect, ev.clientX, ev.clientY));
  else void hit.inst.queryAt(ndcFor(hit.rect, ev.clientX, ev.clientY));
});

/** A Boucot point's own metadata fields (see prep_boucot.py's `fields=`) --
 *  loosely typed since PointOverlay.pick() is generic over any point
 *  dataset's schema (core/pointOverlay.ts), not just this one. */
interface BoucotPoint { type: string; indicator?: string; from?: number; to?: number }

function paleolithologyTooltipLines(p: BoucotPoint): string[] {
  const lines = [p.indicator ?? p.type];
  if (p.from != null && p.to != null) lines.push(`${p.to.toFixed(0)}–${p.from.toFixed(0)} Ma`);
  return lines;
}

// Boucot paleolithology hover: a passive gesture (no modifier, doesn't
// compete with orbit/pan) -- unlike shift-click/alt-click above, this runs on
// every pointer move regardless of button state. Tracks `hoveredInstance` so
// moving off a tile (or off any point within it) clears exactly the ring
// highlight/tooltip/fan it set, never a stale one left on some OTHER instance.
//
// Spiderfy timing mirrors petrify's own hover.js reference
// implementation (`considerFan`) -- not reused directly (its
// getBoundingClientRect()-based coordinate frame doesn't fit Multi-Globe's
// shared-canvas/per-tile-rect layout), but the same two ideas are load-
// bearing, not optional: firing instantly made a dense pile flicker open/
// closed within the same cluster on every sub-pixel jiggle of the pointer --
// see [[geode_boucot_paleolithology]].
//   - a DWELL before opening: most pointer positions on a dense map are near
//     *some* pile, so opening immediately churns the map apart and back
//     together continuously as the pointer sweeps across it.
//   - a KEEP RADIUS once open, well past pick()'s own hit radius: closing at
//     the same boundary that opened it flickers the instant the pointer sits
//     near that boundary. The fan should survive until the pointer strays
//     comfortably clear of it, or lands on a point outside it.
let hoveredInstance: ClimateInstance | null = null;
let dwellTimer: ReturnType<typeof setTimeout> | null = null;
let fanInstance: ClimateInstance | null = null;
let fanAnchor: [number, number] | null = null;
let fanReach = 0;

const SPIDERFY_DWELL_MS = 150;
const SPIDERFY_KEEP_PADDING = 26;

function cancelDwell(): void {
  if (dwellTimer !== null) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
}

function closeFan(): void {
  cancelDwell();
  if (fanInstance) {
    fanInstance.paleolithology.unspiderfy();
    fanInstance = null;
  }
  fanAnchor = null;
}

function openFan(inst: ClimateInstance, x: number, y: number): void {
  const n = inst.paleolithology.spiderfy(x, y);
  if (!n) return;
  fanInstance = inst;
  fanAnchor = [x, y];
  fanReach = inst.paleolithology.spiderExtent() + SPIDERFY_KEEP_PADDING;
}

/** Decide what the open fan (if any) should do about this pointer position,
 *  and arm the dwell for a new one -- see the block comment above. */
function considerFan(inst: ClimateInstance, x: number, y: number, pickedIndex: number | null): void {
  if (fanInstance === inst && fanAnchor) {
    const members = inst.paleolithology.spiderfied;
    const onMember = !!(members && pickedIndex !== null && members.includes(pickedIndex));
    // Working inside the fan: stay open, whatever pick() returned exactly --
    // this is the whole reason for the keep radius.
    if (onMember) return;

    const strayed = Math.hypot(x - fanAnchor[0], y - fanAnchor[1]) > fanReach;
    // Inside the keep radius but over nothing in particular: still hovering
    // the fan's own space, so leave it alone.
    if (!strayed && pickedIndex === null) return;

    // Pointer wandered off, or landed on a point this fan doesn't own.
    closeFan();
    // Fall through so whatever pile is now under the pointer can arm its own
    // dwell immediately, rather than waiting for the next pointer move.
  } else if (fanInstance && fanInstance !== inst) {
    closeFan();
  }

  cancelDwell();
  // Only arm where there is actually a pile -- avoids a timer per pointer
  // move across empty ocean.
  if (inst.paleolithology.clusterSizeAt(x, y) < 2) return;
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    openFan(inst, x, y);
  }, SPIDERFY_DWELL_MS);
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  const hit = hitTest(ev.clientX, ev.clientY);
  if (hoveredInstance && hoveredInstance !== hit?.inst) {
    closeFan();
    hoveredInstance.paleolithology.highlight(null);
    hoveredInstance.ui.hidePointTooltip();
    hoveredInstance = null;
  }
  if (!hit) return;

  const localX = ev.clientX - hit.rect.x;
  const localY = ev.clientY - hit.rect.y;
  const overlay = hit.inst.paleolithology;
  const picked = overlay.pick(localX, localY);

  considerFan(hit.inst, localX, localY, picked ? picked.index : null);

  overlay.highlight(picked ? picked.index : null);
  if (picked) {
    hoveredInstance = hit.inst;
    hit.inst.ui.showPointTooltip(ev.clientX, ev.clientY, paleolithologyTooltipLines(picked.point as BoucotPoint));
  } else {
    hit.inst.ui.hidePointTooltip();
    hoveredInstance = null;
  }
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

  // Plate-Frame Point's data source (docs/adr/0025/0026) -- every
  // climate-family Manifest type resolves to the same Scotese Reconstruction
  // Model, so a single lookup keyed on `type: 'climate'` covers every
  // instance and every registered climate model alike; see
  // resolveStaticPolygonReconstructionId()'s own doc comment for why this is
  // a type-based switch rather than a per-Model declared field. A mode, not
  // a prerequisite -- Plate-Frame Point just stays unavailable if this fails.
  let staticPolygonData = null;
  try {
    staticPolygonData = await loadStaticPolygonDataFor(ARCHIVE, archive, { type: 'climate' });
  } catch (e) {
    console.error(e);
    staticPolygonData = null;
  }

  // Boucot, Chen & Scotese (2013) paleolithology points (see prep_boucot.py) --
  // same "a layer, not a prerequisite" tolerance as staticPolygonData above.
  let paleolithologyUrl: string | null = null;
  try {
    paleolithologyUrl = await loadPaleolithologyUrlFor(ARCHIVE, archive, { type: 'climate' });
  } catch (e) {
    console.error(e);
    paleolithologyUrl = null;
  }

  deps = {
    archiveBase: ARCHIVE, archive, colormaps, coastlineData, staticPolygonData, paleolithologyUrl,
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
  // Drives the same path the button does, and repaints it afterwards -- a
  // screenshot check can't click through a cycle to reach the third
  // Projection, and a hook that set the mode without refreshing the icon
  // would leave the button describing the wrong next step.
  setProjection: (mode: ProjectionMode) => {
    setProjection(mode);
    refreshProjectionToggle();
  },
  getProjection: () => projectionMode,
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
  /** Bypasses the alt-click raycast entirely -- seeds a Tracked Particle
   *  directly at a given lon/lat, for verification scripts that can't
   *  easily simulate a real pointer gesture against a specific globe pixel. */
  addTrackedParticle: (lon: number, lat: number) => {
    primary().trackedParticles.add({ lon, lat });
  },
  clearTrackedParticles: () => primary().clearTrackedParticles(),
  trackedParticleCount: () => primary().trackedParticles.count,
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
