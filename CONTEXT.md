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
with a perspective camera and free orbit), **Plate Carrée** (a flat
equirectangular plane, orthographic camera, pan/zoom, no rotation) or
**Robinson** (a flat compromise projection, same camera treatment). Applies
globally — every tiled instance on screen shares one Projection, the same way
they already share one camera. Independent of Model, Frame, or Reconstruction
Age: switching Projection changes how something is viewed, not what is being
viewed.

**Flat** is the distinction that matters in code, not "is it Plate Carrée" —
ask `isFlat(mode)`. Everything the flat modes share (orthographic camera, an
antimeridian seam a sphere doesn't have, reproject-per-vertex rather than
rotate-in-3D for Reference Plate) they share with each other, and several
places spelled "not globe" as `=== 'plateCarree'` until a second flat
projection made each one a bug (see docs/adr/0036).

Robinson is the first Projection with **no closed-form inverse**: it is
defined by a 19-entry table, so a fragment recovers its latitude by bracketing
that table (Y is strictly increasing, which is what makes this exact rather
than iterative) and its longitude from X at that latitude. It is also the
first that is not **onto**: its boundary is a curve, so a plane large enough to
hold the map has corners that are not on the Earth, and the shader discards
there rather than clamping.

Coastlines **and land fill** now both reproject. Land fill did not until
Robinson arrived — a flat map drew flat coastlines over a spherical blob of
land, survivable only while every flat view had an opaque raster over the whole
sphere. Triangles straddling the antimeridian are dropped rather than clipped,
the same choice the line seam test makes. Vector Field overlays (glyphs and
streaks) reproject too. Mollweide and Spilhaus are still expected later.

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
generally in ADR-0032) — `viewer/vendor/petrify`'s
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

Built on `viewer/vendor/petrify`'s `PointLayer`/`points.json`
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

## Occurrence

One fossil identification, at one place, constrained to an age *interval* —
never a single age. The interval is the data: a fossil is dated by the
stratigraphic unit it came from, so an Occurrence carries a maximum and a
minimum age and the truth lies somewhere between. This makes an Occurrence a
direct fit for `PointLayer`'s `lifespan: 'range'` and a poor fit for anything
expecting a point age.

Like an ore deposit or a sample site, an Occurrence is "a location on a plate"
in Plate-Frame Point's sense — assigned a plate by static-polygon
partitioning, then rotated — not a VGP-like object with its own separate
assignment rule.

_Avoid_ "fossil" alone for this: one Occurrence is a taxon recorded in a
collection, not a specimen, and several Occurrences routinely share a
locality. Designed in `docs/plans/paleobiology-viewer.md`; not built.

## Grouping

A named categorical partition of a point dataset into a small, bounded set of
display categories, each with its own palette. A dataset declares two or three;
exactly one is active at a time, chosen from a dropdown, never overlaid — the
same shape as Vector Field (ADR-0014), and for the same reason.

Bounded is a requirement, not a preference: an aggregate glyph summarising a
cell cannot show an unbounded category set, which is what rules out a free
taxonomic-rank switcher. A Grouping need not be taxonomic at all — the coral
case study groups by subclass, the Panama case study by which side of the
gateway a lineage first appears on.

Maps onto a `points.json`'s existing `points[].type` + `categories` fields, so
it needs nothing new from petrify.

### Observed vs Derived Grouping

