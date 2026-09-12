# Paleomagnetic poles (VGPs) reuse deep-time-map's PointLayer, assigned per Reconstruction Model

Grilling a new feature request: show paleomagnetic poles on the globe.
`CONTEXT.md`'s Plate-Frame Point entry already named this as a likely future
extension of "load an arbitrary point dataset and reconstruct it
consistently with whatever Reconstruction Model is on screen" — this ADR is
that extension actually getting designed, and picks a materially different
mechanism from Plate-Frame Point itself for two reasons resolved below.
Apparent Polar Wander Paths (a smoothed/common-reference-frame path built
from many poles) are explicitly out of scope — see Deferred.

## The decision

**A pole is not a Plate-Frame Point.** A Plate-Frame Point is a location
*on* a plate, meaningfully repositionable at any age within its lifespan — a
Virtual Geomagnetic Pole (VGP) is a computed field direction, expressed in
its sample site's present-day frame, that only means something at one
specific age: the rock's own `averageAge`. Reconstructing it to any other
age isn't a coherent question. So instead of a free-scrubbing trajectory, a
VGP is rotated to exactly its own `averageAge` (same anchor-plate-0
convention coastlines already use) and shown only while the Reconstruction
Age slider sits within a fixed **±5 Ma hard cutoff** of that age (no fade —
this project's existing pattern favours a plain threshold over animated
polish until there's a reason for more). Checked directly against the first
dataset: `T2012_TC2017.gpml`'s own `valid_time` window is a uniform ±10 Ma
export artifact (`write_vgp_feature`'s default `half_time_range`) on all 536
features, not real per-pole age uncertainty, so it cannot be reused as the
matching window and the ±5 Ma is a new, independent parameter.

**Assignment is by the sample site, never the pole.** A VGP's own
`reconstructionPlateId` (as shipped in a source `.gpml`) is trusted by
nobody — per ADR-0004/0025's existing "coherent, cannot be mixed" discipline,
plate id is re-derived per Reconstruction Model by point-in-polygon testing
the pole's **`averageSampleSitePosition`** (the sample site — a real location
on the crust) against that model's own exported static polygons, never the
pole position itself (which is not a location on the plate and has no
polygon membership to test). This limits pole display to whichever
Reconstruction Models actually have static polygons exported today — Müller
2019, Seton 2012, Scotese — the same limitation Plate-Frame Point already
lives with (ADR-0025).

**Assignment is precomputed once per Reconstruction Model, not per viewer
and not at click/load time.** Because the set of Reconstruction Models a
pole dataset might be shown under is small and known in advance (the
archive's `reconstruction_models[]`, not a per-recipe subset), plate
assignment runs at prep time, once per model that has static polygons —
mirroring ADR-0021's "one directory each, from one fetch call" pattern.
Output lives at `archive/reconstructions/<recon-id>/paleomag/<dataset-id>/
points.json`, keyed by Reconstruction Model like every other per-model
asset, not by which generated viewer happens to reference it. A viewer
offering several Reconstruction Models (a dropdown, or a comparison layout)
simply fetches whichever file matches whatever is currently displayed — no
runtime point-in-polygon testing anywhere in the browser.

**The machinery splits upstream/downstream per ADR-0028's own rule, not a
new Geode-`core/` primitive.** `viewer/vendor/deep-time-map` already has a
generic, tested pipeline for exactly this class of problem — arbitrary point
datasets reconstructed through time (`points.py`'s
`points_from_dataframe`/`build_points`, `PointLayer`'s rendering, hit-testing,
and `lifespan: 'window'` age-matching, the same `abs(time - age) <=
ageWindow` rule this decision needed independently). Confirmed nothing in
Geode's own `viewer/src` consumes it yet — only `boundaries.ts` is wired up
today — so this is new consumption, not copying an existing Geode feature.
One real gap: `points_from_dataframe` assumes one coordinate serves both
plate-assignment and drawn position, which a VGP violates (site vs. pole).
That split is pure geometry/data-shape with no paleomagnetism-specific
knowledge, so per ADR-0028's split-features rule it is a small upstream
addition to deep-time-map's `points.py`/`build_points`, not a fork inside
Geode. The domain-specific half — reading `T2012_TC2017.gpml` via
`gprm.utils.pmag.vgp_to_dataframe()`, knowing which field is site vs. pole
vs. A95 vs. age — stays downstream as a new `prep_paleomag.py`, the same
"adapter that produces the plain JSON shape deep-time-map already renders"
role every other Geode prep script already plays.

**First dataset: Torsvik 2012 / Torsvik & Cocks 2017**
(`T2012_TC2017.gpml`, 536 `gpml:VirtualGeomagneticPole` features, found in
the sibling `NREE` repo), chosen over a fresh GPMDB export purely because
it is already in the exact schema `gprm.utils.pmag.vgp_to_dataframe()`
expects — zero new conversion code. The catalog schema is designed
multi-dataset-ready from the start (a keyed array, not a single bucket)
since a second source (a current GPMDB export) is an explicit near-term
goal, applying ADR-0021's own lesson proactively instead of needing a
second migration ADR later.

**First viewer: `single-reconstruction-globe`.** Built for exactly "pure
reconstruction geometry, no Variable" (ADR-0020) — a VGP is reconstruction
geometry, not a painted numerical field — and its Reconstruction Age slider
already drives coastline scrubbing with no Variable/legend/no-data-toggle
tool vocabulary to conflict with. Other viewers (climate, tomography,
deformation) are later extensions, not this pass, the same staging Plate-
Frame Point used (core primitive generic, first UI in one deliberately-
chosen place — ADR-0026).

## Deferred

- **Apparent Polar Wander Paths** — a smoothed running-mean path
  (`gprm.utils.pmag.generate_running_mean_path`, needs `pmagpy`) or a
  common-reference-frame rotation of many poles onto one plate
  (`rotate_to_common_reference`) — explicitly out of scope for this design
  pass. Individual VGPs ship first; APWP is its own future grilling session,
  the same way Plate-Frame Point was split off from Anchored Point.
- **GPMDB as a second pole dataset** — schema is ready for it (multi-dataset
  array), but no conversion work is done here.
- **Dynamic/resolved-topology plate assignment** for a VGP whose sample site
  falls outside every static polygon, or under a Reconstruction Model with
  no static-polygon export at all (Müller 2022, Cao2024 today) — same
  deferral Plate-Frame Point already carries (ADR-0025's "Deferred").

## Consequences

- `viewer/vendor/deep-time-map` gains a small upstream capability (separate
  partition-anchor vs. display-geometry coordinates in `points_from_dataframe`/
  `build_points`), released and tagged there before Geode's submodule pin
  bumps to consume it — per ADR-0028's versioning discipline, never vendored
  as an unmerged branch tip.
- New `prep_paleomag.py` in Geode: reads a source `.gpml` VGP file via
  `gprm.utils.pmag.vgp_to_dataframe()`, and for each Reconstruction Model
  with `has_static_polygons`, assigns plate ids from the sample site and
  writes `archive/reconstructions/<recon-id>/paleomag/<dataset-id>/points.json`
  in deep-time-map's own format (`transport: "rotations"`, the pole position
  as drawn geometry, `lifespan: "window"`, `ageWindow: 5`).
- `archive.json` gains a new `paleomag_pole_sets[]` catalog array (id, name,
  citation, which Reconstruction Models it's exported for), mirroring
  `reconstruction_models[]`'s own shape from ADR-0021 — not built in this
  pass, recorded here as the agreed shape.
- `CONTEXT.md`'s Plate-Frame Point entry is updated alongside this ADR: its
  "none of these is built or separately scheduled" note no longer applies to
  paleomagnetic poles specifically, and a new Virtual Geomagnetic Pole (VGP)
  entry explains why it is a distinct concept rather than a Plate-Frame
  Point variant.
- Rendering details, prep/catalog wiring, and the upstream deep-time-map
  API shape were all resolved within the same design session — see
  `docs/plans/paleomagnetic-poles.md` for the full detail (marker style,
  colour palette, `prep_paleomag.py`'s CLI, `paleomag_pole_sets[]`'s
  fields, and the `partition_lon_field`/`partition_lat_field` addition to
  `points_from_dataframe`). Nothing from this design pass remains open;
  only actual implementation (in both repos) is left.
