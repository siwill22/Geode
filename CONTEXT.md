# Geode — Domain Glossary

Vocabulary for Geode's viewers (mantle tomography and paleoclimate). Glossary
only — no implementation detail, no spec content. The tomography viewer's
spec lives in `tomography-globe-viewer-spec.md`.

## Model

A single named 3D field over the mantle, from one published source. Two kinds,
distinguished by whether they vary in time:

- **Tomography Model** — one static volume representing the present day.
  REVEAL, SEMUCB-WM1, S40RTS. Always exactly one Frame.
- **Convection Model** — a sequence of volumes representing a simulation
  evolving through geological time. Müller 2022 OPT1 and siblings. Many Frames.

## Frame

One volume within a Model, tagged with the age it represents. A Tomography
Model has a single Frame at 0 Ma. The distinction between a Model and its
Frames exists so that a Tomography Model and a Convection Model are the same
kind of thing to everything downstream of ingest.

## Reconstruction Age

**Continuous**, in Ma, present = 0 and deeper time increasing. The age the
*surface* is drawn at: it selects which reconstructed coastline geometry
appears on the globe. It is a property of the view, not of any Model, and it
remains meaningful when the loaded Model is a static Tomography Model.

## Frame Index

**Discrete.** Identifies which Frame of a Convection Model is currently
rendered. Derived from Reconstruction Age by nearest available Frame age, never
set directly.

Reconstruction Age and Frame Index are deliberately separate concepts. They
were conflated in an earlier draft as a single "time slider", which hid the
fact that one is continuous and the other snaps to a model-specific, irregular
list of ages. When they disagree, the disagreement is shown, not smoothed over.

## Variable

One physical field carried by a Model — Vs anomaly, Vp anomaly, density. A
Model is a *source*, not a source-and-field pair: REVEAL is one Model carrying
several Variables, not seven Models. Variables of a Model share a grid and a
depth range, so switching between them changes what is painted on a Cutaway
without changing its geometry. They do not share units, Colour Polarity or
sensible colour ranges.

## Colour Polarity

What a **high** value of a Variable means physically, and therefore which end of
a diverging colour ramp must be warm.

- *fast* — high means seismically fast, so high means **cold**: velocity anomaly.
- *hot* — high means hot: temperature anomaly.

A subducted slab is a positive anomaly under one and a negative anomaly under
the other, so this cannot be derived from the Model, the units, or the data. It
is declared per Variable and carried through to the ramp.

Not to be confused with **Subduction Polarity**, which is unrelated. The bare
word "polarity" is avoided for this reason: both meanings appear in this project,
both are binary, and both are invisible when wrong.

## Subduction Polarity

Which side of a trench the overriding plate lies on, named relative to the
**vertex order** of the line as stored: `Left` or `Right`. It is what the
direction symbols on a plate boundary encode, and it is a property of the
geometry as written, not of the map — reversing a line's vertex order reverses
its Subduction Polarity without changing where the trench is.

## Boundary Frame

The resolved plate topologies at one time, as a set of lines each carrying a
boundary type and, for trenches, a Subduction Polarity.

Unlike coastlines, Boundary Frames are **not interpolatable**: resolved
topologies change discontinuously, segments appear and vanish at triple
junctions, and the feature count can halve between adjacent frames. There is no
correspondence between one frame's features and the next's, so they are shown
with hard cuts.

## Appearance Age / Disappearance Age

The bounds of a coastline feature's lifespan. Because ages increase into the
past, the **Appearance Age is the larger Ma value** — the moment the feature
comes into existence — and the Disappearance Age is the smaller. A feature is
drawn only when the Reconstruction Age falls between them.

The words "earlier" and "later" are avoided throughout for these: earlier in
geological time means a *larger* number, which reads backwards to most people
and has caused the test to be written inverted more than once.

## Volume

The regularly gridded, resampled 3D array that a Frame becomes after ingest —
equirectangular in longitude and latitude, uniformly spaced in depth. The
canonical form everything in the viewer consumes. A Volume is always uniform in
depth even though no source model on disk is.

## Cutaway

The region of mantle removed from view so the interior can be seen. Defined by
a closed spherical polygon and a depth to which the removal extends.

## Cut Depth

How deep the Cutaway removes material. Distinct from the Isosurface Depth
Range: this one takes material away, that one bounds a search. Both are depths
in km and neither is a synonym for the other.

## Isosurface

The surface of constant Variable value within a Volume. Unlike the Wall and the
floor, it is not a piece of geometry the Volume is painted onto — it is found
by searching the Volume, and it exists wherever the Variable takes that value.
Up to two are shown at once, one enclosing cold material and one hot. They can
never intersect.

## Isovalue

The Variable value an Isosurface traces, in that Variable's own units. The two
Isovalues are independent: a downwelling and an upwelling are unrelated objects
at unrelated magnitudes, and one is not the other's mirror.

## Isosurface Depth Range

The radial shell within which Isosurfaces are searched for. Not the whole
mantle by default: an Isovalue that resolves deep structure also encloses the
whole lithosphere, which would wrap the globe in a solid shell and hide
everything inside it. See Cut Depth for what this is not.

## Wall

The surface exposed by a Cutaway: the vertical curtain hanging from the surface
down to the cut depth, along the Cutaway polygon boundary. What the Volume is
actually painted onto.

## Mask

The rasterised footprint of the Cutaway polygon, used to hide the parts of the
surface and coastlines that fall inside it. An implementation of the Cutaway's
effect on the surface, not a separate concept from it.

## Projection

How the globe's surface is mapped onto the screen: **Globe** (a sphere, viewed
with a perspective camera and free orbit) or **Plate Carrée** (a flat
equirectangular plane, viewed with an orthographic camera and pan/zoom, no
rotation). Applies globally — every tiled instance on screen shares one
Projection, the same way they already share one camera. Independent of Model,
Frame, or Reconstruction Age: switching Projection changes how something is
viewed, not what is being viewed.

Coastlines and land fill do not reproject with it yet — the first cut only
reprojects the Volume-derived surface. More Projections (Robinson, Mollweide,
Spilhaus) are expected later; Plate Carrée is the first.

## Wind Glyph

One arrow instance in the paleoclimate viewer's wind vector-field overlay: a
fixed position on a lattice, oriented and scaled each update from the wind
(u, v) sampled there. Static — it shows the field's instantaneous shape at
one point, not motion. See Wind Streak for the overlay's other mode.

## Wind Streak

The wind overlay's other display mode: particles seeded at random positions
and advected each frame along a single, unchanging (u, v) snapshot — whichever
month/age frame is currently selected — leaving a fading world-space trail
ribbon tinted by local speed. Mutually exclusive with Wind Glyph; the two
never render together.

"Perpetual" in the NASA *Perpetual Ocean* sense: the flow keeps moving even
though the field driving it is one static frame, not a time-evolving
simulation. A particle has a finite lifetime and respawns at a new random
position on expiry — without this, particles drift into convergence zones
(e.g. the ITCZ) and pile up there while divergent regions empty out, so
coverage would visibly degrade the longer the animation runs.
