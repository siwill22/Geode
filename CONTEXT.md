# Geode — Domain Glossary

Vocabulary for Geode's viewers (mantle tomography, paleoclimate, crustal
deformation, and the generated globe viewers built from the catalog). Glossary
only — no implementation detail, no spec content. The tomography viewer's
spec lives in `tomography-globe-viewer-spec.md`.

## Model

A single named field from one published source, gridded as one or more
Frames — a *numerical* Model is a simulation's or inversion's output (mantle
tomography, mantle convection, paleoclimate, crustal deformation); a Model is
never itself a Reconstruction Model, ore-deposit/fossil-occurrence dataset,
or other non-gridded catalog resource (see below). Two independent axes
distinguish Models from each other — do not conflate them:

- **Time-variance**: a **Tomography Model** is one static volume representing
  the present day (REVEAL, SEMUCB-WM1, S40RTS — always exactly one Frame); a
  **Convection Model** is a sequence of volumes evolving through geological
  time (Müller 2022 OPT1 and siblings — many Frames). Paleoclimate and
  crustal deformation Models are also usually many-Frame.
- **Reconstruction-dependence** (see Reconstruction Model): a **reconstruction-
  dependent** Model (convection, paleoclimate, crustal deformation) MUST
  declare exactly one Reconstruction Model (never inferred from the Model's
  id/name — see ADR-0004), and the viewer must show it only under that
  Reconstruction Model's own coastlines/Boundary Frames — showing it under a
  different one silently misplaces continents relative to where the Model's
  own data says they are. A **reconstruction-independent** Model (Tomography
  today) has no such constraint, but for the opposite reason from "doesn't
  need one": its own data represents the present day only, and every
  Reconstruction Model agrees on where continents are at present day, so it
  may be shown under ANY Reconstruction Model's coastlines validly, not none
  of them. A Reconstruction Age slider offered alongside a reconstruction-
  independent Model, if present, drives only that reconstruction's coastline
  scrubbing and (for Tomography) the sinking-rate depth calculation — never
  which Frame is loaded, since a reconstruction-independent Model always has
  exactly one.

## Reconstruction Model

A named plate-tectonic reconstruction — rotation files, coastline geometry,
and Boundary Frames (resolved topologies) — independent of any one numerical
Model. Cao2024, Müller 2019, Müller 2022, and the Scotese plate model are
each one Reconstruction Model. Many numerical Models may declare the same
Reconstruction Model (Cao2024's own Deformation and Age & Heat Flux Models
both declare Cao2024; OPT1 declares Müller 2022) so the underlying
rotation/geometry data is stored once, not duplicated per Model — see
Reconstruction-dependence above for the rule this makes possible to enforce.

A first-class catalog entity since ADR-0021: `archive.json`'s
`reconstruction_models[]` array gives each one its own id, display name,
citation, and `path` to a `reconstructions/<id>/manifest.json` carrying its
own `has_boundaries`/`has_static_polygons` facts — no longer a bare name
matched by lowercase key against a directory-discovered coastline bucket.
Müller 2019, Scotese, and Seton et al. 2012 are the three entries today.

A Reconstruction Model's two assets — coastline geometry and Boundary
Frames — are independently optional. Every Reconstruction Model that
reaches the catalog has coastline geometry; Boundary Frames are a separate,
sometimes-permanent absence, not a "not yet exported" gap in general.
Checked directly, not assumed: Scotese's own reconstruction resolves no
topological plates at all (only present-day continents, rotated back
through time by absolute rotation), so it can never gain Boundary Frames no
matter how much more prep work runs, while Müller 2019 and Seton et al.
2012 both genuinely have them and have since been exported. See
`docs/adr/0019` for the full reasoning and the rule this implies for any
catalog metadata or UI that lists Reconstruction Models.

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

## Reference Plate

Which plate is held fixed as Reconstruction Age changes — every other layer
in the view (coastlines, static polygons, Boundary Frames, VGPs, the Volume
raster, Vector Field glyphs/streaks, Tracked Particles) rotates relative to
it instead. A view setting, not a data setting — it changes how the view is
oriented, not what is being shown, the same distinction Projection already
draws.

