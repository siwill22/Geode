# Geode

*[Crack the Earth open and look at the structure inside.]*

This repo contains a shared three.js/Vite engine for browsing 3D Earth-science volumes on a
reconstructed spherical globe. 100% vibe-coded. Docs from here down are AI-generated....

For a live index of which of these (and the generator's own generated sites)
are actually deployed right now, see the
[deconstructions hub](https://siwill22.github.io/elstir/) rather than this file —
deployment status changes independently of the code and drifts out of date
here fast.

On top of the same engine, a **generator** (`generator/`, driven by the
`geode-globe-viewer` Claude Skill) scaffolds standalone, deployable viewer
sites from the data catalog alone — no data-prep judgment calls, no new
code. It produces one of four generic wrapper types, each also checked into
this monorepo with a real working example so `npm run dev`/`typecheck`
exercise them without running the generator first:

| entry page | wrapper type | this repo's checked-in example |
|---|---|---|
| [`globe.html`](viewer/globe.html) | `single-model-globe` — one Model, no comparison controls | Cao 2024 |
| [`groupGlobe.html`](viewer/groupGlobe.html) | `model-group-globe` — several Models from one comparison family, switched via dropdowns | Cao2024/Müller2019 |
| [`reconstruction.html`](viewer/reconstruction.html) | `single-reconstruction-globe` — one Reconstruction Model's own coastlines/boundaries, no numerical field | Müller et al. 2019 |
| [`reconstructionGroup.html`](viewer/reconstructionGroup.html) | `reconstruction-group-globe` — several Reconstruction Models' geometry, switched via one dropdown | Müller 2019 vs Seton 2012 |

All ten entry points (six bespoke, four generated) share the same
engine (`viewer/src/core/`) — the archive/manifest data format,
volume-texture sampling, coastline reconstruction, colour-ramp machinery,
Multi-Globe tiling (ADR-0022), and Query Point (Anchored/Plate-Frame) are
implemented once, not duplicated per viewer. A new bespoke viewer is a new
entry page plus a new wrapper directory, not a branch inside an existing
one; a new generic one is a generator recipe, not new code at all. See
*Layout* below.

Phases 1, 2, 2b and 4 of [the spec](tomography-globe-viewer-spec.md) are
built for the mantle viewer (see the spec's own "Phasing" section for what
Phase 3 still lacks). Design vocabulary is in [CONTEXT.md](CONTEXT.md);
decisions with lasting consequences are in [docs/adr/](docs/adr/) — the
generator's own four-wrapper-type design in particular is ADRs 0017, 0018,
0020, 0021 and 0022, plus `generator/recipeTypes.ts`'s own doc comments and
`.claude/skills/geode-globe-viewer/SKILL.md`.

## Quick start

```bash
git clone --recurse-submodules <this repo>
cd viewer
npm install
npm run dev   # http://localhost:5173                        mantle viewer
              # http://localhost:5173/climate.html            paleoclimate viewer
              # http://localhost:5173/valdes.html              Valdes/BRIDGE viewer
              # http://localhost:5173/oldmap.html               Old Map viewer
              # http://localhost:5173/paleobio.html              paleobiology viewer
              # http://localhost:5173/themelab.html               Theme Lab
              # http://localhost:5173/globe.html                generated: single-model-globe
              # http://localhost:5173/groupGlobe.html            generated: model-group-globe
              # http://localhost:5173/reconstruction.html         generated: single-reconstruction-globe
              # http://localhost:5173/reconstructionGroup.html     generated: reconstruction-group-globe
```

Plate boundaries are drawn by [petrify](https://github.com/siwill22/petrify),
a submodule at `viewer/vendor/petrify`. `git submodule update --init` if
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
mantle viewer. A **climate model** picker switches between two independent
CESM/FOAM simulations sharing the same Layer/Variable UI: Li, Hu et al.
2022 (`climate-540myr`, 0-540 Ma, 10 Myr steps, via `prep/prep_climate.py`)
and Pohl et al. 2022 (`climate-pohl2022`, via `prep/prep_pohl.py`) — surface
temperature, precipitation and (model-dependent) other fields are
switchable from a Variable dropdown; zonal/meridional wind (see *Wind
glyphs*, below) drive a separate glyph layer instead. Temperature/
precipitation carry real monthly resolution in the source, so the volume's
third axis -- the same generic "layer" axis the mantle viewer uses for
depth, `depth_min_km`/`depth_max_km` in the manifest -- carries a calendar
month (0-11) here instead, with a slider and a play button to animate the
seasonal cycle. A variable with no month axis in its own source is
broadcast to all 12 month layers so every variable in a manifest shares one
grid shape, rather than teaching the shared engine about a per-variable
grid shape for one static field.

A second layer, paleogeography, comes from Scotese & Wright (2018) PaleoDEM
elevation rasters via `prep/prep_paleogeography.py`, coloured with GMT's
hypsometric `geo` colormap hinged at true sea level rather than a binary
land/ocean fill. It has no month axis (elevation doesn't have a season), so
the variable dropdown and month slider hide on this layer.

A third, always-available slider layers the same paleogeography raster's
**shaded relief** translucently over whichever primary field is on screen —
terrain context for the climate data, not another colour-coded map competing
with it. `prep_paleogeography.py` computes it with `pygmt.grdgradient`, the
grid explicitly marked geographic (`da.gmt.gtype = 1`) rather than left at
PyGMT's Cartesian default — a plain Cartesian gradient gets the derivative
wrong toward the poles, where a degree of longitude covers less ground than
a degree of latitude. It ships as a second variable, `hillshade`, in the
same manifest as `elevation`; marked `overlay_only` so the variable picker
never offers it as a primary display choice, since it exists to drive the
overlay mesh, not to be looked at on its own.

Two more fixes were needed before the relief read consistently across all
109 ages. First, even with `gtype = 1` set, the pole rows (lat = ±90°) are
still degenerate — every longitude is the same physical point there, so the
longitude-direction derivative `grdgradient` computes at that row is
meaningless, and comes out as a spurious outlier orders of magnitude past
any real terrain slope; those rows are overwritten with their neighbour
before differencing, and zeroed again in the output. Second, PyGMT's
`normalize` option contrast-stretches each grid to its own min/max, so one
age's pole-row outlier (before the first fix) — or just ordinary variation
in terrain roughness between ages — silently changed the relief's contrast
age to age, "visible" for some and washed-out for others. The fix computes
the raw (unnormalized) gradient per age but encodes every age against one
shared clip range, the 99.5th percentile of `|gradient|` pooled across the
whole series, so intensity is comparable across time rather than
independently rescaled per frame.

### Wind glyphs

A fourth, always-available toggle draws 1000 hPa wind as arrow glyphs
directly on the sphere, sourced from the climate simulation's own `U`/`V`
fields regardless of which layer or variable is primary on screen — the same
"independent of the active layer" pattern as the shaded-relief overlay
above. `U`/`V` ride the same monthly pipeline as every other climate
variable in `prep/prep_climate.py` (global percentile clip, not a per-frame
one — see the hillshade fix above for why that matters) but are marked
`vector_only` so the variable picker skips them; they back
`core/windGlyphs.ts`'s arrow field, not a colour-mapped display of their
own. The pairing itself is declared in the manifest (`vector_fields`), not
hardcoded in the viewer, so a different model or a different viewer entirely
could declare its own vector field without a code change.

Turning a per-point `(u, v)` pair into a 3D arrow needs the sphere's actual
3D east/north tangent directions *at that point* — those rotate with
position on a globe, so a flat `(u, v) -> (x, y)` mapping would only be
correct at one longitude. `core/constants.ts`'s `eastNorthAt()` supplies
them, derived directly from `lonLatToVec3`'s own parameterisation so the two
stay consistent by construction. The glyph sample lattice also excludes the
pole rows outright (a longitude-direction quantity, like a "east" tangent,
is undefined exactly at lat=±90°, the same class of degeneracy the
hillshade fix above worked around) and widens its longitude spacing toward
the poles so arrow density stays roughly even in physical area rather than
clustering where meridians converge.

Verifying this feature surfaced an unrelated, pre-existing bug: switching
layers after changing the month left the globe rendering a flat "no data"
grey. The shader's out-of-range check compares the depth-slice's raw
selector value against the *newly active* layer's own valid range — a month
picked on the climate layer (0-11) falls outside paleogeography's (0-1), and
the check does not clamp, it discards. Fixed in `climateInstance.ts` by
clamping the selector into the active layer's own range on every layer
switch and month change (`clampToActiveDepthRange`), rather than handing the
shader a value that could be stale from the other layer.

### Wind Streaks

A second wind display mode, alongside Wind Glyph: animated particles
trailing fading "comet" streaks along the flow, in the style of NASA's
*Perpetual Ocean* — a `wind style` dropdown switches between the two.
They're mutually exclusive, not layered together: one shows the field's
instantaneous shape at fixed points, the other its qualitative flow, and
showing both at once would just be noise. See
`docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md` for why trails
are real 3D geometry glued to the globe rather than the classic
screen-space canvas-fade technique those reference visualizations use —
that trick assumes a view that never moves, and this globe orbits freely
under the user's mouse.

`core/windStreaks.ts` is a generic engine primitive, sibling to
`windGlyphs.ts`: particles advect along whichever month/age's `(u, v)`
snapshot is currently selected — a perpetual flow along a static field, not
a live time-evolving simulation, the same thing the NASA piece itself
visualizes — using the same `eastNorthAt()` tangent-frame math the arrows
use, stepped forward each animation frame and renormalised back onto the
sphere (a small-step spherical Euler integration; the flat 2D prototype
this was modeled on can get away with plain `position += velocity * dt`
precisely because it has no sphere to fall off of). Real wind speeds are
imperceptibly slow at this scale — a 10 m/s wind takes about a week to
circle the globe — so positions are advanced by a `STREAK_SPEED_SCALE`
constant, an explicit artistic time-compression tuned by eye, the same
thing every visualization in this genre does.

Two details worth calling out because they weren't obvious until the first
version was visibly wrong: a trail's ring buffer only committing a new
point every *animation frame* made streaks span about 0.2 real seconds
regardless of the particle's actual speed — trails need a slower, decoupled
recording cadence (`RECORD_INTERVAL_S`) so a handful of stored points can
span a couple of real seconds instead. And spawn positions must be sampled
`lat = asin(uniform(-1, 1))`, not a uniform draw over `[-90°, 90°]` — the
latter clusters particles toward the poles, since the ground area a degree
of latitude covers shrinks by `cos(lat)` away from the equator.

Particle state lives in flat typed arrays rather than particle objects, and
the advection step is written as a self-contained unit inside the update
loop — not because this needs it today (particle counts are modest and
CPU-driven, matching `WindGlyphs`), but because it is the seam a future
GPU (`GPUComputationRenderer`) version would replace without touching how
positions become ribbon geometry.

### Derived variables: Annual mean, seasonality, Köppen classes

Three more layers in `climate-540myr`, none pulled straight from the source:

- **Annual** is a 13th layer on the existing month axis (index 12,
  `prep_climate.py`'s `add_annual_layer()`) rather than a separate control —
  every variable in this manifest already shares one generic "layer" slot
  (month today, a single static layer for `LANDFRAC`), and an annual mean is
  exactly what that slot was designed to carry. The mean of the 12 real
  months for `T`/`P`/`SALB`/`U`/`V`; the same static value again for
  `LANDFRAC`. `U`/`V`'s Annual layer is a real, useful thing on its own —
  annual-mean circulation — and `core/windGlyphs.ts` needed no changes to
  show it, since it already reads whatever layer is currently selected.
- **Seasonality** (`T_RANGE`) is warmest-month-mean minus
  coldest-month-mean temperature per grid cell — "continentality" in the
  paleoclimate literature — computed from `T`'s own physical values (not
  round-tripped through its lossy uint8 encoding) and, like `LANDFRAC`,
  broadcast across every layer since a range has already collapsed the month
  axis by definition.
- **Köppen** is a 13-class simplified Köppen-Geiger climate classification
  (matching Pohl et al. 2022 Table 3, not the fuller ~30-subtype Peel,
  Finlayson & McMahon 2007 taxonomy), computed from `T` and `P` per age.
  Rendered as flat class colours rather than a smooth gradient by reusing
  the shader's existing `uSteps` "discrete contour bands" uniform — set
  `uSteps` to the class count and a colormap built as flat colour blocks
  (`prep_colormaps.py`'s `build_categorical_colormap()`) turns the same
  continuous-ramp pipeline categorical for free, no shader changes needed.
  `VariableInfo.categorical`/`class_names` mark it generically (any future
  categorical variable can reuse the same path); the UI hides the clip
  sliders and shows a swatch-and-name key instead of relying on an
  unlabelled row of bands.

  Two real bugs turned up building this, both worth recording since they're
  easy to reintroduce. First, the working reference implementation this was
  ported from (an internal notebook computing Köppen classes from the same
  source data) defined its summer/winter half-year month lists as if months
  were 1-indexed (Jan=1..Dec=12), but the source's actual `month` coordinate
  is 0-indexed (Jan=0..Dec=11, confirmed against the .nc file's own
  metadata) — both windows ended up shifted a month late. Second, and more
  subtly: `encode_uint8`'s `astype(np.uint8)` *truncates* rather than
  rounds, and the shader's band recovery *floors* — composing a truncating
  encode with a flooring decode silently shifts every class index except 0
  down by one band (confirmed by decoding the actual written bytes: central
  Sahara, unambiguously desert, was being stored and rendered as "temperate,
  no dry season"). Fixed by encoding each class at its **band centre**
  (`class + 0.5`, not the raw integer) — a wide enough margin either side of
  one encode step that the round trip recovers the intended class exactly
  for all 14 classes, verified directly rather than assumed. The original
  `--validate` spot check had read the pre-encoding array directly and so
  never caught this; it now decodes the same way the shader does.

Both layers are reconstructed against the **Scotese** plate model, not
Müller — that is the model the climate simulation itself was run on, and
mixing reconstruction frames the way the mantle viewer's Müller 2019/2022 pair
must not be (see *One rotation model, everywhere*, below) would put
paleogeography under the wrong climate. `prep/prep_coastlines.py` — unchanged
from the mantle viewer's coastline prep, just pointed at Scotese's continent
polygons and rotation file instead of Müller's — produces the reconstructed
continent-outline overlay. There is no plate-boundary layer here: Scotese's
model does not resolve topologies the way Müller 2022 does, so unlike the
mantle viewer there is nothing for petrify to draw.

Age range is bounded by the **climate manifest's own frame range**, 0-540 Ma.
Unlike the mantle viewer's Müller coastlines (capped at 200 Ma), the Scotese
continent outlines and paleogeography rasters both cover the full 0-540 Ma
span, matching the climate data end to end.

### Multiple globes

An "+ Add globe" toolbar button tiles an arbitrary number of globes on one
canvas, each independently choosing its own layer/variable/age/month/clip —
originally ported from the mantle viewer's own multi-globe support
(`tomography/main.ts`), since generalized into a genuinely shared
`core/multiInstanceHost.ts` primitive (ADR-0022) most entry points build on
(all but Valdes/BRIDGE, Old Map and paleobiology, which don't need it), not a
per-viewer reimplementation. One shared camera and
`OrbitControls` instance is the whole trick: rotation and zoom stay locked
across every globe for free, because there is only ever one camera object,
re-aimed at each tile's own viewport/scissor rect (`core/layout.ts`'s
`tileGrid()`, moved out of `tomography/` since it never had any
tomography-specific knowledge — pure rectangle packing) once per tile, once
per frame.

Age and month get their own **explicit** sync toggles ("sync time"/"sync
month"); nothing else does. A user edit on one globe pushes the new value
into every other globe's own state and re-applies it there — the same
broadcast pattern the mantle viewer uses for age/depth-slice — but layer,
variable, clip range and wind style stay independent per globe on purpose,
so e.g. Precipitation on one globe and Surface Temperature on another, at
the same synced age and month, is the point, not an edge case to guard
against.

This needed one structural change beyond the port itself: `ClimateInstance`
now owns its own `ClimateUI` panel and view state directly (constructed
internally, from a `hooks`/`label` pair — mirroring `GlobeInstance` owning
`UI`), rather than the two being separate objects wired together by
`climate/main.ts` as they were for the single-globe version. A view state
object living outside the instance it describes, kept in sync only by
convention (every mutation happens to flow through a callback that updates
both), is fine for exactly one instance and a live bug waiting to happen for
N of them — the same "two things that must agree, nothing enforces it"
shape this project has hit more than once. Each instance's control panel is
now anchored to its own tile (`ClimateUI.setRect()`) instead of lil-gui's
single fixed top-right placement, the same trick `tomography/ui.ts` already
uses.

### Query Point: Anchored and Plate-Frame

Shift-click reads a Variable's value at a point, in one of two modes (a
"query mode" toggle, see `CONTEXT.md`'s Query Point/Anchored Point/
Plate-Frame Point entries and ADR-0011/0025/0026):

- **Anchored** — the grid cell stays fixed as the age slider moves, reading
  whatever ends up there each Frame. Default, and the only mode in the
  generic globe viewer (`globe.html`) too.
- **Plate-Frame** — climate-only. The clicked point is assigned to a static
  polygon (`core/staticPolygons.ts`, ADR-0025) at the reference age, then
  re-expressed in grid space at every other age via that plate's own
  rotation, so the query follows the same piece of crust rather than a
  fixed lon/lat. Reports "no plate found" if the click misses every static
  polygon, or once the age scrubs past the assigned polygon's own begin
  age — a real, expected outcome, not an error.

Either mode's result panel shows **Month Profile** (all months of the
current Frame, free — the texture is already resident for display) and
**Age Series** (one value per Frame across the whole model's age range,
fetched once per point rather than on every age-slider tick, ADR-0027)
stacked together, both charted against the currently active clip range and
tinted with the active colormap so a chart's vertical position visually
matches the colour the same value paints on the globe.

### Plate Carrée projection

A projection toggle switches the whole scene (field, overlay, wind,
coastlines) between the default 3D globe and a flat equirectangular plane
(ADR-0003) — reprojecting wind glyphs/streaks' tangent-frame math along the
way (ADR-0006), rather than only reprojecting the base sphere and leaving
wind glyphs pointing in globe-relative directions on a flat map.

## Regenerating the archive

### Environment

```bash
conda env create -f environment.yml
conda activate geode
```

`environment.yml` pins everything the prep scripts need, including GMT — the one dependency
pip cannot provide, since `pygmt` wraps the GMT C library rather than bundling it. The
commands below say `-n pygmt17` because that is the environment they were developed in;
`-n geode` works identically.

### Inputs

Most inputs download themselves on first use and are cached alongside gprm's datasets
(`python -c "from gprm.datasets import cache_path; print(cache_path())"`):

| Input | Source | Size |
|---|---|---|
| Reconstruction models, coastlines, palaeogeography | `gprm.datasets` | fetched per model |
| Muller et al. (2022) OPT1 mantle temperature grids | Zenodo [6622194](https://zenodo.org/records/6622194), one file of ten | 2.3 GB |
| Surface topography | NOAA ETOPO 2022 60 arc-second | 478 MB |
| REVEAL tomography anomalies | Zenodo [13991965](https://doi.org/10.5281/zenodo.13991965), one member of one zip | 4.6 GB transferred |

**Every input now fetches itself.** The tomography grid was the last holdout, and it is the
awkward one: Schouten et al. (2024), *Sci. Rep.* **14**, 26708 is published as a **single
18.97 GB zip** with no per-file URLs, of which `Models/REVEAL_anomaly.nc` (4.98 GB) is the only
part this build wants.

`prep/_inputs.py` extracts just that member using HTTP range requests. A zip keeps its index at
the end, so three small reads (about 160 kB) give the byte offset and length of every member;
the one wanted is then fetched as a byte range and inflated on the fly. The transfer is **4.6 GB
instead of 19 GB**, and the member is verified against the CRC32 recorded in the archive's own
directory, which is a stronger guarantee than a checksum over a file that is never downloaded
whole. Verified byte-identical (md5) against a manually downloaded copy.

`prep_model.py --downsampled` fetches `REVEAL_downsampled_anomaly.nc` instead: 84 MB, same seven
variables, but 23 depth levels rather than 342. Too coarse for the default `--ndepth 192`, and
useful for exercising the pipeline without a 4.6 GB download.

> **Known issue — the full 4.6 GB fetch has not been run end to end.**
>
> Every part of it is exercised by the 84 MB member, which goes through identical code, and the
> resume path is tested by injecting a mid-stream failure. But a one-hour transfer is the only
> thing that tests a one-hour transfer, and it has not been done.
>
> There is a specific reason to be wary. During development Zenodo answered a request for
> **128 bytes** by beginning to send the whole archive, and the connection broke after 11.27 GB
> (`IncompleteRead(11268954172 bytes read, 7585292681 more expected)`). This could not be
> reproduced afterwards: 15 consecutive range requests, and a replay of the exact sequence that
> failed, all returned clean `206 Partial Content`. The cause is unknown and assumed transient.
>
> Two mitigations are in place. A response that is not `206` is rejected before any of the body
> is read, so an ignored `Range` header costs a second rather than 19 GB. And the transfer
> resumes from the compressed byte it stopped at, retrying up to six times with exponential
> backoff, so a dropped connection does not restart it.
>
> If a real run does fail, `--downsampled` will confirm whether the problem is the transfer size
> or the code. Please record what happened here.

REVEAL ships natively on an unstructured Salvus mesh, so this regular lon/lat/depth grid is a
derived product of the Schouten paper rather than part of the REVEAL release. Two near misses
worth recording: Zenodo [10684325](https://zenodo.org/records/10684325) is the dataset of the
REVEAL *model* paper (Thrastarson et al. 2024) — 49.3 GB of benchmark seismograms, no tomography
grid; and ETH publishes REVEAL directly in netCDF
(400 MB, [cos.ethz.ch/models.html](https://cos.ethz.ch/models.html)), but as absolute velocities
rather than the `vs_anomaly`/`vp_anomaly` this pipeline reads, from a polybox share with no DOI
or checksum.

### Build

```bash
conda run -n pygmt17 python prep/prep_colormaps.py

# extracts REVEAL_anomaly.nc from the Schouten Zenodo zip on first run (4.6 GB);
# add --downsampled for the 84 MB version, or --input for your own grid
conda run -n pygmt17 python prep/prep_model.py \
    --id reveal --name REVEAL \
    --var vs_anomaly:vs:"Vs anomaly" \
    --var vp_anomaly:vp:"Vp anomaly" \
    --validate

# downloads the OPT1 grids from Zenodo on first run
conda run -n pygmt17 python prep/prep_convection.py \
    --id opt1 --name "Muller 2022 OPT1" --age-max 200 --validate

# Coastline GEOMETRY from Muller 2019 v2, ROTATIONS from Muller 2022. See below.
# Both models are fetched by gprm; run these once to populate the cache:
#   python -c "from gprm.datasets import Reconstructions as R; R.fetch_Muller2019(); R.fetch_Muller2022()"
CACHE=$(conda run -n pygmt17 python -c "from gprm.datasets import cache_path; print(cache_path())")
conda run -n pygmt17 python prep/prep_coastlines.py \
    --coastlines "$CACHE/Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics/StaticGeometries/Coastlines/Global_coastlines_2019_v1_low_res.shp" \
    --rotations  "$CACHE/Muller2022/optimisation/1000_0_rotfile_MantleOpt.rot" \
    --age-max 200

PYTHONPATH="$PYTHONPATH:$PWD/viewer/vendor/petrify/python" \
conda run -n pygmt17 python -m petrify.export \
    --model Muller2022 --end 200 --out archive/boundaries

# downloads ETOPO 2022 on first run
conda run -n pygmt17 python prep/prep_topography.py
conda run -n pygmt17 python test-data/make_fixtures.py
conda run -n pygmt17 python prep/build_archive_index.py
```

### Unresolved inputs

These still need a path supplied, because no public source is recorded for them. Both are used
only by the Old Map viewer; **the core build is now entirely self-serving.**

| Input | Needed by | Override |
|---|---|---|
| StoryMaps LIP export | `prep_oldmap_volcanoes.py` (Old Map viewer only) | `$GEODE_LIP_DIR` |
| `JW_HotspotCatalogue.shp` | `prep_oldmap_volcanoes.py` (Old Map viewer only) | `$GEODE_WHITTAKER_HOTSPOTS` |

`prep_convection.py` exists separately from `prep_model.py` because one volume
here is 65 files and the series is another 11 on top of that, where a tomography
model is a single netCDF. Both age and depth are parsed from the filename and
the levels sorted by the parsed depth — sorting by directory order puts 1040 km
before 0140 km in some locales.

`prep_model.py` reads the source variable's dimension order from the file
rather than assuming it, so the same command ingests REVEAL `(lat, lon, depth)`
and SEMUCB-WM1 `(depth, lat, lon)` with only `--var` changing.

### Models currently in the archive

**Mantle** (`viewer/index.html`):

| id | grid | valid depth | notes |
|---|---|---|---|
| `reveal` | 360x181x192 | 0-2735 km | Vs and Vp. Default. |
| `semucb` | 360x181x192 | 48-2735 km | Top 12 levels dropped as >1% NaN |
| `uup07` | 360x181x192 | 5-2816 km | Vp; basal trim correctly does nothing here |
| `opt1` | 360x181x192 | 16-2840 km | **11 frames, 0-200 Ma.** Temperature anomaly, K |

OPT1 is on REVEAL's grid exactly, so the two are directly comparable — the 65
non-uniform source levels are oversampled to 192 uniform ones, which adds no
information but keeps one grid shape across the archive. 12 MB per frame,
131 MB for the series.

**Paleoclimate** (`climate.html`, `valdes.html`):

| id | grid | frames | notes |
|---|---|---|---|
| `climate-540myr` | 360x181x13 | 55, 0-540 Ma | Li et al. 2022. T, P, SALB, LANDFRAC, U, V, T_RANGE, KOPPEN. |
| `climate-pohl2022` | 360x181x13 | 28, 0-540 Ma | Pohl et al. 2022. T, P, EVP, RNF, PME, TOPO, LANDMASK, KOPPEN. |
| `paleogeography-scotese` | 360x181x1 (+ hi 1440x721) | 109, 0-540 Ma | Elevation + hillshade overlay, `geo` colormap. |
| `bridge-valdes2021-monthly` | 360x181x13 | 109, 0-541 Ma | Valdes et al. 2021 BRIDGE atmosphere: T, P, MSLP, ICECONC, U, V, SST, SSS, OCU, OCV, ICEU, ICEV, STREAMFN, MLD, KOPPEN. |
| `bridge-valdes2021-ocean-depth` | 360x181x20 | 109, 0-541 Ma | Same run's ocean fields at 20 depth levels, annual only: OTEMP, OSAL, OCURU, OCURV, OVEL. |

**Fixtures** (`check:render` only — dropped from the deployed archive):

| id | grid | notes |
|---|---|---|
| `fixture-check` | 360x181x192 | Checkerboard, sign flips at 660 and 1800 km |
| `fixture-ramp` | 360x181x192 | Pure function of depth |
| `fixture-drift` | 360x181x192 | 11 frames; blob at lon = age x 0.5 |

`climate-540myr`/`climate-pohl2022`/the BRIDGE monthly model (`ndepth: 13`,
the volume's layer axis carrying month + Annual) and `paleogeography-scotese`/
the BRIDGE ocean-depth model (no month axis) are built by `prep/prep_climate.py`,
`prep/prep_pohl.py`, `prep/prep_bridge.py` and `prep/prep_paleogeography.py`
respectively — each script's own module docstring has its exact invocation.
Reconstruction Model coastlines/
boundaries/static-polygons themselves (Müller 2019, Seton 2012, Scotese) come
from `prep/prep_reconstruction.py` and `prep/prep_staticpolygons.py` (ADR-0021,
ADR-0025), one `gprm.datasets.Reconstructions.fetch_<model>()` call each so
rotations/geometry/topology can never come from mismatched sources
(ADR-0004). The worked example below shows the pattern (`prep_climate.py` +
`prep_paleogeography.py` + `prep_coastlines.py`, Scotese's own coastlines);
every other prep script above follows the same shape.

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

`prep_paleogeography.py` and `prep_coastlines.py` fetch their source data
through `gprm` — but only the parts that need `pooch`/`xarray`/`pygplates`,
loaded by file path rather than `import gprm`, since the package `__init__`
unconditionally pulls in `ptt` (PlateTectonicTools), which is not part of
the `pygmt17` environment. `prep_climate.py` reads a local netCDF instead
(`--input`), unrelated to `gprm`.

### Reconstruction Models currently in the archive

A first-class catalog section of their own (ADR-0021,
`archive.json`'s `reconstruction_models[]`), independent of any numerical
Model — Müller 2022 is used too (mantle viewer coastlines/boundaries,
OPT1's own reference frame) but predates this catalog section and isn't in
it, still resolved the original way (`archive/coastlines`, `archive/boundaries`).

| id | coastlines | boundaries | static polygons |
|---|---|---|---|
| `muller2019` | yes | yes | yes |
| `seton2012` | yes | yes | yes |
| `scotese` | yes | **no, permanently** (ADR-0019 — resolves no topological plates at all) | yes |

A single-layer field (`paleogeography-scotese`; `climate-540myr` before Phase 2
added the month axis) needs `depth_min_km`/`depth_max_km` set to a
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

Drawn by [petrify](https://github.com/siwill22/petrify) onto a 2D
canvas over the WebGL globe. That library talks to its host through exactly one
method, `project(vec3) -> [x, y, depth] | null`, so integrating it costs a
projector and nothing else — the subduction-polarity triangles, the pixel-spaced
decoration walk and the pen-lift at the horizon all come across unchanged, and
already verified.

Three things the projector has to get right:

**The frames differ but are compatible.** petrify works in the geographic
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
npm run check:mask             # spherical scanline vs pygplates
npm run check:boundaries       # subduction polarity vs resolved plate polygons
npm run check:render           # headless render of the visual criteria
npm run check:query-point      # Anchored Point / Month Profile / Age Series arithmetic
npm run check:static-polygons  # Plate-Frame Point assignment + trajectory
npm run check:oldmap           # Old Map viewer: kilometre-true wash/ring/glyph scale
npm run check:paleobio         # paleobiology viewer's headless render
npm run check:themelab         # Theme Lab's headless render
npm run check:themes           # theme colours land only on furniture, never the ramp
npm run check:theme-roles      # every furniture role is set by every theme
npm run check:projections      # globe vs Robinson vs flat, same criteria either way
npm run check:flat-direction   # flat-map winding/orientation
npm run check:robinson         # Robinson projection vs pygplates reference
npm run check:storymaps        # shared StoryMaps globe primitives
```

**Always run `check:boundaries` through the wrapper, never
`petrify.verify` directly.** Its CLI takes `--model`, defaulting to
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
through git. `archive/` is **~6.3 GB** of derived binary (grown a lot as more
models joined the catalog — it was ~400 MB when this section was first
written), and binary does not delta compress, so committing it would add a
fresh multi-GB copy to history on every regeneration, permanently. Instead
the data is a **release asset** and `.github/workflows/deploy.yml` pulls it
in at build time. The Pages artifact carries the bytes to Pages storage
without them entering the repo, which is what lets code deploy as often as
it likes against data uploaded once.

`prep/pack_deploy.mjs` turns the generated archive into the deployable one:

```bash
node prep/pack_deploy.mjs          # archive/ -> archive-deploy/
```

Two changes, both about the 1 GB Pages cap and the bandwidth budget. It **drops
the fixture models** — they exist for `check:render` and are ~160 MB of that —
and it **gzips the volumes** (rewriting each manifest's `path_template` to
`.bin.gz`) as well as each Reconstruction Model's own vector data
(coastlines, boundaries, static polygons — rewriting those manifest fields
too, sharing one rotation file between coastlines and static polygons
rather than gzipping it twice) so nothing else needs a flag. The whole
deployable archive is **~836 MB** — over four-fifths of the 1 GB cap now
(see *The limits, and when they bite*, below; issue #9 tracks moving to
object storage before this runs out). Pre-compressing is worth the trouble
because a CDN will not compress `application/octet-stream` for you. The JSON
is deliberately left alone, since `application/json` *is* compressed on the
wire.

Deployed at **<https://siwill22.github.io/Geode/>** on every push to `main`.
The repo is private; a Pages *site* is public regardless, since
access-controlled Pages is Enterprise Cloud only.

That deploy carries whichever entry pages have reached `main` — not
necessarily all ten. For the current live/not-yet-deployed status of every
viewer in this repo and the wider StoryMaps family, check the
[elstir hub](https://siwill22.github.io/elstir/) rather than this file.

### One-time setup

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Pack and upload the data:

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
| Published Pages site | **1 GB hard** — currently **~836 MB** |
| Bandwidth | 100 GB/month soft |
| Repo | unaffected; stays ~1 MB |

Dataset *count* is cheap; what costs is **frames x variables x resolution**. A
static tomography model is one frame-variable, ~6 MB packed. OPT1 is eleven, ~70
MB; a 1001-frame, 9-variable series at 720x361 is the single biggest line item
in the archive. Headroom is now **~164 MB**, not the dozen-more-series margin
this section used to describe — a couple more series at that scale, or
several dozen more static models, would spend it. Doubling any existing
grid's resolution is 8x the bytes and would spend
it immediately. See [issue #9](https://github.com/siwill22/Geode/issues/9):
this is the thing to act on before it becomes a hard blocker, not after.

Bandwidth is the softer constraint: first load is ~20 MB and scrubbing the whole
OPT1 series pulls ~69 MB, so 100 GB/month is several hundred engaged visits.
Exceeding it prompts an email, not a bill.

When either becomes real, the seam is already there: `VITE_ARCHIVE_BASE` points
the viewer at an absolute URL, so the archive can move to object storage with
free egress (Cloudflare R2) while Pages keeps serving the small built app. The
only extra requirement is CORS headers on the data host.

## Layout

```
prep/                            netCDF/GPML -> viewer binary format (Python, pygmt17)
prep/prep_climate.py             climate netCDF -> climate-540myr model
prep/prep_pohl.py                Pohl et al. FOAM netCDFs -> climate-pohl2022 model
prep/prep_bridge.py              Valdes/BRIDGE run -> bridge-valdes2021-* models
prep/prep_paleogeography.py      Scotese PaleoDEM -> paleogeography-scotese model
prep/prep_reconstruction.py      one gprm fetch_<model>() -> a Reconstruction Model's own coastlines/boundaries
prep/prep_staticpolygons.py      static polygons for Plate-Frame Point, per Reconstruction Model
prep/prep_oldmap.py               mountain-glyph positions for the Old Map viewer
prep/prep_oldmap_volcanoes.py     volcano-glyph positions for the Old Map viewer
prep/prep_pbdb.py                 Paleobiology Database occurrences for the paleobiology viewer
prep/pack_deploy.mjs             archive/ -> archive-deploy/, for the deployed site
archive/                         generated data, served statically, not tracked
archive/reconstructions/<id>/    one Reconstruction Model's own manifest + assets (ADR-0021)
archive-deploy/                  packed subset that ships; not tracked
generator/                       scaffolds a new standalone viewer repo from the data catalog
viewer/                          TypeScript + Vite + three.js
viewer/index.html                the mantle viewer's entry page
viewer/climate.html              the paleoclimate viewer's entry page
viewer/valdes.html               the Valdes/BRIDGE viewer's entry page
viewer/oldmap.html               the Old Map viewer's entry page
viewer/paleobio.html             the paleobiology viewer's entry page
viewer/themelab.html             Theme Lab's entry page
viewer/globe.html                generated: single-model-globe
viewer/groupGlobe.html           generated: model-group-globe
viewer/reconstruction.html       generated: single-reconstruction-globe
viewer/reconstructionGroup.html  generated: reconstruction-group-globe
viewer/src/core/                 shared engine: rendering, data loading, colour ramps, query point
viewer/src/tomography/           mantle viewer only
viewer/src/climate/              paleoclimate viewer only
viewer/src/valdes/               Valdes/BRIDGE viewer only
viewer/src/oldmap/               Old Map viewer only
viewer/src/paleobio/             paleobiology viewer only
viewer/src/themelab/             Theme Lab only
viewer/src/globe/                single-model-globe wrapper
viewer/src/groupGlobe/           model-group-globe wrapper
viewer/src/reconstruction/       single-reconstruction-globe wrapper
viewer/src/reconstructionGroup/  reconstruction-group-globe wrapper
viewer/src/generated/            per-recipe config the generator overwrites (checked in with real defaults)
viewer/vendor/                   petrify submodule
test-data/                       synthetic fixtures and the pygplates cross-check
docs/adr/                        architecture decisions
docs/plans/                      design docs for individual features
.claude/skills/                  the geode-globe-viewer Skill (drives generator/)
.github/workflows/               Pages deploy
```

## Attribution

**Mantle viewer.** Topography from GEBCO, coloured with GMT's `geo`. Colour
ramps from matplotlib. Coastline geometry from Müller et al. 2019 v2.
Rotations, plate boundaries and the OPT1 convection run from Müller et al.
2022. Plate boundary rendering by
[petrify](https://github.com/siwill22/petrify). Tomography models
are cited per-model in each `manifest.json`.

**Paleoclimate viewer.** Climate simulations from Li, X., Hu, Y. et al. 2022,
*A high-resolution climate simulation dataset for the past 540 million years*,
Scientific Data, and from Pohl et al. 2022. Paleogeography from Scotese &
Wright 2018, PALEOMAP PaleoDEMs. Continent outlines from the Scotese 2008
rotation model, via Cao et al. 2018.

**Valdes/BRIDGE viewer.** Simulation from Valdes, P.J. et al. 2021, *The
BRIDGE HadCM3 family of climate models*.

**Old Map viewer.** Coastal wash, offshore rings and hachured mountain
glyphs after the reference notebook `~/GIT/degenerative_art/withMountains.ipynb`.
Reconstruction geometry per the Reconstruction Model chosen in the viewer
(ADR-0034: it follows the dataset, not one fixed model).

**Paleobiology viewer.** Fossil occurrences from the Paleobiology Database
(paleobiodb.org). Paleocoordinates recomputed against the viewer's own
reconstruction rather than taken from PBDB directly.

**Reconstruction Models (`reconstruction.html`/`reconstructionGroup.html`'s
checked-in example).** Müller, R.D., Zahirovic, S., Williams, S.E., et al.
2019, *A Global Plate Model Including Lithospheric Deformation Along Major
Rifts and Orogens Since the Triassic*, Tectonics. Seton, M., Müller, R.D.,
Zahirovic, S., et al. 2012, *Global continental and ocean basin
reconstructions since 200 Ma*, Earth-Science Reviews.
