# A Plate-Frame Transect rotates its vertices, not its samples

A Transect drawn in a viewer with an age slider has to answer what happens when
the age is scrubbed. Following ADR-0025/0027's existing pair, there are two
modes: an **Anchored Transect** stays at fixed lon/lat while the continents move
under it, and a **Plate-Frame Transect** rides the plates so a section drawn
across a margin stays across that margin.

Anchored is the default and needs no further design — it is the Cutaway's
present behaviour and the only sane answer for tomography, which has no age at
all. Plate-Frame is the one with a hidden question, and this ADR answers it.

## The question nobody asks until it is wrong

A Plate-Frame Transect is **not a great-circle arc at any age but the one it was
drawn at.** Its vertices sit on plates that rotate independently; the path
between them is no longer whatever it was.

So there are two defensible constructions, and they produce visibly different
objects:

1. **Rotate the vertices, re-densify.** Only the N vertices carry plate
   assignments. At each age their rotated positions are joined by fresh
   great-circle arcs. The Transect stays one continuous, smooth line.
2. **Rotate every densified sample by its own plate.** Each of the hundreds of
   sample points is assigned and rotated individually. Every sample is then a
   material point, truthfully placed — and the line *tears* into disjoint
   pieces wherever it crosses a plate boundary, with gaps at divergent
   boundaries and overlaps at convergent ones.

## The decision

**Rotate the vertices and re-densify.** The line stays continuous at every age.

The cost is real and must be stated rather than hidden: **where two vertices
resolve to different plates, the interior of the line is a geometric
construction, not a set of material points.** It is where the great circle
between two rotated endpoints happens to fall, which is not where the rock that
was there originally went.

Construction (1) was chosen because option (2) makes every Readout's domain
discontinuous, and none of them want that. A section row would be a row of
fragments separated by gaps of unknown width; the along-track axis would run
backwards across an overlap at a convergent margin; the Catchment's capsule
would become a union of capsules with double-counted samples in the overlaps.
The whole feature would be paying, in every Readout, for a fidelity that
matters at exactly one place on the line.

The third option — refusing a Plate-Frame Transect whose vertices span plates —
removes the fiction completely and also removes the across-a-margin section that
is the entire reason plate-frame mode exists. Rejected for that reason alone.

**Mixed-plate transects are therefore labelled, not prevented.** When a
Plate-Frame Transect's vertices do not all resolve to one plate, the panel says
so. This is the same discipline as `CONTEXT.md`'s Anchored Point rule of
reporting the cell's own centre rather than the click coordinate: the
approximation is fine, silently presenting it as something better is not.

## Consequence: what the distance axis means

The distance axis is **true great-circle arc length at the current age**,
recomputed every age.

This means the axis physically lengthens as a margin extends and shortens as it
converges, so two ages' panels do not share an x-range. That is the correct
trade: the change in length *is* the signal — it is the extension — and an axis
that hid it would be hiding the one thing a plate-frame section is for.

The alternatives both preserve comparability by giving up kilometres. A material
(Lagrangian) axis, freezing each sample at its reference-age arc length, renders
300 km of newly created ocean as 100 km of axis. A normalised 0–1 axis never
lies but strips the first quantity anyone reads off a section. Both were
rejected; either could be added later as a display option without changing what
a Transect *is*, which is why this ADR is about the construction and not really
about the axis.

## What a Transect does and does not carry

A Transect is a **surface** object: vertices, path, along-track distance, and a
frame (Anchored or Plate-Frame). **Depth belongs to the Readout, not to the
line.** A Grid Track has no depth at all; a Mantle Section wants the Volume's
valid range (clamped the way `Cutaway.update()` already clamps to
`volumeMaxDepthKm` with its margin); a Geological Section wants the top ~65 km.
One depth extent stored on the Transect would force a meaningless value onto
two of the three and couple the other two's ranges for no reason.

## A note on the N=2 case

A two-vertex Transect lies in a plane through the Earth's centre, so its
vertical section is a genuine planar slice and a camera can be aligned to it. A
multi-vertex Transect is a bent curtain with no such plane. This distinction is
worth carrying as a named case (a **Great-Circle Transect**) precisely because
the plane is what makes "this is a slice through the Earth" a true statement
rather than a figure of speech — and under Plate-Frame mode, the N=2 case is
also the only one where re-densification produces a single arc rather than a
chain of them.
