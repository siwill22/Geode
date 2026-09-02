#!/usr/bin/env python3
"""Convert the Bristol BRIDGE `scotese_02` HadCM3 run sequence into the
viewer format -- a third, selectable climate model alongside Li et al. 2022
(climate-540myr) and Pohl et al. 2022 (climate-pohl2022).

This is the dataset behind Valdes, Scotese & Lunt 2021, "Deep ocean
temperatures through time" (Clim. Past, 17, 1483-1506,
https://doi.org/10.5194/cp-17-1483-2021) -- see bridge_runs.py for how the
109-run, 541-0 Ma list was confirmed to match the paper's own simulation
count.

Source: run fetch_bridge.py first. Each of the 109 runs has 13 raw netCDF
files (12 monthly means + 1 native annual mean, NOT derived by averaging the
months -- BRIDGE's own `pdclann.nc` is used directly for the Annual layer,
more accurate than re-deriving one). Every run shares an IDENTICAL 39-variable
set (checked directly by diffing the 0 Ma and 541 Ma files) on a global
3.75x2.5 degree grid -- full ocean+atmosphere coverage, unlike Pohl's
continental-only run, so NO validity mask is needed here.

Two different native grids exist in the same file: scalar fields
(temperature, precip, pressure, ice) sit on `latitude`/`longitude`
(73x96, DESCENDING 90..-90 -- confirmed directly, must be flipped before
resampling, the same lesson as the 06m paleogeography source in
prep_paleogeography.py); wind (u_mm_10m/v_mm_10m) sits on a staggered
Arakawa `latitude_1`/`longitude_1` grid (72x96, also descending) -- each
variable is resampled using its OWN native lon/lat, not a shared one.

`decode_times=False` is required when opening every file: the `t` coordinate
uses a 360-day calendar with a day-0 encoding cftime can't parse, and it's
irrelevant here anyway -- one time mean per file, no time axis to resample.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<age_id:03d>.bin

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python prep_bridge.py --validate
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import xarray as xr

from bridge_runs import RUNS
from prep_climate import KOPPEN_CLASS_NAMES, N_KOPPEN_CLASSES, compute_koppen
from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_clip,
    choose_colormap,
    drop_duplicate_seam,
    encode_uint8,
    normalise_longitude,
    resample_horizontal,
)

MONTH_SUFFIXES = ["jan", "feb", "mar", "apr", "may", "jun",
                   "jul", "aug", "sep", "oct", "nov", "dec"]
N_MONTHS = 12
N_LAYERS = N_MONTHS + 1  # + the model's own native Annual mean, index N_MONTHS
ANNUAL_LAYER = N_MONTHS
LAYER_MIN_KM = 0.0
LAYER_MAX_KM = float(N_LAYERS - 1)

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
    staggered: bool = False  # True -> the latitude_1/longitude_1 wind grid
    vector_only: bool = False


VARIABLES = [
    VarSpec("temp_mm_1_5m", "T", "Surface temperature", "°C",
            diverging=True, high_means="hot", colormap="RdBu",
            convert=lambda k: k - 273.15),
    VarSpec("precip_mm_srf", "P", "Precipitation", "mm/day",
            diverging=False, colormap="viridis",
            convert=lambda kg_m2_s: kg_m2_s * 86400.0),
    # No generic "high/low" entry exists in choose_colormap's high_means
    # vocabulary (only 'hot'/'fast', both mantle/temperature-anomaly terms --
    # see prep_model.py) -- rather than stretch that vocabulary for one
    # variable, sea-level pressure is sequential, not diverging.
    VarSpec("p_mm_msl", "MSLP", "Sea-level pressure", "hPa",
            diverging=False, colormap="plasma",
            convert=lambda pa: pa / 100.0),
    # Unlike every other variable here, iceconc_mm_srf is NaN over land
    # (CF standard_name sea_ice_area_fraction -- confirmed directly: ~35% of
    # cells, exactly the land footprint, e.g. NaN at the Sahara, a real
    # fraction at the Arctic). Filled to 0 rather than masked: "fraction of
    # sea covered by ice" is truthfully 0 where there is no sea, not an
    # unknown value being guessed at -- a different case from Pohl's ocean
    # temperature (genuinely undefined, handled with a validity mask) or
    # fill_nan()'s scattered-coastal-cell smoothing (this is ~35% of the
    # grid, not scattered, so nearest-neighbour fill would smear real
    # coastal ice values deep inland).
    VarSpec("iceconc_mm_srf", "ICECONC", "Sea-ice concentration", "fraction",
            diverging=False, colormap="cividis",
            convert=lambda frac: np.nan_to_num(frac, nan=0.0)),
    VarSpec("u_mm_10m", "U", "Zonal wind (10m)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True),
    VarSpec("v_mm_10m", "V", "Meridional wind (10m)", "m/s",
            diverging=False, colormap="gray", staggered=True, vector_only=True),
]


def load_layer(ds: xr.Dataset, source_var: str) -> np.ndarray:
    """One file's (lat, lon) field -- every other dim (t, surface/toa/ht/msl)
    is size 1 and squeezed away."""
    return np.asarray(ds[source_var].values, dtype=np.float64).squeeze()


def load_run(run_dir: Path, spec: VarSpec):
    """Returns (raw[N_LAYERS, lat, lon] physical units, lat, lon) for one
    variable across one run -- months 0-11 real, layer 12 the run's own
    native annual mean (NOT a derived average -- see module docstring)."""
    lat_name, lon_name = ("latitude_1", "longitude_1") if spec.staggered else ("latitude", "longitude")

    layers = []
    lat = lon = None
    for suf in MONTH_SUFFIXES:
        ds = xr.open_dataset(run_dir / f"{run_dir.name}a.pdcl{suf}.nc", decode_times=False)
        if lat is None:
            lat = np.asarray(ds[lat_name].values, dtype=np.float64)
            lon = np.asarray(ds[lon_name].values, dtype=np.float64)
        layers.append(spec.convert(load_layer(ds, spec.source_var)))
        ds.close()

    ds = xr.open_dataset(run_dir / f"{run_dir.name}a.pdclann.nc", decode_times=False)
    layers.append(spec.convert(load_layer(ds, spec.source_var)))
    ds.close()

    raw = np.stack(layers, axis=0)  # (N_LAYERS, lat, lon)
    if lat[0] > lat[-1]:  # confirmed descending in the raw source -- see docstring
        lat = lat[::-1]
        raw = raw[:, ::-1, :]
    return raw, lat, lon


def condition(raw, lat, lon, nlon, nlat):
    data, lon2 = normalise_longitude(raw, lon)
    data, lon2 = drop_duplicate_seam(data, lon2)
    data, lon2, lat2 = resample_horizontal(data, lon2, lat, nlon, nlat)
    return data, lat2


def load_land_fraction(run_dir: Path, nlon: int, nlat: int) -> np.ndarray:
    """Land fraction, derived from iceconc_mm_srf's own raw NaN footprint
    (NaN over land, defined over ocean -- see ICECONC's VarSpec above) rather
    than fetching a separate land-sea mask file. Feeds compute_koppen()'s
    land/ocean split; BRIDGE needs no shader validity mask for display (every
    OTHER variable is globally valid, see module docstring), this is purely
    an input to the Koppen classification below."""
    ds = xr.open_dataset(run_dir / f"{run_dir.name}a.pdclann.nc", decode_times=False)
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


def write_frames(model_dir: Path, resolution_id: str, var_id: str, encoded, frame_meta) -> float:
    frame_dir = model_dir / "frames" / var_id / resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    total_mb = 0.0
    for i, fm in enumerate(frame_meta):
        out_path = frame_dir / f"{fm['id']}.bin"
        encoded[i].tofile(out_path)
        total_mb += out_path.stat().st_size / 1024 / 1024
    return total_mb


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--cache-dir", type=Path,
                     default=Path(__file__).parent / "cache" / "bridge_valdes2021")
    ap.add_argument("--id", default="climate-bridge-valdes2021")
    ap.add_argument("--name", default="Valdes et al. 2021 (BRIDGE)")
    ap.add_argument("--source", default=SOURCE_CITATION)
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    missing = [run for run, _ in RUNS
               if not all((args.cache_dir / run / f"{run}a.pdcl{suf}.nc").exists()
                          for suf in [*MONTH_SUFFIXES, "ann"])]
    if missing:
        raise SystemExit(
            f"{len(missing)} run(s) missing cached files under {args.cache_dir} "
            f"-- run fetch_bridge.py first. First missing: {missing[0]}"
        )

    print(f"{len(RUNS)} runs, {RUNS[0][1]:.0f}-{RUNS[-1][1]:.0f} Ma")

    model_dir = args.out / "models" / args.id
    frame_meta = [{"id": f"{int(round(age)):03d}", "age_ma": float(age)} for _, age in RUNS]

    # Pass 1: condition every run, every variable, keep in memory (109 runs x
    # 6 vars x 13 layers x 360x181 float32 =~ 750 MB, comfortably one pass) so
    # clip ranges span the WHOLE 541 Myr series -- same two-pass shape as
    # prep_pohl.py/prep_paleogeography.py.
    per_var: dict[str, list[np.ndarray]] = {v.var_id: [] for v in VARIABLES}
    land_fractions: list[np.ndarray] = []
    lat_out = None

    for run, age in RUNS:
        run_dir = args.cache_dir / run
        for spec in VARIABLES:
            raw, lat, lon = load_run(run_dir, spec)
            data, lat2 = condition(raw, lat, lon, args.nlon, args.nlat)
            lat_out = lat2
            per_var[spec.var_id].append(data)
        land_fractions.append(load_land_fraction(run_dir, args.nlon, args.nlat))

    variables_meta = []
    for spec in VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, monthly + native annual)")
        vol = np.stack(per_var[spec.var_id])  # (n_runs, N_LAYERS, nlat, nlon)
        raw_min, raw_max = float(np.nanmin(vol)), float(np.nanmax(vol))
        print(f"    range       {raw_min:+.4g} to {raw_max:+.4g} {spec.units}")

        clip_lo, clip_hi = choose_clip(vol, spec.diverging, args.clip_percentile, None)
        print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] ({args.clip_percentile} percentile)")
        colormap = choose_colormap(spec.colormap, spec.high_means, args.out, spec.diverging)
        print(f"    colormap    {colormap}" + (f"  (high = {spec.high_means})" if spec.diverging else ""))

        encoded = encode_uint8(vol, clip_lo, clip_hi)
        total_mb = write_frames(model_dir, args.resolution_id, spec.var_id, encoded, frame_meta)
        print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")

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
            expect = args.nlon * args.nlat * N_LAYERS
            first = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                 / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert last.size == expect, f"{frame_meta[-1]['id']}.bin is {last.size}, want {expect}"
            assert not np.array_equal(first, last), \
                f"{spec.var_id}: 541 Ma and 0 Ma frames are byte-identical -- age grouping failed"
            first3 = first.reshape(N_LAYERS, args.nlat, args.nlon)
            assert not np.array_equal(first3[0], first3[6]), \
                f"{spec.var_id}: month 0 and month 6 are byte-identical -- month axis collapsed"
            print(f"    validate    {expect} bytes/frame, no age/month collapse")

    # --- KOPPEN: derived from T + P, the same way prep_climate.py's Li et
    # al. model does (BRIDGE ships no precomputed classification, unlike
    # Pohl) -- reuses compute_koppen() itself, not a re-implementation, so
    # both models classify identically for the same inputs. MAP needs a true
    # annual TOTAL in mm/month (summed over 12 months); P above is displayed
    # in mm/day (matches Pohl's convention), so this multiplies by 30 --
    # HadCM3's own 360-day/12-month calendar (confirmed directly: every
    # source file's time-units attribute reads "days since ...", calendar
    # '360_day') -- purely for this internal computation, not the stored/
    # displayed P variable. Land fraction comes from load_land_fraction()
    # above (ICECONC's own NaN footprint), not a separate fetched mask.
    print(f"\n=== KOPPEN  (derived from T + P, static -> broadcast to every layer)")
    t_stack = np.stack([v[:N_MONTHS] for v in per_var["T"]])       # (n_runs, 12, nlat, nlon) degC
    p_stack = np.stack([v[:N_MONTHS] for v in per_var["P"]]) * 30.0  # mm/day -> mm/month
    landfrac_stack = np.stack(land_fractions)                       # (n_runs, nlat, nlon)
    koppen_2d = compute_koppen(t_stack, p_stack, landfrac_stack, lat_out)  # (n_runs, nlat, nlon) uint8

    # Same band-centre encoding trick prep_climate.py/prep_pohl.py use:
    # encode_uint8 truncates and the shader decode floors, so landing exactly
    # on an integer class rounds down to the class below it.
    koppen_vol = np.repeat(
        (koppen_2d.astype(np.float32) + 0.5)[:, np.newaxis, :, :], N_LAYERS, axis=1,
    )
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

    if args.validate:
        expect = args.nlon * args.nlat * N_LAYERS
        age0_idx = len(RUNS) - 1  # 0 Ma is last -- RUNS is oldest-first
        first = np.fromfile(model_dir / "frames" / "KOPPEN" / args.resolution_id
                             / f"{frame_meta[age0_idx]['id']}.bin", dtype=np.uint8)
        assert first.size == expect
        koppen_bytes = first.reshape(N_LAYERS, args.nlat, args.nlon)[0]
        koppen_age0 = np.minimum(
            N_KOPPEN_CLASSES - 1,
            np.floor((koppen_bytes.astype(np.float64) / 255.0) * N_KOPPEN_CLASSES),
        ).astype(np.int64)

        def class_at(lon_q, lat_q):
            lon_grid = np.linspace(-180, 180, args.nlon, endpoint=False)
            j = int(np.argmin(np.abs(lon_grid - lon_q)))
            i = int(np.argmin(np.abs(lat_out - lat_q)))
            return KOPPEN_CLASS_NAMES[int(koppen_age0[i, j])]

        checks = [
            ("central Sahara", 10.0, 23.0, "Desert (BW)"),
            ("Congo basin", 22.0, 0.0, "Fully humid (Af)"),
            ("central England", -1.0, 52.0, "Temperate, no dry season (Cf)"),
        ]
        print()
        for label, lon_q, lat_q, expected in checks:
            got = class_at(lon_q, lat_q)
            status = "ok" if got.startswith(expected.split(" (")[0].split(",")[0]) else "** MISMATCH"
            print(f"    validate    {label} (age 0) -> {got}  [expected {expected}]  {status}")

    if args.validate:
        # Present-day (0 Ma) area-weighted global-mean surface temperature
        # should land near the real modern ~14-15 C -- a SIMPLE (unweighted)
        # mean over an equirectangular grid over-samples the poles and reads
        # noticeably colder (~6 C, checked directly), so this check weights
        # by cos(latitude) rather than use a misleadingly tight bound on the
        # wrong statistic.
        t_vol = per_var["T"][-1]  # 0 Ma is last in RUNS (oldest-first)
        w = np.cos(np.deg2rad(lat_out))[:, None]
        t_ann_weighted = float((t_vol[ANNUAL_LAYER] * w).sum() / w.sum() / t_vol.shape[2])
        ok = 10.0 <= t_ann_weighted <= 20.0
        print(f"\n    validate    0 Ma area-weighted annual-mean T = {t_ann_weighted:+.2f} degC "
              f"[expect 10-20]  {'ok' if ok else '** MISMATCH'}")

        t_541 = per_var["T"][0][ANNUAL_LAYER]
        t_541_weighted = float((t_541 * w).sum() / w.sum() / t_541.shape[1])
        print(f"    validate    541 Ma area-weighted annual-mean T = {t_541_weighted:+.2f} degC "
              f"(sanity: materially different from 0 Ma)")

    manifest = {
        "id": args.id,
        "name": args.name,
        "type": "climate",
        "source": args.source,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": LAYER_MIN_KM,
        "depth_max_km": LAYER_MAX_KM,
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": N_LAYERS,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "T",
        "variables": variables_meta,
        "vector_fields": [
            {"id": "wind", "name": "Wind (10m)",
             "u_variable": "U", "v_variable": "V", "units": "m/s"},
        ],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
