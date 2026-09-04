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

## Layer

Which Model is currently loaded onto the globe, switched from a dropdown —
Climate vs Paleogeography today, Monthly vs Ocean Depth in the Valdes/BRIDGE
instance. Not every Layer supports every control: a Layer with no month
axis hides the month slider, a Layer with no time axis at all pins its data
to a single Frame while the Reconstruction Age slider keeps driving
coastlines underneath it regardless (see Reconstruction Age). Distinct from
Variable: switching Layer changes the Model itself — its grid, its Frame
series, its no-data pattern; switching Variable stays inside one Model.

Two Layers can be forced apart by grid alone even within one data source:
Valdes/BRIDGE's Monthly fields (Month axis, every Frame) and Ocean Depth
fields (Ocean Depth axis, annual only) don't share a grid or depth range,
so per the Variable rule below they cannot be Variables of one Model — they
are sibling Layers instead. Monthly is named for its axis, not a physical
domain, precisely because it holds both atmosphere fields (air temperature,
MSLP, wind) and ocean-surface fields (SST, SSS, ocean surface current,
sea-ice drift, streamfunction, mixed-layer depth) that happen to share its
grid and Month axis — a domain-based name ("Atmosphere") stopped being
accurate once BRIDGE's ocean-surface output was folded in alongside it.

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

## No-Data Style

How a cell with no value (NaN) is drawn — transparent, light grey, or white,
switchable at runtime, not fixed per Variable or baked into a manifest.
Distinct from Mask: a cell hidden by a Cutaway has been deliberately removed
from view; a No-Data cell was never computed in the first place. The two can
coincide on screen but are not the same reason for invisibility, and a
Variable that is mostly No-Data (an ocean-only field over land, or vice
versa) needs this to be legible in a way a mostly-populated Variable does not.

Valdes/BRIDGE stays on the `transparent` style, but composites a second,
always-opaque sphere (paleogeography's shaded relief) immediately behind the
primary field rather than actually leaving a hole — see
docs/adr/0015-relief-fill-replaces-transparent-no-data.md. Not a fourth
style: `transparent`'s discard is still what runs, just no longer visible as
a literal gap, and it fixes a real bug in the same move (a discarded,
non-opaque hole let Vector Streaks on the far hemisphere show through).

## Projection

How the globe's surface is mapped onto the screen: **Globe** (a sphere, viewed
with a perspective camera and free orbit) or **Plate Carrée** (a flat
equirectangular plane, viewed with an orthographic camera and pan/zoom, no
rotation). Applies globally — every tiled instance on screen shares one
Projection, the same way they already share one camera. Independent of Model,
Frame, or Reconstruction Age: switching Projection changes how something is
viewed, not what is being viewed.

Coastlines and land fill do not reproject with it yet — their CPU build
pipeline (plate-rotation slerp) is a separate, unrelated piece of work.
Vector Field overlays (glyphs and streaks) do reproject, including their own
Plate-Carrée-only concern of a real antimeridian seam a sphere doesn't have.
More Projections
(Robinson, Mollweide, Spilhaus) are expected later; Plate Carrée is the
first.

## Vector Field

A named pair of Variables (u, v) a Model declares for arrow/streak-style
overlay, distinct from an ordinary scalar Variable painted on the surface —
Wind was the first and, until Valdes/BRIDGE's ocean-surface data, the only
one. A Model may declare several (Monthly declares Wind, Ocean Surface
Current, and Sea-Ice Drift; Ocean Depth declares Ocean Current). Exactly
one is shown at a time, chosen from a dropdown — never overlaid, since
several arrow fields drawn together read as noise, not signal. To compare
two, add a second globe instance and set each to a different Vector Field
rather than looking for a way to show both on one.

Named generically rather than kept as "Wind" once a second Vector Field
existed, for the same reason Layer's Monthly is named for its axis rather
than a domain: the mechanism (one active field, glyph/streak display,
mutual exclusion) has nothing to do with wind specifically, and calling it
Wind after Ocean Current existed would have been the "Atmosphere" mistake
repeated.

## Vector Glyph

One arrow instance in a Vector Field overlay: a fixed position on a
lattice, oriented and scaled each update from the active Vector Field's
(u, v) sampled there. Static — it shows the field's instantaneous shape at
one point, not motion. See Vector Streak for the overlay's other mode.

## Vector Streak

A Vector Field overlay's other display mode: particles seeded at random
positions and advected each frame along a single, unchanging (u, v)
snapshot — whichever month/age frame is currently selected — leaving a
fading world-space trail ribbon tinted by local speed. Mutually exclusive
with Vector Glyph; the two never render together, regardless of which
Vector Field is active.

