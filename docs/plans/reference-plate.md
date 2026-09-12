# Reference Plate

**Status: built for the climate viewer only** (ADR-0030's mechanism, proven
end-to-end in BOTH Projections: coastlines, raster field, wind glyphs, and
Wind Streak all reanchor consistently; Tracked Particle and Query Point
picking are Globe-only by their own separate, pre-existing designs (see
trackedParticles.ts/queryPoint.ts), unrelated to Reference Plate. All
verified live in a browser. Plate Carrée needed real fixes along the way,
not just wiring -- see "Fixed: Plate Carrée reanchoring" and "Fixed:
Plate Carrée antimeridian seam" below for anyone touching this code next.
The other six wrapper types (globe, tomography, valdes, groupGlobe,
reconstruction, reconstructionGroup), deep-time-map's Boundary Frames/VGP
layers, and the Multi-Globe sync toggle are not yet wired up. See
`CONTEXT.md`'s Reference Plate entry for the resolved terminology.

## What it is

A client-side control that reanchors an entire view — reconstructed
coastlines, static polygons, Boundary Frames, VGPs, the Volume raster,
Vector Field glyphs/streaks, Tracked Particles, everything — into an
arbitrary plate's reference frame, replacing the default (plate 0) every
Reconstruction Model is exported with. Available in every globe-based
wrapper (globe, climate, tomography, valdes, groupGlobe, reconstruction,
reconstructionGroup) and both Projections (Globe, Plate Carrée).

## Resolved (ADR-0030)

- **Mechanism**: one shared function,
  `applyReferencePlate(lon, lat, quaternion) -> (lon', lat')`, computed once
  per Reconstruction Age from the same rotation table ADR-0001 already
  established, called at every layer's LonLat→render-position step. Not a
  scene-graph Group transform — that would only work for Globe, and Plate
  Carrée needs to be supported by the same mechanism, not a second one.
  Performance under Plate Carrée is a flagged risk, not yet measured; a
  Group-transform fast path for Globe only is the fallback if it regresses,
  without displacing the LonLat-level function as the source of truth.
- **Plate coverage**: restricted to plate ids that already have a rotation
  series in the current Reconstruction Model's `rotations.json` — the same
  ids coastlines/static polygons already carry. No prep-side changes. A
  plate id with no existing geometry in a given model is simply not
  offered.
- **Plate names**: generated per Reconstruction Model at prep time
  (`prep_plate_names.py`), not hand-curated — see ADR-0031, which
  supersedes this bullet's original design. A model whose source data
  carries no names at all (Scotese) gets no name table; the autocomplete
  falls back to bare numeric plate-id entry for that model, never a
  guessed name. Checked against the current model's actual available ids
  at selection time either way.
- **UI**: a text box with autocomplete on plate name (typing "Aust…"
  surfaces "Australia" → 801), not a dropdown or bare numeric field. Visible
  from the start (unlike Tracked Particles, which shipped hidden pending
  further validation) — this control is well-scoped and doesn't need a
  hidden trial period.
- **No rotation table loaded** (no Reconstruction Model selected): control
  disabled.
- **Reference Plate undefined at the current Reconstruction Age** (plate
  predates/postdates the reconstruction): hold the last valid rotation,
  surface a warning — never snap to identity, which would visibly jar the
  view as the age slider crosses the boundary.
- **Reconstruction Model switch**: keep the same plate id if it's valid in
  the new model, else reset to 0. A plate id has no guaranteed meaning
  across Reconstruction Models.
- **Multi-Globe**: a Synced Field (CONTEXT.md), with its own independent
  sync toggle alongside Reconstruction Age's — the two can be synced
  separately across tiled instances.
- **Default**: plate 0, matching the prep-time `anchor_plate_id` every
  Reconstruction Model is already exported with.

## Required companion change

Click-to-LonLat handling (Query Point, Plate-Frame Point assignment, VGP
hit-testing) must apply the *inverse* rotation to recover the true
underlying LonLat once Reference Plate is not 0. Raycasting/picking against
rendered geometry returns a position already rotated into the current
Reference Plate's frame; without the inverse step, picking would silently
resolve to the wrong physical location. This isn't optional or deferrable —
it ships in the same change as the rotation itself, or picking breaks the
first time Reference Plate is used for anything but the default.

## Correction history: hand-curated names never worked, replaced by per-model generation (ADR-0031)

Two stages, kept here for the record:

1. The name table (`core/plateNames.ts`) originally had ~24 entries,
   generated from recollection of "typical" GPlates plate-id numbering
   (continent-scale ranges like "100s = North America") and presented as a
   named "Cambridge/Seton-style numbering convention" — a citation that
   didn't correspond to anything actually checked. A user testing
   "Antarctica" found it visibly still moving: the invented entry (301) was
   wrong (Antarctica is 802 in the climate viewer's actual Scotese/Cao2018
   coastline data). It was cut back to only three empirically- and
   citation-verified entries (Africa/Nubia 701, Australia 801, Antarctica
   802 — cross-checked against Matthews et al. 2016's real, on-disk
   rotation-file annotations).
2. Even that smaller table was still the wrong SHAPE of fix: a hand-curated
   table can never be correct across more than one Reconstruction Model,
   no matter how carefully verified, because plate-id meaning is
   model-specific. Checking gprm's actual source shapefiles directly
   showed Müller 2019 and Seton 2012 both carry real per-feature `NAME`
   attributes (extractable, verified: 801→"Australia", 802→"Antarctica"),
   while Scotese's shapefile has none at all (0 of 240 features named,
   confirmed directly) — so no single table, however careful, could cover
   all three. Replaced by prep-time generation, one file per model
   (`prep_plate_names.py`) — see ADR-0031 for the full design.

