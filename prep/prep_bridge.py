#!/usr/bin/env python3
"""Convert the Bristol BRIDGE `scotese_02` HadCM3 run sequence into TWO
viewer models feeding the dedicated Valdes/BRIDGE instance (valdes.html):

  - Monthly  (id: bridge-valdes2021-monthly,    type: climate-monthly)
  - Ocean Depth (id: bridge-valdes2021-ocean-depth, type: climate-ocean-depth)

These replace the single climate-bridge-valdes2021 model that used to be one
of climate.html's selectable climate-type models -- see
docs/adr/0008-valdes-bridge-gets-its-own-instance.md for why Valdes/BRIDGE
moved to its own instance instead of gaining a second Layer there, and
docs/adr/0013-monthly-absorbs-bridge-ocean-surface-fields.md for why the
renamed Monthly Layer now carries ocean-surface fields alongside the
original atmosphere ones.

This is the dataset behind Valdes, Scotese & Lunt 2021, "Deep ocean
temperatures through time" (Clim. Past, 17, 1483-1506,
https://doi.org/10.5194/cp-17-1483-2021) -- see bridge_runs.py for how the
109-run, 541-0 Ma list was confirmed to match the paper's own simulation
count.

Source: run fetch_bridge.py first. Each of the 109 runs has three streams
cached (see that script's own docstring): atmosphere (`a.pdcl<suffix>.nc`,
13 files), ocean surface (`o.pfcl<suffix>.nc`, 13 files), ocean depth
(`o.pgclann.nc`, 1 file, annual mean only).

Monthly (13 layers: 12 months + the model's own native annual mean, NOT
derived by averaging the months) draws from BOTH the atmosphere and
ocean-surface streams -- they share an identical grid and Month axis (see
CONTEXT.md's Layer entry for why that's what makes this legal despite one
stream being physically atmosphere and the other ocean). Two different
native horizontal grids exist across both streams: scalar fields sit on
`latitude`/`longitude` (73x96, DESCENDING 90..-90 -- confirmed directly,
must be flipped before resampling); wind, ocean current and sea-ice drift
sit on the staggered Arakawa `latitude_1`/`longitude_1` grid (72x96, also
descending).

Ocean Depth (20 real depth levels, 5m-5192.65m, ANNUAL MEAN ONLY -- BRIDGE's
`pgcl` stream has no monthly breakdown, confirmed directly: `pgcl<month>.nc`
404s across the whole run set) draws from the ocean-depth stream alone.
Its depth axis is wildly non-uniform (dense near the surface, sparse near
the bottom) -- the viewer's depth-mapping shader assumes UNIFORM spacing, so
rather than change that, this Layer reuses Month's own trick: depth_min_km/
depth_max_km are declared as a plain 0..19 INDEX range, with the real km
value per index carried separately in `depth_labels_km` purely for display
(see types.ts's own doc comment on that field, and CONTEXT.md's Ocean Depth
entry). Vertical velocity (`W_ym_dpth`) lives on a 19-level grid, physically
the INTERFACES between the other four variables' 20 levels -- anchored to
the shallower level of each interface, deepest level left NO_DATA (see
docs/adr/0010-vertical-velocity-anchored-to-shallow-level.md).

Both new models reserve byte 255 as NO_DATA (see docs/adr/0005) --
Monthly's ocean-surface fields and every Ocean Depth field are NaN over
land/below-seafloor, unlike the old atmosphere-only model, which had full
global coverage and needed no such sentinel.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<age_id:03d>.bin

Example
-------
    python prep_bridge.py --validate
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import xarray as xr

from bridge_runs import RUNS, cache_dirname
from prep_climate import KOPPEN_CLASS_NAMES, N_KOPPEN_CLASSES, compute_koppen
from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_clip,
    choose_colormap,
    drop_duplicate_seam,
    normalise_longitude,
    resample_horizontal,
)

MONTH_SUFFIXES = ["jan", "feb", "mar", "apr", "may", "jun",
                   "jul", "aug", "sep", "oct", "nov", "dec"]
N_MONTHS = 12
N_MONTH_LAYERS = N_MONTHS + 1  # + the model's own native Annual mean, index N_MONTHS
ANNUAL_LAYER = N_MONTHS
MONTHLY_LAYER_MIN = 0.0
MONTHLY_LAYER_MAX = float(N_MONTH_LAYERS - 1)

N_DEPTH = 20  # HadCM3's ocean tracer/velocity grid -- confirmed len(depth_1) directly
NO_DATA = 255  # reserved; real data clamped to 0..254 -- see module docstring

DEFAULT_CLIP_PERCENTILE = 99.5

SOURCE_CITATION = (
    "Valdes, P. J., Scotese, C. R., and Lunt, D. J.: Deep ocean temperatures "
    "through time, Clim. Past, 17, 1483-1506, "
    "https://doi.org/10.5194/cp-17-1483-2021, 2021 "
    "(BRIDGE scotese_02 HadCM3 run sequence)"
)


@dataclass
class VarSpec:
    source_var: str
    var_id: str
    display_name: str
    units: str
    diverging: bool
    convert: Callable[[np.ndarray], np.ndarray] = lambda x: x
    high_means: str | None = None
    colormap: str = "viridis"
    staggered: bool = False  # True -> the latitude_1/longitude_1 wind/current/ice grid
    vector_only: bool = False
    # 'atmosphere' -> {run}a.pdcl<suffix>.nc, 'ocean_surface' -> {run}o.pfcl<suffix>.nc
    stream: str = "atmosphere"


MONTHLY_VARIABLES = [
    # --- atmosphere (unchanged from the original single-model version) ---
    VarSpec("temp_mm_1_5m", "T", "Surface temperature", "°C",
            diverging=True, high_means="hot", colormap="RdBu",
            convert=lambda k: k - 273.15),
    VarSpec("precip_mm_srf", "P", "Precipitation", "mm/day",
            diverging=False, colormap="viridis",
            convert=lambda kg_m2_s: kg_m2_s * 86400.0),
    VarSpec("p_mm_msl", "MSLP", "Sea-level pressure", "hPa",
            diverging=False, colormap="plasma",
            convert=lambda pa: pa / 100.0),
    VarSpec("iceconc_mm_srf", "ICECONC", "Sea-ice concentration", "fraction",
            diverging=False, colormap="cividis",
            convert=lambda frac: np.nan_to_num(frac, nan=0.0)),
    VarSpec("u_mm_10m", "U", "Zonal wind (10m)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True),
    VarSpec("v_mm_10m", "V", "Meridional wind (10m)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True),
    # --- ocean surface (new -- see docs/adr/0011) ---
    # Already degC in the source (unlike temp_mm_1_5m's Kelvin), confirmed
    # directly -- no conversion.
    VarSpec("temp_mm_dpth", "SST", "Sea surface temperature", "°C",
            diverging=True, high_means="hot", colormap="RdBu",
            stream="ocean_surface"),
    # Source units are (PSU-35)/1000 -- HadCM3's own ocean salinity
    # convention (an anomaly from 35, scaled down) -- converted to plain
    # practical salinity units for a legible display.
    VarSpec("salinity_mm_dpth", "SSS", "Sea surface salinity", "PSU",
            diverging=False, colormap="viridis",
            convert=lambda x: x * 1000.0 + 35.0, stream="ocean_surface"),
    VarSpec("ucurrTot_mm_dpth", "OCU", "Ocean surface current (U)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            convert=lambda cm_s: cm_s / 100.0, stream="ocean_surface"),
    VarSpec("vcurrTot_mm_dpth", "OCV", "Ocean surface current (V)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            convert=lambda cm_s: cm_s / 100.0, stream="ocean_surface"),
    VarSpec("uVelSeaice_mm_uo", "ICEU", "Sea-ice drift (U)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            stream="ocean_surface"),
    VarSpec("vVelSeaice_mm_uo", "ICEV", "Sea-ice drift (V)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            stream="ocean_surface"),
    # cm3/s -> Sverdrups (1 Sv = 1e6 m3/s = 1e12 cm3/s), the standard
    # oceanographic transport unit -- the raw cm3/s values are unreadably
    # large (order 1e13-1e14).
    VarSpec("streamFn_mm_uo", "STREAMFN", "Ocean barotropic streamfunction", "Sv",
            diverging=True, high_means="hot", colormap="RdBu",
            convert=lambda cm3_s: cm3_s / 1e12, stream="ocean_surface"),
    VarSpec("mixLyrDpth_mm_uo", "MLD", "Mixed-layer depth", "m",
            diverging=False, colormap="viridis", stream="ocean_surface"),
]

# Ocean Depth: temperature, salinity, current, and vertical velocity are all
# only ever depth_1 (T/S/U/V grid, 20 levels) EXCEPT vertical velocity,
# handled separately below (see load_ocean_depth_run's own doc comment).
OCEAN_DEPTH_VARIABLES = [
    VarSpec("temp_ym_dpth", "OTEMP", "Ocean temperature", "°C",
            diverging=True, high_means="hot", colormap="RdBu"),
    VarSpec("salinity_ym_dpth", "OSAL", "Ocean salinity", "PSU",
            diverging=False, colormap="viridis",
            convert=lambda x: x * 1000.0 + 35.0),
    VarSpec("ucurrTot_ym_dpth", "OCURU", "Ocean current (U)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            convert=lambda cm_s: cm_s / 100.0),
    VarSpec("vcurrTot_ym_dpth", "OCURV", "Ocean current (V)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True,
            convert=lambda cm_s: cm_s / 100.0),
    # Diverging (positive = upwelling, negative = downwelling) but neither
    # 'fast' nor 'hot' describes what a HIGH value means physically here --
    # reusing 'hot' is a pragmatic ramp-orientation choice (warm = upwelling,
    # the scientifically/visually interesting case this Layer prioritises,
    # see ADR-0010), not a literal temperature claim.
    VarSpec("W_ym_dpth", "OVEL", "Ocean vertical velocity (upwelling)", "cm/s",
            diverging=True, high_means="hot", colormap="RdBu"),
]
VERTICAL_VELOCITY_VAR_ID = "OVEL"

# VectorFieldInfo.display_speed_scale for every ocean-current-family field
# (Ocean Surface Current, Sea-Ice Drift -- numerically identical, see
# ADR-0013's "free-drift" note -- and Ocean Depth's own Ocean Current).
# Measured directly against a mid-run frame: median |wind| ~2.6 m/s vs
# median |ocean surface current| ~0.05 m/s, a ~50x gap (p90 gives the same
# ratio). At scale 1 an arrow/streak drawn with the exact wind-tuned
# constants (windGlyphs.ts/windStreaks.ts) would sit at its minimum
# length/speed almost everywhere -- correct data, unreadable picture. 50
# puts a TYPICAL ocean current on par with a typical wind for on-screen
# motion; the rare boundary-current extreme (up to ~6 m/s, i.e. ~300 m/s
# scaled) just saturates the existing SPEED_CLIP_MS the same way an
# extreme storm wind already does. Deep-ocean currents (weaker again below
# the surface) still read as slower than surface ones at this same flat
# scale -- that's physically correct and deliberately NOT flattened out
# with a second, depth-dependent scale.
OCEAN_VECTOR_DISPLAY_SCALE = 50


def load_layer(ds: xr.Dataset, source_var: str) -> np.ndarray:
    """One file's (lat, lon) field -- every other dim (t, surface/toa/ht/msl/
    depth_1/unspecified/...) is size 1 and squeezed away."""
    return np.asarray(ds[source_var].values, dtype=np.float64).squeeze()


def stream_filename(run: str, suffix: str, stream: str) -> str:
    return f"{run}a.pdcl{suffix}.nc" if stream == "atmosphere" else f"{run}o.pfcl{suffix}.nc"


def load_monthly_run(run_dir: Path, run: str, spec: VarSpec):
    """Returns (raw[N_MONTH_LAYERS, lat, lon] physical units, lat, lon) for
    one Monthly variable across one run -- months 0-11 real, layer 12 the
    run's own native annual mean (NOT a derived average)."""
    lat_name, lon_name = ("latitude_1", "longitude_1") if spec.staggered else ("latitude", "longitude")

    layers = []
    lat = lon = None
    for suf in MONTH_SUFFIXES:
        ds = xr.open_dataset(run_dir / stream_filename(run, suf, spec.stream), decode_times=False)
        if lat is None:
            lat = np.asarray(ds[lat_name].values, dtype=np.float64)
            lon = np.asarray(ds[lon_name].values, dtype=np.float64)
        layers.append(spec.convert(load_layer(ds, spec.source_var)))
        ds.close()

    ds = xr.open_dataset(run_dir / stream_filename(run, "ann", spec.stream), decode_times=False)
    layers.append(spec.convert(load_layer(ds, spec.source_var)))
    ds.close()

    raw = np.stack(layers, axis=0)  # (N_MONTH_LAYERS, lat, lon)
    if lat[0] > lat[-1]:  # confirmed descending in the raw source -- see docstring
        lat = lat[::-1]
        raw = raw[:, ::-1, :]
    return raw, lat, lon


