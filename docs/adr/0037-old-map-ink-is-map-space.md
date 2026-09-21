# The Old Map viewer's ink is measured in kilometres, not pixels

The Old Map viewer (`docs/plans/old-map-viewer.md`) draws a reconstruction as an
engraved chart: a graded wash along the coast, nested rings offshore, and
hachured mountain glyphs. The source notebook computes all three from true
great-circle distance fields — the wash spans 0–400 km inland, the rings sit at
100/200/350/550/800/1200 km offshore.

**The viewer keeps those kilometre values.** A band is 400 km wide, so zooming in
makes it wider on screen exactly as it makes the continents wider. A map does not
change when you look at it more closely.

The conversion is one scale for the whole map, taken from the projection's own
geometry at the current zoom: on a flat map the full width in pixels spans one
equatorial circumference; on the globe the silhouette's radius is one Earth
radius. `npm run check:oldmap` asserts the scale tracks zoom — a 2.5× zoom must
give 2.5× the pixels per kilometre, in both Robinson and the globe.

## What this ADR said first, and why that was wrong

The original decision was the opposite: bands fixed in **screen pixels**, on the
argument that "the wash and rings are decoration, the mountains are a claim", and
that only things making a claim deserve real units. The reasoning was tidy and
the conclusion was wrong, for a reason the argument never considered.

A pixel-fixed band does not merely look different at a different zoom — it
*says* something different. Zoomed out, a 26 px wash might cover 1000 km of
ground; zoomed in, 100 km. The reader is never told the scale changed, so the
map quietly contradicts itself as they scroll. "Decoration" was the right
category for the wash, but decoration drawn over a map still inherits the map's
scale, and the original framing confused "this need not be precise" with "this
need not be a distance at all".

It was also, in the end, *more* code rather than less: pixel constants had to be
retuned per projection to look right, where kilometre constants are simply the
notebook's own numbers and need no tuning at all.

## What is still approximate, stated plainly

One scale for the whole map means the bands track **zoom** but not the distortion
a projection introduces **across** its own map. A band at high latitude in Plate
Carrée is the same width on screen as one at the equator, though the ground
distance it represents is smaller. Correcting that needs a local scale per pixel,
which is real cost for an effect that remains decoration.

The distance field itself is also computed on the projected image rather than on
the sphere, and its resolution is the screen's. Both are fine for a wash; neither
is fine for a measurement.

So the original rule survives, narrowed to what it should always have been about:

- **Nothing drawn by the wash or the rings may be cited as a distance** in a
  legend, a caption, or a readout. They are the right size, not a measurement.
- **The mountains are unaffected and remain the part that makes a claim.** The
  rule — `inland > 300 km AND trench < 800 km`, with decay — runs in
  `prep/prep_oldmap.py` against exact great-circle nearest-neighbour queries
  (measured: 0.000000 m against brute force). It is not approximated, not moved
  into the browser, and not expressed in pixels. Glyph *size* is a ground width
  like everything else here, clamped so a symbol stays legible; glyph *position*
  is geodesic.

## Consequences

- Retuning the look means editing an array of kilometres, with no prep re-run and
  no redeploy of data. This is the main practical payoff and it should be used.
- The bands do not compress toward an orthographic limb, and do not stretch with
  latitude on a flat map. Accepted, and the reason the rule above exists.
- Two things genuinely do stay fixed in pixels, correctly: the pen weight of the
  coastline and the half-width of a ring. A pen is a property of the pen, not of
  the ground.
- This is scoped to the Old Map viewer. It is not a precedent for screen-space
  geometry anywhere else in `core/`.

## How the field is built, and two traps in it

Both were found by looking at the built page, and both are worth keeping because
each looked like a data problem rather than a rendering one.

**The transform must be exact Euclidean, not a chamfer.** A ring is a level set
of the distance field, so the field's metric *is* the ring's shape. A chamfer's
octagonal error drew visibly faceted "circles" at any resolution — raising the
resolution changed nothing, because the error is in the metric and not in the
sampling. Felzenszwalb's exact transform is the same O(n) and the lines came out
smooth.

**The land mask must be morphologically closed first.** Merdith2021's continent
polygons are overlapping terranes, and where two abut, their boundaries leave
hairline gaps. Unclosed, each gap rasterizes as an enclosed sea that grows its
own wash and its own rings, and each blinks in and out as sub-pixel geometry
shifts beneath it — which is the flicker this viewer showed for two rounds of
review. Measured at 100 Ma: **61 enclosed bodies of ocean before closing, 10
after**, the survivors being genuine inland seas. `check:oldmap` reports both.
