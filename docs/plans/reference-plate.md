# Reference Plate

**Status: built for the climate viewer only, Globe Projection only**
(ADR-0030's mechanism, proven end-to-end in Globe: coastlines, raster
field, wind glyphs/streaks, Tracked Particle, and Query Point picking all
reanchor consistently, verified live in a browser). Plate Carrée has
wiring in place for the same layers but is confirmed broken -- see "Known
issue: Plate Carrée reanchoring is broken" below. The other six wrapper
types (globe, tomography, valdes, groupGlobe, reconstruction,
reconstructionGroup), deep-time-map's Boundary Frames/VGP layers, and the
Multi-Globe sync toggle are not yet wired up. See `CONTEXT.md`'s Reference
Plate entry for the resolved terminology.

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

## Known issue: Plate Carrée reanchoring is broken

Confirmed live in a browser (2026-09-12): with a non-zero Reference Plate
and a non-zero Reconstruction Age, the raster rectangle itself visibly
warps/contorts in 3D, while its content still reflects Reference Plate 0.
Wind glyphs/streaks and Tracked Particles are affected the same way in
Plate Carrée (confirmed by code inspection, not yet individually reproduced
live).

Root cause: every layer reanchors by taking a 3D position vector and
rotating it with a quaternion (`rotateVector`/`rotateByQuat`, from
`core/rotation.ts`). In Globe that vector is a genuine point on the unit
sphere (`lonLatToVec3`, `SphereGeometry` vertices) — rotating it in 3D
*is* the LonLat-level operation ADR-0030 calls for, since a sphere point is
already a lon/lat-derived direction. In Plate Carrée the same rotation call
is instead fed `lonLatToFlatVec3(lon, lat)` — `(lon*R, lat*R, z)`, a flat
Cartesian encoding of lon/lat, not a direction in 3D space at all. Rotating
that in 3D is a category error: it warps the flat plane's actual shape
(`core/material.ts`'s VERT shader, applied to the volume-draped surface's
raw mesh position) or scatters per-instance positions (`windGlyphs.ts`,
`windStreaks.ts`, `trackedParticles.ts`), while any content computed from
the UNROTATED position (e.g. the volume/mask fragment lookup, which uses
`vGeoPos` before rotation) stays exactly as it was at Reference Plate 0 —
which is exactly the split symptom observed (contorted shape, unrotated
content).

This is the exact risk ADR-0030 flagged when choosing the LonLat-level
function over a scene-graph Group transform ("a flat equirectangular plane
has no rigid 3D rotation to apply") — the implementation never actually did
the LonLat round-trip for Plate Carrée; it took the Globe's 3D-rotation
shortcut everywhere, which is only correct by coincidence for a sphere.

Correct fix (not yet implemented): in Plate Carrée, the flat rectangle's
own geometry/instance placement must stay fixed to the map's normal
-180..180/-90..90 extent — what needs to change is which TRUE lon/lat's
content is displayed at each fixed display position. That's a genuine
LonLat round-trip: display position → display lon/lat
(`worldToGeographicFlat`, unchanged) → unit sphere vector → rotate by the
INVERSE of `qRef` → back to lon/lat → sample/place using THAT lon/lat.
Needs doing per-fragment for the raster (`core/material.ts`'s FRAG shader,
the `uProjectionMode > 0.5` branch) and per-instance for wind glyphs/
streaks/Tracked Particles (their existing
`mode === 'globe' ? ... : lonLatToFlatVec3(...)` branches). Coastlines are
unaffected — they're simply hidden in Plate Carrée already
(`coastlines.lines.visible = mode === 'globe'`).

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