Distinct from two existing, easily-confused concepts. It is not the
prep-time `anchor_plate_id` pygplates parameter every Reconstruction
Model's rotation table is exported with (see ADR-0001, ADR-0004) — that
stays fixed at 0, invariant, and never becomes user-facing; Reference Plate
is a further rotation layered on top of that fixed export at view time, the
same way Reconstruction Age is a view setting layered on top of a Model's
own Frames. Nor is it Anchored Point, which fixes a *grid cell* in a
Volume's own frame — Reference Plate fixes a *plate*, with plate machinery
fully involved.

Computed as a single rotation at the LonLat level —
`applyReferencePlate(lon, lat, quaternion) -> (lon', lat')`, from the same
rotation table (ADR-0001) that already drives coastlines and Plate-Frame
Point — and applied wherever any layer turns a LonLat into a render
position, in both Globe and Plate Carrée alike (see docs/adr/0030). Choices
are restricted to plate ids that already have a rotation series in the
current Reconstruction Model's table — the same ids coastlines/static
polygons already carry — so a Reference Plate is always answerable from
data already on the client, never a plate id invented or looked up
separately.

Default is plate 0, matching the prep-time anchor. Holds its last valid
rotation, with a warning, rather than snapping to identity, when the
current Reconstruction Age falls outside the chosen plate's own defined
range. Switching Reconstruction Model keeps the same plate id if it's valid
in the new model, else resets to 0 — a plate id has no guaranteed meaning
across Reconstruction Models, including its NAME: the autocomplete's name
table is generated per Reconstruction Model at prep time from that model's
own source data, not a shared hand-curated list (see docs/adr/0031) — a
model whose source data carries no plate names at all (Scotese) offers
bare numeric plate-id entry only, never an invented name. A Synced Field
(see below), with its own
independent sync toggle.

See docs/adr/0030 and docs/plans/reference-plate.md for the full resolved
design.

## Multi-Globe

Two or more globe instances tiled on one shared canvas and camera, so
rotation and zoom stay locked together for free — each instance still owns
its own Model, Variable, and view state independently (see Synced Field for
what, if anything, is deliberately shared instead). Distinct from Layer,
which switches what one instance shows; Multi-Globe changes how many
instances exist. Available uniformly wherever the underlying instance type
exists, never restricted to a subset of Models/Reconstruction Models on the
grounds that a particular pairing seems less useful (see docs/adr/0017) —
the only thing that can prevent it is a genuine technical conflict (see
docs/adr/0022).

## Synced Field

Which of a globe instance's own state, in a Multi-Globe layout, broadcasts
to every other instance when a "sync" toggle is on, versus stays
independent by default. Reconstruction Age is the canonical Synced Field;
Reference Plate is a second, each with its own independent toggle so age and
reference plate can be synced separately. A
field that defines what is being compared — Layer, Variable, Model or
Reconstruction Model choice — is never syncable: the point of a second
globe is as much "show something different at the same age" as "show the
same thing at a different age," and syncing those away would remove that
option rather than add one. Projection is not a Synced Field at all — it
has no independent per-instance value to sync in the first place; every
tiled instance shares one unconditionally (see Projection).

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

## Time Series

A named scalar plotted against Reconstruction Age, computed once (never
recomputed on every age-slider drag) — a different axis from Reconstruction
Age's "what does the surface look like at this one age": this is "how does
some summary number move across every age at once." What can supply one
depends on the catalog entry, named by **Series Source**: a Model may
declare a **Field Aggregate** series for one of its own Variables (see Field
Aggregate below — the only Series Source implemented today); a
Reconstruction Model may one day declare a **Plate Kinematics** series (RMS
plate velocity, boundary length by type, net rotation — derived from its
rotation model and Boundary Frames, with no Variable involved at all).
Plate Kinematics is named here, not designed or built, specifically so the
concept is never assumed to require a Variable — that assumption would
repeat the mistake ADR-0017 exists to prevent, treating "the only thing
built so far" as if it were a domain constraint (see docs/adr/0023). A
recipe may only request a series its chosen catalog entry actually
declares, the same "derive from the catalog, never invent" rule coastline
pairing already follows (ADR-0004).

