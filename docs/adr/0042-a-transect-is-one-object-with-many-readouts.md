# A Transect is one object, and everything it feeds is a Readout

Four separate requests arrived as one feature: sample a tomography model down a
line, read grid values along a line, find samples within some distance of a
line, and draw a stylized geological section from the plate boundaries a line
crosses. They share the phrase "along a line" and nothing else — different
data, different viewers, different units, different vertical axes.

The decision is to treat the line itself as **one domain object, a Transect,
owned by `core/`**, and everything computed from it as a **Readout** that
consumes it. A Transect knows its vertices, its densified great-circle path,
its along-track distance, and how to sample a Volume. It knows nothing about
mantle sections, colour ramps or subduction cartoons.

## Why not four features

The alternative — each viewer grows its own line tool tuned to its own data —
is genuinely cheaper for the first one and genuinely worse by the third. The
cost is not duplicated click handling; it is four independent answers to
questions that have exactly one correct answer each:

- **What is the distance axis?** Great-circle arc length, densified at what
  step, measured from which end. Two readouts that disagree here cannot be
  stacked on a shared axis, and the disagreement is invisible until someone
  measures a feature off two panels and gets two numbers.
- **What happens at a plate boundary in plate-frame mode?** ADR-0043 resolves
  this once. Four implementations would resolve it four ways, and three of them
  would resolve it by not noticing the question.
- **What does a click mean?** The Cutaway already owns a click-to-`LonLat`
  raycast (`tomography/instance.ts`'s `pickLonLat`), and `CONTEXT.md`'s Query
  Point entry already declares that turning a screen click into a `LonLat` is
  the *viewer's* responsibility, not the concept's. A Transect inherits that
  division unchanged.

This is the repo's standing engine-vs-wrapper rule applied to a feature that
arrived pre-split into four wrappers. `core/` stays generic; each wrapper opts
in to the Readouts it can actually serve.

## Why not extend the Cutaway

A Transect is very nearly an open Cutaway, and the temptation to reuse the
Wall wholesale is real: `tomography/cutaway.ts` already densifies a polygon
along great circles, hangs a curtain of `WALL_ROWS` from the surface to a
depth, rasterises a mask, and drags vertices.

But the Cutaway's meaning is *removal* — `CONTEXT.md` defines it as "the region
of mantle removed from view", and its Mask exists to hide surface and
coastlines inside it. A Transect removes nothing. Binding the generic concept
to the polygon-removal semantics would mean every Readout inherits a Mask it
must ignore, an `inverted` flag that has no meaning for a line, and a Cut Depth
that ADR-0043's surface-line-plus-per-Readout-depth split deliberately
separates. The Wall stays what it is: a Cutaway feature.

What is reused is the *vocabulary*, not the object. Transect drawing joins the
existing `view.tool` selector and behaves identically — click to add, drag a
handle to move, right-click to delete, great-circle densification of what is
shown so the drawn line is the line that will be sampled.

## What follows

- **One live Transect at a time**, like the single Cutaway. Drawing a new one
  replaces it. This keeps the panel dimensioned by Models × Readouts rather
  than Models × Readouts × Transects, and keeps "which line is this row from?"
  from ever being a question a reader has to ask. Named, saved Transects are a
  later feature if they earn it, not a shape the first version has to admit.
- **A Transect is shared across a multi-globe's synced instances**, not held
  per tile. One line, many rows: the same Transect read through SEMUCB, UUP07
  and REVEAL is the strongest thing this feature does, and it only works if the
  line is common. This does not make it a Synced Field in `CONTEXT.md`'s sense
  — there is no per-instance value being broadcast, because there is only ever
  one value.
- **Readouts render into one shared panel** with a common along-track axis,
  built on the pattern `core/timeSeriesPanel.ts` already established (a
  collapsible box of per-row canvases that owns no domain knowledge and is fed
  by its caller). Each section row keeps its Variable's own data ramp; panel
  furniture follows the Theme, per ADR-0038.
- **The line is exportable as GeoJSON**, in and out, reusing the Cutaway's
  existing convention (`tomography/instance.ts`). This is not a convenience
  feature: the Python that already does this analysis
  (`gprm.CrossSection`, `gprm/utils/spatial.py`'s
  `plate_boundary_intersections`) takes and returns exactly this, so a line
  drawn in the browser can be handed to a notebook and back.
