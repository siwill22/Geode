# Spec: 3D Globe Viewer for Mantle Volume Models

Build a browser-based viewer that renders an archive of 3D mantle models on a spherical Earth, with reconstructable coastlines on the surface and a user-defined polygonal cutaway whose walls are textured with the model interpolated onto the cut surface.

**The first prototype shipped seismic tomography only**, with the data model accommodating convection output from the start (§3, `frames`) but nothing depending on it. That paid off: adding the Müller 2022 OPT1 run at 0–200 Ma (phase 2b) needed a new ingest script and time plumbing, but no change to the manifest schema, the binary format or the shaders. Its primary purpose is exploration — a tool for looking at REVEAL and its siblings directly — with web deployment for others as a secondary goal, and figure generation third. Those priorities are why the archive stays small enough to serve statically and why the UI favours direct manipulation over presets.

Geographic accuracy of the ellipsoid, terrain, and map projections is explicitly **not** required. The Earth is a sphere.

---

## 1. Stack and repo layout

TypeScript, Vite, three.js (r16x, WebGL2 required). Minimal dependencies: `three`, `lil-gui`. No React or other UI framework.

```
/prep                 Python CLIs: source data -> viewer binary format
  prep_model.py       netCDF / grd volumes -> manifest + .bin
  prep_coastlines.py  GPML + .rot -> static geometry, land fill, rotations
  prep_colormaps.py   matplotlib -> 256-entry colour ramps
  prep_topography.py  GEBCO + GMT geo cpt -> hillshaded surface raster
  requirements.txt    xarray, netCDF4, numpy, scipy, matplotlib, pillow, pygplates
/archive              Generated data, served statically
  models/<model_id>/
    manifest.json
    frames/<variable>/<frame_id>.bin
  coastlines/
    geometry.bin      Polylines + land triangulation, with plate id and valid time
    rotations.json    Per-plate absolute finite rotations, 1 Ma samples
  surface/
    topography.jpg    Equirectangular GEBCO relief, hillshaded
  colormaps.json      256-entry colour ramps
  archive.json        Index of all models and the reconstruction age range
/viewer
  src/
    main.ts
    globe.ts          Surface sphere, core sphere
    coastlines.ts     Geometry load, plate rotation, valid-time visibility
    volume.ts         Data3DTexture loading, manifest handling
    cutaway.ts        Polygon state, mask raster, wall geometry
    shaders/
    ui.ts
/test-data            Synthetic fixtures (see §8)
```

---

## 2. Coordinate and radius conventions

Fix these in one module (`constants.ts`) and use them everywhere.

- Right-handed, Y-up (three.js default). `R_SURFACE = 1.0` world units = 6371 km.
- `x = r·cos(lat)·cos(lon)`, `y = r·sin(lat)`, **`z = −r·cos(lat)·sin(lon)`**
- Inverse: `lat = asin(y/r)`, **`lon = atan2(−z, x)`**, `r = length(p)`

> **The minus sign on z is not optional.** An earlier draft of this spec omitted
> it. The geographic frame is right-handed with X toward (0°N, 0°E), Y toward
> (0°N, 90°E) and Z toward the north pole; mapping that to three.js as
> `(x, y, z) = (X, Z, Y)` transposes two axes, so its determinant is −1 and the
> embedding is **left-handed**. three.js renders in a right-handed world, so the
> result is a mirror image of the Earth with east and west swapped.
>
> Because every consumer shared the convention the error was self-consistent and
> invisible in the tomography — which is blobby enough to look plausible
> mirrored — and only showed up once recognisable coastlines were drawn over it.
> `(X, Z, −Y)` restores right-handedness. Every shader that recovers longitude
> from a world position must use `atan(-z, x)`.
- `R_CMB = 3480/6371 = 0.54615`. Mantle spans radius `[R_CMB, R_SURFACE]`, depth 0–2890 km.
- **A model's valid depth range is not the mantle's.** `R_CMB` describes the Earth; `depth_min_km`/`depth_max_km` in the manifest describe the *data*, and after clipping they never coincide with it (REVEAL: 0–2735 km; SEMUCB-WM1: 48–2735 km). Only the latter may be used to map radius to a texture coordinate. Using `R_CMB` for that stretches the volume over the whole mantle and puts every feature at the wrong depth.
- No vertical exaggeration. Depth is real.

---

## 3. Data archive format

### Reference dataset — REVEAL

The primary model is **REVEAL** (Thrastarson et al., full-waveform inversion), present on this machine at:

```
/Users/simon/Data/SeismicTomography/Schouten_Supplementary_material/Models/REVEAL_anomaly.nc
```

It is the best candidate in the local archive: whole-mantle, regular 0.5° global grid, and the only model here carrying both S and P plus radial anisotropy in one file.

| | |
|---|---|
| Grid | 721 lon × 361 lat × 342 depth, regular 0.5° |
| Extent | lon −180…180, lat −90…90, depth −5…2891 km |
| Variables | `vs_anomaly`, `vp_anomaly`, `vsv/vsh/vpv/vph_anomaly`, `rho_anomaly` |
| Axis order | `(latitude, longitude, depth)` — depth fastest |
| dtype | float64, 4.6 GB |
| Units | per cent perturbation |

Three properties of this file drive requirements below and are **not** negotiable defaults:

