#!/usr/bin/env python3
"""Convert a time series of mantle convection output into the viewer format.

Written for the Muller et al. 2022 OPT1 optimised run, where one volume at one
age is 65 separate 2D .grd files and the whole series is another dimension on
top of that.  prep_model.py handles a model that lives in one file; this one
handles a model that lives in ~700.

Both age and depth come from the FILENAME:

    OPT1-temp-<AGE>Ma-<DEPTH>km_mean_removed_Dim.grd

Files are grouped by age and each group sorted by the parsed depth -- never by
directory order, which sorts 1040 before 0140 in some locales and would silently
shuffle the mantle.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<AGE>.bin

Example
-------
    python prep_convection.py \\
        --input /Users/simon/Data/zenodo/OPT1_temperature_anomaly_grids_dimensional \\
        --id opt1 --name "Muller 2022 OPT1" --age-max 200 --validate
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import xarray as xr

from prep_model import (
    DEFAULT_CLIP_PERCENTILE,
    DEFAULT_NDEPTH,
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_colormap,
    drop_duplicate_seam,
    encode_uint8,
    fill_nan,
    find_coord,
    lateral_roughness,
    normalise_longitude,
    resample_depth,
    resample_horizontal,
    LAT_NAMES,
    LON_NAMES,
)

DEFAULT_AGE_REGEX = r"-(\d+)Ma-"
DEFAULT_DEPTH_REGEX = r"-(\d+)km"

# A level is "constant" if its standard deviation is below this.  The isothermal
# boundary levels are exactly zero, so the threshold only has to be small.
CONSTANT_STD = 1e-6


def scan(path, age_rx, depth_rx, age_min, age_max):
    """Group the slice files by age, each group sorted by depth."""
    arx, drx = re.compile(age_rx), re.compile(depth_rx)
    groups = defaultdict(list)
    for f in path.iterdir():
        if f.suffix.lower() not in (".nc", ".grd"):
            continue
        a, d = arx.search(f.name), drx.search(f.name)
        if not (a and d):
            continue
        age = float(a.group(1))
        if age < age_min or age > age_max:
            continue
        groups[age].append((float(d.group(1)), f))

    if not groups:
        raise SystemExit(
            f"nothing in {path} matched age {age_rx!r} and depth {depth_rx!r}"
        )
    for age in groups:
        groups[age].sort()

    depths = {tuple(d for d, _ in v) for v in groups.values()}
    if len(depths) != 1:
        counts = sorted({len(d) for d in depths})
        raise SystemExit(
            f"ages do not share one depth axis (level counts {counts}) -- "
            "the series cannot be stacked into one texture grid"
        )
    return dict(sorted(groups.items())), np.array(sorted(depths.pop()))


def load_frame(files, varname=None):
    """Stack one age's depth slices into (depth, lat, lon)."""
    slices, lon, lat = [], None, None
    for _, f in files:
        ds = xr.open_dataset(f)
        name = varname or ("z" if "z" in ds else list(ds.data_vars)[0])
        lon_n = find_coord(ds, LON_NAMES)
        lat_n = find_coord(ds, LAT_NAMES)
        da = ds[name].transpose(lat_n, lon_n)
        this_lon = np.asarray(ds[lon_n].values, dtype=np.float64)
        this_lat = np.asarray(ds[lat_n].values, dtype=np.float64)
        if lon is None:
            lon, lat = this_lon, this_lat
        elif not (np.array_equal(lon, this_lon) and np.array_equal(lat, this_lat)):
            raise SystemExit(f"grid of {f.name} differs from the first slice")
        slices.append(np.asarray(da.values, dtype=np.float32))
        ds.close()
    return np.stack(slices, axis=0), lon, lat


