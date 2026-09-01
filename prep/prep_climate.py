#!/usr/bin/env python3
"""Convert the Li et al. 2022 paleoclimate simulation set into the viewer format.

Phase 1: annual-mean surface temperature only, one uint8 layer per age (no
depth axis -- the volume's third dimension is left at ndepth=1 rather than
hardcoded away, so a future climate model with real ocean-depth layers can
reuse this same manifest shape).

Source: 55 CESM1.2.2 snapshot simulations, one every 10 Myr from 0-540 Ma,
each with 12 monthly fields on a 192x288 lat/lon grid. Longitude arrives as
0..358.75 (0-360 convention) and must be normalised to the -180..180 grid the
viewer's shaders assume -- get this wrong and every field is offset from the
coastline overlay by a fixed longitude shift that looks entirely plausible
until you check a landmark.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/T/<resolution>/<age_ma:03d>.bin

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python prep_climate.py \\
        --input "/Users/simon/Library/CloudStorage/OneDrive-UniversityofTasmania/Work/Climate/High_Resolution_Climate_Simulation_Dataset_540_Myr.nc" \\
        --id climate-540myr --name "Li et al. 2022 Paleoclimate" --validate
"""

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr

from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_colormap,
    drop_duplicate_seam,
    encode_uint8,
    lateral_roughness,
    normalise_longitude,
    resample_horizontal,
)

