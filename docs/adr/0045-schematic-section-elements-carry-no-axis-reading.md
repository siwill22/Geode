# A schematic element is marked as one, and carries no axis reading

The Geological Section Readout draws a cross-section from the plate boundaries
a Transect crosses: trenches with their vergence, ridges, and crust of
plausible thickness either side. It is the most attractive of the four Readouts
and the only one that draws things nobody measured.

## What the data actually knows

Worth stating precisely, because the gap is the whole subject of this ADR. The
vendored boundary export
(`vendor/deep-time-map/js/boundaries.js`, built by `prep/` from GPlates
topologies) gives, per feature:

- `boundary_type` — one of subduction, ridge, transform, other;
- `polarity` — `Left` or `Right` for subduction, naming the side of the line
  the slab descends toward, already verified upstream against resolved plate
  polygons on two independent models;
- reconstructed vertex geometry at the frame's age.

And `prep_staticpolygons.py` gives a per-feature `continental` flag, per
Reconstruction Model, established against each model's own feature types (with
Merdith2021's island arcs counted continental, documented there).

From those, real: **where** the Transect crosses a boundary, **what kind** it
is, **which way** a trench verges relative to the direction of travel along the
line, and **whether** each point along the line is on continental or oceanic
crust.

Not in the data, at all: crustal thickness, Moho depth, slab dip angle,
lithosphere base, sediment, or anything else with a number on a vertical axis.

## The decision

**Every element that is not derived from a loaded layer is drawn as visibly
schematic, and no schematic element may be read off an axis.**

Concretely, for the first version, where crustal thickness is a drawn
convention — continental roughly four to five times oceanic — rather than a
derived quantity:

- schematic elements are drawn in a distinct register (unfilled or dashed,
  never a solid body that reads like a mapped unit);
- the panel's key names them as schematic individually, not once for the whole
  figure;
- the depth axis is drawn **only** for rows whose vertical quantity is real. A
  schematic section gets a scale bar for the horizontal distance, which is
  measured, and no tick labels on the vertical, which is not.

The alternative — the full textbook cartoon with a single "schematic" caption —
is more legible, more immediately publication-like, and was rejected for one
concrete reason: **a reader screenshots the panel and the caption does not
travel with the image.** A section with a labelled depth axis will be measured
off, by someone who was not in this conversation, at some later date. Marking
per element is what survives the crop.

## Why this is a rule and not a preference

The repo already holds this line in two other places. ADR-0035 shows a
diversity curve together with its confound rather than alone. ADR-0038 forbids
a Theme from touching a Variable's data ramp because a decorative control that
can invert a scientific reading is unsafe at any level of care. The failure
mode named there — "a slab rendered in the wrong polarity looks entirely
plausible" — is exactly this Readout's failure mode, since a stylized section
is *designed* to look plausible.

There is also a direct upstream precedent for the one number the cartoon most
wants to invent. The existing Python
(`gprm/utils/paleogeography.py`'s `paleo_age_grid_cross_section`) does not draw
a conventional Moho: it derives one by Airy isostasy from smoothed topography
(`topo2moho`, reference depth 22 km, ρc 2200) and sets oceanic crust to
seafloor depth minus 6 km. That is the difference between a drawn line and a
computed one, and it is the natural upgrade path here — grounded once the
topography and seafloor-age layers are wired into the Readout, at which point
the Moho graduates out of the schematic register and earns its axis.

## What follows

- **The Geological Section requires a Reconstruction Model to be loaded**, for
  the `continental` flag if nothing else. It is therefore unavailable in the
  tomography viewer, which has no Reconstruction Model — this is a real
  capability gap per wrapper, in the spirit of ADR-0019 and ADR-0024, not a bug
  to work around by guessing crust type from bathymetry.
- **Vergence is computed, never chosen.** `gprm/utils/spatial.py`'s
  `get_subduction_polarity()` resolves the trench's `Left`/`Right` property
  against the Transect's own direction of travel at the crossing, yielding
  which way the slab dips *in this section*. That logic is ported, not
  re-derived: it is the one quantity that is invisibly wrong when mirrored,
  which is the same warning `boundaries.js` carries about its own triangles.
- **Slab dip is schematic and stays schematic** until something measures it. A
  fixed drawn angle is honest as a symbol and dishonest as a geometry; it
  therefore gets no angle readout, no depth extent claim, and no tick marks.
- **Export carries the distinction.** A CSV or GeoJSON export of this Readout
  emits crossings, types and vergence — the measured things — and does not emit
  the drawn geometry as if it were a horizon.
