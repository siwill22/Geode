# Geode

*Crack the Earth open and look at the structure inside.*

A shared three.js/Vite engine for browsing 3D Earth-science volumes on a
reconstructed spherical globe, with two viewers built on it so far:

- **[the mantle viewer](viewer/index.html)** — static seismic tomography or a
  mantle convection run scrubbed through 200 Myr, with reconstructable
  coastlines and plate boundaries on the surface, and a user-drawn polygonal
  cutaway whose walls and floor are textured with the model interpolated onto
  the cut surface.
- **[the paleoclimate viewer](viewer/climate.html)** — annual-mean surface
  temperature from a 540 Myr climate simulation, with a paleogeography layer
  and reconstructed continent outlines consistent with the same underlying
  plate model the climate run used.

Both are thin wrappers (`viewer/src/tomography/`, `viewer/src/climate/`) over
one generic engine (`viewer/src/core/`) — the archive/manifest data format,
volume-texture sampling, coastline reconstruction and colour-ramp machinery
are shared, not duplicated per viewer. A new viewer is a new entry page plus a
new wrapper directory, not a branch inside an existing one. See *Layout*
below.

Phases 1 and 2 of [the spec](tomography-globe-viewer-spec.md) are built for
the mantle viewer. Design vocabulary is in [CONTEXT.md](CONTEXT.md); decisions
with lasting consequences are in [docs/adr/](docs/adr/).

## Quick start

```bash
git clone --recurse-submodules <this repo>
cd viewer
npm install
npm run dev            # http://localhost:5173         mantle viewer
                        # http://localhost:5173/climate.html   paleoclimate viewer
```

