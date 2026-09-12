# Reference Plate Uses a Shared LonLat-Level Rotation, Not a Scene-Graph Transform

We're adding a Reference Plate control (see CONTEXT.md) that reanchors an
entire view — every layer, in both Globe and Plate Carrée Projections — into
an arbitrary plate's frame at the current Reconstruction Age. Changing which
plate is fixed is mathematically a single rigid rotation (compose each
plate's existing rotation, from the table ADR-0001 already established, with
the inverse of the chosen plate's own rotation at that age), so it could be
applied either as one quaternion on a shared parent `Object3D`/`Group` per
viewer instance, or as one shared function
`applyReferencePlate(lon, lat, quaternion) -> (lon', lat')` called at every
layer's LonLat→render-position step. We chose the LonLat-level function so
Plate Carrée is supported by the exact same mechanism as Globe — a flat
equirectangular plane has no rigid 3D rotation to apply, so the Group
shortcut could only ever cover Globe. The cost is touching every layer's
position-generation code (coastlines, static polygons, raster sampling,
Vector Field glyphs/streaks, Tracked Particles, deep-time-map boundaries/
points) instead of a single Group node.

Performance under Plate Carrée (every vertex/instance remapped per frame,
not just a transform on one node) is a known risk, not yet measured. If it
regresses, a Group-transform fast path for Globe only remains available
without changing the LonLat-level function's role as the shared source of
truth — Plate Carrée would keep the general path, Globe would get an
optimization, not a second implementation of the rotation math itself.

## Considered Options

- **Rotate a shared parent Group per viewer instance.** Rejected as the
  general mechanism: no rigid 3D transform exists for a flat Plate Carrée
  plane, so this alone couldn't cover both Projections without two
  divergent mechanisms to keep consistent.
- **Teach each layer to reimplement the rotation independently**, with no
  shared primitive at all. Rejected: five separate implementations of the
  same math, more surface area for drift as new layer types are added.
- **Export a full plate-circuit rotation table at prep time**, so any plate
  id is a valid Reference Plate regardless of whether it has its own
  geometry. Rejected for now: restricting choices to plate ids already
  present in the current Reconstruction Model's `rotations.json` needs no
  prep-side changes and is always answerable from data the client already
  has. Revisit if users need plate ids with no existing coastline/static-
  polygon geometry in a given model.

## Consequences

- Click-to-LonLat handling (Query Point, Plate-Frame Point assignment, VGP
  picking) must apply the *inverse* rotation to recover the true underlying
  LonLat once Reference Plate is not 0 — picking would silently resolve to
  the wrong location otherwise.
- A plate-id → name table (for the autocomplete UI) is needed, checked
  against each model's actual available ids at selection time. **Superseded
  by ADR-0031**: this originally meant hand-curated and shipped
  client-side, independent of Reconstruction Model; that approach produced
  invented, unverified entries (one factually wrong) and, more
  fundamentally, could never be correct across more than one Reconstruction
  Model. Names are now generated per model at prep time from that model's
  own source data, absent entirely for a model whose source has none.
- A Reference Plate whose rotation series doesn't cover the current
  Reconstruction Age (the plate predates or postdates the reconstruction)
  holds its last valid rotation with a warning shown, rather than snapping
  the view to identity — avoids a jarring jump as the age slider crosses the
  boundary.
