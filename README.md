# Geode

*Crack the Earth open and look at the structure inside.*

Browser viewer for 3D mantle models on a spherical Earth: reconstructable
coastlines on the surface, and a user-drawn polygonal cutaway whose walls and
floor are textured with the model interpolated onto the cut surface.

Phases 1 and 2 of [the spec](tomography-globe-viewer-spec.md) are built.
Design vocabulary is in [CONTEXT.md](CONTEXT.md); decisions with lasting
consequences are in [docs/adr/](docs/adr/).

## Quick start

```bash
cd viewer
npm install
npm run dev            # http://localhost:5173
```

The archive is already generated and served from `viewer/public/archive`, a
symlink to `archive/` at the repo root.

## Controls

Pick a tool in the right-hand panel, GPlates-style:

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
reconstructed coastlines would be misleading.

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

conda run -n pygmt17 python prep/prep_coastlines.py
conda run -n pygmt17 python prep/prep_topography.py
conda run -n pygmt17 python test-data/make_fixtures.py
conda run -n pygmt17 python prep/build_archive_index.py
```

`prep_model.py` reads the source variable's dimension order from the file
rather than assuming it, so the same command ingests REVEAL `(lat, lon, depth)`
and SEMUCB-WM1 `(depth, lat, lon)` with only `--var` changing.

### Models currently in the archive

| id | grid | valid depth | notes |
|---|---|---|---|
| `reveal` | 360x181x192 | 0-2735 km | Vs and Vp. Default. |
| `semucb` | 360x181x192 | 48-2735 km | Top 12 levels dropped as >1% NaN |
| `uup07` | 360x181x192 | 5-2816 km | Vp; basal trim correctly does nothing here |
| `fixture-check` | 360x181x192 | 0-2840 km | Checkerboard, sign flips at 660 and 1800 km |
| `fixture-ramp` | 360x181x192 | 0-2840 km | Pure function of depth |

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

### Colour polarity

Diverging maps are emitted so that **fast (positive dV) is blue** and **slow
(negative dV) is red** — slabs cold, plumes and LLSVPs warm.
`prep_colormaps.py` asserts this for every diverging map and prints a verdict,
because an inverted ramp looks completely plausible and nothing else catches
it.

## Checks

```bash
cd viewer
npm run typecheck
npm run check:mask      # spherical scanline vs pygplates
npm run check:render    # headless render of the visual criteria
```

`check:mask` is the important one. The cutaway mask is rasterised in TypeScript
because the polygon is drawn interactively in the browser, where pygplates is
not available — but pygplates is the reference implementation for
point-in-polygon on a sphere, so it holds the scanline to account offline across
a set of deliberately awkward polygons (pole-enclosing, both poles,
antimeridian-spanning, larger than a hemisphere, narrow slivers).

`check:render` needs the dev server running, and writes annotated screenshots to
`viewer/shots/`. It also probes rendered pixels for the no-data grey, which is
how the SEMUCB valid-range band gets verified — at 48 km it is only ~1.7 % of the
mantle and too thin to judge by eye.

## Layout

```
prep/          netCDF/GPML -> viewer binary format (Python, pygmt17)
archive/       generated data, served statically
viewer/        TypeScript + Vite + three.js
test-data/     synthetic fixtures and the pygplates cross-check
docs/adr/      architecture decisions
```

## Attribution

Topography from GEBCO, coloured with GMT's `geo`. Velocity colour ramps from
matplotlib. Coastlines and rotations from Müller et al. 2019 v2. Tomography
models are cited per-model in each `manifest.json`.