def constant_levels(stds):
    """Indices of leading and trailing levels that carry no signal.

    Convection runs impose isothermal boundary conditions at the surface and the
    CMB, so after the horizontal mean is removed the top and bottom levels are
    identically zero.  They are not data; left in they render as a flat
    zero-valued shell over the whole globe at both ends of the mantle.

    prep_model.trim_bad_base() cannot catch these.  It tests lateral roughness
    and departure of the level mean from a deep-mantle baseline; a constant zero
    level has the LOWEST possible roughness and sits exactly on the baseline
    mean, so it passes both tests convincingly.  Hence a separate test, and one
    that looks for absence of signal rather than excess of it.

    Only contiguous runs at the two ends are considered -- a dead level in the
    middle would be a different problem and should not be silently swallowed.
    """
    n = len(stds)
    lo = 0
    while lo < n and stds[lo] <= CONSTANT_STD:
        lo += 1
    hi = n
    while hi > lo and stds[hi - 1] <= CONSTANT_STD:
        hi -= 1
    interior = [k for k in range(lo, hi) if stds[k] <= CONSTANT_STD]
    return lo, hi, interior


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--input", type=Path, default=None,
                    help="directory of temperature grids; if omitted, the Muller et al. "
                         "(2022) OPT1 grids are downloaded from Zenodo and cached")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--source", default="")
    ap.add_argument("--var-id", default="temp")
    ap.add_argument("--var-name", default="Temperature anomaly")
    ap.add_argument("--slice-var", default=None)
    ap.add_argument("--units", default="K")
    ap.add_argument("--high-means", default="hot", choices=["fast", "hot"],
                    help="what a HIGH value means physically; selects the "
                         "diverging ramp's orientation")
    ap.add_argument("--colormap", default="RdBu")
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=200.0)
    ap.add_argument("--age-regex", default=DEFAULT_AGE_REGEX)
    ap.add_argument("--depth-regex", default=DEFAULT_DEPTH_REGEX)
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--ndepth", type=int, default=DEFAULT_NDEPTH)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip", nargs=2, type=float, default=None)
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--default-clip", nargs=2, type=float, default=None)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    if args.input is None:
        from _inputs import fetch_opt1_grids
        args.input = fetch_opt1_grids()

    colormap = choose_colormap(args.colormap, args.high_means, args.out, True)

    groups, src_depth = scan(
        args.input, args.age_regex, args.depth_regex, args.age_min, args.age_max
    )
    ages = list(groups)
    print(f"{len(ages)} ages {ages[0]:.0f}-{ages[-1]:.0f} Ma, "
          f"{len(src_depth)} depth levels {src_depth.min():.0f}-{src_depth.max():.0f} km")
    print(f"colormap    {colormap}  (high = {args.high_means})")

    # ---- pass 1: load and put every frame on the target lon/lat grid --------
    # Horizontal resampling first keeps the whole series in memory at a few
    # hundred MB; the depth axis is left alone until the dead levels are gone,
    # so they cannot bleed into good levels through interpolation.
    frames = {}
    raw_min, raw_max = np.inf, -np.inf
    for age in ages:
        data, lon, lat = load_frame(groups[age], args.slice_var)
        if lat[0] > lat[-1]:
            lat, data = lat[::-1], data[:, ::-1, :]
        data, lon = normalise_longitude(data, lon)
        data, lon = drop_duplicate_seam(data, lon)
        raw_min = min(raw_min, float(np.nanmin(data)))
        raw_max = max(raw_max, float(np.nanmax(data)))
        data, _, _ = resample_horizontal(data, lon, lat, args.nlon, args.nlat)
        frames[age] = data
        print(f"  loaded      {age:6.0f} Ma  {data.shape}")

    # ---- dead levels, decided once for the whole series --------------------
    stds = np.array([
        [float(np.nanstd(frames[age][k])) for k in range(len(src_depth))]
        for age in ages
    ])
    # A level survives only if it carries signal at EVERY age; the depth axis has
    # to be identical across frames or they are not one volume series.
    lo, hi, interior = constant_levels(stds.max(axis=0))
    if interior:
        raise SystemExit(
            "constant level(s) in the middle of the mantle at "
            f"{[float(src_depth[k]) for k in interior]} km -- not a boundary "
            "condition, so refusing to guess"
        )
    if lo or hi < len(src_depth):
        dropped = list(src_depth[:lo]) + list(src_depth[hi:])
        print(f"  dropped     {len(dropped)} constant level(s): "
              + ", ".join(f"{d:.0f} km" for d in dropped)
              + "  (isothermal boundary, no signal)")
    depth = src_depth[lo:hi]
    for age in ages:
        frames[age] = frames[age][lo:hi]
    valid_min, valid_max = float(depth.min()), float(depth.max())

    # ---- encoding range, computed once across the WHOLE series -------------
    # A per-frame range would make the same colour mean a different temperature
    # at every age, which is the one thing a time series must not do.
    if args.clip:
        clip_lo, clip_hi = float(args.clip[0]), float(args.clip[1])
    else:
        pooled = np.concatenate([
            np.abs(frames[age].ravel()[::8]) for age in ages
        ])
        pooled = pooled[np.isfinite(pooled)]
        m = float(np.percentile(pooled, args.clip_percentile))
        clip_lo, clip_hi = -m, m
    print(f"  encoding    [{clip_lo:+.1f}, {clip_hi:+.1f}] {args.units} "
          f"(series-wide {args.clip_percentile}th percentile)")

    # ---- pass 2: depth-resample, encode, write -----------------------------
    model_dir = args.out / "models" / args.id
    frame_dir = model_dir / "frames" / args.var_id / args.resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)

    frame_meta, total_mb = [], 0.0
    dclip_samples = []
    for age in ages:
        data = frames.pop(age)
        data, nan_filled = fill_nan(data)
        data, _ = resample_depth(data, depth, args.ndepth, valid_min, valid_max)
        dclip_samples.append(np.abs(data.ravel()[::32]))
        vol = encode_uint8(data, clip_lo, clip_hi)

        fid = f"{int(round(age)):03d}"
        out_path = frame_dir / f"{fid}.bin"
        vol.tofile(out_path)
        mb = out_path.stat().st_size / 1024 / 1024
        total_mb += mb
        frame_meta.append({"id": fid, "age_ma": float(age)})
        extra = f"  ({nan_filled} NaN filled)" if nan_filled else ""
        print(f"  wrote       {fid}.bin  {vol.shape}  {mb:.1f} MB{extra}")

    if args.default_clip:
        dclip = [float(args.default_clip[0]), float(args.default_clip[1])]
    else:
        m = float(np.percentile(np.concatenate(dclip_samples), 95)) * 0.5
        dclip = [-m, m]

    manifest = {
        "id": args.id,
        "name": args.name,
        "type": "convection",
        "source": args.source,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": round(valid_min, 3),
        "depth_max_km": round(valid_max, 3),
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": args.ndepth,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": args.var_id,
        "variables": [{
            "id": args.var_id,
            "name": args.var_name,
            "source_var": args.slice_var or "z",
            "units": args.units,
            "diverging": True,
            "high_means": args.high_means,
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(dclip[0], 4),
            "default_clip_max": round(dclip[1], 4),
            "default_colormap": colormap,
        }],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}  "
          f"({len(frame_meta)} frames, {total_mb:.0f} MB, "
          f"{valid_min:.0f}-{valid_max:.0f} km)")

    if args.validate:
        expect = args.nlon * args.nlat * args.ndepth
        sizes = set()
        for fm in frame_meta:
            back = np.fromfile(frame_dir / f"{fm['id']}.bin", dtype=np.uint8)
            sizes.add(back.size)
            assert back.size == expect, f"{fm['id']}.bin is {back.size}, want {expect}"
        assert len(sizes) == 1, "frames differ in size"
        first = np.fromfile(frame_dir / f"{frame_meta[0]['id']}.bin",
                            dtype=np.uint8).reshape(args.ndepth, args.nlat, args.nlon)
        last = np.fromfile(frame_dir / f"{frame_meta[-1]['id']}.bin",
                           dtype=np.uint8).reshape(args.ndepth, args.nlat, args.nlon)
        r = [lateral_roughness(first[k].astype(np.float32))
             for k in (0, args.ndepth // 2, args.ndepth - 1)]
        print(f"  validate    {len(frame_meta)} frames all {expect} bytes")
        print(f"  roughness   top {r[0]:.2f}  mid {r[1]:.2f}  base {r[2]:.2f}")
        # Frames must differ: identical bytes would mean every age loaded the
        # same files, which the age regex getting no match would produce.
        assert not np.array_equal(first, last), \
            "first and last frames are byte-identical -- age grouping failed"
        diff = float(np.mean(np.abs(first.astype(np.int16) - last.astype(np.int16))))
        print(f"  frames      differ by {diff:.1f} codes mean |first - last|")


if __name__ == "__main__":
    main()