def load_ocean_depth_run(run_dir: Path, run: str, spec: VarSpec):
    """Returns (raw[N_DEPTH, lat, lon] physical units, lat, lon) for one
    Ocean Depth variable across one run -- read once from the run's own
    o.pgclann.nc, BRIDGE's only depth-resolved ocean file (annual mean, no
    monthly breakdown -- see module docstring).

    Vertical velocity is the one exception: its source array has only 19
    levels (the interfaces BETWEEN the other variables' 20 levels, not
    co-located with them) and is remapped onto the shared 20-slot index by
    anchoring each interface to the shallower level it borders -- slot i
    (0..18) holds the flow crossing into the level below it, slot 19 (the
    deepest level) is left NO_DATA, since nothing lies below it to flux
    into. See docs/adr/0010 for why shallow (not deep) is the anchor
    choice."""
    lat_name, lon_name = ("latitude_1", "longitude_1") if spec.staggered else ("latitude", "longitude")
    ds = xr.open_dataset(run_dir / f"{run}o.pgclann.nc", decode_times=False)
    lat = np.asarray(ds[lat_name].values, dtype=np.float64)
    lon = np.asarray(ds[lon_name].values, dtype=np.float64)
    raw = spec.convert(load_layer(ds, spec.source_var))  # (depth_source, lat, lon)
    ds.close()

    if spec.var_id == VERTICAL_VELOCITY_VAR_ID:
        assert raw.shape[0] == N_DEPTH - 1, (
            f"expected {N_DEPTH - 1} vertical-velocity interfaces, got {raw.shape[0]}"
        )
        padded = np.full((N_DEPTH, raw.shape[1], raw.shape[2]), np.nan, dtype=np.float64)
        padded[:N_DEPTH - 1] = raw
        raw = padded
    else:
        assert raw.shape[0] == N_DEPTH, f"expected {N_DEPTH} depth levels, got {raw.shape[0]}"

    if lat[0] > lat[-1]:  # same descending-latitude convention as the atmosphere/surface streams
        lat = lat[::-1]
        raw = raw[:, ::-1, :]
    return raw, lat, lon