Whether a Grouping's categories are **read** from the data or **inferred** by a
rule. "Which side of the gateway this occurrence is on" is observed — it comes
straight from the coordinates. "Which continent this genus came from" is
derived: no source records it, so it is computed (from the continent of the
genus's oldest occurrence) and is only as good as that rule.

The distinction is in the glossary rather than left implicit because a derived
category that looks like an observed one is how a viewer ends up asserting what
it cannot support. A Derived Grouping states its rule in the legend and is
named for what was measured — "first appears in", never "originated in" — and
keeps an explicit `ambiguous` category rather than forcing a call.

## Time Bin

The stratigraphic interval a diversity or composition series is computed over —
ICS stages, of which there are 101 in the Phanerozoic, with durations ranging
from under 1 Myr to 21.6 Myr.

Distinct from **Sampling Step**, and the two must never collapse into one term.
A Time Bin is an analytic unit whose boundaries are stratigraphic and whose
widths are uneven; a Sampling Step is a uniform interval an export is
precomputed at, purely a rendering convenience (cf. the 5 Myr rotation sampling
`prep_boucot.py` already uses). Their unevenness is load-bearing in opposite
directions: a longer Time Bin accumulates more taxa purely by lasting longer,
which is a bias to show rather than hide, while a Sampling Step's uniformity is
what makes it invisible.

The *map* needs neither. At a continuous Reconstruction Age, a cell holds every
Occurrence whose own age interval contains that age — bins are needed only by a
series that requires discrete x-values.

## Aggregation Cell

An equal-area cell on the sphere that Occurrences are binned into for
summary display, one glyph per occupied cell. Equal-area (HEALPix, as
`velocities.json` already samples on) rather than a lon/lat grid, and the
difference is not cosmetic: a lon/lat grid's cells shrink toward the poles, so
counting into one would inflate polar density exactly where a latitudinal
diversity reading is being taken.

Binned in **paleo** coordinates at each time, never present-day ones — a cell
is a region of the reconstructed globe, so which Occurrences fall in it changes
as the plates move.

## Theme

A named, coherent look for the **map furniture** — the page, the water, the
land, the coastline, the plate boundaries, the velocity arrows, the speed ramps
— offered as a quick start, so a view can be asked for in plain language
("something light and warm", "more for kids") instead of assembled piece by
piece. A view has exactly one Theme at a time, shared by every tiled instance.

A Theme is mostly, but not only, colour. It is a colour per Theme Role, plus
three bounded non-colour properties: Lightness, Theme Weight, and Outline
Treatment. Two looks can differ in ink weight alone with no change of hue at
all, which is what "for kids" mostly is, so a colour-only Theme could not
express one.

A Theme is also described by two declared axes — Lightness and a `temperature`
of `warm`, `cool` or `neutral` — so a plain-language request can be *filtered*
rather than guessed at. The Theme set covers every cell of that grid, which is
what stops "light and warm" landing on nothing.

A Theme governs furniture and nothing else. It never reaches the colour ramp a
Variable is painted with: that ramp carries Colour Polarity, which encodes
whether a positive anomaly is cold or hot, so letting a decorative choice touch
it would let "light and warm" silently invert what a reader takes off the
mantle. That boundary is the point of the concept rather than a limit of the
current implementation — a Theme can always be changed without changing what
any value means, which is what makes offering ten of them safe.

An element never names a colour; it names a Theme Role, and the Theme resolves
it. That indirection is what keeps a Theme's promise of coherence true for
elements that did not exist when it was authored.

Distinct from Paper: Old Map is not a Theme and must not become one. It is a
different renderer with its own marks, textures and idiom, not a recolouring of
the default one.

## Theme Role

The named part a drawable element plays in a Theme — page, water, land,
outline, one of a small set of accents, or an end of a speed ramp. Roles are
what a Theme is actually written against: the Theme assigns one colour per
role, and every element claims a role.

Bounded is a requirement, not a preference, for the same reason Grouping's
categories are: whoever authors a Theme has to hold the whole set in mind at
once to judge whether the colours work *together*, which is the only thing a
Theme is for. The accents carry the sharpest version of this constraint — the
four plate-boundary types are told apart by colour alone, so accents that stop
being mutually distinguishable do not merely look worse, they stop conveying
which boundary is which.

## Lightness

Whether a Theme's marks sit on a light substrate or a dark one — `light` or
`dark`, declared once per Theme. The only thing a Theme carries that is not a
colour, and it exists because the difference is not one of hue: on a dark Theme
a mark is lighter than its surround and reads as emitting; on a light Theme it
is darker and reads as ink. An element that swaps only hue between the two is
not off-palette, it is inverted.

_Avoid_ calling this "polarity". Colour Polarity and Subduction Polarity both
already exist, both binary, both invisible when wrong — this would have been
the third, in a glossary that already avoids the bare word for that reason.

Lightness is not only about which colours a Theme picks. It also sets the
*direction* of any derived colour — see Outline Treatment's `shade`, which moves
away from the page and so darkens on a light Theme and lightens on a dark one.

## Theme Weight

How heavily a Theme draws its marks — one scalar multiplying every stroke width
and decoration size at once, so a "for kids" look (thick boundaries, large
subduction triangles) and a dense analytical look are the same Theme machinery
at different settings.

Deliberately one number rather than a width per element. The widths already in
use are *relatively* tuned — subduction heavier than ridge, ridge heavier than
transform — and a single multiplier preserves those ratios by construction,
where per-element widths would let a Theme quietly invert the emphasis. It also
means an element added later is drawn at the right weight without any Theme
being edited, the same guarantee Theme Role gives for colour.

Because it scales every mark uniformly, it cannot distort a size-based data
encoding: a glyph whose area means something still means it, larger.

## Outline Treatment

How a continent's pen relates to its fill — `contrast` (a bright accent against
the fill), `shade` (derived from the fill by moving away from the page colour in
lightness, the classic atlas look) or `none` (no pen; land is separated from
water by fill alone).

