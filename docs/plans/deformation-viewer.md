# A third viewer: crustal deformation from the `defamation` pipeline

**Status: implemented**, from a grilling session on 2026-09-03, built the
same day. `prep/prep_deformation.py` ingests `Muller2019_deformation_pipeline`
into `muller2019-deformation`/`muller2019-age-heatflux`; the viewer lives at
`viewer/deformation.html` / `viewer/src/deformation/`. `Cao2024` and the
full heat-flux scenario ensemble remain future work (see "Out of scope for
v1" below, still accurate). Source repo is a sibling project,
`~/GIT/defamation` — a pipeline that reconstructs where and when continental
crust deformed from nothing but a plate rotation model and continent
polygons, and turns that history into crustal thickness, tectonothermal age
and surface heat flux. Its own `CONTEXT.md` is authoritative on the
vocabulary quoted below (Deformation zone, β, tectonothermal age, etc.).

One real bug surfaced building this, worth recording since a screenshot alone
wouldn't have caught it: the no-data sentinel check in `core/material.ts`
used a 0.004 margin between the sentinel byte (255) and the highest byte
real data ever clamps to (254) — but those two are only 1/255 ≈ 0.00392
apart, so the margin was wider than the gap it was supposed to sit inside,
and every texel clamped to 254 (e.g. a stable-craton composite tectonothermal
age of 2500 Ma, which is *most* of every continental interior) rendered as
no-data instead of data. A first render of `composite_age` with `transparent`
no-data looked entirely plausible — coastline-hugging rims lit up, continental
interiors went dark — until checked against the actual encoded bytes (byte
254 at three continental interior points, not 255), the same "decode the same
way the shader does" discipline the Köppen off-by-one fix used. Fixed by
tightening the margin to 0.002.

## What it is

A new entry page, `viewer/deformation.html` / `viewer/src/deformation/`,
following the project's own rule that a new viewer is a new page and wrapper
directory, not a branch inside `tomography/` or `climate/`. Structurally it
is much closer to the climate viewer than the mantle one: a 2D surface field
with no depth axis, reconstructed per-age rather than a fixed-frame volume
with coastlines rotated on top of it.

Two Layers, the same switching mechanism the climate viewer already uses for
Climate vs Paleogeography:

- **Deformation** — time-varying. 241 Frames, 0–240 Ma at 1 Myr, native
  0.5° grid (721×361). Nine Variables share this grid and frame series:
  `horizontal_divergence`, `effective_strain_rate`, `shear_strain`,
  `obliquity`, `deformation_style`, `max_principal_strain`,
  `min_principal_strain`, `volumetric_strain` (all from
  `deformation_grids/deformation_{T}Ma.nc`), plus `thickness` (from
  `thickness_grids/thickness_{T}Ma.nc`, same frame series and grid, a
  different physical domain but no different a case than `LANDFRAC` sitting
  in the climate manifest alongside `T`/`P`/`SALB`). The age slider drives
  both the loaded Frame and the coastline Reconstruction Age, together.
- **Age & Heat Flux** — static, present-day only. `tectonothermal_age`,
  `subduction_age`, `composite_age`, `subduction_dist_min` (from
  `tectonothermal_age/*.nc`), and `heat_flux` restricted to three of its
  seventeen scenario files: `nominal`, `ensemble_mean`, `ensemble_range`.
  These carry no `time_Ma` or `coordinate_frame` attribute at all — they are
  a location's *history*, not a per-age snapshot — so the age slider stays
  live for coastlines only, and the data pins to its single Frame regardless
  of slider position. This is exactly the existing mechanism a
  `type: tomography` model already uses in the mantle viewer (Reconstruction
  Age keeps meaning something while the loaded Model has exactly one Frame);
  no new machinery, just a second consumer of it.

Out of scope for v1, explicitly: the point-track (`*_thickness_evolution.nc`)
and `beta_factor`. Both are Lagrangian — a value per tracking point, not a
grid — and nothing in `RunOutputs` grids beta the way `thickness_grids`
already grids its derived thickness. Adding it would mean a new gridding
step, not just a new manifest entry.

Also out of scope for v1: the other 14 heat-flux scenario files (kept as a
possible Scenario sub-dropdown later, mirroring `defamation`'s own CONTEXT.md
"Scenario" concept), the full 1001-frame `Cao2024_deformation_pipeline` run,
and multi-globe compare.

## Source data, as measured

```
output/Muller2019_deformation_pipeline/
    deformation_grids/deformation_{0..240}Ma.nc   241 files, 8 variables each
    thickness_grids/thickness_{0..240}Ma.nc       241 files, 1 variable
    tectonothermal_age/*_tectonothermal_age.nc              1 variable
    tectonothermal_age/*_composite_tectonothermal_age.nc    3 variables
    heat_flux/heat_flux_{scenario}.nc             17 files, 1 variable each
```

Grid: `lat`/`lon`, 361×721, 0.5°, global extent. `deformation_*.nc` also
carries `plate_id_a`/`plate_id_b` on a same-shaped `y`/`x` grid — internal to
the thickness tracker, not a display variable.

Every deformation variable is **~92% NaN**: deformation only happens in
narrow overlap zones between differentially-moving rigid polygon groups, so
most of the globe genuinely has no value at any given time, not a coverage
gap. `thickness` is denser (all continental crust) but still far from global
— oceanic crust is outside the model domain by definition.

`coordinate_frame: reconstructed` on both `deformation_grids` and
`thickness_grids` confirms these are already gridded at each timestep's
paleo-position, unlike the mantle viewer's OPT1 volumes (fixed present-day
frame, coastlines separately rotated on top). The age/heat-flux products
carry neither `coordinate_frame` nor `time_Ma` — confirmed present-day-only.

