# Paleomagnetic Poles (VGPs)

**Status: fully designed, not yet built.** One grilling session resolved
every open question below — architecture, rendering, prep/catalog wiring,
and the upstream deep-time-map API shape (ADR-0029). No code written yet
in either repo. See `CONTEXT.md`'s Virtual Geomagnetic Pole and Apparent
Polar Wander Path entries for the resolved terminology.

## What it is

Show individual paleomagnetic poles (Virtual Geomagnetic Poles, VGPs) on a
reconstructed globe: each pole reconstructed to exactly its own recorded
age using its assigned plate's rotation, visible only while the
Reconstruction Age slider sits within a fixed window of that age — a live
visual check of whether a Reconstruction Model's rotations agree with
independent paleomagnetic constraints.

Apparent Polar Wander Paths (a smoothed curve, or many poles rotated into
one common reference frame) are explicitly deferred — see ADR-0029.

## Resolved (ADR-0029)

- A VGP is not a Plate-Frame Point: plate assignment tests the VGP's
  *sample site*, never its pole position; age is not scrubbable — a VGP is
  only reconstructed at its own `averageAge`, shown within a **±5 Ma hard
  cutoff** (no fade) around it.
- Assignment is precomputed once per Reconstruction Model (point-in-polygon
  against that model's own static polygons), never trusting a source
  file's embedded plate id, and never done at click/load time. Limits
  display to Reconstruction Models with static polygons exported today:
  Müller 2019, Seton 2012, Scotese.
- Built on `viewer/vendor/deep-time-map`'s `PointLayer`/`points.json`
  pipeline (ADR-0028's split-features rule), not a new Geode `core/`
  primitive. Needs one small upstream addition to deep-time-map first: a
  separate partition-anchor coordinate from the drawn-geometry coordinate
  in `points_from_dataframe`/`build_points` (a VGP needs both; existing
  point datasets there only ever needed one).
- First dataset: `T2012_TC2017.gpml` (Torsvik 2012 / Torsvik & Cocks 2017,
  536 `gpml:VirtualGeomagneticPole` features, in the sibling `NREE` repo) —
  already in the exact schema `gprm.utils.pmag.vgp_to_dataframe()` expects.
  Catalog schema designed multi-dataset-ready from the start; a current
  GPMDB export is the intended second source, not built yet.
- First viewer: `single-reconstruction-globe` (pure reconstruction
  geometry, no Variable — ADR-0020). Other viewers are later extensions.
- Export lives per Reconstruction Model, not per viewer/recipe:
  `archive/reconstructions/<recon-id>/paleomag/<dataset-id>/points.json`,
  mirroring how coastlines/static-polygons/boundaries are already
  per-model assets (ADR-0021).

## Resolved — rendering and interaction

- **Marker**: a solid dot at the pole position, surrounded by a light-tint
  circle of angular radius `PoleA95`, with a darker-shade edge — dot,
  circle fill, and edge are all the same hue, keyed by the pole's assigned
  plate id (see palette below).
- **Sample site**: always faintly visible (a separate, low-opacity marker
  at `averageSampleSitePosition`), brightened/emphasized when its pole is
  hovered. Built entirely downstream in Geode's consumer code — the site's
  `lon`/`lat` rides along as ordinary per-point metadata (`points.json`
  already carries arbitrary metadata per point, per `SCHEMA.md`), and
  `PointLayer`'s existing `hovered` index drives which sample site
  highlights. No new deep-time-map capability needed beyond the
  partition-coordinate split already scoped.
- **Hover metadata popup**: free — `PointLayer`'s hit-testing/hover
  tracking and per-point metadata carry-through are already generic and
  built (`points.js`), confirmed nothing paleomagnetism-specific is needed.
- **Colour palette**: checked `/Users/simon/Data/GeoData_2.5/CptFiles/
  EarthByte/plate_id_regular.cpt` and `plate_id_categorical.cpt` — both are
  GPlates' own illustrative example files (2-4 named buckets, grey/black/
  white for everything else), not a real per-plate-id palette covering the
  dozens of plate ids this data actually carries. Decision: generate our
  own deterministic categorical palette (plate id → hue via a well-
  distributed hash, per the `dataviz` skill's categorical-palette method
  when this is implemented), fixing 701 = orange and 801 = green as anchors
  so it agrees with GPlates' own convention on the two plates GPlates
  itself names.

## Resolved — prep and catalog wiring

- **Source data is vendored into Geode**, not read live from the sibling
  `NREE` repo's machine-specific path: `T2012_TC2017.gpml` is copied to
  `prep/sources/paleomag/T2012_TC2017.gpml` so prep is reproducible from a
  fresh clone. NREE stays the upstream original; this is a snapshot, the
  same relationship `prep/sources/` already implies for other one-off
  inputs.
- **`prep_paleomag.py` runs standalone, never chained from
  `prep_reconstruction.py`** — a pole dataset is agnostic of any one
  Reconstruction Model (the same dataset gets tested against several), so
  it is invoked once per (dataset, model) pair, on demand, mirroring
  `prep_reconstruction.py`'s own `--model`/`--id`/`--name`/`--citation`/
  `--out` flag conventions:
  `prep_paleomag.py --source prep/sources/paleomag/T2012_TC2017.gpml
  --id torsvik-cocks-2017 --name "Torsvik & Cocks (2017)" --models
  muller2019 seton2012 scotese --out archive/`. Adding a new Reconstruction
  Model later does not automatically re-run this — someone re-invokes it
  per existing dataset, by design (see the separate-vs-auto-chained
  decision above).
- **`archive.json` gains `paleomag_pole_sets[]`**, one entry per dataset,
  shaped like `reconstruction_models[]` (ADR-0021): `id`, `name`,
  `citation`, and a per-Reconstruction-Model map of which models it's been
  exported for (pointing at each model's own
  `archive/reconstructions/<recon-id>/paleomag/<dataset-id>/points.json`),
  plus informational counts (`n_poles`, age range) mirroring how
  `boundaries.json`'s `frames[].features` is informational rather than
  load-bearing.
- **Generator/recipe support is out of scope for this pass.** The first
  build targets Geode's own hand-built `viewer/reconstruction.html` (a
  live, first-class Geode page today, not just generator-template code) —
  `recipeTypes.ts`/`validateRecipe.mjs` support for externally-generated
  standalone viewers is a distinct, later follow-up, the same staging
  Plate-Frame Point used (one hand-built viewer first).