1. **Depth axis is non-uniform** — spacing varies from 0.01 km to 15 km. Resampling to uniform levels (§3, step 3) is mandatory, not an optimisation.
2. **The base of the model is corrupt, and it starts ~100 km shallower than the mean suggests.** The contamination has two distinct characters, and catching only one of them leaves the other in the volume:

   | Depth | Symptom | Caught by |
   |---|---|---|
   | 2750–2855 km | field goes spiky row to row while the **mean still looks like plausible mantle** (+0.3 %) | lateral roughness |
   | 2870–2891 km | field goes smooth again but the **mean runs away** to +7 %, +16 %, +20.7 % | mean |

   Lateral roughness (mean \|Δ between adjacent latitude rows\|) sits at 0.047 from 2510 to 2735 km, jumps to 0.12 at 2750 and reaches 0.49 by 2840. An earlier draft clipped on the mean alone at 2850 km; that removes the second block and leaves the first, and the surviving ~100 km of spiky data renders as **latitude banding across the base of every cutaway** — which looks like a rendering bug and is not.

   Ingest therefore trims a contiguous basal block using **both** tests (§3, step 3). REVEAL lands at **0–2735 km**; SEMUCB-WM1 at 48–2735 km; UU-P07 is untouched at 5–2816 km, so the detector is not over-eager.
3. **Levels above 0 km are all-NaN** (the −5…−1 km levels). Clip to `depth ≥ 0`.

Note the consequence for §2: the volume then spans 0–2735 km, so the wall's bottom row sits well *above* `R_CMB`. The core sphere at `R_CMB` covers the gap. **Clamp the cut radius to the volume's base, with a few km of margin** — the floor cap is a tessellated sphere, so face interiors chord very slightly inside the vertex radius, and sitting exactly on the deepest sample that wobble straddles the valid-range boundary and paints alternating data and no-data bands across the floor.

### Secondary models

All under `/Users/simon/Data/SeismicTomography/`. Useful for cross-model comparison and, more importantly, as ingest test cases — **the axis order is not consistent between them**, which is exactly the bug the prep CLI must not have.

| Model | Path | Grid (lon×lat×depth) | Depth range | Axis order |
|---|---|---|---|---|
| GLAD-M25 | `Schouten_.../Models/GLAD_M25_anomaly.nc` | 721×361×342 | −5…2891 km | lat, lon, depth |
| SEMUCB-WM1 | `Schouten_.../Models/SEMUCB_WM1_anomaly.nc` | 361×181×311 | 32…2891 km | depth, lat, lon |
| UU-P07 | `Schouten_.../Models/UU-P07_anomaly.nc` | 719×360×29 | 5…2815 km | depth, lat, lon |
| GAP-P4 | `Schouten_.../Models/GAP_P4_anomaly.nc` | 576×288×29 | 40…2728 km | lat, lon, depth |
| S40RTS | `s40rts/s40rts_<depth>.grd` | 328×165, 169 files | 0…2800 km | one 2D `.grd` per depth |

`REVEAL_downsampled_anomaly.nc` (80 MB) looks tempting but covers **only 600–2800 km** — it is a lower-mantle subset from the Schouten study, not a substitute for the full file. Do not wire it in as the default.

### Input assumption

Two input shapes, both required:

- **3D netCDF** (the common case): one file, a 3D variable plus `latitude`/`longitude`/`depth` coordinate variables. The CLI must read the variable's dimension order from the file and transpose to canonical order rather than assuming one — see the table above for why. Select the field with `--var` (e.g. `--var vs_anomaly`).
- **Directory of 2D slices** (S40RTS, GMT `.grd`): one file per depth, depth from the filename via `--depth-regex`, falling back to a coordinate variable.

Detect which mode applies from whether the path is a file or a directory. Validate in both modes that lat/lon grids are identical across depths and that depths are monotonic.

### Prep CLI

`prep_model.py` converts a directory of netCDF slices into one binary volume per time frame plus a manifest.

Responsibilities:

1. Read the volume (either input mode), sort by depth, transpose to canonical `(depth, lat, lon)`, validate grid consistency and depth monotonicity.
2. Regrid to a regular equirectangular lat/lon grid if the input is not already regular.
3. Drop bad levels *before* resampling, so they cannot bleed into good ones through interpolation:
   - `--depth-range` (default `0 2890`) for out-of-range levels;
   - `--max-nan-fraction` (default 0.01) for mostly-empty levels;
   - `--roughness-factor` (default 2.0) to trim a contiguous **basal** block that is either too rough laterally or whose mean has run away, relative to a baseline taken from the **deep mantle** (1500–2500 km). The baseline must not come from the whole model: roughness legitimately rises toward the surface where crustal structure is genuinely sharp, so a whole-model baseline is inflated and catches nothing. Only a run at the bottom is trimmed, so real shallow detail is never at risk.
4. **Resample onto uniformly spaced depth levels** (linear in depth). This matters: the shader assumes uniform spacing on the texture's third axis. Emit the number of levels as a flag, **default 192** — see §3a.
5. Normalise to `uint8` over a symmetric range for diverging fields, or min/max for sequential fields. Record the physical range in the manifest so the shader can map back. Support `--dtype float32` as an escape hatch.

   **The default clip must be a percentile, not `±max(|v|)`.** REVEAL's `vs_anomaly` reaches ±35 % in the crust and uppermost mantle while lower-mantle structure lives at ±2 %; scaling to the absolute max quantises the entire lower mantle into two or three uint8 codes and renders it flat grey. Default to symmetric `±p99.5(|v|)` (≈ ±13 % for REVEAL, still crust-dominated — hence the interactive clip slider in §6 matters), overridable with `--clip LO HI`. Record both the clip used and the true data min/max in the manifest.
5. Write raw binary, **longitude fastest, then latitude, then depth** — this is the memory order `Data3DTexture` expects for (width, height, depth). Latitude ascending from −90.
6. Write `manifest.json`.

### No-data