A relationship, not a colour, which is why it is a named choice and not simply
another Theme Role. Both a bright-pen annotated-diagram look and a shaded-pen
atlas look were always expressible as two colours; what was missing was any way
to say which of the two a Theme *is*.

`none` is the case that changes what must be checked: with no pen, the land/water
pair carries the whole land-sea distinction and has to be legible on its own,
where in the other two treatments the outline carries it.

Distinct from the runtime **edge toggle**, and the two are separate axes rather
than two names for one switch. Outline Treatment is what a Theme *is* — part of
its authored character, and the thing a `shade` pen derives from. The toggle is
what a reader wants *right now*, and it survives Theme changes. A pen is drawn
only when both agree: a Theme with `none` has no pen colour to draw in, so it
stays bare however the toggle is set, and the toggle's value is remembered for
the next Theme that does provide one.

## Explorer

A viewer page whose structure is a globe, some standard layers, and the controls
to move through time — legend, hover, time slider — with **no authored
narrative**. The reader decides what to look at.

Distinct from a **Narrative** page, where scroll position drives camera and time
through a sequence someone wrote. The difference is not size or sophistication:
it is whether the order of the reading is the author's or the reader's. Two
pages of nearly identical length can be one of each.

The distinction matters because it is the boundary of what can be *generated*.
An Explorer's structure is derivable from what it displays; a Narrative's is
prose plus camera choreography, which is a different authoring problem and not
one a DataFrame implies.

## Display Rule

How a point's appearance is decided at a given Reconstruction Age — a named,
parameterised rule, not an arbitrary function.

Two exist: **constant** (appearance depends only on which Grouping category the
point is in) and **age window** (a point is drawn emphatically while the current
age is within some span of its own age, faintly otherwise).

Named and bounded rather than free-form because the rule has to be *evaluated in
the browser on every time change* — it is a function of the point and the
current age, so it cannot be a Python callback handed across. Keeping the set
closed and small is what stops it becoming a small programming language; a rule
earns its place by being needed by a page that exists, never by symmetry with
one that does.

Anything outside the set is written as JavaScript at a declared seam. That is a
supported outcome, not a failure — a rendering that is genuinely bespoke (a
pie-chart glyph per sample, say) should not be squeezed into a rule vocabulary.

## View Script

The generated, canonical record of how a view was built: every call that shaped
it, in order, minimally, as runnable code.

Not a transcript. It is reconstructed from what the view itself recorded, so it
is faithful by construction — free of the re-runs, abandoned attempts and
out-of-order execution that a notebook's own history carries, and identical
whether the calls arrived from a notebook, a script, or a conversation.

Distinct from the author's notebook, which may accompany it. The notebook holds
the wrangling and the reasoning and is the human artifact; the View Script holds
only what determines the view, and is the one that can be *checked* against what
is on screen.

Neither contains the analysis itself. A View Script names and pins the library
calls it made, with citations, and says that it is doing so — a record implying
an audit trail it does not have is worse than one that states its own edge.

## Paper