The UI still shows the resolved plate id alongside the name (e.g.
"Antarctica (802)") once committed, so a wrong mapping is visible and
reportable rather than silently trusted — that part carries over unchanged.

## Fixed: Plate Carrée reanchoring

Confirmed live in a browser (2026-09-12): with a non-zero Reference Plate
and a non-zero Reconstruction Age, the raster rectangle itself visibly
warped/contorted in 3D, while its content still reflected Reference Plate
0. Wind glyphs and Wind Streak were affected the same way (confirmed by
code inspection at the time, since fixed and reverified live). Fixed the
same day; kept here since the failure mode is easy to reintroduce by
instinct (a 3D quaternion rotation "obviously" belongs wherever a position
is generated) unless a future change in this area re-reads why it doesn't
apply to Plate Carrée's own geometry.

Root cause: every layer reanchored by taking a 3D position vector and
rotating it with a quaternion (`rotateVector`/`rotateByQuat`, from
`core/rotation.ts`). In Globe that vector is a genuine point on the unit
sphere (`lonLatToVec3`, `SphereGeometry` vertices) — rotating it in 3D
*is* the LonLat-level operation ADR-0030 calls for, since a sphere point is
already a lon/lat-derived direction. In Plate Carrée the same rotation call
is instead fed `lonLatToFlatVec3(lon, lat)` — `(lon*R, lat*R, z)`, a flat
Cartesian encoding of lon/lat, not a direction in 3D space at all. Rotating
that in 3D is a category error: it warped the flat plane's actual shape
(`core/material.ts`'s VERT shader, applied to the volume-draped surface's
raw mesh position) or scattered per-instance positions (`windGlyphs.ts`,
`windStreaks.ts`), while any content computed from the UNROTATED position
(e.g. the volume/mask fragment lookup, which uses `vGeoPos` before
rotation) stayed exactly as it was at Reference Plate 0 — which is exactly
the split symptom observed (contorted shape, unrotated content).
`trackedParticles.ts` calls the same `rotateVector` on a flat position too,
but never hit this bug in practice: Tracked Particle is Globe-only by its
own separate, pre-existing design (`setProjection()` clears every particle
on switching away from Globe rather than draw them at all), so that call
never actually runs against a flat-plane vector.

