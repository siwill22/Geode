# Geode — Domain Glossary

Vocabulary for the 3D mantle volume viewer. Glossary only — no implementation
detail, no spec content. The spec lives in `tomography-globe-viewer-spec.md`.

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

## Wall

The surface exposed by a Cutaway: the vertical curtain hanging from the surface
down to the cut depth, along the Cutaway polygon boundary. What the Volume is
actually painted onto.

## Mask

The rasterised footprint of the Cutaway polygon, used to hide the parts of the
surface and coastlines that fall inside it. An implementation of the Cutaway's
effect on the surface, not a separate concept from it.