The page-space substrate an Old Map view is drawn on — an aged sheet, with its
own tint, stains, folds and vignette. It belongs to the **page**, not to the
Earth: it never moves when the globe is dragged or Reconstruction Age is
scrubbed, while every mark on top of it does.

That separation is what lets one sheet carry any Projection. The paper is
always a rectangle and the Projection is merely what is drawn on it, so a Globe
view is a disc of ink on a full page rather than a textured ball — which is how
an atlas plate actually looks. Under Robinson, whose boundary is a curve, the
corners of the page are simply paper, and that is correct rather than a gap.

## Orogen Candidate

One of a fixed set of points, generated once on the sphere and assigned a plate
id, that is reconstructed to every age and tested there against a mountain
rule. A Candidate is not itself a mountain: it is a place that may or may not
be carrying one at a given age.

Fixed identity is the whole point. Candidates ride their plates, so a mountain
drawn on one moves with the continent it sits on, and a glyph that is fading
has something stable to fade — regenerating the point set per frame instead
puts glyphs on a fixed global lattice that blinks as the orogenic band sweeps
past it, which is the failure this concept exists to prevent.

## Orogen Age

Myr since an Orogen Candidate last satisfied the mountain rule — zero while it
is active, then increasing once the condition that raised it goes away. Drives
how strongly the glyph is drawn, so orogens age out rather than vanish the
instant their trench departs.

Distinct from Reconstruction Age, and the two move in opposite directions:
Reconstruction Age is the age of the view, while Orogen Age is measured
*backwards from* it, and the same Candidate carries a different Orogen Age at
every Reconstruction Age. A consequence worth stating: a view's oldest frame
has no history behind it, so an Orogen Age series is only meaningful where the
computation began some margin deeper than the range on display.

## Transect

A user-drawn path across the sphere: an ordered list of at least two points,
each consecutive pair joined by a great-circle arc. A surface object — it has
no depth of its own, because the things computed from it disagree about what
depth means (see Readout).

_Avoid_: "profile" for this. Month Profile already names a single cell's read
down the depth axis, so "profile" would mean both one column and a line across
the world in the same glossary. A Transect is the line; what comes out of it
is a Readout.

Distinct from a Cutaway, which is a closed polygon whose purpose is to *remove*
material from view. A Transect removes nothing and has no Mask.

## Great-Circle Transect

A Transect with exactly two vertices. Named as its own case because it lies in
a plane through the centre of the Earth, so a vertical Readout taken along it
is a genuine planar slice and a camera can be aligned to it. A Transect with
more vertices is a bent curtain and has no such plane — the phrase "the section
plane" is simply false for it.

## Anchored Transect / Plate-Frame Transect

The two frames a Transect can be held in, mirroring Anchored Point and
Plate-Frame Point. An Anchored Transect stays at fixed lon/lat while the
continents move beneath it. A Plate-Frame Transect's vertices ride their
assigned plates, so a line drawn across a margin stays across that margin.

A Plate-Frame Transect is not a great-circle arc at any age but the one it was
drawn at. Its *vertices* are rotated and the path between them redrawn, which
keeps the line continuous; where the vertices resolve to different plates, the
interior of the line is therefore a geometric construction rather than a set of
material points — a fact that is stated to the reader, not hidden. See
ADR-0043.

## Readout

Anything computed from a Transect: a Mantle Section, a Grid Track, a Catchment,
a Geological Section. A Readout owns its own vertical quantity and depth
extent; the Transect owns only the line. All Readouts of one Transect share a
single Along-Track Distance axis, which is what makes reading one against
another meaningful.

## Along-Track Distance

Position measured along a Transect, from its first vertex, as great-circle arc
length in km. For a Plate-Frame Transect it is recomputed at every age from the
rotated vertices, so the axis genuinely lengthens as a margin extends and
shortens as it converges — that change is the signal, not an artefact of the
measurement.

## Cross-Track Distance

Shortest great-circle distance from a point to a Transect, measured to the
*segments* and not to the infinite great circle they lie on — so the set of
points within a given cross-track distance is a capsule with rounded ends, not
an unbounded band. Signed by which side of the line the point falls on, so it
can serve as a plan-view axis.