This was the exact risk ADR-0030 flagged when choosing the LonLat-level
function over a scene-graph Group transform ("a flat equirectangular plane
has no rigid 3D rotation to apply") — the implementation never actually did
the LonLat round-trip for Plate Carrée; it took the Globe's 3D-rotation
shortcut everywhere, which is only correct by coincidence for a sphere.

Fix: in Plate Carrée, the flat rectangle's own geometry/instance placement
now stays fixed to the map's normal -180..180/-90..90 extent — what
changes instead is which TRUE lon/lat's content is displayed at each fixed
display position. That's the genuine LonLat round-trip ADR-0030 called
for:

- **Raster** (`core/material.ts`): VERT no longer rotates `position` when
  `uProjectionMode > 0.5` (the flat plane stays put). FRAG's
  `uProjectionMode > 0.5` branch instead takes the fragment's fixed
  display position → display (lon, lat) (`worldToGeographicFlat`,
  unchanged) → unit sphere direction (`lonLatToUnit`, new) → rotate by the
  INVERSE of `uRefQuat` (`conjugateQuat`, new) → back to (lon, lat) → THAT
  is what every downstream sample/lookup uses. Forward for Globe (rotate
  the sphere point to find where to draw it), inverse for Plate Carrée
  (unrotate the fixed pixel's lon/lat to find what to draw there) — two
  directions of the same underlying operation, not two designs.
- **Wind glyphs/Wind Streak** (`core/projection.ts`'s new
  `referencePlateFlatPosition()`/`referencePlateFlatSample()`): the
  opposite direction from the raster, since these place a TRUE physical
  point rather than sample content for a fixed pixel — rotate the true
  (lon, lat)'s sphere-equivalent point FORWARD by `qRef`, convert back to
  (lon, lat), then reproject onto the flat map. `referencePlateFlatSample()`
  additionally reanchors a direction (wind glyphs' arrows): the rotated
  tangent vector is decomposed back onto the ROTATED location's own
  east/north basis, since the flat map's own screen axes
  (`FLAT_EAST`/`FLAT_NORTH`) are fixed and never rotate — only which
  physical (u, v) displays against them does. Both short-circuit to the
  pre-fix bit-identical behaviour when `qRef` is identity (Reference Plate
  0, the default), so the ordinary case pays no extra trig.
- **Tracked Particle**: untouched — already Globe-only by its own design,
  see above.

Coastlines are unaffected — they're simply hidden in Plate Carrée already
(`coastlines.lines.visible = mode === 'globe'`). Query Point picking
against the raster remains Globe-only too, by its own separate,
pre-existing design (`hitToLonLat()`'s doc comment; every query-click
caller already guards `projectionMode !== 'globe'`) — unrelated to this
fix, not attempted here.

Verified live in a browser (2026-09-12): Plate Carrée's raster rectangle
stays a perfect flat rectangle at a non-zero Reference Plate and age, its
content (and wind glyphs) visibly shifted to match, and the SAME content
appears in Globe mode at the same Reference Plate/age — confirming the two
Projections now agree, not just that Plate Carrée stopped visibly
breaking. `npm run typecheck` clean.

## Fixed: coastlines had no Plate Carrée support at all

Separate from the reanchoring bug above: `Coastlines` never had a Plate
Carrée mode to begin with, reanchoring or not — its line geometry was
always computed on the sphere and simply hidden outright in Plate Carrée
(`coastlines.lines.visible = mode === 'globe'`), predating Reference Plate
entirely. Once the raster/wind fix above made Plate Carrée usable, this
became the visible gap: the continent outlines that key the raster's
paleogeography to something recognisable were just gone.

Fix: `Coastlines` gained a `mode`/`setProjection()` (mirroring
`WindStreaks`), and `setAge()`'s per-line-point loop now branches on it —
Globe keeps the existing viewer-frame sphere position; Plate Carrée
recovers (lon, lat) from that same already-fully-rotated (reconstruction +
Reference Plate composed together, see the existing `composeQuaternions`
call) point via `vec3ToLonLat`, then reprojects with
`lonLatToFlatVec3`. `climateInstance.setProjection()` now calls
`coastlines.setProjection(mode)` instead of toggling `.lines.visible`, so
outlines render (and reanchor) in both Projections.

Land fill (the triangulated continent mesh, distinct from the line
outlines) was deliberately left on the sphere unconditionally — the
climate viewer always sets `landVisible = false` (only the line outlines
are used there, see the class doc comment), and reprojecting filled
polygons correctly needs actual antimeridian polygon clipping, a
materially bigger job than the line case below, for a mesh nothing
currently draws. Flag this if a future wrapper turns land fill on under
Plate Carrée.

## Fixed: Plate Carrée antimeridian seam

Reported live (2026-09-12): under Plate Carrée with a non-zero Reference
Plate, Wind Streak drew bright ribbons spanning the full width of the map
— the same failure mode the codebase already had ONE defence against
(`WindStreaks.advect()`'s existing `Math.abs(nextLon - lon) > 180` check,
which respawns a particle whose TRUE, unrotated position just crossed the
antimeridian rather than draw a wrong segment across it), but that defence
checks the wrong frame once Reference Plate is involved.

Root cause: the TRUE-frame check is only a valid proxy for "does the
RENDERED segment span the seam" when TRUE and DISPLAY longitude are the
same thing, i.e. Reference Plate 0. A non-zero Reference Plate moves the
antimeridian to a different TRUE longitude than the map's own fixed
DISPLAY edges (±180, always) — so an ordinary short step that never
crosses the TRUE seam can still reproject (via `referencePlateFlatPosition`,
see the fix above) to a DISPLAY position on the opposite edge from where
that particle's trail was last drawn. The existing check has nothing to
say about that case; it only ever looked at the TRUE lon.

Fix: `WindStreaks.advect()`'s Plate Carrée branch now ALSO compares the
newly-computed DISPLAY x against the trail's own previously-committed
DISPLAY x (`this.trail[... this.cursor[p] ...]`, read before this tick
overwrites it) and respawns on the same "drop rather than draw a wrong
line" precedent if that jump exceeds half the map width — checked in the
space that's actually rendered, not the space that's merely sampled for
data. The pre-existing TRUE-frame check is unchanged and still needed (it
guards `texelIndex` lookups staying in a valid domain, unrelated to
rendering).

Coastlines needed the equivalent the moment they gained Plate Carrée
support (previous section): each line's points are stored as independent
`LineSegments` pairs already (not a shared vertex chain), so `setAge()`
simply skips emitting a segment outright — no respawn concept applies to
static geometry — whenever its two endpoints' DISPLAY x differ by more
than half the map width. Wind glyphs need no equivalent: each arrow is an
independent instance with no line connecting it to its neighbours, so a
glyph landing on the opposite map edge from where it "should" visually
continue isn't a rendering artifact, just the same thing every flat world
map already looks like at its own edges.

Verified live in a browser (2026-09-12): swept Reference Plate through
five plate ids (801, 802, 701, 601, 501) at age 100 Ma under Plate Carrée
with Wind Streak active and enlarged (density/size upsized for
visibility) — no ribbon or coastline segment spanning the map at any of
them, coastlines and streaks both reanchoring consistently with the
raster underneath. `npm run typecheck` clean.

## Not yet resolved

- Exact shape/location of `applyReferencePlate` and the Reference-Plate
  quaternion computation in `core/rotation.ts` (extending `rotationAt`/
  `rotateVector`, per ADR-0001) — not designed in detail, only the call
  contract.
- Which layers' current LonLat→position code needs touching, file by file
  (`core/coastlines.ts`, `core/staticPolygons.ts`, `core/volume.ts`/
  `core/depthSlice.ts`, `core/windGlyphs.ts`, `core/windStreaks.ts`,
  `core/trackedParticles.ts`, `viewer/vendor/deep-time-map`'s
  `BoundarySeries`/`PointLayer` consumers) — deferred to implementation.
- Plate names are only generated for models whose static-polygon source
  data already carries a NAME attribute (Müller 2019, Seton 2012) — no
  wrapper actually loads either of those models yet (only Scotese, via the
  climate viewer, which has none), so this path is built and verified
  against the real generated data but not yet exercised end-to-end through
  an actual UI showing a non-empty name table.
- Exact UI placement per wrapper (alongside the Reconstruction Age slider
  is the working assumption, not confirmed per wrapper's layout).
- Warning presentation for "Reference Plate undefined at this age" (toast,
  inline badge, GUI panel note) — behavior is resolved, presentation isn't.

## Performance watch-item

Applying the rotation per vertex/instance (rather than once per Group)
means every layer's render-position computation grows by one extra step,
every frame the Reconstruction Age or Reference Plate changes. Untested
against Plate Carrée's typical vertex/instance counts (coastlines, static
polygons, Vector Field glyphs at density). If this regresses interactivity,
the documented fallback (ADR-0030) is a Group-transform fast path for Globe
only — Plate Carrée keeps the general per-vertex path regardless.