`uint8` has no NaN, and a reserved sentinel code **does not work here**: the volume texture uses `LinearFilter`, so a sentinel interpolates with its neighbours and every no-data boundary acquires a halo of fabricated values — which, on a diverging map centred at zero, reads as a strong anomaly. Doing sentinels properly would need a validity channel (RG texture, double the bytes) or nearest-neighbour filtering, which costs the smooth wall.

So **no-data is eliminated at ingest**, and validity is expressed as a property of the model rather than of individual texels:

1. Drop any depth level whose NaN fraction exceeds `--max-nan-fraction` (default 0.01). This is the same mechanism as the REVEAL D″ clip, generalised.
2. Fill whatever scattered NaN remains by nearest-neighbour.
3. Record the surviving interval as `depth_min_km` / `depth_max_km` — the range the model is *actually* valid over.
4. Where a Wall extends outside that interval, the shader paints **neutral grey**. Not a notch: a gap in the geometry could be mistaken for structure, whereas grey says plainly that the model does not reach there.

This matters for real models, not hypothetically. SEMUCB-WM1 is 34 % NaN at its shallowest level (32 km, crust excluded), so its `depth_min_km` lands near 40 km and the top of the wall is grey. REVEAL, UU-P07 and GAP-P4 are clean over their clipped ranges and produce no grey at all.

Add `--validate` to re-read the output and print grid shape, depth range, value range, and per-level NaN count — so a model like SEMUCB reports what was dropped instead of hiding it.

### Manifest schema

```json
A model is a **source**, not a source-and-field pair. One manifest per model; the fields it carries are listed in `variables`. Grid geometry, depth range and dtype are model-level because every variable shares them; range, units, polarity and colormap are per-variable because they do not.

```json
{
  "id": "reveal",
  "name": "REVEAL",
  "type": "tomography",
  "source": "Thrastarson et al., full-waveform inversion",

  "lon_min": -180.0, "lon_max": 180.0,
  "lat_min": -90.0, "lat_max": 90.0,
  "depth_min_km": 0.0, "depth_max_km": 2850.0,
  "dtype": "uint8",

  "default_resolution": "std",
  "resolutions": [
    { "id": "std", "nlon": 360, "nlat": 181, "ndepth": 192 }
  ],

  "frames": [{ "id": "000", "age_ma": 0 }],
  "path_template": "frames/{variable}/{resolution}/{frame}.bin",

  "default_variable": "vs",
  "variables": [
    {
      "id": "vs",
      "name": "Vs anomaly",
      "source_var": "vs_anomaly",
      "units": "%",
      "diverging": true,
      "encode_min": -13.0, "encode_max": 13.0,
      "value_min": -35.25, "value_max": 35.25,
      "default_clip_min": -2.0, "default_clip_max": 2.0,
      "default_colormap": "vik"
    },
    {
      "id": "vp",
      "name": "Vp anomaly",
      "source_var": "vp_anomaly",
      "units": "%",
      "diverging": true,
      "encode_min": -8.0, "encode_max": 8.0,
      "value_min": -20.0, "value_max": 20.0,
      "default_clip_min": -1.5, "default_clip_max": 1.5,
      "default_colormap": "vik"
    }
  ]
}
```

Three ranges, deliberately distinct — conflating them is the easiest way to get a washed-out render:

- `value_min/max` — the true physical extremes in the source. Metadata only; never used for display.
- `encode_min/max` — the range the uint8 quantisation spans. Fixed at ingest, cannot be changed in the viewer. Values outside are clamped.
- `default_clip_min/max` — where the colour ramp starts and ends when the model is first shown. Freely draggable at runtime **within** `encode_min/max`.

`archive.json` lists model manifests and the available coastline ages.

**Drop the duplicate seam column.** REVEAL ships 721 longitude columns spanning −180…180 inclusive, so both endpoints are present and identical. The volume texture uses `RepeatWrapping` on S, which assumes column 0 and column `nlon` are one step apart, not coincident. Emit `nlon` columns with the final duplicate removed (721 → 720, or 360 after 1° decimation). Failing to do this puts a one-cell-wide smear at the antimeridian that is easy to mistake for structure.
```

A tomography model has a single frame at age 0. A convection model has many — hence the `frames` array, which exists so that the two are the same kind of thing to everything downstream of ingest, even though only tomography is in scope for the prototype.

**Reconstruction age and frame index are separate concepts** (see `CONTEXT.md`). Reconstruction age is continuous and drives coastlines only. Frame index is discrete, model-specific and derived from the reconstruction age by nearest available frame — never set directly. Conflating them into a single "time slider" hides the fact that convection frame ages are an irregular list (gld37: 0, 4, 10, 14, 21, 30, 41, 46, 50, 60, 69…) while coastline reconstruction is continuous. When they disagree, show the disagreement.

Serve `.bin` with gzip `Content-Encoding`. Do not slice into PNGs. All grid dimensions stay comfortably inside the WebGL2 `MAX_3D_TEXTURE_SIZE` floor of 2048.

## 3a. Grid resolution

**Depth resolution matters more than horizontal resolution here, and an earlier draft had it backwards** — generous in lon/lat, stingy in depth. The Wall is a *vertical* section, and the features worth looking at are vertically structured: slab dip, the 660, LLSVP margins, D″. A depth level costs the same bytes as a longitude column and buys considerably more.

| Grid | Cell at equator | Size (uint8, one variable, one frame) |
|---|---|---|
| 360 × 181 × 64 | 111 × 44.5 km | 4.2 MB |
| **360 × 181 × 192** ← default | **111 × 14.8 km** | **12.5 MB** |
| 720 × 361 × 192 | 55 × 14.8 km | 50 MB |
| 720 × 361 × 342 (native, no depth resampling) | 55 × 8.3 km | 89 MB |