"Perpetual" in the NASA *Perpetual Ocean* sense: the flow keeps moving even
though the field driving it is one static frame, not a time-evolving
simulation. A particle has a finite lifetime and respawns at a new random
position on expiry — without this, particles drift into convergence zones
(e.g. the ITCZ, or an Ocean Current's own gyres) and pile up there while
divergent regions empty out, so coverage would visibly degrade the longer
the animation runs.

## Time Series (climate)

One area-weighted global-mean point per Frame, for a single Variable of the
active layer/model — a different axis from Reconstruction Age's "what does
the surface look like at this one age": this is "how does the whole-globe
mean of this Variable move across every age at once." Read from the Annual
layer (or the only layer, for a Variable with no month axis), never
whichever month the Reconstruction Age view currently shows — a long-term
overview is a different question from an instantaneous snapshot, and tying
it to the scrubbable month would mean recomputing on every drag for a chart
meant to be computed once and left alone. Undefined (not zero) for a Frame
where the model's own validity mask covers every texel; never computed for a
categorical Variable (Koppen), whose class indices have no meaningful mean.

## Month (climate)

The climate viewer's repurposing of a Volume's shared depth axis for a Model
whose Frames vary seasonally rather than by physical depth: index 0-11 are
the twelve calendar months, index 12 is the model's own native annual mean
(not a derived average of the other twelve). Distinct from Ocean Depth,
which reuses the exact same underlying axis machinery for a different Model
to mean literal metres below the sea surface — the two meanings never
coexist within one Model, only across sibling Models of the same source
(see the Valdes/BRIDGE instance).

## Ocean Depth

Real depth in metres below the sea surface — the shared depth axis's
meaning for an Ocean Layer's Model, as opposed to Month. Populated only as
an **annual mean**: BRIDGE's ocean archive has no monthly 3D fields
(confirmed directly against the source server — the monthly ocean file
carries a single surface level only, the depth-resolved file exists
annual-only). Distinct from Month, which the same axis machinery means for
a Monthly Layer.

## Vertical Velocity (ocean)

Ocean upward/downward flow — positive is upwelling, negative is
downwelling. Physically defined at the interfaces *between* Ocean Depth's
levels, not co-located with Temperature/Salinity/Current at those levels.
Stored anchored to the shallower level of each interface (level *i* holds
the flow crossing into the level below it), leaving the deepest level
undefined — nothing lies below it to flux into. A deliberate
visual-completeness-over-physical-precision choice, favouring the
scientifically interesting near-surface upwelling patterns (equatorial,
coastal) over strict co-location or full-depth coverage at the physically
quiet abyssal bottom (see ADR-0010). The half-level offset is recorded in
the variable's own metadata so a future vertical-profile consumer can
correct for it rather than assume co-location.

## Query Point

A user-chosen (lon, lat) and the Variable values read from the
currently-loaded Model(s) there. The concept starts at a `LonLat` — however
a viewer turns a screen click into one (raycasting against whatever mesh is
currently pickable) is not part of it, and stays that viewer's own
responsibility, the same way the tomography viewer's Cutaway tool already
owns its own click-to-`LonLat` step. Two distinct shapes exist under this
term (Month Profile, Age Series); there is no combined query across both
axes at once.

## Anchored Point

A Query Point whose grid cell is held fixed in the Volume's own grid frame
across every Frame — the same cell is read regardless of age, with no plate
machinery involved. Honours the Model's own validity mask, reporting no
value (never a fabricated one) for a Frame where the cell is masked — the
same rule Time Series (climate) already follows, applied per cell instead
of per globe. Snaps to the nearest grid cell using the same convention
Vector Glyph and Vector Streak already sample by, and reports that cell's own centre
back to the caller rather than only the raw click coordinate, since at 1°
resolution the two can visibly disagree. Unlike Time Series (climate), an
Anchored Point never reduces multiple cells together, so nothing stops a
categorical Variable (Köppen) from being queried this way — the mean-of-
class-indices problem that excludes Köppen from Time Series doesn't exist
here.

_Future work, not yet decided:_ nearest-cell snapping is a placeholder for
continuous Variables — bilinear interpolation over the four nearest cells
would be preferable, gated on the same `categorical` / no-data-sentinel
distinction the manifest already carries for GPU texture filtering, since
blending across a class boundary or a sentinel cell fabricates a value the
same way it would on the GPU path.

## Month Profile

An Anchored Point query answering "how does this cell vary across the
calendar": all layers of the Volume's depth axis (twelve Months plus
Annual, see Month (climate)) at the currently-loaded Frame, read from the
texture already resident for display. Costs no network request beyond what
showing that Frame already paid for.

## Age Series (point)

An Anchored Point query answering "how has this cell changed across
geological time": one value per Frame of the active Model, Annual layer
only — never whichever Month is currently selected, for the same reason
Time Series (climate) reads Annual only. _Avoid_: "Time Series" alone for
this — that term already names the area-weighted global mean; qualify as
"Age Series" to keep the two apart, since they answer different questions
from what looks like the same axis.

## Plate-Frame Point

A Query Point whose grid cell is *not* fixed: pinned to a specific Plate at
a reference age, then re-expressed in grid space at every other Frame via
that plate's absolute rotation — the same rotation mechanism the coastline
pipeline already supplies (see ADR-0001's rotation table), applied to an
arbitrary point instead of a coastline vertex. Assigning the reference
Plate itself requires point-in-polygon testing against plate polygon data
the archive does not yet carry — nothing today gives an arbitrary clicked
point a plate id the way coastline features already carry one from their
own source shapefile. Not yet implemented; see
`docs/plans/plate-frame-point.md`.

"No plate contains this point at this age" is an expected outcome of the
query, not an error condition — a point on crust that has since subducted,
or outside reconstructed polygon coverage, simply cannot answer for some
ages in a series and must say so per-age, not fail the whole query.

The word "Frame" here means reference frame, as in a plate's own frame of
reference — a second sense of the word that coexists with Frame's other
meaning (one volume within a Model, tagged with an age) without replacing
it: a Plate-Frame Point's grid position is recomputed once per per-age
Frame.