## Catchment

The points of a point dataset lying within a chosen Cross-Track Distance of a
Transect. Membership is a property of the point and the line together, not of
the dataset: the same dataset yields a different Catchment for every line and
every half-width, which is why the swath is always drawn and non-members are
dimmed rather than removed.

## Section

A Readout drawn as a vertical slice: Along-Track Distance across, depth down.
Drawn as a radial wedge where the depth range is large enough for the
sphericity to matter, and as a rectangle with a stated vertical exaggeration
where it is not.

_Avoid_: using "section" for the Wall. The Wall is the surface a Cutaway
exposes inside the 3D scene; a Section is a drawn panel. They can show the same
data and are not the same object.

## Crossing

A place where a Transect meets a plate boundary, carrying the boundary's type
and — for a subduction zone — its Vergence. A Crossing is measured: it comes
from reconstructed boundary geometry, unlike most of what is drawn around it in
a Geological Section.

## Vergence

Which way a subducting slab descends *as seen in a particular Section* —
left-to-right or right-to-left across the panel. Not a property of the trench
alone: it is the trench's own polarity resolved against the direction the
Transect travels at the Crossing, so the same trench verges one way in a
section drawn west-to-east and the other way in the same section drawn
backwards.

Worth naming precisely because it is invisible when wrong. A mirrored slab
looks entirely plausible — the same failure the vendored boundary library warns
about for its subduction triangles.

## Schematic Element

A mark in a Readout that no data stands behind — a drawn Moho, a slab at a
conventional dip, a crustal thickness chosen to be four or five times thicker
under continents than oceans. Drawn in a distinct register, named as schematic
in the panel's key individually rather than once for the whole figure, and
never given a vertical axis to be read off, because a screenshot leaves the
caption behind. See ADR-0045.

An element stops being schematic by being derived, not by being improved: a
Moho computed from topography by isostasy is a different kind of object from a
Moho drawn at a plausible depth, and only the first one earns an axis.

## Plate Tree

The hierarchy of relative rotations a Reconstruction Model is built from, at
one age, reduced to only those plates that carry geometry. Every plate's
position is defined relative to some other plate, up to the anchor; a Plate
Tree is that structure made visible.

It is a property of the Reconstruction Model's rotation data, not of any
numerical Model, and it exists for every Reconstruction Model whether or not
one is displayed.

Reduced is the operative word. The full rotation hierarchy at one age carries
thousands of plate ids, most of which have no polygon and so no position to
draw — a Plate Tree is what is left after collapsing those away (see Patched
Link for what collapsing them leaves behind).

## Tree Node

One plate of a Plate Tree, positioned at the **boundary centroid of that
plate's largest polygon** — the definition `gprm.utils.platetree`'s
`get_polygon_centroids()` uses, adopted deliberately rather than improved on.

Which polygon is largest is decided **per age** and is genuinely discontinuous:
a plate's largest polygon can switch to a different feature between adjacent
ages, moving the node by up to 58.8° of arc where ordinary plate motion moves
it by 0.23° (measured, Müller 2019, 94 switches across 55 plates over
0–240 Ma). That is a property of the definition, not a defect in an
implementation of it, and a viewer must not quietly smooth it away.

So a Tree Node has two halves that behave differently, and conflating them is
the mistake to avoid: **which** polygon defines it is discrete and snaps to an
exported age, the way a Boundary Frame does; **where** that polygon's centroid
sits is continuous in Reconstruction Age, the way a coastline vertex is.

## Tree Link

One hop of a Plate Tree, drawn between two Tree Nodes: the relationship "this
plate's position is defined relative to that one."

A Tree Link is directed — one endpoint is the parent — even though the line
drawn for it is not. Which endpoint is the parent depends on the anchor, which
is fixed at plate 0 and never a user setting (see Reference Plate for the
separate, view-level knob this is not).

## Patched Link

A Tree Link whose rotation circuit passes through plate ids that carry no
geometry at that age, so the line drawn connects two plates that are **not
adjacent** in the rotation hierarchy. 40 of 397 links at 0 Ma in Müller 2019.

