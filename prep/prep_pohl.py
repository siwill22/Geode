#!/usr/bin/env python3
"""Convert Pohl et al.'s FOAM GCM continental paleoclimate series into the
viewer format -- a second, selectable climate model alongside Li et al. 2022
(climate-540myr), for climate.html's new climate-model picker.

Source: a DIRECTORY of one netCDF file per age (not one file with an age
dimension, unlike Li et al.), 28 ages every 20 Myr, 0-540 Ma, 128x128 grid.
Longitude/latitude are already ascending, unlike the paleogeography viewer's
6-arcmin source, which needed a flip -- checked directly, not assumed.

Variables arrive as (lon, lat[, time]) -- the OPPOSITE trailing-axis order
prep_model.py's helpers assume ((..., lat, lon)) -- so every variable is
pulled through xarray's own named-axis `.transpose()` rather than a raw
numpy transpose, immune to this script mis-stating which axis is which.

This run is CONTINENTAL ONLY: ocean cells hold the raw netCDF default fill
sentinel (~9.97e36) with no `_FillValue`/`missing_value` attribute for
xarray to auto-decode -- converted to NaN by hand (see FILL_SENTINEL) before
anything else touches the data. Painting oceans with a fabricated colour
would be dishonest (see material.ts's existing no-data branch: "say so,
don't fabricate"), so a land/ocean validity mask is derived from `topo`'s
own NaN footprint (the one static-per-age field every other variable's
footprint is checked against, see --validate) and shipped as its own
`mask_only` frame, consumed at runtime by core/material.ts's new
`uValidMask`/`uUseValidMask` uniforms -- see Manifest.mask_variable.

Pohl's own `koppen` variable is a PRECOMPUTED Koppen-Geiger classification
(codes 1-13), used AS SHIPPED rather than recomputed the way prep_climate.py
derives one from T+P -- Geode's existing 13-class scheme (KOPPEN_CLASS_NAMES)
was already built to match "Pohl et al. 2022 Table 3", and this dataset IS
that paper (Pohl et al. 2022, Data in Brief, doi:10.1016/j.dib.2022.108424):
Table 3 there gives the exact same 1-13 code order used here, confirmed by
reading the paper directly, not just the class-name-derived assumption
prep_climate.py's own comment states. The --validate spot-checks below
still caught a real, worthwhile thing during development: central England
comes back as "Tundra" at 0 Ma, which looked like a mapping bug at first --
it isn't (the raw code is 1 in Pohl's own native-grid data too, checked
directly) but a known character of FOAM's simplified slab-ocean setup (a
tuned diffusion coefficient standing in for a dynamic Gulf Stream), which
under-heats western Europe at this coarse ~2.8x1.4 degree resolution.
Kept as a real spot-check anyway (Sahara/Congo below are unambiguous), not
softened, since a future genuine regression at those two would still be
worth catching. Unlike every other variable here, koppen is resampled with
NEAREST-NEIGHBOUR interpolation (see the `kind='nearest'` addition to
prep_model.py's resample_horizontal) -- linearly blending class CODES would
fabricate classes that don't exist between real ones, the same reasoning
the GPU texture sampler already uses NearestFilter for categorical data
(see material.ts).

`area` (grid-cell area, m^2) is grid metadata, not a climate field, and is
deliberately not ingested.

A derived 13th "Annual" layer is added for every monthly variable, the same
convention prep_climate.py uses, so climateUi.ts's month slider/legend code
(hardcoded to N_LAYERS=13) needs no per-model special-casing.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<age_id:03d>.bin

Example
-------
    python prep_pohl.py \\
        --input-dir "/Users/simon/Library/CloudStorage/OneDrive-UniversityofTasmania/Work/Climate/Pohl/All_NC_files" \\
        --validate
"""

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xarray as xr

from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_clip,
    choose_colormap,
    drop_duplicate_seam,
    encode_uint8,
    fill_nan,
    normalise_longitude,
    resample_horizontal,
)

N_MONTHS = 12
N_LAYERS = N_MONTHS + 1  # + the derived Annual layer, index N_MONTHS
ANNUAL_LAYER = N_MONTHS
LAYER_MIN_KM = 0.0
LAYER_MAX_KM = float(N_LAYERS - 1)

DEFAULT_CLIP_PERCENTILE = 99.5

# Anything at or above this is the raw netCDF default fill value (classic
# NC_FILL_DOUBLE, ~9.9692e36), not real data -- see the module docstring.
FILL_SENTINEL = 1e30

FILENAME_RE = re.compile(r"^(\d+)Ma_")

MASK_VAR_ID = "LANDMASK"