## Colour

**Extension warm, compression cool** for the five diverging strain
variables (`horizontal_divergence`, `volumetric_strain`, `max_principal_strain`,
`min_principal_strain`, and by extension `shear_strain`'s sign where
relevant) — CONTEXT.md's own convention (positive = extension/thinning,
negative = compression/thickening), rendered the way structural geology
usually reads it: red for rifting, blue for compression. See
[[extension-colour-polarity]] below.

**`deformation_style` is categorical**, flag values `-1..9` (undefined,
negligible, then nine named styles — see `defamation`'s own
`compute_transient_geotherm`-adjacent docs for the full list). The climate
viewer's existing categorical path (Köppen) assumes 0-indexed classes; rather
than force-fit `-1` into that scheme, this gets its own categorical colormap
built from a matplotlib qualitative palette (e.g. `tab10`), to be refined
once it's on screen — explicitly not trying to get the exact classification
palette right in v1.

**Sequential variables** (`effective_strain_rate`, `shear_strain` magnitude,
`obliquity`, `thickness`) get a reasonable default perceptually-uniform ramp
(viridis-family); not litigated in this session, left for visual refinement
once real data is on screen.

**No-data is a runtime toggle**, not a fixed manifest choice: transparent,
light grey, or white, switchable in the UI. This is a deliberate departure
from the mantle viewer's fixed dark-grey no-data convention — see
[[runtime-no-data-toggle]] below — because at ~92% NaN, a fixed grey would
read as "no data" dominating the globe rather than "not currently
deforming," which is the actual, meaningful state being shown.

## Coastlines: this run's own rotation model, not the shared archive entry

`Reconstructions.fetch_Muller2019()` (the `gprm` call the pipeline's config
actually names) builds its rotation model from
`Global_250-0Ma_Rotations_2019_v2.rot` — the *native* 2019 rotations. Geode's
existing archive already has Müller 2019 v2 coastline geometry, but paired
with Müller **2022**'s `MantleOpt` rotations, deliberately, because OPT1 was
run on the 2022 model. Reusing that existing entry here would put every
deformation zone under continents rotated by up to ~6° (~700 km at the
equator, 200 Ma) from where the pipeline itself put them — the exact class of
error the mantle viewer's own README calls out under "One rotation model,
everywhere." This viewer needs its own `prep_coastlines.py` invocation
against the 2019-native `.rot` file. See [[per-run-coastline-rotations]].

Coastline *geometry* is the same file either way
(`Global_coastlines_2019_v1_low_res.shp`), so this is a rotations-only
re-export, not a new geometry source.

## Archive size — measured, not estimated

Quantizing one frame's 8 deformation variables + thickness to uint8 (0.5/99.5
percentile clip, NaN → sentinel 255) and gzipping at level 6:

| variable | raw | gzip | ratio |
|---|---|---|---|
| horizontal_divergence | 254 KB | 8.5 KB | 0.03 |
| effective_strain_rate | 254 KB | 9.3 KB | 0.04 |
| shear_strain | 254 KB | 9.3 KB | 0.04 |
| obliquity | 254 KB | 4.2 KB | 0.02 |
| deformation_style | 254 KB | 4.9 KB | 0.02 |
| max_principal_strain | 254 KB | 9.3 KB | 0.04 |
| min_principal_strain | 254 KB | 9.4 KB | 0.04 |
| volumetric_strain | 254 KB | 9.2 KB | 0.04 |
| thickness | 254 KB | 29.2 KB | 0.11 |

**~93 KB/frame across all 9 variables, × 241 frames ≈ 23 MB total gzipped** —
against a raw (unquantized, uncompressed) 565 MB. The sparse fields compress
far better than the mantle/climate volumes' ~46% ratio because most of each
buffer is one repeated sentinel byte. This fully absorbs the earlier
resolution-vs-budget tension: keeping the native 0.5° grid (4x the cells of
Geode's usual 360×181) costs essentially nothing here, the opposite of what
it would cost for a dense field like REVEAL. The static age/heat-flux layer
adds a handful of single-frame files, negligible by comparison. Total new
archive weight is small next to the existing ~170 MB deployed archive and
well inside the shared 1 GB Pages cap.

## Prep script

`prep/prep_deformation.py`, generalized like `prep_model.py` rather than
hardcoded to one run — takes a run directory and the `gprm` fetch name as CLI
arguments, so `Cao2024_deformation_pipeline` (1001 frames, 0–1000 Ma — a
follow-up, not part of this plan) is a second invocation, not a rewrite.
Registers as one entry in the existing multi-model archive index
(`archive/archive.json`) the same way `reveal`/`semucb`/`opt1` already do —
there is no special-casing for "only one model exists yet," the archive
format already generalizes to N.

## Verification

Follows the existing `check:render` discipline where it applies:

- A known deformation zone at a known age (e.g. East African Rift extension
  at recent time) should read as warm/extension in `horizontal_divergence`,
  the same "measured from the data, not by eye" standard as the mantle
  viewer's Pacific-LLSVP-is-hot check.
- `deformation_style`'s flag values round-trip through the categorical
  encode/decode exactly, the same discipline that caught the Köppen
  off-by-one (encode at band centre, decode the same way the shader does —
  see Geode's README for why this bit before).
- Coastline age at a sample time matches pygplates reconstructing the same
  point with the 2019-native rotation file directly — the same cross-check
  `check:mask` already does for the cutaway polygon, applied here to confirm
  the *right* rotation file was used, not just *a* rotation file.
