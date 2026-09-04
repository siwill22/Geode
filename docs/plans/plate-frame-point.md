# Plate-Frame Point

**Status: not scheduled.** Requirements captured during the same design
session as Anchored Point (`docs/plans/anchored-point-query.md`,
ADR-0011), then deliberately split off — this needs a new data source the
archive doesn't carry yet and a genuinely new "cannot answer" outcome, both
of which deserve their own grilling session rather than riding along with
the query that needed neither. Term defined in `CONTEXT.md`.

## What it is

A Query Point that follows a material point on a moving Plate rather than a
fixed grid cell: click a location at some reference age, and see what
Variable value that same *piece of crust* carries at other ages — as
opposed to Anchored Point, which always reads whatever ends up in that grid
cell regardless of what's there.

## What it needs that doesn't exist yet

**Plate polygon data, per Model.** Coastline features get a plate id for
free from their own source shapefile's attributes
(`feature.get_reconstruction_plate_id()`, see `prep_coastlines.py`) — that
works because every coastline vertex already belongs to a tagged feature.
An arbitrary clicked point belongs to nothing until it's tested against a
closed plate polygon covering that location at the reference age (GPlates
"static polygons," or a resolved topology). Nothing in the archive ships
this today.

**The same per-Model provenance discipline ADR-0004 already established for
coastlines vs. rotations.** ADR-0004 exists because pairing the wrong
rotation file with a coastline set silently mis-places continents by
hundreds of km. The same failure mode applies here in a second dimension:
the plate polygons used for point-in-polygon assignment and the rotation
table used to move the assigned point must come from the *same* rotation
model's own provenance, not merely "a" polygon set and "a" rotation table
that happen to both exist in the archive. Which polygon/rotation pair a
Model uses needs to be declared per Model, the same way ADR-0004 declared it
for coastlines.

**Reuse of the existing rotation mechanism, not a new one.** `RotationTable`
(ADR-0001) already gives any plate id its absolute rotation at any age via
slerp between 1 Ma samples. Once a Plate-Frame Point knows which plate id it
belongs to, moving it to another age is the same math coastline vertices
already use — nothing new there.

## The "cannot answer" outcome

Given a reference-age position and a target age, the plate assignment can
fail for reasons that are real, expected geology, not bugs:

- The point sits on oceanic crust that has since been subducted — no
  polygon at the target age covers it because that crust no longer exists.
- The point falls outside whatever coverage the model's plate polygons
  actually have at that age (gaps are common in older reconstructions).

This must surface as a first-class per-age outcome, not an exception and
not a silently-dropped point. An Age Series-shaped result under this mode is
therefore NOT `CellSample[]` the way Anchored Point's is — some entries
answer with a value, others must say "no plate found here at this age"
distinctly from "a plate was found but the cell was masked/no-data"
(Anchored Point's existing distinction). The exact shape of that result type
is an open decision for the future session, not resolved here — resist
designing it prematurely before the polygon data source itself is chosen,
since the two decisions interact (a resolved-topology source changes
discontinuously between ages the way Boundary Frame already does; a static
-polygon source doesn't, and that difference shapes what "cannot answer"
even means at an in-between age).

## Open questions for the next session

- Which polygon source per existing Model (static polygons vs. resolved
  topologies) — and does this differ per Model the way rotation files
  already do per ADR-0004?
- Is the reference age always "whatever Reconstruction Age was active at
  the moment of the click," or can a user pick a different reference age
  after the fact?
- What does querying a Plate-Frame Point's Month Profile even mean — Month
  Profile is inherently single-Frame/single-age, so does the plate
  machinery ever engage for it at all, or is Month Profile always an
  Anchored Point operation regardless of which mode the click was made in?
- Result type for the per-age "no plate found" outcome, once the polygon
  source is chosen (see above — deliberately not designed yet).
