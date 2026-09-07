# Plate-Frame Point lands in the climate viewer first, as a mode toggle on Anchored Point's shift-click

Grilling the remaining "Left to build" items in `docs/plans/plate-frame-point.md`
now that the data export and engine (ADR-0025) are done and tested. Five
UI/wrapper decisions, previously undesigned.

## Which viewer, and why not the obvious first guess

Of the two Reconstruction Models with static polygons when this session
started (Müller 2019, Seton 2012), only Müller 2019 backed an actual
numerical Model: `muller2019-age-heatflux` (tomography, already wired to
the shift-click/`queryPointAt` pipeline) and `muller2019-deformation`
(convection — the crustal deformation viewer, treated as more private than
the rest of this project and excluded from consideration here on that basis
alone, not on technical merit).

That made `muller2019-age-heatflux` the only real candidate — until it was
noticed that **Scotese**, the plate model behind the entire climate viewer
family (`climate-540myr`, `climate-pohl2022`, `bridge-valdes2021-monthly`,
`bridge-valdes2021-ocean-depth`, `paleogeography-scotese`), had never been
exported as a proper Reconstruction Model catalog entry at all (ADR-0021) —
only ever into the legacy `archive/scotese_coastlines` bucket, which
predates that catalog. Fixed as part of this session:
`prep_reconstruction.py --model Scotese` now produces
`archive/reconstructions/scotese/`, including static polygons (245
polygons, all continental — Scotese's `static_polygon_files` is literally
its `continent_polygons_files`, per ADR-0025 — `has_boundaries: false`,
consistent with ADR-0019).

**Decision: the climate viewer, not tomography.** Scotese's climate family
spans 0-540 Ma (versus Müller 2019's 0-240) and is where Anchored Point's
shift-click gesture was *born* (`climateInstance.ts`, the original ADR-0016
implementation), not merely an adopter of a pattern established elsewhere.

## Gesture: shift-click stays the one query gesture, mode-dependent

ADR-0016 established shift-click as the query gesture and explicitly left
open whether a future click-driven feature should reuse or reinvent it.
**Decision: reuse it, but make it mode-dependent** — an explicit "Anchored"
/ "Plate-Frame" toggle (a lil-gui control on `climateUi.ts`'s existing
`this.gui` panel, the same home as `windStyle`'s own dropdown) that changes
what a shift-click *does*, rather than a second modifier combination (e.g.
Shift+Ctrl). Shift-click remains the only query gesture in the app; this
would have been the first place needing two simultaneous modifiers instead
of a mode selector.

## "No plate here": one panel, two messages, no new outcome type

Two distinct moments, per ADR-0025's own design: assignment failing
outright at click time (`assignPlate` returns `null` — nothing to pin), and
scrubbing the age slider past an already-assigned point's own `beginAge`
mid-session (`plateFrameMonthProfile` returns `null` for that Frame).
**Decision: reuse the existing query-result panel** (`queryPanel`/
`showQueryResult`) for both, rather than new UI surface — a message at
click time ("no plate found here at this age"), and a boundary message once
scrubbing crosses the point's own `beginAge` ("no plate here before X Ma"),
computed by the viewer comparing the current age against `beginAge`
directly rather than inspecting a per-frame engine outcome (there isn't
one, by ADR-0025's design).

## Wiring static polygons into a climate instance -- and the debt this creates

Climate-family manifests have no explicit `reconstruction_model` field
(unlike `muller2019-deformation`, which follows ADR-0004's convention) —
they resolve coastlines only via `resolveCoastlineSet()`'s type-based
fallback (`case 'climate': return archive.scotese_coastlines`). Locating a
climate Model's static polygons needs the same kind of resolution, which
this exact gap already blocks in one other place: **GitHub issue #5**
("Build the reconstruction-override confirmation wizard") names the same
missing field and the same two ways to close it.

**Decision: option (a) from issue #5** — a small, additive, type-based
resolver mirroring `resolveCoastlineSet()`'s own switch, mapping a
climate-family manifest to the Reconstruction Model id `"scotese"` for a
lookup in `archive.reconstruction_models`. Not option (b) (adding
`reconstruction_model` to every climate-family manifest properly) — that
would mean re-touching, and likely re-running prep for, several already-
shipped exports, some large (BRIDGE Monthly), which is out of scope for
landing Plate-Frame Point. Recorded as a comment on issue #5 rather than a
new issue, since the real fix is the one that issue already asks for: give
these Models a real declared `reconstruction_model` once, and let every
consumer -- the override wizard, Plate-Frame Point, anything else -- read
it instead of re-deriving it from `type`.

## Trajectory rendering: a marker, not a path

Anchored Point shows a text panel only, no persistent marker -- its click
location never moves, so it needs no visual anchor beyond itself. A
Plate-Frame Point's position genuinely changes as the age slider scrubs, so
a panel alone would report a value with no visible indication of where it's
coming from once the user has scrubbed away from the click.

**Decision: a minimal moving marker only** -- one point, repositioned via
`positionAt()` (already built) whenever the age changes -- not a full
trajectory path/trail. Full paths are the exception, not the default,
deferred until a specific future use actually needs one (CONTEXT.md already
scopes motion paths/flowlines this way: "None of these are separately
scheduled").

## Consequences

- `archive/reconstructions/scotese/` now exists as a byproduct of this
  session (static polygons, `has_boundaries: false`), and `archive.json`
  has been rebuilt to include it. This is additive: the legacy
  `archive.scotese_coastlines` bucket the climate viewer already renders
  from is untouched.
- All of the code described here is now built: `ClimateUI`'s "query mode"
  toggle, `core/staticPolygons.ts`'s `loadStaticPolygonDataFor()` resolver
  (called once at boot in `climate/main.ts`), `ClimateInstance`'s
  `plateFrameMarker` and `queryPlateFramePointAt()`/`refreshPlateFrameQuery()`,
  and `ClimateUI.showPlateFrameMessage()` for both "no plate" messages. This
  ADR still records the design reasoning, the same way ADR-0025 precedes
  `core/staticPolygons.ts`'s implementation.
- The lightweight resolver is accepted debt, not a preferred pattern --
  see issue #5. A future session that gives climate-family manifests a real
  `reconstruction_model` field should delete this resolver in favour of the
  same lookup every other Reconstruction-Model-aware consumer uses.