def condition(raw, lat, lon, nlon, nlat):
    data, lon2 = normalise_longitude(raw, lon)
    data, lon2 = drop_duplicate_seam(data, lon2)
    data, lon2, lat2 = resample_horizontal(data, lon2, lat, nlon, nlat)
    return data, lat2


def load_land_fraction(run_dir: Path, run: str, nlon: int, nlat: int) -> np.ndarray:
    """Land fraction, derived from iceconc_mm_srf's own raw NaN footprint
    (NaN over land, defined over ocean) rather than fetching a separate
    land-sea mask file. Feeds compute_koppen()'s land/ocean split; Monthly
    needs no shader validity mask for ITS atmosphere variables (they're
    globally valid), this is purely an input to the Koppen classification
    below -- unrelated to the NEW ocean-surface variables' OWN, separate
    NO_DATA handling (see encode_sparse)."""
    ds = xr.open_dataset(run_dir / f"{run}a.pdclann.nc", decode_times=False)
    raw = load_layer(ds, "iceconc_mm_srf")
    lat = np.asarray(ds["latitude"].values, dtype=np.float64)
    lon = np.asarray(ds["longitude"].values, dtype=np.float64)
    ds.close()

    land = np.isnan(raw).astype(np.float64)[np.newaxis, :, :]
    if lat[0] > lat[-1]:
        lat = lat[::-1]
        land = land[:, ::-1, :]
    data, _lat2 = condition(land, lat, lon, nlon, nlat)
    return np.clip(data[0], 0.0, 1.0)


