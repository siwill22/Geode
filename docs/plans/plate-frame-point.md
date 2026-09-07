# Plate-Frame Point

**Status: built and live in the climate viewer.**
Requirements captured during the same design session as Anchored Point
(`docs/plans/anchored-point-query.md`, ADR-0011), then deliberately split
off — this needed a new data source the archive didn't carry yet and a
genuinely new "cannot answer" outcome, both of which deserved their own
grilling session rather than riding along with the query that needed
neither. Two follow-on design sessions happened first: ADR-0025 (data
source, "cannot answer" semantics) and ADR-0026 (which viewer, the click
gesture, how "no plate here" surfaces, trajectory rendering). The static
polygon export exists for Müller 2019, Seton 2012, and Scotese
(`prep_staticpolygons.py`); the engine-level consumer, `core/staticPolygons.ts`
(click-time assignment, largest-wins overlap tie-break, per-age
repositioning) and `core/queryPoint.ts`'s
`plateFrameAgeSeries`/`plateFrameMonthProfile`, is covered by
`check:static-polygons`; and ADR-0026's UI design is now implemented in the
climate viewer (`climate.html`): a "query mode" toggle
(`ClimateUI`/`ClimateInstance.setQueryMode()`) switches shift-click between
Anchored Point and Plate-Frame Point, `ClimateInstance.queryPlateFramePointAt()`
assigns a click to a plate and pins a marker, and
`ClimateInstance.refreshPlateFrameQuery()` -- hooked into every Frame load --
keeps the marker and the query panel's value in step as the age slider
scrubs, showing ADR-0026's two "no plate" messages where appropriate.
`core/staticPolygons.ts`'s `loadStaticPolygonDataFor()` resolves and fetches
Scotese's static polygons at boot via the accepted-debt type-based resolver
from ADR-0026 (tracked on issue #5). Verified against a live dev server
(Playwright): mode toggle, click assignment + panel value, live
repositioning/re-query across an age scrub, and the on-screen marker
rendering at the correct screen position. Anchored Point got a matching,
smaller update in the same pass (no ADR needed -- mechanical, not a design
decision): it now drops the same on-globe marker on click and its panel
value re-reads on every subsequent Frame load too, via a generalized
`queryMarker`/`refreshAnchoredQuery()` that mirrors Plate-Frame Point's own
mechanism, just without the repositioning step (a grid cell doesn't move).
A third item -- an Age Series (point) chart showing the value through time,
not just the current age -- is designed AND built too, per ADR-0027; see
below. Term defined in `CONTEXT.md`.

## What it is

A Query Point that follows a material point on a moving Plate rather than a
fixed grid cell: click a location at some reference age, and see what
Variable value that same *piece of crust* carries at other ages — as
opposed to Anchored Point, which always reads whatever ends up in that grid
cell regardless of what's there.

## The data dependency — now exported, see ADR-0025

**Static plate polygon data, per Reconstruction Model** (not per numerical
Model — see docs/adr/0024). Coastline features get a plate id for free from
their own source shapefile's attributes
(`feature.get_reconstruction_plate_id()`, see `prep_coastlines.py`) — that
works because every coastline vertex already belongs to a tagged feature.
An arbitrary clicked point belongs to nothing until it's tested against a
closed plate polygon covering that location at the reference age.

This is now exported: `prep_staticpolygons.py`, invoked from
`prep_reconstruction.py`, writes `staticpolygons/geometry.bin` — plate id,
a `continental` flag, and each feature's own valid-time begin age, per
static-polygon feature, present-day coordinates for in-browser rotation —
and the Model's manifest gains `has_static_polygons` plus a
`static_polygons` section pointing at it. All three currently-exported
Reconstruction Models have it: **Müller 2019** (2107 polygons, 489
continental), **Seton 2012** (1583 polygons, 288 continental), and
**Scotese** (245 polygons, all continental — its static-polygon source is
literally its continent-polygon source, see ADR-0025), the last of these
added during the ADR-0026 session once it became clear Scotese was the
right target for Plate-Frame Point's first viewer.

The engine-level consumer exists too: `core/staticPolygons.ts` does
click-time assignment (`assignPlate`, largest-polygon tie-break) and
per-age repositioning (`createPlateFramePoint`/`positionAt`, "no plate
here yet" past a point's own begin age); `core/queryPoint.ts` adds
`plateFrameAgeSeries`/`plateFrameMonthProfile` alongside the existing
Anchored Point functions. `core/rotation.ts` was split out of
`coastlines.ts` so both share the exact same rotation primitives rather
than a second copy. All covered by `viewer/scripts/check_static_polygons.mjs`
(`npm run check:static-polygons`). The viewer UI is built too — see "UI
design — resolved in ADR-0026, and implemented" below.

**Static polygons only — see ADR-0025.** ADR-0024 identified two
independent polygon sources (static, dynamic/resolved-topology); ADR-0025
picks static polygons as the sole assignment source for this feature and
defers dynamic-polygon assignment to future work (see "Deferred" below).
Continent polygons are not a separate export either — ADR-0025 found the
static-polygon file already tags a subset of its own features as
continental (feature-type value differs per model, checked directly), so
`prep_staticpolygons.py` derives a `continental` flag from that instead of
also fetching `continent_polygons_files`.

**The shared rotation table now covers both sources.** A static-polygon-only
plate id (one that owns no coastline vertex — 93 of Müller 2019's 399 static
polygon plate ids, confirmed directly) still needs a rotation to move with.
`prep_reconstruction.py` unions the plate id sets from both exports before
writing `coastlines/rotations.json`, so it is one shared table covering
whichever plate ids either source needs, not two separate tables.

**Also motivates**: velocity arrows, motion paths, and tectonic flowlines
(GPlates-style) are the same primitive rendered differently — a Plate-Frame
Point's trajectory drawn as a path/vector rather than read back as a
Variable value — and "load arbitrary point data, reconstruct it
consistently with whatever's displayed" is this primitive run over a
user-supplied point set instead of one click. None of these need new
machinery beyond what's described here; see CONTEXT.md's Plate-Frame Point
entry.

**The same per-Model provenance discipline ADR-0004 already established for
coastlines vs. rotations.** ADR-0004 exists because pairing the wrong
rotation file with a coastline set silently mis-places continents by
hundreds of km. The same failure mode applies here in a second dimension:
the plate polygons used for point-in-polygon assignment and the rotation
table used to move the assigned point must come from the *same* rotation
model's own provenance, not merely "a" polygon set and "a" rotation table
that happen to both exist in the archive. Which polygon/rotation pair a
Model uses needs to be declared per Model, the same way ADR-0004 declared it
for coastlines.

**Reuse of the existing rotation mechanism, not a new one.** `RotationTable`
(ADR-0001) already gives any plate id its absolute rotation at any age via
slerp between 1 Ma samples. Once a Plate-Frame Point knows which plate id it
belongs to, moving it to another age is the same math coastline vertices
already use — nothing new there.

## The "cannot answer" outcome — resolved, see ADR-0025

Static polygons turn out to structurally forbid one of the two scenarios
this section originally worried about, and collapse the other into
something much simpler than a per-age re-test:

- **Crust since subducted is not representable at all on this path.**
  Static polygons are digitized in present-day space and rotated backward,
  so every static-polygon feature is, by construction, crust that survives
  to today — confirmed directly against Müller 2019 (essentially no feature
  has a finite, before-present end age). A static polygon cannot express
  "existed, then was consumed." This scenario only applies to the deferred
  dynamic-polygon path (see ADR-0025's "Deferred" section), not to anything
  built here.
- **Coverage gaps collapse into one begin-age bound per assigned point, not
  a per-age re-test.** Assignment is a single point-in-polygon test, at
  click time, against one static-polygon *feature* (not just a plate id —
  a plate id is typically covered by several features, each with its own
  `pygplates` `get_valid_time()` begin age). Point-in-polygon containment is
  invariant under a shared rigid rotation, so once a point is inside a
  feature's boundary at the reference age, it stays inside that same
  rotated boundary at every other age — no re-testing needed. The point's
  valid range is exactly `[0, assignedFeature.beginAge]`: every age older
  than that reports "no plate here yet" (this crust hadn't formed); no age
  is ever too young, since every feature's window reaches present by
  construction.

So the per-age result shape Age Series (point) needs for a Plate-Frame
Point is much smaller than originally feared: not a redesigned
`CellSample[]` with a new per-entry outcome, but a single `beginAge` cutoff
computed once at assignment time, applied uniformly across the whole
trajectory. Implemented exactly that way: `queryPoint.ts`'s
`plateFrameAgeSeries` filters `manifest.frames` to `age_ma <= beginAge`
before returning ordinary `CellSample`s — frames beyond the cutoff are left
out of the array entirely, not padded with a per-entry "no plate" marker,
since the caller already holds `beginAge` and can show it as a series
boundary on its own.

At click time itself, failure is binary: if no static polygon covers the
reference-age point, there is nothing to assign — no retry, no fallback
(the dynamic-polygon path that could attempt one is deferred, see below).

## Resolved in ADR-0025 (formerly "open questions for the next session")

- **Which polygon source, and does it differ per Model?** Static polygons
  only, for every Model that has them (currently Müller 2019, Seton 2012).
  Dynamic/resolved-topology assignment is a distinct, deferred feature, not
  a per-Model alternate path — see ADR-0025's "Deferred" section. This also
  resolves ADR-0024's own remaining open question ("should a Model with both
  sources prefer one") in favour of always preferring static.
- **Continent polygons.** Not a separate export — folded into the static
  polygon export as a `continental` boolean flag, derived from a
  feature-type value that differs per Model (`gpml:ClosedContinentalBoundary`
  for Müller 2019, `gpml:ContinentalFragment` for Seton 2012 — checked
  directly per Model, never assumed shared). For Scotese, the static and
  continent-polygon files are literally the same shapefile already.
- **Overlap tie-break.** When reconstructed static polygons overlap at
  non-zero ages (confirmed real and growing with age: 0/3000 sampled points
  at 0 Ma, 26/3000 at 50 Ma, 46/3000 at 100 Ma, 64/3000 at 150 Ma for Müller
  2019), the largest overlapping polygon wins — better geological
  constraint on larger blocks' reconstructed position, not polygon size for
  its own sake.
- **Reference age.** Fixed at click time, alongside the click's `LonLat`,
  never edited after — same convention ADR-0011 already established for
  `LonLat` itself.
- **Month Profile.** Still engages the plate machinery (one rotation from
  reference age to whichever Frame is on screen), not "always an Anchored
  Point operation" — that would silently reintroduce a mismatched-provenance
  bug in the same family ADR-0004 already guards against.

See ADR-0025 for the full reasoning behind each of these.

## UI design — resolved in ADR-0026, and implemented

A second grilling session, once the data/engine above landed, resolved
every remaining UI/wrapper decision. All five are now built, in the climate
viewer:

- **Viewer: the climate viewer** (`climate-540myr`), not tomography.
  Triggered this session's other concrete output: Scotese — the plate
  model behind the whole climate family — had never been exported as a
  proper Reconstruction Model catalog entry (ADR-0021) before now; it only
  ever lived in the legacy `archive.scotese_coastlines` bucket. Fixed:
  `archive/reconstructions/scotese/` now exists, static polygons included
  (245 polygons, all continental, `has_boundaries: false` per ADR-0019).
  `muller2019-deformation` was never a candidate regardless of this pivot
  — it's the crustal deformation viewer, treated as more private than the
  rest of this project.
- **Gesture: shift-click stays the one query gesture**, made mode-dependent
  — a "query mode" (`Anchored` / `Plate-Frame`) lil-gui toggle right next to
  `layer` on `ClimateUI`'s existing panel, wired to
  `ClimateInstance.setQueryMode()`; `ClimateInstance.queryAt()` is the one
  dispatch point `climate/main.ts`'s shift-click handler calls, so it never
  needs to know which mode is active.
- **"No plate here": one panel, two messages.** Both the click-time
  assignment-failure message and the scrubbed-past-`beginAge` boundary
  message reuse `ClimateUI.showPlateFrameMessage()`, itself reusing the
  existing `queryPanel` DOM node — no new UI surface, no new engine-level
  outcome type. `ClimateInstance.refreshPlateFrameQuery()` is the single
  place both get triggered from (click time, and every subsequent Frame
  load while a Plate-Frame Point is assigned).
- **Wiring static polygons into a climate instance**: `core/staticPolygons.ts`'s
  `loadStaticPolygonDataFor()`/`resolveStaticPolygonReconstructionId()`, a
  small, additive, type-based resolver mirroring `resolveCoastlineSet()`'s
  own switch — not adding `reconstruction_model` to the climate-family
  manifests properly, which would mean re-touching several already-shipped
  exports. Called once at boot (`climate/main.ts`), same timing as the
  existing `coastlineData` fetch. This is accepted debt, tracked as a
  comment on
  [issue #5](https://github.com/siwill22/Geode/issues/5#issuecomment-5566353388),
  which already named this same gap for the reconstruction-override wizard.
- **Trajectory rendering: a marker only** (`ClimateInstance`'s
  `queryMarker`, shared with Anchored Point's own click marker), repositioned
  via `positionAt()` every time a new Frame loads — no path/trail. Full
  paths are deferred to whichever future session actually needs one
  (CONTEXT.md already scopes motion
  paths/flowlines separately).

See ADR-0026 for the full reasoning. The data, engine, and UI layers are all
built and tested now: `prep_staticpolygons.py`, `core/staticPolygons.ts`,
`core/queryPoint.ts`'s `plateFrameAgeSeries`/`plateFrameMonthProfile`,
`core/rotation.ts` (engine, covered by `check:static-polygons`), plus
`ClimateInstance`/`ClimateUI`'s mode toggle, marker, and panel wiring in the
climate viewer (verified against a live dev server with Playwright: mode
switch, click assignment, live value/position refresh across an age scrub,
and the on-screen marker's rendered pixel colour). Not built, and not in
scope here: dynamic-polygon-based assignment (deferred per ADR-0025), and a
real `reconstruction_model` field on climate-family manifests (tracked on
issue #5).

## Age Series (point) — resolved in ADR-0027, and implemented

A scope chat, once the above landed, resolved the shape of the "value
through time" chart CONTEXT.md already names **Age Series (point)** —
distinct from the existing whole-globe **Time Series** panel. Now built, for
both query modes, in the climate viewer: `ClimateInstance.fetchAgeSeries()`
calls the engine (`core/queryPoint.ts`'s `ageSeries()`/`plateFrameAgeSeries()`,
Annual layer only, never whichever Month is selected) once per assigned
point — on a new click, or on a layer/variable/climate-model/resolution
switch (mirroring exactly the conditions each already re-triggers Month
Profile's own live value under) — and deliberately *not* from `loadFrame()`,
so a plain age-slider scrub never re-fetches the whole series. The chart
(`ClimateUI.drawAgeSeriesChart()`) renders stacked below the existing Month
Profile chart in the same `queryPanel`, not a toggle, showing "computing…"
until the fetch resolves; its marker still moves on every age-slider tick,
for free, because `refreshAnchoredQuery()`/`refreshPlateFrameQuery()` already
rebuild the whole panel on every Frame load (Month Profile's own chart
already worked this way) — no separate marker-only update path was needed.
Plots just the active variable, matching Month Profile's own scope; x-axis
spans the full model age range, so a Plate-Frame Point whose series stops
at its own `beginAge` shows visibly as a short line on a wider axis, not a
silently-trimmed one. Verified against a live dev server (Playwright, both
modes): the "computing…" placeholder, the resolved chart's own non-blank
pixels, and — checked via request counts — that scrubbing the age slider
after the fetch completes does *not* re-trigger it. See ADR-0027 for the
full reasoning.

CONTEXT.md's own "Age Series (point)" and "Plate-Frame Point" glossary
entries have been updated to match — the former to cover the Plate-Frame
variant, the latter to drop its stale "Not yet implemented" language from
before ADR-0025/0026's work.
