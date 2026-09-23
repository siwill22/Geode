import { type Camera, type PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { Graticule } from '../core/graticule';
import { resolveTheme } from '../core/theme';
import { createMaskTexture } from '../core/mask';
import { BoundaryOverlay } from '../core/boundaries';
import { PointOverlay, resolvePaleomagPoleSetFor } from '../core/pointOverlay';
import {
  GAPWAP_PATH_COLOR, GAPWAP_PATH_WIDTH, poleStyle, siteStyle,
} from '../core/paleomagPalette';
import { reconstructionAssetPath, reconstructionAssetUrl } from '../core/reconstructions';
import { isFlat, type ProjectionMode } from '../core/projection';
import type { Quaternion } from '../core/rotation';
import type { ArchiveIndex, ReconstructionManifest } from '../core/types';
import type { Rect } from '../core/layout';
import type { PaleomagSampleRecord } from '../core/paleomagPalette';
import { ReconstructionUI, type LandColorMode, type ReconstructionViewState } from './reconstructionUi';


export interface ReconstructionInstanceDeps {
  archiveBase: string;
  archive: ArchiveIndex;
  manifest: ReconstructionManifest;
  title: string;
}

/** See globe/globeInstance.ts's GlobeInstanceHooks -- identical reasoning
 *  (no onFocus, Reconstruction Age is the only Synced Field this wrapper
 *  type offers). */
export interface ReconstructionInstanceHooks {
  onRemove(self: ReconstructionInstance): void;
  onAgeChange?(self: ReconstructionInstance, age: number): void;
  /** A sample site or VGP was clicked (`record`), or a click landed on
   *  neither and the previous selection should be cleared (`null`) -- see
   *  `selectSampleAt()`. `citation` is the whole pole DATASET's citation
   *  (no per-record citation exists, see PaleomagSampleRecord's own doc
   *  comment), passed alongside since the popup needs it but this instance
   *  otherwise has no reason to hold onto it past boot(). */
  onSelectSample?(
    self: ReconstructionInstance, record: PaleomagSampleRecord | null, citation: string,
  ): void;
}

/**
 * One globe showing exactly one Reconstruction Model's own geometry --
 * coastlines always, Boundary Frames when the model has them (see
 * docs/adr/0019). Never a numerical field (docs/adr/0020) -- this is the
 * `single-reconstruction-globe` wrapper, the reconstruction-only sibling of
 * globe/globeInstance.ts (which shows exactly one numerical Model instead).
 */
export class ReconstructionInstance {
  readonly scene = new Scene();
  readonly ui: ReconstructionUI;
  readonly boundaries: BoundaryOverlay;
  /** Paleomagnetic poles (VGPs) and the modelled GAPWaP path built from them
   *  -- see docs/plans/paleomagnetic-poles.md, ADR-0029. Two PointOverlays,
   *  not one: a pole marker (dot + A95 ring, 'window' lifespan) and a path
   *  vertex (connected line, 'since' lifespan) are different `PointLayer`
   *  option sets on the same generic overlay class -- both toggle together
   *  off the single "Paleomagnetic poles" control (see onShowPaleomagPoles).
   *  Always constructed (same reasoning as `boundaries`); `.load()` in
   *  boot() only if this model has an export -- never every model does
   *  (ADR-0025's static-polygon limitation) -- and an unloaded PointOverlay's
   *  draw()/setTime() are no-ops, so no extra null-guarding is needed here. */
  readonly poles: PointOverlay;
  readonly gapwapPath: PointOverlay;
  /** Sample Site markers -- the real-world outcrop each VGP in `poles` was
   *  measured from, built from the SAME loaded records at the SAME array
   *  index (see `boot()`), just repositioned to `sample_lon`/`sample_lat`.
   *  That shared indexing is what makes `selectSampleAt()`'s "click a site,
   *  highlight its VGP" a direct index lookup rather than a search. */
  readonly sites: PointOverlay;
  /** The pole dataset's own citation (no per-record citation exists -- see
   *  PaleomagSampleRecord's doc comment) -- captured in boot() so
   *  `selectSampleAt()` can hand it to `onSelectSample` without the caller
   *  needing to look it up separately via `resolvePaleomagPoleSetFor()`
   *  again. */
  private poleSetCitation = '';
  /** plate_id set for Land Colour's "By plate" mode -- see
   *  Coastlines.setLandColorMode()'s own `platesWithData` field doc comment
   *  ("only give colour to polygons that ever have data"). Empty (not just
   *  unset) when there's no pole set at all, which correctly greys out
   *  every plate rather than colouring all of them. */
  private platesWithData: Set<number> = new Set();
  /** A solid ocean, always present: continents previously sat straight on
   *  the page colour, so the globe read as a cut-out and the far
   *  hemisphere's coastlines showed through. */
  readonly ocean = new OceanSurface('globe');
  /** A fixed lon/lat reference grid, in the same world frame as coastlines
   *  and the paleomagnetic overlay -- see core/graticule.ts. Never rotates
   *  with reconstruction age; its whole point is to show where the FIXED
   *  geographic south pole sits regardless of how continents have drifted. */
  readonly graticule = new Graticule();
  /** Built in boot() once the geometry has been fetched -- every
   *  Reconstruction Model has coastlines (unlike Boundary Frames, never
   *  optional), so this is always assigned before any other method runs. */
  coastlines!: Coastlines;

  /** This instance's own record of the last Projection/Map Orientation
   *  main.ts told it about (see CONTEXT.md's Map Orientation entry) --
   *  Projection is global, never per-instance (docs/adr/0003), so main.ts
   *  is the source of truth; these exist only so boot() can hand a freshly-
   *  constructed layer set the CURRENT ambient state rather than leaving it
   *  at Coastlines/etc.'s own internal default (globe, identity) until the
   *  next explicit switch. */
  private projectionMode: ProjectionMode = 'globe';
  private qOrient: Quaternion = [0, 0, 0, 1];

  readonly view: ReconstructionViewState = {
    age: 0, showBoundaries: true, showPaleomagPoles: true, landColorMode: 'theme',
  };

  get manifest(): ReconstructionManifest { return this.deps.manifest; }

  constructor(
    private camera: Camera,
    private readonly deps: ReconstructionInstanceDeps,
    private readonly hooks: ReconstructionInstanceHooks,
  ) {
    this.boundaries = new BoundaryOverlay(camera as PerspectiveCamera);
    this.poles = new PointOverlay(camera);
    this.gapwapPath = new PointOverlay(camera);
    this.sites = new PointOverlay(camera);

    this.ui = new ReconstructionUI(this.view, {
      onAge: (age) => { this.applyAge(age); this.hooks.onAgeChange?.(this, age); },
      onShowBoundaries: (show) => { this.boundaries.visible = show; },
      onShowPaleomagPoles: (show) => {
        this.poles.visible = show;
        this.gapwapPath.visible = show;
        this.sites.visible = show;
      },
      onLandColorMode: (mode) => this.setLandColorMode(mode),
    }, deps.title, () => this.hooks.onRemove(this));
  }

  async boot(): Promise<void> {
    this.ui.setStatus('loading...');
    const m = this.deps.manifest;

    const data = await fetchCoastlineData(
      this.deps.archiveBase,
      reconstructionAssetPath(m, m.coastlines.geometry),
      reconstructionAssetPath(m, m.coastlines.rotations),
    );
    const maskTexture = createMaskTexture();
    // Default land radius, not LAND_R_UNDER_SURFACE: there is an opaque
    // ocean at R_SURFACE now, and land beneath it would be inside the
    // sphere. Land colour comes from the Theme rather than a local grey.
    this.coastlines = new Coastlines(data.lines, data.table, maskTexture);
    this.coastlines.setMaskEnabled(false);
    this.coastlines.landVisible = true;
    this.scene.add(
      this.ocean.mesh, this.coastlines.lines, this.coastlines.land, this.graticule.lines,
    );
    // No Theme control in this wrapper yet (docs/adr/0038 wants one). Fixed
    // to 'graphite' rather than the family DEFAULT_THEME ('abyssal'): this
    // page's whole point is the paleomagnetic pole/path overlay, and
    // graphite's own description is exactly the property that needs --
    // "neutral dark greys with no colour cast at all, so a painted field is
    // the only hue on screen."
    const theme = resolveTheme('graphite');
    this.graticule.applyTheme(theme);
    this.ocean.applyTheme(theme);
    this.coastlines.applyTheme(theme);
    // Boundaries too, or they keep the pre-Theme black subduction stroke --
    // which was already weak on a black page and is invisible against a solid
    // ocean. Safe to call before load(): BoundaryOverlay holds it as
    // pendingTheme and applies it when the frames arrive.
    this.boundaries.applyTheme(theme);

    this.view.age = m.age_min;
    this.ui.setAgeRange(m.age_min, m.age_max);

    if (m.has_boundaries && m.boundaries) {
      await this.boundaries.load(reconstructionAssetUrl(this.deps.archiveBase, m, m.boundaries));
    }
    this.ui.setBoundariesAvailable(m.has_boundaries);
    this.boundaries.visible = m.has_boundaries;

    // Paleomagnetic poles (VGPs) + the modelled GAPWaP path -- see
    // docs/plans/paleomagnetic-poles.md, ADR-0029. Not every model has an
    // export (ADR-0025's static-polygon limitation), so this toggle is
    // added/removed exactly like setBoundariesAvailable() above.
    const poleSet = resolvePaleomagPoleSetFor(this.deps.archive, m);
    if (poleSet) {
      await this.poles.load(`${this.deps.archiveBase}/${poleSet.points}`, {
        lifespan: 'window',
        ageWindow: 5,
        style: poleStyle,
      });
      this.poleSetCitation = poleSet.dataset.citation;
      // Sample Site markers: the SAME records `poles` just loaded, at the
      // SAME array index, repositioned to sample_lon/sample_lat -- see this
      // class's own `sites` field doc comment. Built from the already-
      // fetched payload (PointOverlay.payload()) rather than a second
      // fetch of poleSet.points.
      const payload = this.poles.payload();
      if (payload) {
        // Not age-filtered, unlike recomputeLandVgpCounts()'s counts -- "By
        // plate" greys out a plate with literally no VGP anywhere in the
        // dataset, not merely none in the CURRENT age window.
        this.platesWithData = new Set(payload.points.map((p) => p.plate_id as number));
        const sitePoints = payload.points.map((p) => ({
          ...p, lon: p.sample_lon, lat: p.sample_lat,
        }));
        this.sites.loadData({ ...payload, points: sitePoints }, {
          lifespan: 'window',
          ageWindow: 5,
          style: siteStyle,
        });
      }
      if (poleSet.path) {
        await this.gapwapPath.load(`${this.deps.archiveBase}/${poleSet.path}`, {
          lifespan: 'since',
          connectLive: true,
          connectWidth: GAPWAP_PATH_WIDTH,
          style: () => ({ fill: GAPWAP_PATH_COLOR }),
        });
      }
    }
    this.ui.setPaleomagPolesAvailable(poleSet != null);
    this.poles.visible = poleSet != null;
    this.gapwapPath.visible = poleSet?.path != null;
    this.sites.visible = poleSet != null;

    this.coastlines.setAge(this.view.age);
    await this.boundaries.setAge(this.view.age);
    this.poles.setTime(this.view.age);
    this.gapwapPath.setTime(this.view.age);
    this.sites.setTime(this.view.age);
    this.ui.setAge(this.view.age);
    this.ui.setCredit(`${m.name} -- ${m.citation}`);
    this.ui.setStatus('');

    // Reconcile the layers just built (at Coastlines/etc.'s own default:
    // globe, identity orientation) to whatever Projection/Map Orientation is
    // already ambient -- e.g. a globe added via Multi-Globe after the page
    // was already switched to Robinson. main.ts calls setProjection()/
    // setOrientation() again right after this resolves with the CURRENT
    // values (this is only ever non-default the very first time through, at
    // construction; see this class's own field doc comments), so this is
    // never wrong, only sometimes redundant.
    this.setProjection(this.projectionMode, this.camera);
    this.setOrientation(this.qOrient);
  }

  /** Switch this globe's Projection -- always called from main.ts for every
   *  instance at once, alongside the shared camera it just built for `mode`
   *  (docs/adr/0003: Globe and a flat Projection need different camera
   *  types, so main.ts always replaces the camera object wholesale). */
  setProjection(mode: ProjectionMode, camera: Camera): void {
    this.camera = camera;
    this.projectionMode = mode;
    this.coastlines.setProjection(mode);
    this.ocean.setProjection(mode);
    this.graticule.setProjection(mode);
    this.boundaries.setCamera(camera, mode);
    this.poles.setCamera(camera, mode);
    this.gapwapPath.setCamera(camera, mode);
    this.sites.setCamera(camera, mode);
    // boundaries/poles/gapwapPath's setReferenceRotation() also targets
    // their GLOBE projector unconditionally (it's the same generic method
    // Reference Plate uses elsewhere, where that's wanted -- see its own
    // doc comment). Map Orientation must NOT reach Globe mode's rendering
    // (Globe already free-orbits via OrbitControls and has no "off-centre"
    // concept), so switching mode re-applies the gated rotation rather than
    // leaving the globe projector holding whatever qOrient was last set
    // while flat -- see applyReferenceRotation()'s own doc comment.
    this.applyReferenceRotation();
  }

  /** Change Map Orientation's centre/roll rotation -- see CONTEXT.md's Map
   *  Orientation entry. `q` is GEOGRAPHIC frame throughout (see
   *  rotation.ts's `orientationQuaternion()`); each layer converts to
   *  whatever frame ITS OWN projector needs internally. */
  setOrientation(q: Quaternion): void {
    this.qOrient = q;
    this.coastlines.setOrientation(q);
    this.graticule.setOrientation(q);
    this.applyReferenceRotation();
  }

  /** Feed `qOrient` to boundaries/poles/gapwapPath's `setReferenceRotation()`
   *  -- but ONLY while a flat Projection is active. That method updates
   *  BOTH the Globe and flat projector unconditionally (PointOverlay/
   *  BoundaryOverlay are shared with Reference Plate callers like
   *  climate.html, where feeding the Globe projector too is correct), so
   *  passing Map Orientation's `qOrient` through it while in Globe mode
   *  would rotate the Globe's own rendering by whatever orientation a prior
   *  flat-mode drag left behind -- the exact bug this guards against
   *  (Antarctica adrift from the south pole in Globe view, tracking the
   *  last oblique drag rather than staying fixed). Coastlines/Graticule
   *  don't need this: their own `qOrient` fields are Map-Orientation-only
   *  (never shared with Reference Plate) and already gate internally. */
  private applyReferenceRotation(): void {
    const q: Quaternion = isFlat(this.projectionMode) ? this.qOrient : [0, 0, 0, 1];
    this.boundaries.setReferenceRotation(q);
    this.poles.setReferenceRotation(q);
    this.gapwapPath.setReferenceRotation(q);
    this.sites.setReferenceRotation(q);
  }

  applyAge(age: number): void {
    this.view.age = age;
    this.coastlines.setAge(age);
    void this.boundaries.setAge(age);
    this.poles.setTime(age);
    this.gapwapPath.setTime(age);
    this.sites.setTime(age);
    this.ui.setAge(age);
    if (this.view.landColorMode === 'count') this.recomputeLandVgpCounts();
  }

  /** Switch land fill between the Theme's flat colour, per-plate hue
   *  (matching each plate's own VGP dots, restricted to plates that ever
   *  have a VGP -- see `platesWithData`), and a "hot"-style ramp on how many
   *  VGPs are CURRENTLY visible for that plate -- see CONTEXT.md's (planned)
   *  Land Colour entry and Coastlines.setLandColorMode()'s own doc comment
   *  for the shader side of this. */
  setLandColorMode(mode: LandColorMode): void {
    this.view.landColorMode = mode;
    if (mode === 'count') this.recomputeLandVgpCounts();
    else if (mode === 'plate') this.coastlines.setLandColorMode('plate', undefined, this.platesWithData);
    else this.coastlines.setLandColorMode(mode);
  }

  /** How many VGPs are drawable, per plate_id, at the CURRENT age -- the
   *  same `age`/`ageWindow`/`plate_begin_age` rule `poles` was loaded with
   *  (`lifespan: 'window', ageWindow: 5`), reapplied here against the raw
   *  payload rather than reaching into PointLayer's own private `_live`
   *  array (petrify's public surface for this is `points`/`payload()`, not
   *  its underscore-prefixed internals). Recomputed only while Land Colour
   *  is actually 'count' (see setLandColorMode()/applyAge()) -- pointless
   *  work otherwise. */
  private recomputeLandVgpCounts(): void {
    const payload = this.poles.payload();
    const counts = new Map<number, number>();
    if (payload) {
      const age = this.view.age;
      for (const p of payload.points) {
        const recordAge = p.age as number;
        const plateBeginAge = p.plate_begin_age as number | null | undefined;
        if (Math.abs(recordAge - age) > 5) continue;
        if (plateBeginAge != null && age > plateBeginAge) continue;
        const plateId = p.plate_id as number;
        counts.set(plateId, (counts.get(plateId) ?? 0) + 1);
      }
    }
    this.coastlines.setLandColorMode('count', counts);
  }

  /** A click landed at this tile-local (x, y) -- see main.ts's click-vs-drag
   *  disambiguation, which calls this only once a plain click (not a drag)
   *  is confirmed. Tries `sites` first, then `poles` (both are clickable,
   *  see this feature's plan doc), and either way highlights BOTH overlays
   *  at the same index -- they're the same underlying record, see `sites`'s
   *  own field doc comment. A miss on both clears the selection.
   *
   *  Several sites sharing (near enough) one real-world outcrop -- 44 of
   *  475 distinct sites in the T2012_TC2017 dataset carry 2+ VGPs -- are
   *  otherwise unreachable individually: pick() would return only the pile's
   *  own tie-break winner every time. `sites.clusterSizeAt()`/`spiderfy()`
   *  (petrify's own mechanism, already used identically by climate.html's
   *  Boucot paleolithology hover) fans a pile apart into individually-
   *  clickable positions. Unlike that hover case, this is click-driven, so
   *  there's no dwell/keep-radius timing to get right -- just: a click on an
   *  unopened pile explodes it and selects nothing yet (ambiguous which
   *  member was meant); a click on an ALREADY-fanned member (checked via
   *  `spiderfied`, since `clusterSizeAt` itself can't tell fanned-open from
   *  piled-up -- it's a membership test on true position, not current screen
   *  position) selects that one normally, same as any other single click. */
  selectSampleAt(x: number, y: number): void {
    const sitePick = this.sites.pick(x, y);
    const openFan = this.sites.spiderfied;
    const onOpenFanMember = !!(openFan && sitePick && openFan.includes(sitePick.index));

    if (!onOpenFanMember && this.sites.clusterSizeAt(x, y) >= 2) {
      this.sites.spiderfy(x, y);
      return;
    }

    const hit = sitePick ?? this.poles.pick(x, y);
    this.poles.highlight(hit?.index ?? null);
    this.sites.highlight(hit?.index ?? null);
    this.hooks.onSelectSample?.(
      this, (hit?.point as PaleomagSampleRecord | undefined) ?? null, this.poleSetCitation,
    );
    if (!hit) this.sites.unspiderfy();
  }

  /** Clear whatever selectSampleAt() last highlighted -- called from the
   *  metadata popup's own close button (core/samplePopup.ts), which has no
   *  other way back to this instance's overlays. */
  clearSelection(): void {
    this.poles.highlight(null);
    this.sites.highlight(null);
  }

  /** Move this instance's boundary overlay and panel onto a new tile -- see
   *  core/multiInstanceHost.ts, docs/adr/0022. */
  applyLayout(rect: Rect): void {
    this.boundaries.setRect(rect);
    this.poles.setRect(rect);
    this.gapwapPath.setRect(rect);
    this.sites.setRect(rect);
    this.ui.setRect(rect);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
    this.boundaries.draw();
    this.poles.draw();
    this.gapwapPath.draw();
    this.sites.draw();
  }

  dispose(): void {
    this.ui.dispose();
    this.ocean.dispose();
    this.graticule.dispose();
    this.coastlines?.dispose();
    this.boundaries.dispose();
    this.poles.dispose();
    this.gapwapPath.dispose();
    this.sites.dispose();
  }
}
