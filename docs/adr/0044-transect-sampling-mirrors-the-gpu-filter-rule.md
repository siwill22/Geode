# Transect sampling mirrors the GPU's own per-Variable filter rule

A Transect reads the Volume on the CPU, hundreds of times along a line and at
every depth of a section. How it reads a texel that falls between grid cells is
not a free choice, and the reason is that **the same Volume is simultaneously
being read on the GPU, a few pixels away on screen.**

## The decision

The CPU sampler applies the branch `core/volume.ts:133-135` already computes:

```ts
const categorical = ... ?? false;
const sparse = manifest.no_data_sentinel !== undefined;
const filter = (categorical || sparse) ? NearestFilter : LinearFilter;
```

Trilinear interpolation for a continuous, dense Variable; nearest texel for one
that is categorical **or** declares a no-data sentinel. Not a parameter, not a
control — the same expression, evaluated once and used by both paths.

## Why the rule is already correct

Both halves of it were derived for reasons that apply identically on the CPU,
and `volume.ts` states them at the point of decision:

- **Categorical.** Texel values are class indices, so blending two neighbouring
  Köppen classes yields "a meaningless third class rather than an in-between
  physical value."
- **Sparse.** Linear-blending a real value against the sentinel "fabricates a
  plausible-looking intermediate colour at every boundary, which
  `core/material.ts`'s sentinel check would then fail to catch (a blend is
  almost never exactly the sentinel value)."

That second failure is *worse* on the CPU, not better. On the GPU a fabricated
blend is a wrong pixel at a coastline. In a Transect Readout it is a number: it
can be hovered, read off an axis, and exported to CSV. Re-deriving the rule per
call site is how the two paths drift apart, and the drift would be silent.

## Why not simply "always nearest"

Nearest sampling is what `core/queryPoint.ts` does today, and `CONTEXT.md`'s
Anchored Point entry already flags this as a placeholder: "bilinear
interpolation over the four nearest cells would be preferable, gated on the same
`categorical` / no-data-sentinel distinction the manifest already carries for
GPU texture filtering."

This ADR is that gate, arriving in the place where it matters most. A single
point read as nearest is defensible — the Anchored Point entry also requires
reporting the sampled cell's own centre, so the user is told exactly which cell
answered. A *line* read as nearest cannot do that: a 1° model sampled at one
sample per pixel column produces visible staircase blocks, and blocks read as
structure in the data. The panel would be showing quantisation of the sampling
grid next to a globe showing the smoothly-filtered same field, and the two
pictures would disagree about where a slab edge is.

Always-interpolating fails the other way, for the reasons above. The manifest
already knows which Variables can safely be blended; nothing else needs to.

## What follows

- **The panel shows what the globe shows.** A Mantle Section is checkable
  against the Wall beside it, which is the whole reason the tomography Readout
  ships first (see `docs/plans/transect-readouts.md`).
- **`queryPoint.ts` should converge on the same helper** when its placeholder is
  eventually resolved, rather than growing a second interpolation policy.
- **Sample density is a display property, not a data property.** One sample per
  panel pixel column, re-sampled on resize, decimated during a vertex drag and
  restored at full resolution on release. The Model's own cell size is stated on
  the panel so dense sampling of a coarse model is never mistaken for resolution
  the model does not have — the same honesty the Anchored Point cell-centre rule
  buys for a single point.
- **A NaN stays a NaN.** Masked and sentinel texels are excluded from the
  interpolation neighbourhood rather than blended, and a sample with no valid
  neighbour is reported as no-data, never as a fabricated value. This is the
  rule `core/timeSeries.ts` and `core/queryPoint.ts` already follow; sampling
  along a line does not get an exemption because a gap in a section looks worse
  than a gap in a series.