def encode_sparse(data, clip_lo, clip_hi):
    """As prep_model.py's encode_uint8, but reserving byte 255 for NaN (see
    module docstring and docs/adr/0005) -- real data is clamped to 0..254 so
    the two never collide."""
    safe = np.nan_to_num(data, nan=clip_lo)
    scaled = np.clip((safe - clip_lo) / (clip_hi - clip_lo), 0.0, 1.0)
    byte = np.minimum(254, np.round(scaled * 255.0)).astype(np.uint8)
    return np.where(np.isfinite(data), byte, NO_DATA)


def write_frames(model_dir: Path, resolution_id: str, var_id: str, encoded, frame_meta) -> float:
    frame_dir = model_dir / "frames" / var_id / resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    total_mb = 0.0
    for i, fm in enumerate(frame_meta):
        out_path = frame_dir / f"{fm['id']}.bin"
        encoded[i].tofile(out_path)
        total_mb += out_path.stat().st_size / 1024 / 1024
    return total_mb


def build_monthly(args, frame_meta, out) -> None:
    model_dir = args.out / "models" / f"{args.id_prefix}-monthly"
    print(f"\n{'=' * 70}\nMONTHLY  ({len(MONTHLY_VARIABLES)} variables + Koppen)\n{'=' * 70}")

    per_var: dict[str, list[np.ndarray]] = {v.var_id: [] for v in MONTHLY_VARIABLES}
    land_fractions: list[np.ndarray] = []
    lat_out = None

    for i, (run, age) in enumerate(RUNS):
        run_dir = args.cache_dir / cache_dirname(i, run)
        for spec in MONTHLY_VARIABLES:
            raw, lat, lon = load_monthly_run(run_dir, run, spec)
            data, lat2 = condition(raw, lat, lon, args.nlon, args.nlat)
            lat_out = lat2
            per_var[spec.var_id].append(data)
        land_fractions.append(load_land_fraction(run_dir, run, args.nlon, args.nlat))

    variables_meta = []
    for spec in MONTHLY_VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, {spec.stream}, monthly + native annual)")
        vol = np.stack(per_var[spec.var_id])  # (n_runs, N_MONTH_LAYERS, nlat, nlon)
        raw_min, raw_max = float(np.nanmin(vol)), float(np.nanmax(vol))
        print(f"    range       {raw_min:+.4g} to {raw_max:+.4g} {spec.units}")

        clip_lo, clip_hi = choose_clip(vol, spec.diverging, args.clip_percentile, None)
        print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] ({args.clip_percentile} percentile)")
        colormap = choose_colormap(spec.colormap, spec.high_means, args.out, spec.diverging)
        print(f"    colormap    {colormap}" + (f"  (high = {spec.high_means})" if spec.diverging else ""))

        encoded = encode_sparse(vol, clip_lo, clip_hi)
        nan_frac = float(np.isnan(vol).mean())
        total_mb = write_frames(model_dir, args.resolution_id, spec.var_id, encoded, frame_meta)
        print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total"
              + (f"  ({nan_frac:.1%} NO_DATA)" if nan_frac > 0 else ""))

        variables_meta.append({
            "id": spec.var_id,
            "name": spec.display_name,
            "source_var": spec.source_var,
            "units": spec.units,
            "diverging": spec.diverging,
            **({"high_means": spec.high_means} if spec.diverging else {}),
            **({"vector_only": True} if spec.vector_only else {}),
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(clip_lo, 4),
            "default_clip_max": round(clip_hi, 4),
            "default_colormap": colormap,
        })

        if args.validate:
            expect = args.nlon * args.nlat * N_MONTH_LAYERS
            first = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                 / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert not np.array_equal(first, last), \
                f"{spec.var_id}: 541 Ma and 0 Ma frames are byte-identical -- age grouping failed"
            first3 = first.reshape(N_MONTH_LAYERS, args.nlat, args.nlon)
            assert not np.array_equal(first3[0], first3[6]), \
                f"{spec.var_id}: month 0 and month 6 are byte-identical -- month axis collapsed"

    # --- KOPPEN: derived from T + P (atmosphere stream, unaffected by the
    # new ocean-surface additions) -- see prep_climate.py's compute_koppen(),
    # reused unchanged so Monthly classifies identically to Li et al.'s model
    # for the same inputs.
    print(f"\n=== KOPPEN  (derived from T + P, static -> broadcast to every layer)")
    t_stack = np.stack([v[:N_MONTHS] for v in per_var["T"]])
    p_stack = np.stack([v[:N_MONTHS] for v in per_var["P"]]) * 30.0  # mm/day -> mm/month, HadCM3's 360-day calendar
    landfrac_stack = np.stack(land_fractions)
    koppen_2d = compute_koppen(t_stack, p_stack, landfrac_stack, lat_out)

    koppen_vol = np.repeat(
        (koppen_2d.astype(np.float32) + 0.5)[:, np.newaxis, :, :], N_MONTH_LAYERS, axis=1,
    )
    from prep_model import encode_uint8  # koppen never produces byte 255 by construction -- see module docstring
    encoded = encode_uint8(koppen_vol, 0.0, float(N_KOPPEN_CLASSES))
    total_mb = write_frames(model_dir, args.resolution_id, "KOPPEN", encoded, frame_meta)
    print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")
    variables_meta.append({
        "id": "KOPPEN",
        "name": "Koppen climate classification",
        "source_var": "T,P",
        "units": "class",
        "diverging": False,
        "categorical": True,
        "class_names": KOPPEN_CLASS_NAMES,
        "encode_min": 0.0,
        "encode_max": float(N_KOPPEN_CLASSES),
        "value_min": 0.0,
        "value_max": float(N_KOPPEN_CLASSES - 1),
        "default_clip_min": 0.0,
        "default_clip_max": float(N_KOPPEN_CLASSES),
        "default_colormap": "koppen",
    })

    manifest = {
        "id": f"{args.id_prefix}-monthly",
        "name": "Valdes et al. 2021 (BRIDGE) — Monthly",
        "type": "climate-monthly",
        "source": SOURCE_CITATION,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": MONTHLY_LAYER_MIN, "depth_max_km": MONTHLY_LAYER_MAX,
        "no_data_sentinel": NO_DATA,
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": N_MONTH_LAYERS,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "T",
        "variables": variables_meta,
        "vector_fields": [
            {"id": "wind", "name": "Wind (10m)", "u_variable": "U", "v_variable": "V", "units": "m/s"},
            {"id": "ocean_current", "name": "Ocean Surface Current",
             "u_variable": "OCU", "v_variable": "OCV", "units": "m/s",
             "display_speed_scale": OCEAN_VECTOR_DISPLAY_SCALE},
            {"id": "sea_ice_drift", "name": "Sea-Ice Drift",
             "u_variable": "ICEU", "v_variable": "ICEV", "units": "m/s",
             "display_speed_scale": OCEAN_VECTOR_DISPLAY_SCALE},
        ],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


def build_ocean_depth(args, frame_meta, out) -> None:
    model_dir = args.out / "models" / f"{args.id_prefix}-ocean-depth"
    print(f"\n{'=' * 70}\nOCEAN DEPTH  ({len(OCEAN_DEPTH_VARIABLES)} variables, annual mean only)\n{'=' * 70}")

    per_var: dict[str, list[np.ndarray]] = {v.var_id: [] for v in OCEAN_DEPTH_VARIABLES}
    lat_out = None
    depth_labels_km: list[float] | None = None

    for i, (run, age) in enumerate(RUNS):
        run_dir = args.cache_dir / cache_dirname(i, run)
        if depth_labels_km is None:
            ds = xr.open_dataset(run_dir / f"{run}o.pgclann.nc", decode_times=False)
            depth_1 = np.asarray(ds["depth_1"].values, dtype=np.float64)
            assert depth_1.shape == (N_DEPTH,), f"expected {N_DEPTH} depth_1 levels, got {depth_1.shape}"
            depth_labels_km = [round(float(d) / 1000.0, 5) for d in depth_1]
            ds.close()
            print(f"    depth levels (km): {depth_labels_km}")
        for spec in OCEAN_DEPTH_VARIABLES:
            raw, lat, lon = load_ocean_depth_run(run_dir, run, spec)
            data, lat2 = condition(raw, lat, lon, args.nlon, args.nlat)
            lat_out = lat2
            per_var[spec.var_id].append(data)

    variables_meta = []
    for spec in OCEAN_DEPTH_VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, annual, {N_DEPTH} depth levels)")
        vol = np.stack(per_var[spec.var_id])  # (n_runs, N_DEPTH, nlat, nlon)
        raw_min, raw_max = float(np.nanmin(vol)), float(np.nanmax(vol))
        print(f"    range       {raw_min:+.4g} to {raw_max:+.4g} {spec.units}")

        clip_lo, clip_hi = choose_clip(vol, spec.diverging, args.clip_percentile, None)
        print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] ({args.clip_percentile} percentile)")
        colormap = choose_colormap(spec.colormap, spec.high_means, args.out, spec.diverging)
        print(f"    colormap    {colormap}" + (f"  (high = {spec.high_means})" if spec.diverging else ""))

        encoded = encode_sparse(vol, clip_lo, clip_hi)
        nan_frac = float(np.isnan(vol).mean())
        total_mb = write_frames(model_dir, args.resolution_id, spec.var_id, encoded, frame_meta)
        print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total  ({nan_frac:.1%} NO_DATA)")

        variables_meta.append({
            "id": spec.var_id,
            "name": spec.display_name,
            "source_var": spec.source_var,
            "units": spec.units,
            "diverging": spec.diverging,
            **({"high_means": spec.high_means} if spec.diverging else {}),
            **({"vector_only": True} if spec.vector_only else {}),
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(clip_lo, 4),
            "default_clip_max": round(clip_hi, 4),
            "default_colormap": colormap,
        })

        if args.validate:
            expect = args.nlon * args.nlat * N_DEPTH
            first = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                 / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert not np.array_equal(first, last), \
                f"{spec.var_id}: 541 Ma and 0 Ma frames are byte-identical -- age grouping failed"
            first3 = first.reshape(N_DEPTH, args.nlat, args.nlon)
            assert not np.array_equal(first3[0], first3[5]), \
                f"{spec.var_id}: depth level 0 and level 5 are byte-identical -- depth axis collapsed"
            if spec.var_id == VERTICAL_VELOCITY_VAR_ID:
                assert bool(np.all(first3[N_DEPTH - 1] == NO_DATA)), \
                    "OVEL's deepest level should be entirely NO_DATA -- shallow-anchor mapping broken"

    manifest = {
        "id": f"{args.id_prefix}-ocean-depth",
        "name": "Valdes et al. 2021 (BRIDGE) — Ocean Depth",
        "type": "climate-ocean-depth",
        "source": SOURCE_CITATION,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": 0.0, "depth_max_km": float(N_DEPTH - 1),
        "depth_labels_km": depth_labels_km,
        "no_data_sentinel": NO_DATA,
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": N_DEPTH,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "OTEMP",
        "variables": variables_meta,
        "vector_fields": [
            {"id": "ocean_current", "name": "Ocean Current",
             "u_variable": "OCURU", "v_variable": "OCURV", "units": "m/s",
             "display_speed_scale": OCEAN_VECTOR_DISPLAY_SCALE},
        ],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--cache-dir", type=Path,
                     default=Path(__file__).parent / "cache" / "bridge_valdes2021")
    ap.add_argument("--id-prefix", default="bridge-valdes2021")
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    missing = [run for i, (run, _) in enumerate(RUNS)
               if not all((args.cache_dir / cache_dirname(i, run) / name).exists()
                          for name in [
                              *(f"{run}a.pdcl{suf}.nc" for suf in [*MONTH_SUFFIXES, "ann"]),
                              *(f"{run}o.pfcl{suf}.nc" for suf in [*MONTH_SUFFIXES, "ann"]),
                              f"{run}o.pgclann.nc",
                          ])]
    if missing:
        raise SystemExit(
            f"{len(missing)} run(s) missing cached files under {args.cache_dir} "
            f"-- run fetch_bridge.py first. First missing: {missing[0]}"
        )

    print(f"{len(RUNS)} runs, {RUNS[0][1]:.0f}-{RUNS[-1][1]:.0f} Ma")
    frame_meta = [{"id": f"{int(round(age)):03d}", "age_ma": float(age)} for _, age in RUNS]

    build_monthly(args, frame_meta, args.out)
    build_ocean_depth(args, frame_meta, args.out)


if __name__ == "__main__":
    main()