## Field Aggregate

The Series Source (see Time Series) implemented today: one area-weighted
global-mean point per Frame, for a single Variable of the active model.
Read from the Annual layer (or the only layer, for a Variable with no month
axis) where the model has one, never whichever month the Reconstruction Age
view currently shows — a long-term overview is a different question from an
instantaneous snapshot, and tying it to the scrubbable month would mean
recomputing on every drag for a chart meant to be computed once and left
alone. Undefined (not zero) for a Frame where the model's own validity mask
covers every texel; never computed for a categorical Variable (Koppen),
whose class indices have no meaningful mean. Originally built only for the
paleoclimate viewer (hence Model+Variable rather than a curated per-source
allowlist); also available on the generator's `single-model-globe`/
`model-group-globe` wrapper types, offered via the `time-series` UI tool
(see docs/adr/0023).

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
same rule Field Aggregate already follows, applied per cell instead
of per globe. Snaps to the nearest grid cell using the same convention
Vector Glyph and Vector Streak already sample by, and reports that cell's own centre
back to the caller rather than only the raw click coordinate, since at 1°
resolution the two can visibly disagree. Unlike Field Aggregate, an
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

A Query Point query answering "how has this cell changed across geological
time": one value per Frame of the active Model, Annual layer only — never
whichever Month is currently selected, for the same reason Field Aggregate
reads Annual only. _Avoid_: "Time Series" alone for this — that term
already names the whole-globe summary-per-age concept (see Time Series);
qualify as "Age Series" to keep the two apart, since they answer different
questions from what looks like the same axis.

Answerable by either query mode (ADR-0027): for an Anchored Point, one
value per Frame with nothing filtered out — the grid cell never moves, so
every Frame has something to report. For a Plate-Frame Point, the same
question but following the assigned material point instead of a fixed
cell — and per Plate-Frame Point's own "cannot answer" resolution, the
series simply stops at the assigned polygon feature's own `beginAge`
rather than reporting a value for a Frame the crust hadn't formed by; no
per-entry outcome needed, since the caller already holds that cutoff and
can render it as a series boundary (a shorter line on the full Model age
range) rather than a gap inside one. In the climate viewer's query panel,
this renders stacked below Month Profile, computed once per assigned point
(a new click, or a layer/variable/climate-model switch) rather than
re-fetched on every age-slider tick — see ADR-0027 for the full reasoning.

## Plate-Frame Point