Plate boundaries are drawn by [deep-time-map](https://github.com/siwill22/deep-time-map),
a submodule at `viewer/vendor/deep-time-map`. `git submodule update --init` if
you cloned without `--recurse-submodules`.

The archive is generated, not tracked — see *Regenerating the archive*. It is
served from `viewer/public/archive`, a symlink to `archive/` at the repo root.

## Controls

*The mantle viewer.* Pick a tool in the right-hand panel, GPlates-style:

| Tool | |
|---|---|
| **Drag Globe** | rotate and zoom (default) |
| **Draw Polygon** | click to add vertices; double-click or Enter to close; Escape to abandon |
| **Edit Vertices** | drag a handle to move it, click to delete |

Hold **Command** (Control on non-Mac) in any tool to rotate the globe without
leaving it. A cutaway routinely wraps around the limb, so rotating mid-polygon
has to be possible.

The **Scene** panel switches what the surface shows: GEBCO topography (present
day only), reconstructed land fill, or flat. Moving the age slider off 0 while
in topography mode switches to the land fill, since present-day relief under
reconstructed coastlines would be misleading. It also toggles the plate
boundaries.

## Time

One age slider drives every time-dependent layer, but they do not all step
together, so the readout at bottom left says what each is actually showing:

```
age 137.0 Ma  ·  mantle 140 Ma  ·  boundaries 137 Ma
```

| layer | resolution | why |
|---|---|---|
| coastlines | continuous | rotated in the browser, so any age is exact — see [ADR 0001](docs/adr/) |
| boundaries | 1 Myr, snapped | resolved topologies change discontinuously; there is nothing to interpolate |
| mantle | 20 Myr, snapped | what OPT1 ships |

Snapping silently would let someone read a 140 Ma mantle as a 137 Ma one. Volume
frames are 12 MB each, so they are fetched on demand, cached four deep, and the
neighbours of the current age are prefetched.

## The paleoclimate viewer

`climate.html` reuses the same volume-texture / archive machinery as the
mantle viewer, aimed at annual-mean surface temperature from the Li, Hu et al.
2022 CESM simulation (0-540 Ma, 10 Myr steps): `prep/prep_climate.py`. A
second layer, paleogeography, comes from Scotese & Wright (2018) PaleoDEM
elevation rasters via `prep/prep_paleogeography.py`, coloured with GMT's
hypsometric `geo` colormap hinged at true sea level rather than a binary
land/ocean fill.

Both layers are reconstructed against the **Scotese** plate model, not
Müller — that is the model the climate simulation itself was run on, and
mixing reconstruction frames the way the mantle viewer's Müller 2019/2022 pair
must not be (see *One rotation model, everywhere*, below) would put
paleogeography under the wrong climate. `prep/prep_coastlines.py` — unchanged
from the mantle viewer's coastline prep, just pointed at Scotese's continent
polygons and rotation file instead of Müller's — produces the reconstructed
continent-outline overlay. There is no plate-boundary layer here: Scotese's
model does not resolve topologies the way Müller 2022 does, so unlike the
mantle viewer there is nothing for deep-time-map to draw.

Age range is bounded by the **climate manifest's own frame range**, 0-540 Ma.
Unlike the mantle viewer's Müller coastlines (capped at 200 Ma), the Scotese
continent outlines and paleogeography rasters both cover the full 0-540 Ma
span, matching the climate data end to end.

## Regenerating the archive

Everything runs in the `pygmt17` conda environment.

```bash
conda run -n pygmt17 python prep/prep_colormaps.py

conda run -n pygmt17 python prep/prep_model.py \
    --input /Users/simon/Data/SeismicTomography/Schouten_Supplementary_material/Models/REVEAL_anomaly.nc \
    --id reveal --name REVEAL \
    --var vs_anomaly:vs:"Vs anomaly" \
    --var vp_anomaly:vp:"Vp anomaly" \
    --validate

conda run -n pygmt17 python prep/prep_convection.py \
    --input /Users/simon/Data/zenodo/OPT1_temperature_anomaly_grids_dimensional \
    --id opt1 --name "Muller 2022 OPT1" --age-max 200 --validate

# Coastline GEOMETRY from Muller 2019 v2, ROTATIONS from Muller 2022. See below.
CACHE=~/Library/Caches/gprm
conda run -n pygmt17 python prep/prep_coastlines.py \
    --coastlines "$CACHE/Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics/StaticGeometries/Coastlines/Global_coastlines_2019_v1_low_res.shp" \
    --rotations  "$CACHE/Muller2022/optimisation/1000_0_rotfile_MantleOpt.rot" \
    --age-max 200

PYTHONPATH="$PYTHONPATH:$PWD/viewer/vendor/deep-time-map/python" \
conda run -n pygmt17 python -m deep_time_map.export \
    --model Muller2022 --end 200 --out archive/boundaries

conda run -n pygmt17 python prep/prep_topography.py
conda run -n pygmt17 python test-data/make_fixtures.py
conda run -n pygmt17 python prep/build_archive_index.py
```

`prep_convection.py` exists separately from `prep_model.py` because one volume
here is 65 files and the series is another 11 on top of that, where a tomography
model is a single netCDF. Both age and depth are parsed from the filename and
the levels sorted by the parsed depth — sorting by directory order puts 1040 km
before 0140 km in some locales.

`prep_model.py` reads the source variable's dimension order from the file
rather than assuming it, so the same command ingests REVEAL `(lat, lon, depth)`
and SEMUCB-WM1 `(depth, lat, lon)` with only `--var` changing.

### Models currently in the archive

| id | grid | valid depth | notes |
|---|---|---|---|
| `reveal` | 360x181x192 | 0-2735 km | Vs and Vp. Default. |
| `semucb` | 360x181x192 | 48-2735 km | Top 12 levels dropped as >1% NaN |
| `uup07` | 360x181x192 | 5-2816 km | Vp; basal trim correctly does nothing here |
| `opt1` | 360x181x192 | 16-2840 km | **11 frames, 0-200 Ma.** Temperature anomaly, K |
| `climate-540myr` | 360x181x1 | n/a | **55 frames, 0-540 Ma.** Annual-mean surface T, degC. Paleoclimate viewer. |
| `paleogeography-scotese` | 360x181x1 | n/a | **109 frames, 0-540 Ma.** Elevation, `geo` colormap. Paleoclimate viewer. |
| `fixture-check` | 360x181x192 | 0-2840 km | Checkerboard, sign flips at 660 and 1800 km |
| `fixture-ramp` | 360x181x192 | 0-2840 km | Pure function of depth |
| `fixture-drift` | 360x181x192 | 0-2840 km | 11 frames; blob at lon = age x 0.5 |

OPT1 is on REVEAL's grid exactly, so the two are directly comparable — the 65
non-uniform source levels are oversampled to 192 uniform ones, which adds no
information but keeps one grid shape across the archive. 12 MB per frame,
131 MB for the series.

`climate-540myr` and `paleogeography-scotese` are single-layer fields
(`ndepth: 1`) for the paleoclimate viewer, built by `prep/prep_climate.py` and
`prep/prep_paleogeography.py` respectively:

```bash
conda run -n pygmt17 python prep/prep_climate.py \
    --input "<path to High_Resolution_Climate_Simulation_Dataset_540_Myr.nc>" \
    --validate

conda run -n pygmt17 python prep/prep_paleogeography.py --validate

conda run -n pygmt17 python prep/prep_coastlines.py \
    --coastlines "$CACHE/Cao2018_SM/SupplementaryMaterial_Cao_etal/Rotation_models/Scotese_2008_PresentDay_ContinentalPolygons.shp" \
    --rotations  "$CACHE/Cao2018_SM/SupplementaryMaterial_Cao_etal/Rotation_models/Scotese_2008_Rotation.rot" \
    --age-min 0 --age-max 540 --age-step 1 \
    --out archive/scotese_coastlines

conda run -n pygmt17 python prep/build_archive_index.py
```

Both fetch their source data through `gprm` — but only the parts that need
`pooch`/`xarray`/`pygplates`, loaded by file path rather than `import gprm`,
since the package `__init__` unconditionally pulls in `ptt`
(PlateTectonicTools), which is not part of the `pygmt17` environment.

A single-layer field needs `depth_min_km`/`depth_max_km` set to a
**non-degenerate placeholder** (`0.0`/`1.0`, not `0.0`/`0.0`) — the shader's
`volumeUVW()` divides by `depth_max_km - depth_min_km`, and an equal min/max
divides by zero, rendering solid grey regardless of age.

**Its top and bottom levels are identically zero.** Isothermal boundary
conditions at the surface and the CMB, so after the horizontal mean is removed
there is no signal left at 0 km or 2867 km. `trim_bad_base()` cannot catch
these: it tests lateral roughness and departure from a deep-mantle mean, and a
constant zero level has the *lowest possible* roughness and sits *exactly* on
the baseline mean, so it passes both tests convincingly. Ingest drops them with
a separate test that looks for absence of signal rather than excess of it,
leaving 16-2840 km.

Two REVEAL details worth not rediscovering the hard way.

**Its base is corrupt in two different ways, and the obvious test only finds
one.** Below ~2870 km the mean runs away to +20 %, which is easy to spot. But
from ~2750 km the field is already spiky row to row while its mean still reads
like plausible mantle (+0.3 %). Clipping on the mean alone leaves that ~100 km
in the volume, where it renders as latitude banding across the base of every
cutaway and looks like a rendering bug. Ingest trims the base using lateral
roughness *and* the mean, against a baseline taken from the deep mantle.

**Its values reach ±35 % in the crust** while lower-mantle structure sits at
±2 %, so the uint8 encoding range defaults to a percentile rather than the
absolute maximum, which would quantise the entire lower mantle into a few codes.

### Colour polarity depends on the variable, not the model

Slabs should be blue and plumes red. But a slab is a **positive** anomaly in
seismic velocity and a **negative** one in temperature, so there is no single
correct orientation for a diverging ramp:

| variable | high means | high end of the ramp |
|---|---|---|
| Vs / Vp anomaly | fast, therefore cold | cool — `RdBu` |
| temperature anomaly | hot | warm — `RdBu_hot` |

`prep_colormaps.py` emits every diverging map in both orientations, tagged
`high_end: warm` or `cool`. Orientation is **measured from the sampled RGB**
rather than taken from matplotlib's `_r` naming, then asserted. Each variable
declares `high_means: fast | hot`; ingest picks the matching ramp and asserts
the match, and the viewer offers only ramps of the right polarity, so choosing
a wrong one is unreachable rather than merely non-default.

This is the third time this class of bug has come up here. All three looked
entirely plausible on screen.

### Plate boundaries

Drawn by [deep-time-map](https://github.com/siwill22/deep-time-map) onto a 2D
canvas over the WebGL globe. That library talks to its host through exactly one
method, `project(vec3) -> [x, y, depth] | null`, so integrating it costs a
projector and nothing else — the subduction-polarity triangles, the pixel-spaced
decoration walk and the pen-lift at the horizon all come across unchanged, and
already verified.

Three things the projector has to get right:

**The frames differ but are compatible.** deep-time-map works in the geographic
frame (Z through the pole); Geode works in three.js Y-up. The map between them
is a permutation with determinant **+1** — a rotation, not a reflection — so the
`a x tangent` cross product that decides which side the triangles go on survives
untouched. A reflection would silently mirror every subduction zone.

**The horizon is at `dot(v, camDir) > R/d`, not `> 0`.** The library's reference
projector is orthographic, where the visible cap ends at 90°; under perspective
at d = 2.6 R it ends at 67°. Note that the obvious test — "is anything drawn
outside the silhouette?" — does *not* catch this, because points between the two
horizons project **inside** the disc and paint the far side over the near one.
`check:render` probes the projector at three known angles instead.

**The overlay has no depth buffer**, so where the cutaway has removed the ground
the lines are culled explicitly, by looking up the same mask raster the surface
shader discards on — not by a second point-in-polygon implementation.

### The topography must be resampled, not truncated

`prep_topography.py` decimates GEBCO by an integer stride, which does not land
on the output size: 21601 columns strided by 5 gives 4321, not 4096. An earlier
version **truncated** to the output size, keeping only lon −180…+161.3° and lat
−90…+80.7° and letting the shader stretch that across the whole globe.

That is a **1.0547× scale error anchored at lon −180 / lat −90**, not an offset,
so it grows with distance from that corner — about 15° of longitude at Sumatra
and 5° of latitude at the equator, in both axes at once, by different amounts in
different places. Every other layer derives lon/lat from world position, so only
the topography moved; it looked like a reconstruction problem and was not.

It is now interpolated onto the exact texel centres the shader samples,
`lon = −180 + (i+0.5)·360/W`, and checked on every build.

The check correlates the written image's blue-minus-red against the same
quantity predicted from the source grid through the same palette, and fits the
best offset **separately in six longitude bands and six latitude bands**:

```
longitude -180..-120: +0.00  -120..-60: +0.00  -60..+0: +0.00  ...
```

Per band is the point. A constant shift reads as the same non-zero value in
every band; a scale error reads as a *ramp* across them — the real bug gave
+4.75, +8.50, +10.75, +15.25, +19.75 — and a single global fit would have
averaged that into something unremarkable. Correlation rather than a land/ocean
classifier because any fixed RGB threshold misjudges `geo`'s pale shelf colours:
the first version of this check missed a seventh of the ocean and was no better
than chance *at the shoreline*, which is exactly where the positional signal is.

### One rotation model, everywhere

OPT1 was run on the Müller 2022 plate model, so the surface layers must use it
too. Müller 2019 and Müller 2022 differ by a **whole-Earth rotation of up to
6.4° (~715 km at the equator) at 200 Ma** — all plates by the same amount, which
is the absolute reference frame differing, exactly the error that would put a
slab under the wrong continent.

gprm's Müller 2022 ships no coastlines, only continent polygons, so coastline
*geometry* still comes from Müller 2019 v2 while the *rotations* come from
Müller 2022's `MantleOpt` file — the mantle reference frame, which is what a
convection model is referenced to. All 310 coastline plate IDs resolve against
it.

## Checks

```bash
cd viewer
npm run typecheck
npm run check:mask        # spherical scanline vs pygplates
npm run check:boundaries  # subduction polarity vs resolved plate polygons
npm run check:render      # headless render of the visual criteria
```

**Always run `check:boundaries` through the wrapper, never
`deep_time_map.verify` directly.** Its CLI takes `--model`, defaulting to
`Merdith2021`, and does not read the model name from the export's manifest. Aim
it at a Müller 2022 export and it resolves Merdith topologies instead. Because
the two models share Merdith's topologies — identical feature counts — the only
difference is the rotations, so agreement degrades smoothly with age in step
with the 0° / 2.9° / 6.2° rotation difference at 0 / 50 / 100 Ma:

| age | against Merdith2021 (wrong) | against Muller2022 (right) |
|---|---|---|
| 0 Ma | 75 agree / 3 disagree | 75 / 3 |
| 50 Ma | 18 / 24 | 59 / 0 |
| 100 Ma | 14 / 16 | 41 / 0 |
| 150 Ma | 14 / 19 | 45 / 0 |

The left-hand column reads exactly like a real polarity bug that worsens into
deep time. It is not one. `prep/check_boundaries.py` takes the model from the
manifest so the mistake cannot be made. The 3 disagreements at 0 Ma are genuine,
in Müller 2022's present-day trenches.

`check:mask` is the important one. The cutaway mask is rasterised in TypeScript
because the polygon is drawn interactively in the browser, where pygplates is
not available — but pygplates is the reference implementation for
point-in-polygon on a sphere, so it holds the scanline to account offline across
a set of deliberately awkward polygons (pole-enclosing, both poles,
antimeridian-spanning, larger than a hemisphere, narrow slivers).

`check:render` needs the dev server running, and writes annotated screenshots to
`viewer/shots/`. Beyond the screenshots it asserts six things, all of which
would otherwise need an expert eye and none of which is visible in a plausible
render:

- **`fixture-drift` lands on the right frame.** Its blob sits at `lon = age x
  0.5`, and the check decodes the volume texture *actually bound to the GPU* at
  two ages. Catches an off-by-one frame index or a reversed series.
- **The Pacific LLSVP is hot** at 2600 km (+773 K) — colour polarity, from the
  data rather than by eye.
- **The mantle under 100 Ma trenches is cold**: −154 K against +3 K globally at
  300 km, sampling beneath the actual exported trench positions rather than a
  present-day guess. This is the one check that ties the surface to the volume,
  and the only one that would catch the two being in different reference frames.
- **The projector uses the perspective horizon**, probed at three known angles.
- **The boundary frame tracks the age.**
- **The no-data grey** is exactly `#555555`, which is how SEMUCB's valid-range
  band gets verified — at 48 km it is only ~1.7 % of the mantle and too thin to
  judge by eye.

## Deploying

The site is static, so GitHub Pages serves it whole — but the data must not go
through git. `archive/` is ~400 MB of derived binary, and binary does not delta
compress, so committing it would add a fresh several-hundred-MB copy to history
on every regeneration, permanently. Instead the data is a **release asset** and
`.github/workflows/deploy.yml` pulls it in at build time. The Pages artifact
carries the bytes to Pages storage without them entering the repo, which is what
lets code deploy as often as it likes against data uploaded once.

`prep/pack_deploy.mjs` turns the generated archive into the deployable one:

```bash
node prep/pack_deploy.mjs          # archive/ -> archive-deploy/
```

Two changes, both about the 1 GB Pages cap and the bandwidth budget. It **drops
the fixture models** — they exist for `check:render` and are ~160 MB of that —
and it **gzips the volumes**, rewriting each manifest's `path_template` to
`.bin.gz` so nothing else needs a flag. ~200 MB of volumes becomes ~92 MB; the
whole deployable archive is **~130 MB**. Pre-compressing is worth the trouble
because a CDN will not compress `application/octet-stream` for you. The JSON is
deliberately left alone, since `application/json` *is* compressed on the wire.

Deployed at **<https://siwill22.github.io/Geode/>**. The repo is private; a
Pages *site* is public regardless, since access-controlled Pages is Enterprise
Cloud only.

### One-time setup

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. A **read-only deploy key** for the submodule. `deep-time-map` is a separate
   private repo, and a workflow's `GITHUB_TOKEN` is scoped to this one, so
   `checkout` cannot fetch it — the failure reads `Repository not found`, which
   looks like a bad URL rather than a permissions problem. A deploy key grants
   read on exactly that one repo, where a PAT would carry the whole account's
   access into CI:

```bash
ssh-keygen -t ed25519 -N "" -C geode-ci-readonly -f /tmp/dtm_key
gh api -X POST repos/siwill22/deep-time-map/keys \
    -f title="Geode CI (read-only)" -f key="$(cat /tmp/dtm_key.pub)" -F read_only=true
gh secret set DTM_DEPLOY_KEY --repo siwill22/Geode < /tmp/dtm_key
rm /tmp/dtm_key /tmp/dtm_key.pub
```

3. Pack and upload the data:

```bash
node prep/pack_deploy.mjs
tar -czf archive-deploy.tar.gz -C archive-deploy .
gh release create data-v1 archive-deploy.tar.gz \
    --title "Archive v1" --notes "Packed archive for the deployed viewer."
```

The tarball holds the archive's *contents*, not the directory — the workflow
extracts into `archive/`, which is what `viewer/public/archive` points at.

After that, **deploying code is just `git push`**. Updating the data means a new
tag and a matching bump of `DATA_RELEASE` in the workflow.

### Verifying what will actually ship

The packed archive is a different set of bytes reaching the shader through a
different code path, so it gets held to the same screenshots. Point the existing
symlink at it — which is exactly the arrangement CI builds — and re-run the
render check:

```bash
node prep/pack_deploy.mjs --keep-fixtures      # check:render needs the fixtures
ln -sfn ../../archive-deploy viewer/public/archive
cd viewer && npm run dev &
node scripts/shoot.mjs /tmp/shots-gz           # must match a raw-archive run
ln -sfn ../../archive public/archive           # restore for dev
```

Every screenshot and check comes back identical to a run against the raw
archive. Do not simply keep a second symlink in `viewer/public/` — vite copies
that directory wholesale, so a stray one ships both archives and doubles the
site.

### The limits, and when they bite

| | |
|---|---|
| Published Pages site | **1 GB hard** — currently ~130 MB |
| Bandwidth | 100 GB/month soft |
| Repo | unaffected; stays ~1 MB |

Dataset *count* is cheap; what costs is **frames x variables x resolution**. A
static tomography model is one frame-variable, ~6 MB packed. OPT1 is eleven, ~70
MB. So the headroom is roughly a dozen more convection series, or a hundred more
static models — but doubling the grid resolution is 8x the bytes and would spend
it fast.

Bandwidth is the softer constraint: first load is ~20 MB and scrubbing the whole
OPT1 series pulls ~69 MB, so 100 GB/month is several hundred engaged visits.
Exceeding it prompts an email, not a bill.

When either becomes real, the seam is already there: `VITE_ARCHIVE_BASE` points
the viewer at an absolute URL, so the archive can move to object storage with
free egress (Cloudflare R2) while Pages keeps serving the 630 kB app. The only
extra requirement is CORS headers on the data host.

## Layout

```
prep/                       netCDF/GPML -> viewer binary format (Python, pygmt17)
prep/prep_climate.py        climate netCDF -> climate-540myr model
prep/prep_paleogeography.py Scotese PaleoDEM -> paleogeography-scotese model
prep/pack_deploy.mjs        archive/ -> archive-deploy/, for the deployed site
archive/                    generated data, served statically, not tracked
archive-deploy/             packed subset that ships; not tracked
viewer/                     TypeScript + Vite + three.js
viewer/index.html           the mantle viewer's entry page
viewer/climate.html         the paleoclimate viewer's entry page
viewer/src/core/            shared engine: rendering, data loading, colour ramps
viewer/src/tomography/      mantle viewer only
viewer/src/climate/         paleoclimate viewer only
viewer/vendor/               deep-time-map submodule
test-data/                  synthetic fixtures and the pygplates cross-check
docs/adr/                   architecture decisions
.github/workflows/          Pages deploy
```

## Attribution

**Mantle viewer.** Topography from GEBCO, coloured with GMT's `geo`. Colour
ramps from matplotlib. Coastline geometry from Müller et al. 2019 v2.
Rotations, plate boundaries and the OPT1 convection run from Müller et al.
2022. Plate boundary rendering by
[deep-time-map](https://github.com/siwill22/deep-time-map). Tomography models
are cited per-model in each `manifest.json`.

**Paleoclimate viewer.** Climate simulation from Li, X., Hu, Y. et al. 2022,
*A high-resolution climate simulation dataset for the past 540 million years*,
Scientific Data. Paleogeography from Scotese & Wright 2018, PALEOMAP
PaleoDEMs. Continent outlines from the Scotese 2008 rotation model, via Cao et
al. 2018.
