# The Old Map viewer's ink is screen-space; only its mountains are geodesic

The Old Map viewer (`docs/plans/old-map-viewer.md`) draws a reconstruction as
an engraved chart: a graded wash along the coast, nested rings offshore, and
hachured mountain glyphs. The source notebook computes all three from true
great-circle distance fields — the wash spans 0–400 km inland, the rings sit
at 100/200/350/550/800/1200 km offshore.

**The viewer reproduces the wash and rings by stroking the coastline path
repeatedly at increasing `lineWidth`, in screen pixels.** They are not
distances. A band is not 400 km wide; it is 18 px wide, and it stays 18 px
wide at the limb of an orthographic globe where 400 km would have compressed
to nearly nothing.

This is deliberate, and it is the opposite of how the rest of this repo
behaves. Geode is careful about spherical geometry everywhere else — coastline
seam tests, equal-area aggregation cells (ADR-0035), great-circle proximity in
prep. A reader finding pixel-width distance bands here will reasonably assume
it is a bug.

## Why

**The wash and rings are decoration. The mountains are a claim.**

A wash whose width is measured in pixels is a stylistic choice about ink. A
mountain whose position is measured in pixels would be a false statement about
where an orogen stood. Those two things do not deserve the same standard, and
giving them the same standard is what made the first draft of this design
large and wrong.

Holding the line on geodesic correctness for the wash would have cost: a
contour pass per frame in prep, per-frame GeoJSON with a series manifest and a
gzip pipeline, ~1–2 MB of payload, a re-run of prep to retune a colour, and —
worst — hard cuts every timestep against a coastline that glides smoothly,
because `PolygonLayer` slerps between rotation frames while contour sets have
no vertex correspondence between them. The wash would visibly lag and snap
against its own coastline. Screen-space stroking is not merely cheaper; it is
the only one of the two that stays attached to the thing it decorates.

## What stays geodesic

The mountain rule — `inland > 300 km AND trench < 800 km`, with decay — runs
in `prep/prep_oldmap.py` against true great-circle distance transforms over a
global raster, using resolved subduction topologies. It is not approximated,
not moved into the browser, and not expressed in pixels. Glyph *size* is fixed
in screen pixels, like any map symbol; glyph *position* is not.

## Consequences

- Retuning the map's look means editing an array of pixel widths, with no
  prep re-run and no redeploy of data. This is the main practical payoff and
  it should be used — the look is the deliverable.
- The bands do not shrink toward an orthographic limb. On a globe the wash
  will read as slightly too wide near the edge. Accepted.
- Nothing in this viewer's wash or rings may ever be cited as a distance, in a
  legend, a caption, or a readout. If a future version wants to state "400 km"
  anywhere on screen, it must first move to precomputed geodesic contours.
- This rule is scoped to the Old Map viewer. It is not a precedent for
  screen-space geometry anywhere else in `core/`.