# Same 13-class scheme prep_climate.py's compute_koppen() targets --
# see the module docstring for why Pohl's own raw 1-13 codes are trusted
# to already be in this order, rather than recomputed.
KOPPEN_CLASS_NAMES = [
    "Ocean",
    "Tundra (ET)", "Frost (EF)",
    "Cold, dry winter (Dw)", "Cold, dry summer (Ds)", "Cold, no dry season (Df)",
    "Temperate, dry winter (Cw)", "Temperate, dry summer (Cs)",
    "Temperate, no dry season (Cf)",
    "Desert (BW)", "Steppe (BS)",
    "Savannah (Aw)", "Monsoon (Am)", "Fully humid (Af)",
]
N_KOPPEN_CLASSES = len(KOPPEN_CLASS_NAMES)


@dataclass
class VarSpec:
    source_var: str
    var_id: str
    display_name: str
    monthly: bool
    units: str
    diverging: bool
    high_means: str | None = None  # 'hot'/'fast' -- see choose_colormap(); a
    # vocabulary borrowed from the mantle models, just a lookup key into
    # which pre-tagged colormap orientation to use, not a claim that
    # anything here is a velocity anomaly.
    colormap: str = "viridis"


VARIABLES = [
    VarSpec("tssub1", "T", "Surface temperature", True, "°C",
            diverging=True, high_means="hot", colormap="RdBu"),
    VarSpec("precip", "P", "Precipitation", True, "mm/day",
            diverging=False, colormap="viridis"),
    VarSpec("evp", "EVP", "Evaporation", True, "mm/day",
            diverging=False, colormap="viridis"),
    VarSpec("rnf", "RNF", "Runoff", True, "mm/day",
            diverging=False, colormap="viridis"),
    # High P-E = net wet -> the 'cool'/blue-high-end orientation ('fast' is
    # just choose_colormap()'s lookup key for that, see VarSpec.high_means).
    VarSpec("PmE", "PME", "Precipitation minus evaporation", True, "mm/day",
            diverging=True, high_means="fast", colormap="RdBu"),
    VarSpec("topo", "TOPO", "Topography", False, "m",
            diverging=False, colormap="viridis"),
]


def load_var(ds: xr.Dataset, name: str, dims: tuple[str, ...]) -> np.ndarray:
    """`.transpose(*dims)` reorders by NAME -- Pohl's own (lon, lat[, time])
    axis order is the opposite of what every helper below assumes, so this
    is immune to this script mis-stating which axis is which. Converts the
    raw fill sentinel to NaN -- see FILL_SENTINEL."""
    arr = np.asarray(ds[name].transpose(*dims).values, dtype=np.float64)
    arr[arr >= FILL_SENTINEL] = np.nan
    return arr


def add_annual_layer(vol: np.ndarray, monthly: bool) -> np.ndarray:
    """(N_MONTHS, nlat, nlon) -> (N_LAYERS, nlat, nlon), appending the Annual
    layer at index N_MONTHS -- the real mean of the 12 months for monthly
    data, or an exact copy for static data already broadcast to N_MONTHS
    (avoids introducing float noise into an already-uniform field). Mirrors
    prep_climate.py's own add_annual_layer() (age axis omitted here -- one
    age is processed at a time, see main())."""
    annual = vol.mean(axis=0, keepdims=True) if monthly else vol[:1]
    return np.concatenate([vol, annual], axis=0)


def condition(raw: np.ndarray, lon: np.ndarray, lat: np.ndarray, nlon: int, nlat: int):
    """normalise_longitude -> drop_duplicate_seam -> fill_nan -> resample,
    the same order prep_model.py's own main() uses for REVEAL/SEMUCB. `raw`
    is (levels, lat, lon); levels is N_MONTHS for a monthly variable or 1
    for a static one."""
    data, lon2 = normalise_longitude(raw, lon)
    data, lon2 = drop_duplicate_seam(data, lon2)
    data, n_filled = fill_nan(data)
    data, lon2, lat2 = resample_horizontal(data, lon2, lat, nlon, nlat)
    return data, lat2, n_filled