The default is **360 × 181 × 192**. That is REVEAL's *full native vertical resolution* (its lower-mantle spacing is 15 km) with the compromise falling entirely on longitude and latitude, where it is least visible on a vertical wall. 64 levels — the earlier default — puts 44.5 km between samples, which is coarser than the data and drops the 660 discontinuity between levels, exactly the feature you would use to confirm the render is right.

12.5 MB is a small load and a trivial amount of VRAM, so a single tier serves both local exploration and web deployment.

**Keep the schema tier-ready anyway.** `resolutions` is an array and `path_template` includes `{resolution}` even though only one entry exists today. Adding a 50 MB `full` tier for regional or upper-mantle work is then a prep re-run plus a UI toggle, not a schema migration.

---

## 3b. Coastlines

Coastlines are **not** pre-baked per age. The geometry at every age is the same set of polylines under different finite rotations, so ship the geometry once and rotate in the browser. Pre-baking one GeoJSON per age would cost ~1 MB gzipped per age (~50 MB over 0–250 Ma at 5 Ma spacing) and would quantise Reconstruction Age to the bake increment; this approach costs ~2–3 MB in total and keeps the age genuinely continuous.

Defaults, all overridable by CLI flag:

| | |
|---|---|
| Plate model | Müller et al. 2019 v2 |
| Rotations | `PublishedModels/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics/Global_250-0Ma_Rotations_2019_v2.rot` |
| Geometry | `.../StaticGeometries/Coastlines/Global_coastlines_2019_v1_low_res.shp` |
| Age range | 0–250 Ma |
| Rotation sampling | 1 Ma |

### `prep_coastlines.py`

1. Load the coastline features and the rotation model with pygplates.
2. Emit `geometry.bin`: all polylines in **present-day** coordinates, each tagged with its `plate_id`, its **appearance age**, and its **disappearance age**.
3. Emit `rotations.json`: for every plate id referenced by the geometry, the **absolute** finite rotation relative to the anchor plate, sampled at 1 Ma from 0 to 250 Ma, as unit quaternions.

pygplates resolves the plate circuit to absolute rotations offline. The browser therefore needs no plate-hierarchy logic at all — only quaternion slerp and a vector rotate.

### Runtime

Per Reconstruction Age `t`:

1. Slerp each plate's rotation between the bracketing 1 Ma samples. **Interpolate the rotation, never the geometry** — plates rotate about Euler poles rather than translating, so interpolating vertex positions between two baked ages is simply wrong.
2. Rotate each visible polyline's vertices by its plate's rotation.
3. Apply the Cutaway mask and draw.

### Valid time — direction convention

Features appear and disappear through geological time and **must not be drawn outside their lifespan**. Ages increase into the past, so state the test in terms that cannot be misread:

- **Appearance age** — the age at which the feature comes into existence. The *larger* Ma value. pygplates calls this the begin time.
- **Disappearance age** — the age at which it ceases to exist. The *smaller* Ma value.

> A feature is drawn at age `t` if and only if `disappearance_age <= t <= appearance_age`.

So a feature with an appearance age of 100 Ma is **not** drawn at 150 Ma, because 150 Ma is before it existed. Note that "earlier" is ambiguous here and is avoided deliberately: earlier *in geological time* means a larger number of Ma. Features with an unbounded begin or end time (`pygplates` distant past / distant future) are always visible and should be written as `+inf` / `-inf` rather than a sentinel like `-999`.

Visibility is re-evaluated per age change, not per frame. Because the set of drawn polylines changes, the line geometry cannot be a single static buffer — allocate at maximum size and update the draw range, in the same spirit as the wall geometry in §5.

## 4. Scene composition

Four render layers, drawn in this order:

| Object | Radius | Notes |
|---|---|---|
| Core sphere | `R_CMB` | Opaque, plain shading. Never cut. |
| Cutaway floor | cut radius | Spherical cap at the cut radius, clipped to the polygon. Volume-sampled with the same `VolumeSurfaceMaterial` as the walls. |
| Cutaway walls | cut radius → `R_SURFACE` | Volume-sampled. `DoubleSide`. |
| Surface sphere | `R_SURFACE` | Topography raster, reconstructed land fill, or flat colour. Masked. |
| Land fill | `R_SURFACE × 1.0006` | Reconstructed land polygons, filled. Masked. |
| Coastlines | `R_SURFACE × 1.0014` | `LineSegments`. Masked. Offset avoids z-fighting. |

### Making it read as a sphere

A flat-shaded globe reads as a *disc*. Both the surface and the core take a **fixed key light**, not a headlight: a headlight lights every visible point equally and flattens the silhouette, whereas a fixed light gives a terminator and a bright limb. The core additionally gets a rim term, brightest where its surface turns away from the viewer, which traces the limb and makes it unmistakably spherical when you look down into the cut.

The surface offers three modes:

- **Topography** — GEBCO relief coloured with GMT's `geo` and hillshaded. `geo` is normalised over −1…1 with a **hard hinge at 0**, so its land/sea break is pinned to sea level by construction and the raster's shoreline agrees with the coastline vectors drawn over it. Present-day only.
- **Land fill** — reconstructed land polygons, filled, correct at any age.
- **Flat** — plain ocean colour.

Topography is meaningless at any age but the present, so moving the age slider off 0 switches to the land fill and says so in the status line, rather than silently leaving today's continents under yesterday's coastlines.

**The land fill must be triangulated with interior points, not just its boundary.** A triangulation whose vertices all lie on the coastline produces continent-sized flat triangles that chord a long way *beneath* the sphere — the sagitta of a 40° chord is about 6 % of Earth's radius — so the globe's own surface occludes the middle of every large landmass and the fill renders as a hollow ribbon following the coast. Sampling interior points at ~2° and including them in the triangulation keeps every triangle small enough to hug the sphere. Triangulate by Delaunay in a stereographic projection about the polygon's centroid, then keep only those triangles whose centroid tests inside the polygon **on the sphere, with pygplates** — Delaunay alone fills the convex hull, which is wrong for anything concave. Draw with `DoubleSide`: Delaunay returns simplices in arbitrary winding order.

