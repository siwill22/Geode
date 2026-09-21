# Tree Node positions reproduce gprm's discontinuities rather than smoothing them

A Tree Node sits at the boundary centroid of its plate's largest polygon —
`gprm.utils.platetree.get_polygon_centroids()`'s definition. That definition is
discontinuous in age, badly, and this ADR records the decision to keep it.

## What was measured

`get_polygon_centroids()` chooses each plate's largest polygon **independently
at each age**. Over Müller 2019, 0–240 Ma at 1 Myr:

- The chosen polygon's identity switches between adjacent ages **94 times,
  across 55 of 397 plates**.
- The worst resulting node jumps are **58.81°** of arc (plate 301, 2→3 Ma),
  31.57° (plate 901, 110→111 Ma) and 22.59° (plate 983, 86→87 Ma).
- When the choice does *not* switch, a node moves by a median of **0.23°** per
  1 Myr step (p99 0.999°) — ordinary plate motion.

So on a scrubbable age slider a node teleports roughly a quarter of the way
around the globe, dragging its Tree Links with it, about 94 times over the
model's range. On gprm's static snapshot plots this is invisible; in a viewer
it is the dominant visual artefact.

## The decision

**Reproduce gprm exactly, jumps included.** Considered and rejected:

- **Pin one defining polygon per plate for all time** (largest by present-day
  area, which is rotation-invariant and so well-defined). Continuous by
  construction while that feature is valid. Rejected because the reference
  implementation's per-age choice handles edge cases — polygons entering and
  leaving validity, plates whose coverage is rebuilt from different features in
  different eras — that a pinned choice would silently get wrong in ways nobody
  would notice, and because it would make node positions unverifiable against
  the one implementation that is known to work.
- **Area-weighted centroid of all the plate's valid polygons.** Smoother, but
  still steps when a polygon enters or leaves validity, and it can place a
  node in open ocean between a plate's fragments — a position the plate has no
  crust at.
- **Largest continental polygon only.** Fewer candidates, so fewer flips, but
  plates 901 and 983 — two of the three worst offenders — are oceanic and would
  lose their node entirely.

The general principle: where a reference implementation exists and is the
source of the algorithm, parity is worth more than an improvement we cannot
check. An improvement can be made later against a known-correct baseline;
without the baseline there is nothing to make it against.

**The discontinuity is shown, not hidden.** It is a property of the definition,
so a viewer that quietly smoothed it would be misrepresenting what gprm
computes. The ages at which a node's defining polygon switches are known at
export time and can be surfaced rather than papered over.

**A Tree Node has two halves that behave differently.** *Which* polygon defines
it is discrete and snaps to an exported age, the way a Boundary Frame does.
*Where* that polygon's centroid sits is continuous in Reconstruction Age, the
way a coastline vertex is. Conflating them is what produces either a node that
jogs between exported ages for no reason (if both are treated as discrete) or a
tie broken differently from pygplates (if both are treated as continuous). See
ADR-0042 for the export that keeps them apart.

**One fidelity detail.** pygplates' `get_boundary_centroid()` is arc-length
weighted around the ring; `core/staticPolygons.ts`'s existing
`polygonCentroid()` is the normalised vertex mean, and the two differ on a ring
with uneven vertex spacing. A `polygonBoundaryCentroid()` is needed alongside
the existing function so that "same node positions as gprm" is a checkable
claim rather than an approximately-true one.

## Consequences

- The check script compares node positions against `get_polygon_centroids()`
  to a tolerance, which is only meaningful because the defining polygon is
  exported rather than re-chosen in the browser (ADR-0042).
- A future session tempted to "fix" the teleporting nodes should read this
  first: the fix is known, it was rejected deliberately, and reversing that
  needs a reason beyond the jumps looking wrong — they *are* wrong, and they
  are what the reference computes.
- `core/staticPolygons.ts` gains `polygonBoundaryCentroid()`. The existing
  `polygonCentroid()` keeps its current callers and meaning.
