# Transects and Readouts

**Status: specced, not started.** Written up from a grilling session
(2026-09-17). Four ADRs came out of it — 0042 (one object, many Readouts),
0043 (plate-frame construction), 0044 (sampling rule), 0045 (schematic
elements) — and the glossary entries are in `CONTEXT.md`. This document is the
staged delivery plan and the record of what was deliberately left open.

## What it is

The user draws a line on the globe. Things are extracted along it:

- a **Mantle Section** — the tomography/convection Volume sampled down the line
  and drawn as a vertical section;
- a **Grid Track** — a Variable's values along the line, as a chart;
- a **Catchment** — the points of a point dataset lying within some great-circle
  distance of the line;
- a **Geological Section** — a stylized cross-section built from the plate
  boundaries the line crosses, with trench vergence resolved in the plane of
  the section.

The line is a **Transect**, a first-class object in `core/`; each of the four
is a **Readout** consuming it (ADR-0042).

## What already exists, and what it means for scope

Most of the hard machinery is in the repo already, which is why this is a
moderate feature rather than a large one.

**Drawing a great-circle path on the globe is solved.** `tomography/cutaway.ts`
densifies a vertex list along great circles (`densifyPolygon`), draws it as a
horizon-culled overlay with vertex handles at `R_SURFACE * 1.002`, and drags
those handles via a raycast against a pick sphere (`instance.ts`'s
`pickLonLat`, `onPointerDown/Move/Up`). It also already reanchors the overlay
under Reference Plate (`setReferenceRotation`, ADR-0030), and suppresses
OrbitControls while a tool is active (`toolActive()`, and `main.ts`'s
synthetic-pointerdown trick that keeps modifier-drag rotating rather than
panning). A Transect needs the open-path case of all of this and nothing new.

**The data is already in memory.** `core/volume.ts`'s `loadVolume()` fetches a
Model's entire 3D field in one request and uploads it whole as a
`Data3DTexture`; `core/frameByteCache.ts` keeps raw frame bytes for the
session. Sampling a line costs zero network requests — the same observation
that makes `docs/plans/vertical-profile-clustering.md` feasible.

**The panel pattern exists.** `core/timeSeriesPanel.ts` is a collapsible box of
per-row canvases that owns no domain knowledge: the caller decides which rows
exist and feeds them data. Its rect logic already dodges the lil-gui panel and
bottom-anchored legends on a multi-globe tile. The Transect panel is the same
shape of component with different rows.

**Point datasets are generic.** `core/pointOverlay.ts` wraps deep-time-map's
`PointLayer` and works in both Projections; any point dataset already loads,
reconstructs and symbolises through it. The Catchment Readout is a filter over
something that already exists, not a new data path.

**Continental vs oceanic is already exported.** `prep_staticpolygons.py` writes
a per-feature `continental` uint8 next to the plate id, per Reconstruction
Model, with each model's feature-type mapping declared explicitly (and
Merdith2021's island arcs counted continental). `core/staticPolygons.ts`
already does the point-in-polygon walk for Plate-Frame Point. The Geological
Section's "continental crust is four to five times thicker" convention needs no
new prep step.

**Boundary crossings have a reference implementation.** `gprm`
(`~/GIT/GPlatesReconstructionModel`) already does this analysis in Python:
`CrossSection` builds great-circle profile points and samples a raster;
`utils/spatial.py`'s `plate_boundary_intersections()` finds subduction, ridge
and other crossings with along-profile distances; `get_subduction_polarity()`
resolves the trench's `Left`/`Right` property against the section's direction
of travel; `utils/paleogeography.py`'s `paleogeography_cross_section()` draws
the cartoon. The browser case is *simpler* — the boundary GeoJSON is
pre-resolved and pre-reconstructed by `prep/`, so there are no topologies to
resolve at runtime — but the polarity resolution is worth porting rather than
re-deriving (ADR-0045).

## The resolved design

Recorded here in one place; the reasoning is in the ADRs.

**Transect.** Ordered list of ≥2 `LonLat` vertices; each segment a great-circle
arc. N=2 is a **Great-Circle Transect** — planar, so it has a section plane a
camera can be aligned to. N>2 is a bent curtain with no plane. One live
Transect at a time, shared across a multi-globe's synced instances. Surface
object only: depth belongs to each Readout (ADR-0043).

**Frame.** Anchored (fixed lon/lat, the default, and the only meaningful mode
in tomography) or Plate-Frame (vertices ride their plates). Plate-Frame rotates
the **vertices** and re-densifies, so the line stays continuous; where vertices
resolve to different plates the interior is a construction and the panel says
so. Distance is true great-circle km at the current age (ADR-0043).

**Sampling.** Trilinear for continuous dense Variables, nearest for
categorical-or-sparse — the same expression `volume.ts:133-135` evaluates for
the GPU texture filter. One sample per panel pixel column; decimated (every
~4th column) during a vertex drag, full resolution on release. No-data is
excluded from the interpolation neighbourhood and reported as no-data, never
blended (ADR-0044).

**Panel.** One collapsible panel, rows stacked on a shared along-track axis,
one row per (Readout × Model). Vertical Readouts draw as a true radial wedge
when the depth range is deep enough for sphericity to matter, and as a
rectangle with a stated vertical exaggeration when it is shallow — chosen by
the Readout's depth range, overridable. Section rows use their Variable's own
data ramp; panel furniture follows the Theme (ADR-0038).