**The floor is not optional.** The cut depth is user-adjustable (§7), so a cut to 1000 km leaves the walls ending in mid-air with a clear view through to the inside of the far hemisphere. The core sphere only closes the cut when the cut is full-depth. Render the floor as a volume-textured cap rather than a neutral plug: it is the same material, so it costs one geometry, and the result — the structure at the cut depth, exposed — is informative rather than merely a hole-filler. Sweeping the cut depth then becomes a way of exploring the volume, which is the point.

The one case where the core legitimately serves as the floor is a full-depth cut. The volume ends at 2850 km while `R_CMB` is 2890 km, so even then the floor cap sits 40 km above the core — under a pixel at any reasonable zoom, and the core covers the gap. Clamp the cut radius to the volume's base rather than to `R_CMB`.

`OrbitControls` with damping; clamp zoom so the camera cannot enter the core.

---

## 5. The cutaway

### Polygon state

The polygon is an ordered list of `{lat, lon}` vertices on the sphere, plus a `depth_km` for how far down the cut extends (default: full mantle, to the CMB), plus an `inverted` boolean (below). Densify each edge along its great circle to ≤0.5° spacing before use — straight chords in lon/lat would cut the wrong path.

Store in a single `CutawayState` object; every consumer (mask, walls, UI) derives from it and rebuilds on change.

### Which side is removed

A closed curve on a sphere divides it into two regions and **neither is intrinsically the interior** — "inside" is a property of the plane, not the sphere. The convention is therefore explicit:

- On polygon **close**, compute the signed spherical area and set `inverted` so that the **smaller** of the two regions is the one removed. This is the intuitive result for ordinary cutaways and does not require the user to think about the order they clicked in.
- Thereafter `inverted` is a **sticky, user-controlled toggle** exposed in the UI. It is *never* recomputed — in particular not on vertex drag. Dragging a vertex past the half-sphere point changes the areas but must not flip the cut out from under the user.

This also makes "keep only this region, remove the rest of the planet" a supported view rather than an accident.