def write_frames(model_dir: Path, resolution_id: str, var_id: str, encoded, frame_meta) -> float:
    """encoded: (age, N_LAYERS, nlat, nlon) uint8. One file per age."""
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
    ap.add_argument("--input-dir", type=Path, required=True)
    ap.add_argument("--id", default="climate-pohl2022")
    ap.add_argument("--name", default="Pohl et al. Paleoclimate")
    ap.add_argument("--source", default=(
        "Pohl, A., Wong Hearing, T., Franc, A., Sepulchre, P., and Scotese, "
        "C.R. 2022. Dataset of Phanerozoic continental climate and "
        "Koppen-Geiger climate classes. Data in Brief, 43, 108424. "
        "https://doi.org/10.1016/j.dib.2022.108424"
    ))
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    files = sorted(args.input_dir.glob("*Ma_*.nc"))
    if not files:
        raise SystemExit(f"no *Ma_*.nc files found in {args.input_dir}")

    entries = []
    for p in files:
        m = FILENAME_RE.match(p.name)
        if not m:
            raise SystemExit(f"can't parse age from filename: {p.name}")
        entries.append((float(m.group(1)), p))
    entries.sort()
    print(f"{len(entries)} age files, {entries[0][0]:.0f}-{entries[-1][0]:.0f} Ma")

    model_dir = args.out / "models" / args.id
    frame_meta = [{"id": f"{int(round(a)):03d}", "age_ma": a} for a, _ in entries]

    # Pass 1: load + condition every age, every variable, keep in memory (28
    # ages x ~5 monthly vars x 13 layers x 360x181 float32 =~ 130 MB -- cheap
    # enough not to need a third disk read) so clip ranges span the WHOLE
    # series, not one age -- same two-pass shape as prep_paleogeography.py.
    per_var: dict[str, list[np.ndarray]] = {v.var_id: [] for v in VARIABLES}
    mask_frames: list[np.ndarray] = []
    koppen_frames: list[np.ndarray] = []
    lat_out = None
    total_filled = 0

    for age, path in entries:
        ds = xr.open_dataset(path)
        lat = np.asarray(ds["lat"].values, dtype=np.float64)
        lon = np.asarray(ds["lon"].values, dtype=np.float64)
        if lat[0] > lat[-1]:
            raise SystemExit(f"{age} Ma: expected ascending latitude -- source grid changed")

        # --- land/ocean validity mask, from topo's own raw footprint,
        # BEFORE fill_nan touches anything -- see the module docstring.
        topo_raw = load_var(ds, "topo", ("lat", "lon"))
        land = (~np.isnan(topo_raw)).astype(np.float32)[np.newaxis, :, :]
        land, lon_m = normalise_longitude(land, lon)
        land, lon_m = drop_duplicate_seam(land, lon_m)
        land, lon_m, lat_m = resample_horizontal(land, lon_m, lat, args.nlon, args.nlat)
        mask_frames.append(np.clip(land[0], 0.0, 1.0))

        # --- koppen: precomputed, nearest-neighbour resample (see module
        # docstring), Ocean(NaN) -> class 0 BEFORE resampling so nearest-
        # neighbour picks between real discrete codes only.
        koppen_raw = load_var(ds, "koppen", ("lat", "lon"))
        koppen_raw = np.where(np.isnan(koppen_raw), 0.0, koppen_raw)[np.newaxis, :, :]
        koppen_n, lon_k = normalise_longitude(koppen_raw, lon)
        koppen_n, lon_k = drop_duplicate_seam(koppen_n, lon_k)
        koppen_n, lon_k, lat_k = resample_horizontal(
            koppen_n, lon_k, lat, args.nlon, args.nlat, kind="nearest",
        )
        koppen_frames.append(np.rint(koppen_n[0]))

        # --- every real climate variable.
        for spec in VARIABLES:
            dims = ("time", "lat", "lon") if spec.monthly else ("lat", "lon")
            raw = load_var(ds, spec.source_var, dims)
            if not spec.monthly:
                raw = raw[np.newaxis, :, :]
            data, lat2, n_filled = condition(raw, lon, lat, args.nlon, args.nlat)
            total_filled += n_filled
            lat_out = lat2
            per_var[spec.var_id].append(data)

        ds.close()

    print(f"fill_nan replaced {total_filled} scattered NaN cells across all variables/ages "
          f"(coastal cells near the land/ocean boundary -- discarded anyway via the "
          f"validity mask, see condition())")

    # --- Pass 2: per variable, add the Annual layer, choose one clip/colormap
    # for the WHOLE series, encode, write.
    variables_meta = []

    for spec in VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, "
              f"{'monthly' if spec.monthly else 'static -> broadcast to every layer'})")
        vol = np.stack([add_annual_layer(a, spec.monthly) for a in per_var[spec.var_id]])
        if not spec.monthly:
            vol = np.repeat(vol[:, :1], N_LAYERS, axis=1)  # broadcast the one static layer
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
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(clip_lo, 4),
            "default_clip_max": round(clip_hi, 4),
            "default_colormap": colormap,
        })

    # --- landmask: broadcast to every layer (no month axis), fixed [0,1] encode.
    print(f"\n=== {MASK_VAR_ID}  (land=1/ocean=0, static -> broadcast to every layer)")
    mask_vol = np.repeat(np.stack(mask_frames)[:, np.newaxis, :, :], N_LAYERS, axis=1)
    encoded = encode_uint8(mask_vol, 0.0, 1.0)
    total_mb = write_frames(model_dir, args.resolution_id, MASK_VAR_ID, encoded, frame_meta)
    print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")
    variables_meta.append({
        "id": MASK_VAR_ID,
        "name": "Land mask",
        "source_var": "topo",
        "units": "fraction",
        "diverging": False,
        "mask_only": True,
        "encode_min": 0.0, "encode_max": 1.0,
        "value_min": 0.0, "value_max": 1.0,
        "default_clip_min": 0.0, "default_clip_max": 1.0,
        "default_colormap": "gray",
    })

    # --- koppen: same band-centre-encoding trick prep_climate.py uses
    # (encode_uint8 truncates; the shader's uSteps decode floors -- landing
    # exactly on an integer class would round-trip to the class BELOW it
    # for every class but 0, see prep_climate.py's own comment on this).
    print(f"\n=== KOPPEN  (precomputed, static -> broadcast to every layer)")
    koppen_vol = np.repeat(
        (np.stack(koppen_frames) + 0.5)[:, np.newaxis, :, :], N_LAYERS, axis=1,
    ).astype(np.float32)
    encoded = encode_uint8(koppen_vol, 0.0, float(N_KOPPEN_CLASSES))
    total_mb = write_frames(model_dir, args.resolution_id, "KOPPEN", encoded, frame_meta)
    print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")
    variables_meta.append({
        "id": "KOPPEN",
        "name": "Koppen climate classification",
        "source_var": "koppen",
        "units": "class",
        "diverging": False,
        "categorical": True,
        "class_names": KOPPEN_CLASS_NAMES,
        "encode_min": 0.0, "encode_max": float(N_KOPPEN_CLASSES),
        "value_min": 0.0, "value_max": float(N_KOPPEN_CLASSES - 1),
        "default_clip_min": 0.0, "default_clip_max": float(N_KOPPEN_CLASSES),
        "default_colormap": "koppen",
    })

    if args.validate:
        age0_idx = int(np.argmin(np.abs(np.asarray([f["age_ma"] for f in frame_meta]))))
        koppen_age0 = koppen_frames[age0_idx].astype(np.int64)  # pre-encode, exact class ints

        def class_at(lon_q, lat_q):
            lon_grid = np.linspace(-180, 180, args.nlon, endpoint=False)
            j = int(np.argmin(np.abs(lon_grid - lon_q)))
            i = int(np.argmin(np.abs(lat_out - lat_q)))
            return KOPPEN_CLASS_NAMES[koppen_age0[i, j]]

        checks = [
            ("central Sahara", 10.0, 23.0, "Desert (BW)"),
            ("Congo basin", 22.0, 0.0, "Fully humid (Af)"),
            # NOT a mapping bug -- confirmed against Pohl et al. 2022 Table 3
            # directly, and against the raw native-grid data (bypassing every
            # step of this script) -- FOAM's slab-ocean setup genuinely
            # under-heats western Europe at this coarse resolution. Kept as
            # "Tundra", the model's real answer, not the true observed
            # climate, so a future regression away from THIS value is still
            # worth catching. See the module docstring.
            ("central England", -1.0, 52.0, "Tundra (ET)"),
        ]
        print()
        for label, lon_q, lat_q, expected in checks:
            got = class_at(lon_q, lat_q)
            status = "ok" if got.startswith(expected.split(" (")[0].split(",")[0]) else "** MISMATCH"
            print(f"    validate    {label} (age 0) -> {got}  [expected {expected}]  {status}")

        expect = args.nlon * args.nlat * N_LAYERS
        for var_id in [*per_var, MASK_VAR_ID, "KOPPEN"]:
            first = np.fromfile(model_dir / "frames" / var_id / args.resolution_id
                                 / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(model_dir / "frames" / var_id / args.resolution_id
                                / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{var_id} {frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert last.size == expect, f"{var_id} {frame_meta[-1]['id']}.bin is {last.size}, want {expect}"
        print(f"    validate    every variable {expect} bytes/frame")

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
        # See core/types.ts's Manifest.mask_variable / material.ts's
        # uValidMask -- read generically by the viewer, not hardcoded to
        # this model's variable id.
        "mask_variable": MASK_VAR_ID,
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
