# Plate-Frame Point assigns via static polygons only, once, at click time

Grilling Plate-Frame Point (`docs/plans/plate-frame-point.md`) to resolve
the open questions it deliberately left for "the next session." ADR-0024
already established that plate-polygon availability is two independent
per-Reconstruction-Model facts — static polygons and dynamic (resolved
topology) polygons — without picking which one Plate-Frame Point should
actually use. This ADR picks, and resolves the three questions that turned
out to depend on that pick.

## The decision

**Static polygons only. Dynamic/resolved-topology assignment is deferred,
not designed here.** Static polygons rotate with the exact mechanism
coastlines already use (one quaternion slerp per plate, applied to
present-day geometry, `rotationAt()` in `viewer/src/core/coastlines.ts`) —
zero new rotation or discontinuous-frame machinery. Dynamic polygons behave
like Boundary Frames (a new resolved topology per timestep) and would need
a new closed-polygon export the existing `boundaries/frames/*.geojson`
output doesn't provide (those are boundary *lines*, not filled polygons).
Both currently-exported Reconstruction Models (Müller 2019, Seton 2012)
have static polygons; Müller 2022 — the only known model lacking them — is
not yet in the archive at all. Dynamic-polygon assignment has a real future
use (see "Deferred" below) but is a different feature, not a fallback mode
of this one.

**Assignment is a single point-in-polygon test against one static-polygon
*feature*, not a plate id.** A plate id's coverage is typically built from
several static-polygon features, each with its own `pygplates`
`get_valid_time()` window — confirmed directly (not assumed) against both
Müller 2019 and Seton 2012: the Pacific plate alone (id 901 / 983) is
covered by a dozen-plus features, each beginning at a different age (crust
accreted at a ridge at that age) and, in every case checked, ending at
`-inf` (present). That is not incidental: static polygons are digitized in
present-day space and rotated backward, so **every static-polygon feature
is, by construction, crust that survives to today** — crust fully
subducted before present has no present-day trace to have been digitized
from in the first place. A static polygon literally cannot represent
"existed, then was consumed."

That collapses this plan's whole "cannot answer" design space:

- **At click time**, if no static polygon covers the reference-age point,
  there is nothing to assign — full stop, no retry, no fallback. This is
  the only failure mode a click itself can hit.
- **Once assigned**, the point's valid age range is exactly
  `[0, assignedFeature.beginAge]` — it needs no re-derivation, because
  point-in-polygon containment is invariant under a shared rigid rotation:
  if the click point is inside a feature's boundary at the reference age,
  it stays inside that same rotated boundary at every other age, with no
  per-age re-testing required. Every age older than `beginAge` reports "no
  plate here yet" (this crust hadn't formed); no age is ever too young,
  since every feature's window reaches present by construction.
- The plan doc's other cannot-answer scenario — "crust that has since been
  subducted" — cannot occur on this path at all. It was written assuming a
  single shared per-age coverage test; it is actually a dynamic-topology-
  only phenomenon and is out of scope now, not merely unhandled.

**Continent polygons are not a separate export.** `continent_polygons_files`
and `static_polygon_files` were checked directly across all three current
Reconstruction Models: for Scotese they are *literally the same shapefile*;
for Müller 2019 and Seton 2012, the static-polygon file already tags a
subset of its own features with a feature-type value that marks them
continental (`gpml:ClosedContinentalBoundary` for Müller 2019,
`gpml:ContinentalFragment` for Seton 2012 — the vocabulary differs per
model, so this must be checked per model like every other polygon fact
ADR-0024 established, never assumed shared). Exporting a standalone
continent-polygon geometry set alongside the static-polygon set would ship
near-duplicate geometry for a distinction the static export can already
carry as one boolean flag per feature. `prep_reconstruction.py` exports
static-polygon geometry once, per model, with a `continental` flag derived
from that model's own feature-type convention; nothing is ever fetched from
`continent_polygons_files` for this purpose.

**Overlap tie-break: largest polygon wins.** Checked directly (not
assumed): Müller 2019's static polygons have zero overlaps among 3000
sampled points at 0 Ma, growing to 26/3000 at 50 Ma, 46/3000 at 100 Ma,
64/3000 at 150 Ma — overlap among independently-rotated adjacent features is
real and grows with reconstruction age, exactly as `pygplates`' own
`PlatePartitioner` documentation warns ("reconstructed static polygons do
overlap for non-zero reconstruction times"). Rejected: favouring the
*smallest* overlapping polygon (arguing the smaller one is the more
specific, more locally-named unit) — this begs the question, since
"smaller" was doing all the work in that argument. The adopted rule instead
follows reconstruction methodology: larger blocks generally carry more
geological constraint (paleomagnetic, marine magnetic anomaly, hotspot-track
data), so their reconstructed position is the safer bet when two
independently-rotated polygons disagree at a given age.

**Reference age and Month Profile fall out of the above, not decided
separately.** Reference age is whatever age was active at click time,
captured once alongside the click's `LonLat`, and never edited after — the
same convention ADR-0011 already established for `LonLat` itself; nothing
about static-polygon assignment needs it to be otherwise. Month Profile
(inherently single-Frame) still engages the plate machinery, but trivially:
one rotation from reference age to whichever Frame is on screen, using the
same precomputed trajectory Age Series (point) uses, then an identical read
to `queryPoint.ts`'s existing `monthProfile()` from there. It is not "always
an Anchored Point operation" — that would silently ignore plate motion and
reintroduce the exact mismatched-provenance bug ADR-0004 exists to prevent,
just in a new dimension.

## Deferred

Assigning a plate id via dynamic/resolved topology, for a click that fails
static-polygon assignment, is a real future feature — letting plate id
change over time (splitting/merging) and letting a point actually get
subducted, neither of which static polygons can express. `gprm`'s
`ReconstructionModel.assign_plate_ids` is a known precedent for the
underlying mechanism. Explicitly out of scope here: static polygons ship
first: they cover both Reconstruction Models the archive currently has, and
adding dynamic assignment later is additive (a fallback path when static
assignment fails), not a rework of anything decided in this ADR.

## Consequences

- `prep_reconstruction.py` gains a static-polygon export (geometry, plate
  id, `continental` flag, begin age per feature) alongside the existing
  coastlines/boundaries outputs. Manifest gains a `has_static_polygons`
  fact per ADR-0024's own prescription; no dynamic-polygon manifest field is
  needed yet since nothing consumes it.
- A Plate-Frame Point's engine-level shape is `{ plateId, beginAge,
  trajectory }` where `trajectory` is the same per-Frame rotation
  `coastlines.ts` already computes, keyed by Frame age; any Frame with
  `age > beginAge` answers "no plate here yet" instead of a `CellSample`.
  The exact type is still an implementation detail for whichever session
  writes the code, not fixed by this ADR.
- CONTEXT.md's Plate-Frame Point entry and `docs/plans/plate-frame-point.md`
  are updated alongside this ADR to drop the now-obsolete "subducted crust"
  cannot-answer framing and the "open questions" they described, since both
  are resolved above.