**Interaction.** A tool mode, joining tomography's existing
`ToolMode = 'drag' | 'draw' | 'edit'` (`tomography/ui.ts:10`). Click to add
vertices, double-click or Enter to finish, drag a handle to move, right-click
to delete — the Cutaway's vocabulary exactly. GeoJSON import/export for the
line, matching the Cutaway's existing convention, so a Transect can travel
between the browser and `gprm`.

**Geological Section honesty.** v1 grounds on boundary crossings and subduction
polarity only. Crustal thickness is a drawn convention. Every element with no
data behind it is drawn in a schematic register, named schematic individually
in the key, and carries no vertical axis reading (ADR-0045).

## Staged delivery

### Stage 1 — Transect + panel + Mantle Section (tomography)

The shared machinery, validated against the Readout with the least room to
fabricate anything: the section can be compared directly against the Cutaway
Wall rendered beside it, in the same viewer, from the same Volume.

- `core/transect.ts` — vertices, densification, along-track distance, frame,
  GeoJSON in/out. No rendering.
- `core/transectSampler.ts` — the ADR-0044 sampler: a Transect plus a
  `Data3DTexture`/`ResolutionInfo`/`VariableInfo` and a depth range, in;
  a distance × depth array of values-or-NaN, out.
- `core/transectOverlay.ts` — the line, its handles and (later) its Catchment
  swath, drawn with `cutaway.ts`'s horizon-culling and Reference Plate
  reanchoring. Extracting the shared bits out of `cutaway.ts` rather than
  copying them is part of this stage.
- `core/transectPanel.ts` — rows on a shared axis, modelled on
  `timeSeriesPanel.ts`; wedge and rectangle geometries.
- `tomography/` — the tool mode, and one row per loaded Model.

Done when: a line drawn across a slab shows the slab, in the same colours, at
the same place, as the Wall; and three tomography models stack as three rows on
one axis.

### Stage 2 — Grid Track

Cheap once Stage 1 exists: the same sampler at a single depth (or a 2D field),
drawn as a line chart row rather than a section row. Lands in `climate`/
`globe`/`groupGlobe`. This is where multi-Variable rows and the "what does the
y axis show" control get their first real workout.

### Stage 3 — Catchment

Spherical cross-track distance to the **segment**, clamped at the endpoints, so
the catchment is a capsule rather than an infinite band. The swath is drawn on
the globe and caught points are emphasised while uncaught ones dim rather than
vanish — the corridor's result stays checkable against the map instead of being
asserted by a count in a panel. Row y-axis defaults to signed cross-track
offset in km (the one quantity every dataset has by construction, giving a
plan-view strip map) and can be switched to any numeric field the dataset
carries. Half-width is a control, in km.

### Stage 4 — Geological Section

Crossings from the boundary layer's own vertex buffer
(`boundaries.js`'s flat `xyz` plus per-feature `offset`/`count`/`type`/`side`),
intersected against the densified Transect on the sphere; vergence from the
ported `get_subduction_polarity()` logic; continental/oceanic from
`staticPolygons.ts`. Lands in the reconstruction/oldmap wrappers — **not** in
tomography, which has no Reconstruction Model and therefore no `continental`
flag (ADR-0045).

## Open questions, deliberately not resolved

- **What `'edit'` means once there are two editable objects.** Tomography's
  tool menu currently has one `'edit'` mode operating on Cutaway vertices.
  Whether the Transect gets its own combined draw-and-edit mode, or `'edit'`
  becomes polymorphic over whichever object is active, is an implementation
  decision — with a known trap: never guard a no-op check on the same property
  a lil-gui dropdown is bound to.
- **Where the wedge/rectangle threshold falls**, and whether the override is a
  per-Readout or per-panel control.
- **Camera alignment to a Great-Circle Transect's plane.** The plane exists and
  the case is named for this reason, but flying the camera onto it (and what
  happens to that view when a second vertex makes it non-planar) is not
  designed.
- **Whether the Geological Section's Moho graduates.** Airy isostasy from
  topography, per `gprm`'s `topo2moho` (reference depth 22 km, ρc 2200) with
  oceanic crust at seafloor−6 km, is the obvious path from drawn to derived,
  and would move the Moho out of the schematic register. Needs the topography
  and seafloor-age layers (`muller2019-age-heatflux`, `cao2024-age-heatflux`)
  wired into the Readout first.
- **CSV export of sampled values.** Agreed as desirable, not agreed as v1. It
  needs the sample-spacing convention written into the header to be
  reproducible, which is a small spec of its own.
- **Named/saved Transects.** One live Transect is the v1 rule (ADR-0042). A
  family of parallel sections across a margin is a real analytical want; it
  needs a list UI, per-Transect identity and a way to tell lines apart on the
  globe, and none of that is designed.
- **Whether this is ever generator-exposed.** `GlobeTool` (`core/tools.ts`) is
  a fixed allowlist mirrored in `generator/validateRecipe.mjs`. A Transect tool
  could join it, but — as with vertical-profile clustering — it may be a
  test-viewer feature first and a recipe feature only once it has earned it.

## Explicitly not decided

Whether the Geological Section eventually justifies its own wrapper with a
full-width section panel instead of a box beside a globe. The first version
deliberately lives as a tool on existing wrappers; if the cartoon turns out to
want the whole screen, that is a promotion to argue for later, the way
`reconstructionGroup` was promoted from a one-file harness.