DEFAULT_ENCODE_MIN = -60.0
DEFAULT_ENCODE_MAX = 50.0
# Placeholder range for the (currently unused) depth/layer axis. Must NOT be
# 0.0-0.0: the shader's volumeUVW() divides by (depthMax - depthMin), and a
# degenerate range divides by zero -- see viewer/src/glsl/geographic.ts. The
# single layer always samples at depthKm=0, which clamps into [0, 1] fine.
LAYER_MIN_KM = 0.0
LAYER_MAX_KM = 1.0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--id", default="climate-540myr")
    ap.add_argument("--name", default="Li et al. 2022 Paleoclimate")
    ap.add_argument("--source", default=None,
                     help="citation; defaults to the file's own 'reference' attribute")
    ap.add_argument("--var-id", default="T")
    ap.add_argument("--var-name", default="Surface temperature (annual mean)")
    ap.add_argument("--units", default="°C")
    ap.add_argument("--colormap", default="RdBu")
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--encode-range", nargs=2, type=float,
                     default=[DEFAULT_ENCODE_MIN, DEFAULT_ENCODE_MAX],
                     help="fixed uint8 encoding range -- T is an absolute "
                          "physical field, not an anomaly, so this is a "
                          "round-number bound rather than a percentile clip")
    ap.add_argument("--default-clip", nargs=2, type=float, default=None)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    colormap = choose_colormap(args.colormap, "hot", args.out, True)
    print(f"colormap    {colormap}  (high = hot)")

    ds = xr.open_dataset(args.input)
    if "T" not in ds:
        raise SystemExit(f"variable 'T' not in {args.input.name}: {list(ds.data_vars)}")

    lat = np.asarray(ds["lat"].values, dtype=np.float64)
    lon = np.asarray(ds["lon"].values, dtype=np.float64)
    sim = np.asarray(ds["simulation"].values, dtype=np.int64)
    source = args.source or ds.attrs.get("reference", "")
    if lat[0] > lat[-1]:
        raise SystemExit("expected ascending latitude -- source grid changed")

    # Annual mean over the 12 synthetic months, equal-weighted (no month-length
    # weighting field exists in this source). One "level" per simulation here
    # stands in for the volume's depth/layer axis -- normalise_longitude(),
    # drop_duplicate_seam() and resample_horizontal() only touch the lat/lon
    # axes, so running all 55 ages through them at once is both correct and
    # guarantees they land on an identical target grid.
    annual = ds["T"].mean(dim="month").values.astype(np.float32)
    ds.close()
    age_ma = (sim * 10).astype(np.float64)
    print(f"loaded      T  {annual.shape}  {len(sim)} ages "
          f"{age_ma.min():.0f}-{age_ma.max():.0f} Ma")

    data, lon2 = normalise_longitude(annual, lon)
    data, lon2 = drop_duplicate_seam(data, lon2)

    raw_min = float(np.nanmin(data))
    raw_max = float(np.nanmax(data))
    print(f"range       {raw_min:+.2f} to {raw_max:+.2f} {args.units}")

    # len(lon2) == args.nlon would false-positive on resample_horizontal's
    # count-only fast path if the native grid happened to match nlon/nlat --
    # it doesn't here (288x192 native vs 360x181 target), so the real
    # interpolation branch always runs and lands on the canonical
    # -180..178.75 grid the shader expects. Left unguarded deliberately: if a
    # future source ever DID arrive at 360x181 natively, it would only be
    # correct to skip resampling if it were already registered on that exact
    # grid, which is not something to assume silently.
    data, lon2, lat2 = resample_horizontal(data, lon2, lat, args.nlon, args.nlat)
    print(f"resampled   {data.shape}")

    clip_lo, clip_hi = float(args.encode_range[0]), float(args.encode_range[1])
    if raw_min < clip_lo or raw_max > clip_hi:
        print(f"  ** warning: data range [{raw_min:+.2f}, {raw_max:+.2f}] exceeds "
              f"encode range [{clip_lo:+.2f}, {clip_hi:+.2f}] -- will clip")
    vol = encode_uint8(data, clip_lo, clip_hi)

    model_dir = args.out / "models" / args.id
    frame_dir = model_dir / "frames" / args.var_id / args.resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)

    frame_meta = []
    total_mb = 0.0
    for i, age in enumerate(age_ma):
        layer = vol[i][np.newaxis, :, :]  # (1, nlat, nlon): ndepth=1
        fid = f"{int(round(age)):03d}"
        out_path = frame_dir / f"{fid}.bin"
        layer.tofile(out_path)
        mb = out_path.stat().st_size / 1024 / 1024
        total_mb += mb
        frame_meta.append({"id": fid, "age_ma": float(age)})
    print(f"wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")

    if args.default_clip:
        dclip = [float(args.default_clip[0]), float(args.default_clip[1])]
    else:
        dclip = [clip_lo, clip_hi]

    manifest = {
        "id": args.id,
        "name": args.name,
        "type": "climate",
        "source": source,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": LAYER_MIN_KM,
        "depth_max_km": LAYER_MAX_KM,
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": 1,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": args.var_id,
        "variables": [{
            "id": args.var_id,
            "name": args.var_name,
            "source_var": "T",
            "units": args.units,
            "diverging": True,
            "high_means": "hot",
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
    print(f"\nwrote {model_dir / 'manifest.json'}")

    if args.validate:
        expect = args.nlon * args.nlat * 1
        sizes = set()
        for fm in frame_meta:
            back = np.fromfile(frame_dir / f"{fm['id']}.bin", dtype=np.uint8)
            sizes.add(back.size)
            assert back.size == expect, f"{fm['id']}.bin is {back.size}, want {expect}"
        assert len(sizes) == 1, "frames differ in size"
        first = np.fromfile(frame_dir / f"{frame_meta[0]['id']}.bin",
                             dtype=np.uint8).reshape(args.nlat, args.nlon)
        last = np.fromfile(frame_dir / f"{frame_meta[-1]['id']}.bin",
                            dtype=np.uint8).reshape(args.nlat, args.nlon)
        assert not np.array_equal(first, last), \
            "first and last frames are byte-identical -- age grouping failed"
        diff = float(np.mean(np.abs(first.astype(np.int16) - last.astype(np.int16))))
        r0 = lateral_roughness(first.astype(np.float32))
        print(f"  validate    {len(frame_meta)} frames all {expect} bytes")
        print(f"  frames      differ by {diff:.1f} codes mean |first - last|"
              f"   roughness(frame0) {r0:.2f}")
        phys = first.astype(np.float32) / 255.0 * (clip_hi - clip_lo) + clip_lo
        print(f"  decoded     frame 0 range [{phys.min():+.2f}, {phys.max():+.2f}] {args.units}")


if __name__ == "__main__":
    main()