Winding order is deliberately **not** the mechanism. It is standard (GeoJSON's left-of-boundary rule) but it is determined by the order the user happened to click, so the same visual loop drawn clockwise would cut the entire rest of the world.

### Masking the surface — the key mechanism

Do **not** attempt to triangulate a sphere with a hole. Instead:

Rasterise the polygon into an equirectangular `Uint8` mask, 2048×1024, using a **spherical scanline** — not an `OffscreenCanvas` even-odd fill.

The key observation is that raster rows **are** latitude circles. So, per row:

1. Compute where each densified great-circle edge crosses that latitude, giving a set of crossing longitudes.
2. Sort them and parity-fill in **cyclic** longitude.
3. A row with zero crossings lies wholly inside or wholly outside; it inherits its parity from the row below.
4. Apply `inverted` to decide which parity is removed.
5. Upload as a `DataTexture` (`LinearFilter`, `RepeatWrapping` on S, `ClampToEdgeWrapping` on T).
6. In the surface sphere and coastline fragment shaders: convert world position to lat/lon, sample the mask, `discard` above 0.5.

Both of the special cases an earlier draft called out disappear rather than being handled:

- **Antimeridian** — longitude is cyclic in step 2, so there is no seam to unwrap and no ±360° refill.
- **Pole enclosure** — falls out of step 3 with no path-extension hack, and works identically for one pole or both.

It also removes any dependence on `OffscreenCanvas` winding/fill rules, which are a browser-dependent thing to be betting geometric correctness on.

Rebuild the mask only on polygon edit, not per frame. Antialias by supersampling the parity test in latitude, or accept hard edges at 2048×1024 — at that resolution a mask texel is ~0.18°, well below what is visible at any sane zoom.

**Validation, offline:** pygplates is not available at runtime (the polygon is drawn in the browser), but it *is* the reference implementation. Add a test that generates a set of awkward polygons — pole-enclosing, both-poles, antimeridian-spanning, greater-than-hemisphere — and cross-checks the TypeScript scanline against `pygplates.PolygonOnSphere.is_point_in_polygon` on a few thousand random points.

### Wall geometry

For the densified boundary of `n` points, build a curtain: `n × m` vertices, `m` rows from `R_SURFACE` down to the cut radius. `m ≈ 128`. Allocate the `BufferGeometry` once at max size and update the position attribute in place (`needsUpdate = true`) on edit.

The wall carries **true 3D world positions**, so the shader converts each fragment to spherical coordinates directly and the section narrows correctly toward the centre. There is no flat texture being stretched, and therefore no convergence distortion.

### Wall shader

```glsl
uniform sampler3D uVolume;
uniform sampler2D uColormap;
uniform vec3  uGrid;          // nlon, nlat, ndepth
uniform float uDepthMin;      // km — the model's valid range, not the mantle's
uniform float uDepthMax;
uniform float uClipLo;        // encoded 0..1 space
uniform float uClipHi;
uniform vec3  uNoDataColor;   // neutral grey

varying vec3 vWorldPos;

void main() {
  float r     = length(vWorldPos);
  float lat   = asin(clamp(vWorldPos.y / r, -1.0, 1.0));
  float lon   = atan(vWorldPos.z, vWorldPos.x);
  float depth = (R_SURFACE - r) * 6371.0;

  // Outside the model's valid depth range: say so, don't fabricate.
  if (depth < uDepthMin || depth > uDepthMax) {
    gl_FragColor = vec4(uNoDataColor, 1.0);
    return;
  }

  float pLon = (lon + PI) / (2.0 * PI);
  float pLat = (lat + PI * 0.5) / PI;
  float pDep = (depth - uDepthMin) / (uDepthMax - uDepthMin);

  vec3 uvw = vec3(
    pLon + 0.5 / uGrid.x,                       // wraps; half-texel offset
    (pLat * (uGrid.y - 1.0) + 0.5) / uGrid.y,   // endpoints inclusive
    (pDep * (uGrid.z - 1.0) + 0.5) / uGrid.z
  );

  float v = texture(uVolume, uvw).r;
  float t = clamp((v - uClipLo) / (uClipHi - uClipLo), 0.0, 1.0);
  gl_FragColor = texture(uColormap, vec2(t, 0.5));
}
```

Three things this gets right that the naive version does not:

1. **Depth is normalised against the model's valid range, not the mantle's.** `(R_SURFACE - r) / (R_SURFACE - R_CMB)` is wrong the moment a model doesn't span the full mantle — which is now every model, since REVEAL is clipped at 2850 km and SEMUCB starts at ~40 km. Using it would stretch the volume over the whole mantle and put every feature at the wrong depth.
2. **Half-texel offsets.** Longitude wraps and has no duplicate column, so it needs a `+0.5/nlon` shift. Latitude and depth include both endpoints, so they map to `(p·(N−1)+0.5)/N`. Sampling at raw `p` puts every value half a cell off — a quarter-degree in latitude and ~7 km in depth, small enough to look plausible and wrong enough to move the 660. §8's fixtures exist to catch exactly this.
3. **`clamp` inside `asin`.** Floating-point drift can push `y/r` a hair past ±1 and produce NaN at the poles.

The clip range arrives already converted to encoded 0–1 space; the UI works in physical units and JS does the conversion using `encode_min/max`. This keeps the shader free of per-variable constants, so changing variable or clip range never triggers a recompile.

Volume texture: `RedFormat`, `LinearFilter`, `RepeatWrapping` on S (so profiles crossing the antimeridian interpolate across the seam), `ClampToEdgeWrapping` on T and R.

### Reuse

The same material must work for any geometry, because the geometry is the only thing that changes:

- Vertical wall → cross-section *(phase 2)*
- Spherical cap at constant radius, clipped to the polygon → the cutaway floor *(phase 2 — see §4, it is required, not a bonus)*
- Spherical cap unclipped → standalone depth slice *(phase 3)*
- Great-circle curtain between two user points → standalone profile *(phase 3)*

Write it once as `VolumeSurfaceMaterial`. The floor and the walls differ only in their vertex positions.

---

## 6. Colormaps

Generate 256×1 RGBA `DataTexture`s from matplotlib colour maps — `RdBu`, `Spectral`, `coolwarm`, `seismic`, `bwr` for diverging; `viridis`, `magma`, `cividis` for sequential. Never compute colours in GLSL. Sourcing from matplotlib rather than an external colour-map distribution keeps the project free of extra data dependencies.

### Colour polarity is a correctness requirement, and it is per-variable

The physical convention is fixed:

> **subducting slabs → cold colours (blue)**
> **plumes, hotspots, LLSVPs → warm colours (red)**

But the *sign* that corresponds to a slab is not fixed, because it depends on the field:

| variable | high value means | high end of the ramp |
|---|---|---|
| Vs / Vp anomaly | fast, therefore cold | **cool** |
| temperature anomaly | hot | **warm** |

A slab is a positive anomaly under one and a negative anomaly under the other. So polarity cannot be a property of the project, or of the model, or inferred from the units — it belongs to the **variable**, which declares `high_means: fast | hot`. An earlier version of this spec fixed a single global orientation, which was correct only as long as every model was a velocity anomaly.

Getting this backwards paints every slab red and every plume blue, which looks entirely plausible and is entirely wrong — nothing about the render flags it. So it is machine-checked end to end, in three places:

1. `prep_colormaps.py` emits every diverging map in **both** orientations, tagging each `high_end: warm | cool`. The orientation is **measured from the sampled RGB**, not taken from matplotlib's `_r` naming, and then asserted; a failure aborts the build.
2. Ingest selects the ramp whose `high_end` matches the variable's `high_means`, and asserts the match.
3. The viewer offers only ramps of the correct polarity for the loaded variable, so a wrong one is unreachable rather than merely non-default.

This class of bug has now occurred three times in this project. Every occurrence looked plausible on screen and was caught by a machine check, never by eye.

Expose as uniforms so the user can change palette and clip range with no shader recompile. For diverging fields the clip must stay symmetric about the physical zero by default, with a toggle to unlock.

## 7. UI

Right-hand `lil-gui` panel, dark, no chrome competing with the globe:

- Model selector (from `archive.json`)
- **Variable selector** (from the model's `variables`) — changing it swaps the volume texture, leaving the cutaway geometry untouched
- **Reconstruction age slider** (Ma, continuous, 0–250) — drives coastline reconstruction only
- Colormap selector, clip range slider, symmetric-clip toggle
- Cut depth slider (km)
- **Invert cutaway** toggle (§5) — seeded on polygon close, sticky thereafter
- Surface opacity slider
- Export: PNG screenshot; polygon as GeoJSON; load polygon from GeoJSON

### Tools

Follow GPlates: an **explicit tool mode**, switched in the UI, with a **modifier key** to rotate the globe without leaving the current tool.

| Tool | Behaviour |
|---|---|
| **Drag Globe** | Default. `OrbitControls` rotate and zoom. |
| **Draw Polygon** | Click adds a vertex; double-click or Enter closes and seeds `inverted`; Escape abandons. |
| **Edit Vertices** | Drag a vertex handle to move it; click a handle to delete. |
| **Clear** | Discards the polygon. |

In Draw and Edit, **holding the modifier (Command on macOS, Control elsewhere) gives globe rotation for as long as it is held**, then returns to the tool. This is not a nicety: a cutaway routinely wraps around the limb, so you must be able to rotate mid-polygon to see where the next vertex goes. A strictly modal design would make any polygon larger than the visible face require exiting the tool, rotating, and re-entering — for the whole-mantle work this viewer is for, that's the common case, not the edge case.

Matching GPlates matters more than picking the theoretically best interaction, because the muscle memory should transfer.

**`OrbitControls` will fight this.** It maps left-drag with *any* of ctrl/meta/shift to PAN, so the modifier slides the globe sideways off-centre instead of spinning it on its axis. The check happens only on `pointerdown`, so intercept that one event in the capture phase, swallow it, and re-dispatch an identical event with the modifier flags cleared — which the controls then read as an ordinary rotate. Also set `enablePan = false`: a globe should stay centred.

Raycast against a plain sphere at `R_SURFACE` for vertex placement. Show the in-progress polygon as a line loop with vertex handles at `R_SURFACE × 1.002`. Densify for display as well as for the mask, so the drawn edges follow great circles and the user sees the path that will actually be cut.

---

## 8. Test fixtures

Ship a synthetic volume generator in `/test-data`: a spherical-harmonic checkerboard whose sign flips at 660 km and 1800 km. Correct rendering is unambiguous by eye — this catches axis-order errors, latitude flips, and depth inversion, which are otherwise very hard to spot in real tomography. Add a second fixture that is a pure function of depth (radial ramp) to verify the depth axis alone.

---

## 9. Phasing

**Phase 1 — Globe.** Constants, scene, core and surface spheres, orbit controls. `prep_coastlines.py`; coastline geometry loading, plate rotation in JS, valid-time visibility, continuous reconstruction age slider. No volume.

**Phase 2 — Cutaway.** `prep_model.py`, manifest and binary loading, `Data3DTexture`, tool modes and polygon drawing, spherical scanline mask and discard, wall geometry, **floor cap**, `VolumeSurfaceMaterial`, colormap and variable UI. This is the core deliverable and needs no raymarching — every volume-sampled fragment lies on a surface.

**Phase 2b — Time and plate boundaries.** *(built)* `prep_convection.py`; the Müller 2022 OPT1 run at 0–200 Ma in 11 frames. The `frames` array stops being a formality: one age slider drives coastlines continuously, boundaries at 1 Myr and the volume at 20 Myr, each snapping to what it has and **saying which age it is actually showing**. Volume frames are fetched on demand behind an LRU with neighbour prefetch, and stale responses are discarded so a fast scrub cannot land an old frame after a newer one.

Plate boundaries come from `petrify`, vendored as a submodule and drawn onto a 2D canvas over the WebGL globe. Its entire coupling surface is `project(vec3) -> [x, y, depth] | null`, so integration is a projector and nothing else — the subduction-polarity triangles come across already verified rather than being re-derived in 3D. Three things the projector must get right, all recorded in the README: the geographic→three.js map must be a rotation (det +1) or the polarity mirrors; the horizon is `dot(v, camDir) > R/d`, not `> 0`; and the overlay has no depth buffer, so it culls against the cutaway mask raster rather than a second point-in-polygon.

**Every time-dependent layer must rest on one rotation model.** Müller 2019 and Müller 2022 differ by a whole-Earth rotation of up to 6.4° at 200 Ma — 715 km at the equator, and invisible in any single layer. OPT1 was run on Müller 2022, so the surface uses its `MantleOpt` rotations too.

**Phase 3 — Sections and export.** Standalone great-circle profiles and unclipped constant-depth slices, using the same material. PNG and GeoJSON export. (The *clipped* cap is already built in phase 2 as the cutaway floor.)

**Phase 4 — Isosurfaces.** *(built)* Ray-marched first-hit isosurface with bisection refinement, on a back-face **shell** proxy — a sphere at the search range's outer radius, with the march interval taken from analytic ray/sphere intersections rather than from a box. **Two** surfaces with independent isovalues, one enclosing cold downwellings and one hot upwellings, found in a single march so their depth ordering is correct by construction. Raymarching is introduced here and nowhere else. If lit, exportable geometry is needed later, generate it offline with `skimage.measure.marching_cubes` and load as glTF instead.

Two things this phase pinned down that are not obvious. The isosurface must write `gl_FragDepth` from its **hit**, and in the **ordinary NDC encoding** — the renderer is constructed with `logarithmicDepthBuffer: true`, but every material here is a hand-written `ShaderMaterial` and none include three's `logdepthbuf` chunks, so nothing in the scene actually writes a log depth; a fragment that helpfully did would sit at ~0.26 where the walls sit at ~0.99 and float in front of everything. And the search range is **not** the whole mantle by default: any isovalue that resolves deep structure also encloses the entire lithosphere, so the first run would be an opaque ball.

Its depth mapping is checked against the ramp fixture by bisecting the **cutaway floor** for the depth at which the isosurface stops poking through — the screen is far too coarse a ruler, at ~17 km of depth per pixel of silhouette radius against a half-texel of ~7 km.

---

## 10. Acceptance criteria

**Geometry and orientation**

- Checkerboard fixture renders with correct sign, correct hemisphere, and sign flips at the right depths on the cutaway walls.
- Radial-ramp fixture confirms the depth axis independently, including the half-texel offsets: the ramp's endpoints land exactly at `depth_min_km` and `depth_max_km`, not half a level inside them.
- A polygon crossing the antimeridian cuts a single contiguous hole, and the wall texture is continuous across the seam.
- A polygon enclosing the North Pole cuts correctly; so does one enclosing both poles, and one covering more than half the sphere.
- The scanline mask agrees with `pygplates.PolygonOnSphere.is_point_in_polygon` on random points, for every polygon in the awkward set.
- Coastlines vanish exactly at the hole boundary, with no fringe of line fragments hanging over the cut.
- No seam artefact at ±180°: the duplicate longitude column has been dropped and the half-texel offset applied.
- On the ramp fixture an isosurface at value `V` is a sphere at depth `(V+1)/2 × 2840 km`. Bisecting the cutaway floor for the depth at which it stops poking through, over several `V`, must fit that line with **zero intercept** — half a depth texel is 7.4 km, so an isosurface sampling the volume even slightly differently from the wall shows up there. The fitted slope carries a small excess (~0.3 %) from the software rasteriser's filtering of the uint8 volume, so only the intercept gets a tight bound.
- The isosurface sorts against the floor, walls and core by the depth of its **hit**, not of its proxy sphere: a floor above it must hide it, and a floor below it must not.
- Both isosurfaces draw at once and independently. On the checkerboard, which is ±2 everywhere, isovalues at −1 and +1 produce comparable amounts of each colour.

**Cutaway behaviour**

- A cut to 1000 km has a visible, volume-textured floor — you cannot see through it to the far hemisphere.
- `inverted` is seeded to remove the smaller region on close, and does *not* flip when a vertex is dragged past the half-sphere point.
- The globe can be rotated mid-polygon via the modifier without leaving Draw mode, and a polygon spanning more than the visible face can be drawn without switching tools.

**Data fidelity**

- REVEAL shows neither a bright shell nor latitude banding at the base of the mantle: both characters of the D″ contamination are excluded, and the African and Pacific LLSVPs read as the slow features they are.
- Slabs are visible in the transition zone at the default clip — the percentile clip has not been swamped by crustal amplitude.
- The 660 discontinuity is resolvable on a wall, which it is not at 64 depth levels.
- SEMUCB-WM1 loads with a grey band above ~40 km rather than a halo of fabricated values, and `--validate` reports the levels it dropped.
- REVEAL, SEMUCB-WM1 and UU-P07 all ingest with the same command and only `--var` changing, despite their differing dimension order.

**Coastlines**

- A feature with an appearance age of 100 Ma is absent at 150 Ma and present at 50 Ma.
- Sweeping the reconstruction age is continuous — no snapping to baked increments, and no geometry interpolated between ages.

**Performance**

- Polygon vertex drag updates walls at interactive frame rates (no geometry reallocation per frame).
- Switching model, variable, colormap and clip range causes no shader recompile.
- Camera cannot enter the core sphere.
- REVEAL ingests with no manual axis fiddling, and so do SEMUCB-WM1 and UU-P07, whose dimension order differs from REVEAL's. Same command, only `--var` changes.
- The REVEAL cutaway shows no bright shell at the base of the mantle: the D″ contamination above 2850 km is excluded, and the African and Pacific LLSVPs read as the slow features they are.
- Slabs are visible in the transition zone at the default clip — i.e. the percentile clip has not been swamped by crustal amplitude.

---

## 11. Non-goals

Ellipsoid or terrain accuracy; map projections; vertical exaggeration; cutting the core; server-side rendering; CPU resampling of the volume for display (per-pixel work stays on the GPU — keep the raw typed array only for numerical readout at clicked points).

**On the 3-D plate carrée box view** (depth as the vertical axis, with adjustable vertical exaggeration), which has been asked for and costed but not scheduled. It is roughly 2.5–3× the isosurface work, and unlike isosurfaces it is multiplicative rather than additive — it touches every module. Three costs that are not obvious up front:

- Every geometry is built as a sphere — core, surface, pick target, cutaway walls, floor cap, coastlines, land fill — and each needs a parameterised builder.
- The boundary overlay loses its occlusion model. It works because a sphere has a horizon, `dot(v, camDir) > R/d`. A box has none, so that machinery does not transfer and the overlay would need real depth testing, which it cannot do.
- The antimeridian stops being free. `petrify` deliberately does not split lines at ±180° because it works in 3-D unit vectors, where the dateline is not special. In plate carrée it is, and every feature crossing it draws a full-width streak. Coastlines and the cutaway polygon need the same treatment; the poles become lines.

Worth stating plainly, because it is the thing most likely to be misread: this would be a **display** choice, not a change of model. All the spherical geometry — great-circle densification, the scanline mask, the rotations — stays exactly as it is and keeps being computed on the sphere. Only the final world-position mapping changes, and vertical exaggeration would be a factor applied there, never in the data. The one shared prerequisite, a single canonical geographic mapping in GLSL, has already been paid down in `viewer/src/glsl/geographic.ts`.

**TODO, bundled with the plate carrée work: a global depth-slice view, with depth optionally driven by a sinking rate.** Plan at `docs/plans/depth-slice-and-sinking-rate.md`. Paint the whole globe with the volume sampled at one depth instead of a cutaway — a mode the plate carrée box is a natural home for, since a depth slice is exactly the box view's horizontal plane. The sinking-rate half turns the age slider into a slab-depth predictor (`depth_km = rate_cm_per_yr × age_Ma × 10`), which is the tomotectonic comparison the literature (van der Meer et al. 2010; *Atlas of the Underworld*, 2018; Domeier et al. 2016) uses to date slabs against palaeo-trenches at ~1.1–1.9 cm/yr. Only valid against present-day (`type: tomography`) volumes — a convection run already has its own time axis, and letting one slider drive both would double-count depth and age.