Worth distinguishing on screen because it is the one kind of Tree Link that
does not mean what it appears to mean: the two plates it joins have something
in between them that the map cannot show.

## Locked Link

A Tree Link whose two endpoints have **zero relative rotation** over the step —
the plates move together, and the link records bookkeeping rather than motion.

Interval-valued, not instantaneous: "no relative motion" is only answerable
over a span of time, so a Locked Link is locked over a step, never locked "at"
an age.

The majority case, which is the reason it needs a name: 310 of 397 links at
0 Ma in Müller 2019, 407 of 477 in Merdith 2021. A Plate Tree drawn without
this distinction shows mostly plates that are not moving relative to anything.

A property of one link, and so a rendering distinction. The analytic object
built on the same underlying test is the Locked Group, which is **not** derived
from Locked Links — see its entry for why the two must not be collapsed.

_Avoid_ "static link" (collides with Static Polygon), "fixed link" ("fixed
plate" already means one half of a rotation pair) and "rigid" (which in this
project means non-deforming — an unrelated claim, and a false one for a
Reconstruction Model with deforming networks).

## Locked Group

A maximal set of plates with no relative motion between any two of them over
the step: everything the model moves as one mass.

**Not the connected components of Locked Links**, and the difference is not
academic. A Locked Link relates two plates that are *adjacent in the Plate
Tree*; co-rotation relates any two plates at all. A plate can co-rotate with
another several hops away while the plates in between move, so a Locked Group
routinely contains plates that no Locked Link joins. Deriving groups from links
under-merges — measured at 57 groups against 59 at 50 Ma in Müller 2019.

Defined instead by equality of each plate's own rotation relative to the
anchor over the step, which is what makes it a genuine partition: co-rotation
is transitive, so the grouping is canonical and independent of the order plates
are visited in. That transitivity is lost the moment "no relative motion" is
relaxed to "slower than some threshold" — at which point there is no
well-defined partition, only a procedure, and which procedure is chosen starts
to matter.

The count is the interesting quantity, and it is a supercontinent signal read
straight out of a rotation file with no geometry involved — 89 Locked Groups
among 399 plates at 0 Ma in Müller 2019, falling to 16 among 232 plates at
200 Ma, with the two largest groups then holding 90 and 85 plates.

A caution the measurement earned: a group count at a model's oldest age is
untrustworthy if the step reaches past it. Rotations flatten beyond a model's
range, so everything there appears locked — a forward step at `age_max`
reported a single spurious 150-plate group where a backward step reports 78.

Deliberately **not** named "Plate Assembly": assembly is what the group count
measures, and naming the instrument after the result makes the finding
unstatable without circularity.

## Plate Circuit

The full path from one plate to the anchor — every plate whose rotation is
composed to place it. `301 → 102 → 101 → 714 → 715 → 701 → 0`.

_Avoid_ using "chain" as a synonym. A chain is `gprm.utils.platetree`'s word
for **one hop** of a circuit, patched intermediates included; conflating the
two is how a circuit panel ends up displaying a single link.

A Plate Circuit is not recoverable from Tree Links alone. Links stop at the
Root Plate, because a Root Plate has no parent that carries geometry — the
final hop from Root Plate to anchor has to be carried separately or the circuit
silently ends one plate short.

## Root Plate

A plate carrying geometry that is closest to the anchor. The anchor itself
normally carries none, so it is never a Root Plate.

**Plural by nature.** Measured at `[701, 901]` at 100 Ma in both Müller 2019
and Seton 2012 — the anchor's subtree splits above the level where geometry
exists. Any UI or type that says "the root plate" is already wrong at 100 Ma.

## Hierarchy Depth

How many Tree Links separate a plate from its Root Plate — a **count**, not a
length in km, unlike Cut Depth, Ocean Depth and Isosurface Depth Range. Always
qualify it; the bare word "depth" in this glossary otherwise means a distance
below the surface.

Ranges further than expected: 2 to **37**, median 7, at 0 Ma in Müller 2019. A
plate positioned through 37 composed rotations is a real property of a
published model, and it is invisible on an ordinary reconstruction map.