A Query Point whose grid cell is *not* fixed: pinned to a specific Plate at
a reference age, then re-expressed in grid space at every other Frame via
that plate's absolute rotation — the same rotation mechanism the coastline
pipeline already supplies (see ADR-0001's rotation table), applied to an
arbitrary point instead of a coastline vertex. Assigning the reference
Plate itself requires point-in-polygon testing against plate polygon data —
exported per Reconstruction Model since ADR-0025 (`staticpolygons/geometry.bin`,
via `prep_staticpolygons.py`); a coastline feature, by contrast, already
carries a plate id from its own source shapefile with no separate
assignment step needed. Built and live in the climate viewer
(`core/staticPolygons.ts`, `ClimateInstance.queryPlateFramePointAt()`) as a
"query mode" toggle alongside Anchored Point (ADR-0026); see
`docs/plans/plate-frame-point.md` and ADR-0025/0026/0027 for the resolved
design.

Assignment tests against a Reconstruction Model's **static** polygons only
(ADR-0025) — dynamic/resolved-topology assignment is a distinct, deferred
feature, not an alternate path this primitive picks per Model. That choice
makes "cannot answer" simpler than it first looked: a static polygon is
always crust that survives to present (digitized in present-day space,
then rotated backward), so it can never represent "existed, then was
subducted" — that scenario is structurally impossible here, not merely
unhandled. The only real failure modes are (1) no static polygon covers the
point at the reference age at all — assignment fails outright, once, at
click time, no retry — or (2) an age older than the assigned polygon
feature's own begin age, which needs no per-age re-test: point-in-polygon
containment is invariant under the shared rigid rotation, so the one
assignment made at click time bounds every age in the series at once.

The word "Frame" here means reference frame, as in a plate's own frame of
reference — a second sense of the word that coexists with Frame's other
meaning (one volume within a Model, tagged with an age) without replacing
it: a Plate-Frame Point's grid position is recomputed once per per-age
Frame.

Several GPlates-style features are this same primitive, not separate
concepts: a velocity arrow is a Plate-Frame Point's trajectory expressed as
a derivative instead of a series of positions; a motion path or tectonic
flowline is that trajectory drawn as a line instead of read back as a
Variable value; loading an arbitrary point dataset and reconstructing it
consistently with whatever Reconstruction Model is on screen is the same
per-point assignment-and-rotation applied to many points instead of one,
under the same discipline ADR-0004 already requires (never a rotation/
polygon pair from a different Reconstruction Model than what's displayed).
None of these is built or separately scheduled — the underlying primitive
they'd all be built from (assignment + rotation) is no longer a blocked
dependency now that it exists, just not yet extended past a single click's
Month Profile / Age Series (see docs/plans/plate-frame-point.md,
docs/adr/0024, docs/adr/0025).

**The age-validity half of "loading an arbitrary point dataset" is now
available upstream, even though the feature itself is not built.** A point
older than the static polygon it would be assigned to cannot be validly
reconstructed past that polygon's own begin age (ADR-0025's rule, stated
generally in ADR-0032) — `viewer/vendor/deep-time-map`'s
`points_from_dataframe()` exposes this as `plate_begin_age` on every point
(v0.3.0+) so a future prep script does not need to re-derive it. This is
data availability, not the feature: nothing in `viewer/src` or `prep/`
consumes it yet.

**Correction, from designing Virtual Geomagnetic Pole:** "loading an
arbitrary point dataset" turned out not to be one uniform case. A dataset
whose points are locations *on* a plate (deposits, sample sites) is this
same primitive. A Virtual Geomagnetic Pole is not — see its own entry below
for why assignment and age-semantics both differ — so it is designed
(ADR-0029) as a related but distinct mechanism, not an instance of this one.

## Virtual Geomagnetic Pole (VGP)

A paleomagnetic pole computed from one sampling site's mean field
direction — pole position, sample site position, age, and a confidence
radius (A95), read from a `gpml:VirtualGeomagneticPole` feature (e.g.
`gprm.utils.pmag.vgp_to_dataframe()`). _Avoid_ using "paleomagnetic pole"
interchangeably with VGP: a paleomagnetic pole can also mean a pole averaged
from several VGPs at one geological unit, which this project does not yet
compute (see Apparent Polar Wander Path below).

Not a Plate-Frame Point, despite the family resemblance (per-point plate
assignment, then rotation by that plate's own Reconstruction Model). Two
differences drive different mechanisms: **assignment** is tested against
the VGP's *sample site* position, never its pole position — a pole is not a
location on the plate and has no polygon membership to test, so unlike a
Plate-Frame Point's click-time assignment, a VGP's plate id is precomputed
once per Reconstruction Model, not assigned live. **Age** is not free to
scrub: a Plate-Frame Point's trajectory is meaningful at any age within its
lifespan, but a VGP only means something at its own recorded age — it is
reconstructed to exactly that age (the same anchor-plate-0 convention
coastlines use) and shown only while the Reconstruction Age slider sits
within a fixed window of it (see ADR-0029), never repositioned to track the
slider continuously.

Built on `viewer/vendor/deep-time-map`'s `PointLayer`/`points.json`
pipeline per ADR-0028's split-features rule, not a new Geode `core/`
primitive — see ADR-0029 for the upstream/downstream split, the per-
Reconstruction-Model export granularity, and why VGP display is currently
limited to Reconstruction Models with static polygons exported (Müller
2019, Seton 2012, Scotese).

## Apparent Polar Wander Path

A path built from many VGPs — either a running-mean smoothed curve per time
window, or many VGPs rotated into one common reference plate's frame for
comparison (`gprm.utils.pmag.generate_running_mean_path` /
`rotate_to_common_reference`). Explicitly deferred, not designed — see
ADR-0029's Deferred section. Named here only so "Apparent Polar Wander
Path" is never confused with a VGP itself once this is eventually built.