- **UI toggle** mirrors `reconstructionUi.ts`'s existing
  `setBoundariesAvailable()` pattern exactly — added/removed depending on
  whether the loaded Reconstruction Model has a pole-set exported, no new
  UI paradigm. Dataset selection (a picker between multiple pole datasets)
  is moot with only one dataset and deferred until a second exists.

## Resolved — the upstream deep-time-map API shape

Checked `points_from_dataframe`'s actual mechanics closely before designing
this: for `transport: "rotations"` (what VGPs use — see ADR-0029), the
*drawn* position at any time is reconstructed browser-side from the plain
`record["lon"]/record["lat"]` metadata fields plus the plate's rotation
series — the `pygplates.Feature` geometry built inside
`points_from_dataframe` is used **only** for the `partition_into_plates`
call, never for producing rotated output under this transport. So the two
roles (assignment geometry, drawn/display geometry) are already less
coupled in the existing code than they look; the only actual coupling is
that both are read from the same `(lon_field, lat_field)` pair today.

**The fix**: two new optional parameters, `partition_lon_field` /
`partition_lat_field`, defaulting to `None` (meaning "same as
`lon_field`/`lat_field`" — today's behaviour, fully backward compatible for
every existing caller). When given, `points_from_dataframe` builds a
**second, throwaway** `pygplates.Feature` list from those fields purely to
run `partition_into_plates` against and read back `plate_id` — the
`features` list used for display geometry (and for `transport:
"trajectory"`'s `pygplates.reconstruct()` call) is built from
`lon_field`/`lat_field` exactly as today, completely untouched.

This was the deliberate alternative over silently repointing the *same*
feature list's geometry: doing that would make `transport: "trajectory"`
silently reconstruct the wrong point (the partition anchor, not the drawn
position) for any future caller who requests it with a split configured —
a real, easy-to-miss trap. Two independent feature lists close it off
entirely rather than requiring callers to remember trajectory-transport
is unsafe with a split. Names are deliberately domain-agnostic
(`partition_*`, not `site_*`/`pole_*`) — per ADR-0028's split-features rule,
`points.py` must stay ignorant of what a VGP (or a deposit, or a species) is.

Still to happen, as a separate follow-up, not done in this session: writing
this change, merging + tagging it in `deep-time-map`'s own repo per its
ADR-0001 versioning discipline, then bumping Geode's submodule pin
(ADR-0028) to consume it.

## Deferred (see ADR-0029)

- Apparent Polar Wander Paths (running-mean smoothing or common-reference-
  frame rotation of many VGPs).
- GPMDB as a second pole dataset.
- Dynamic/resolved-topology plate assignment for VGPs whose sample site
  falls outside every static polygon, or under a Reconstruction Model with
  no static-polygon export (Müller 2022, Cao2024 today) — same deferral
  Plate-Frame Point already carries (ADR-0025).
