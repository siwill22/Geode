#!/usr/bin/env python3
"""Convert the Li et al. 2022 paleoclimate simulation set into the viewer format.

Phase 2: real monthly resolution, four variables. The volume's third axis is
month (ndepth=12, depth_min_km=0, depth_max_km=11) rather than the Phase 1
placeholder (ndepth=1) -- the same generic "layer axis" the manifest format
always supported, just finally carrying real data. DepthSlice.setDepthKm(0..11)
now selects a calendar month instead of landing on the single Phase 1 layer.

Source: 55 CESM1.2.2 snapshot simulations, one every 10 Myr from 0-540 Ma.
T, P, SALB, U, V carry real (month, lat, lon) resolution; LANDFRAC is
(lat, lon) only -- CESM does not simulate a seasonal land/ocean mask -- and
is broadcast to 12 identical month layers so every variable in this manifest
shares one grid shape (see the Phase 2 plan for why: a per-variable ndepth
would need core/volume.ts to stop reading grid shape from
manifest.default_resolution, a real change to shared engine code, to save
~40 MB raw against a site nowhere near its 1 GB Pages cap).

Phase 3 adds U/V (1000 hPa zonal/meridional wind): they ride the same
percentile-clip / uint8-encode pipeline as every other variable here, marked
`vector_only` so the viewer's variable picker skips them -- they back
core/windGlyphs.ts's arrow field, not a colour-mapped display of their own.
See `vector_fields` in the manifest below for how the U/V pairing is
declared as data.

Longitude arrives as 0..358.75 (0-360 convention) and must be normalised to
the -180..180 grid the viewer's shaders assume -- get this wrong and every
field is offset from the coastline overlay by a fixed longitude shift that
looks entirely plausible until you check a landmark.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<age_ma:03d>.bin

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python prep_climate.py \\
        --input "/Users/simon/Library/CloudStorage/OneDrive-UniversityofTasmania/Work/Climate/High_Resolution_Climate_Simulation_Dataset_540_Myr.nc" \\
        --id climate-540myr --name "Li et al. 2022 Paleoclimate" --validate
"""

import argparse
import json
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
    lateral_roughness,
    normalise_longitude,
    resample_horizontal,
)

N_MONTHS = 12
# The month axis spans the WHOLE grid.z range 0..N_MONTHS-1: see volumeUVW()
# in viewer/src/core/glsl/geographic.ts, which maps depth_min_km/depth_max_km
# onto texel centres via (p*(grid.z-1)+0.5)/grid.z. depth_min=0, depth_max=11
# with ndepth=12 lands month index m exactly on its own texel, for any m.
LAYER_MIN_KM = 0.0
LAYER_MAX_KM = float(N_MONTHS - 1)

DEFAULT_CLIP_PERCENTILE = 99.5


@dataclass
class VarSpec:
    source_var: str
    var_id: str
    display_name: str
    monthly: bool
    units: str
    diverging: bool
    high_means: str | None = None
    fixed_range: tuple[float, float] | None = None  # None => percentile clip
    colormap: str = "viridis"
    # True for a variable that only backs a render layer (here: the wind
    # glyph field) rather than being offered as a primary display choice --
    # same idea as prep_paleogeography.py's overlay_only, see VariableInfo
    # in core/types.ts. colormap is irrelevant for these (never colour-mapped)
    # so it's left at an arbitrary valid value rather than adding a branch
    # that skips choose_colormap for them.
    vector_only: bool = False


VARIABLES = [
    VarSpec("T", "T", "Surface temperature", True, "°C",
            diverging=True, high_means="hot", fixed_range=(-70.0, 65.0), colormap="RdBu"),
    VarSpec("P", "P", "Precipitation", True, "mm/month",
            diverging=False, fixed_range=None, colormap="viridis"),
    VarSpec("SALB", "SALB", "Surface albedo", True, "fraction",
            diverging=False, fixed_range=(0.0, 1.0), colormap="magma"),
    VarSpec("LANDFRAC", "LANDFRAC", "Land fraction", False, "fraction",
            diverging=False, fixed_range=(0.0, 1.0), colormap="cividis"),
    VarSpec("U", "U", "Zonal wind (1000 hPa)", True, "m/s",
            diverging=False, fixed_range=None, colormap="gray", vector_only=True),
    VarSpec("V", "V", "Meridional wind (1000 hPa)", True, "m/s",
            diverging=False, fixed_range=None, colormap="gray", vector_only=True),
]


def load_and_condition(ds, spec: VarSpec, nlon: int, nlat: int):
    """Return (vol[age, month, nlat, nlon] float32, lon2, lat2, raw_min, raw_max).

    normalise_longitude/drop_duplicate_seam/resample_horizontal only touch the
    trailing (lat, lon) axes, so a monthly variable's (age, month) leading axes
    are flattened into one axis before calling them and restored after -- this
    runs all 55*12 = 660 slices through the identical resampling path in one
    call, guaranteeing every age and month lands on the same target grid.
    """
    da = ds[spec.source_var]
    lat = np.asarray(ds["lat"].values, dtype=np.float64)
    lon = np.asarray(ds["lon"].values, dtype=np.float64)
    if lat[0] > lat[-1]:
        raise SystemExit("expected ascending latitude -- source grid changed")

    n_age = da.sizes["simulation"]
    if spec.monthly:
        flat = da.values.astype(np.float32).reshape(n_age * N_MONTHS, *da.shape[-2:])
    else:
        flat = da.values.astype(np.float32)  # (age, lat, lon)

    raw_min = float(np.nanmin(flat))
    raw_max = float(np.nanmax(flat))

    flat, lon2 = normalise_longitude(flat, lon)
    flat, lon2 = drop_duplicate_seam(flat, lon2)
    # len(lon2) == nlon would false-positive on resample_horizontal's count-only
    # fast path if the native grid happened to match -- it doesn't here (288x192
    # native vs 360x181 target), so the real interpolation branch always runs.
    flat, lon2, lat2 = resample_horizontal(flat, lon2, lat, nlon, nlat)

    if spec.monthly:
        vol = flat.reshape(n_age, N_MONTHS, nlat, nlon)
    else:
        # No month axis in the source -- broadcast each age's single field to
        # all 12 month layers so this variable shares the manifest's one grid
        # shape with the monthly variables (see module docstring).
        vol = np.repeat(flat[:, np.newaxis, :, :], N_MONTHS, axis=1)

    return vol, lon2, lat2, raw_min, raw_max


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--id", default="climate-540myr")
    ap.add_argument("--name", default="Li et al. 2022 Paleoclimate")
    ap.add_argument("--source", default=None,
                     help="citation; defaults to the file's own 'reference' attribute")
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    ds = xr.open_dataset(args.input)
    missing = [v.source_var for v in VARIABLES if v.source_var not in ds]
    if missing:
        raise SystemExit(f"variables {missing} not in {args.input.name}: {list(ds.data_vars)}")

    sim = np.asarray(ds["simulation"].values, dtype=np.int64)
    # simulation's own coordinate metadata: 'From 540 Ma to the
    # pre-industrial with a 10-million-year interval' -- index 0 is the
    # OLDEST simulation, not the present, the reverse of the obvious
    # reading. age_ma = sim*10 (Phase 1 and Phase 2's original assumption)
    # silently swapped every age around the midpoint of the series -- caught
    # visually via land fraction, which has an unmistakable shape signature
    # present-day continents have that no other variable does.
    age_ma = (float(sim.max()) - sim.astype(np.float64)) * 10.0
    source = args.source or ds.attrs.get("reference", "")
    print(f"ages        {len(sim)}  {age_ma.min():.0f}-{age_ma.max():.0f} Ma "
          f"(sim {sim.min()}={age_ma.max():.0f} Ma .. sim {sim.max()}={age_ma.min():.0f} Ma)")

    model_dir = args.out / "models" / args.id
    frame_meta = [{"id": f"{int(round(a)):03d}", "age_ma": float(a)} for a in age_ma]
    variables_meta = []

    for spec in VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, "
              f"{'monthly' if spec.monthly else 'static -> broadcast to 12 layers'})")
        vol, lon2, lat2, raw_min, raw_max = load_and_condition(
            ds, spec, args.nlon, args.nlat
        )
        print(f"    range       {raw_min:+.4g} to {raw_max:+.4g} {spec.units}")

        if spec.fixed_range is not None:
            clip_lo, clip_hi = spec.fixed_range
            if raw_min < clip_lo or raw_max > clip_hi:
                print(f"    ** warning: data range exceeds encode range "
                      f"[{clip_lo:+.4g}, {clip_hi:+.4g}] -- will clip")
        else:
            clip_lo, clip_hi = choose_clip(
                vol, spec.diverging, args.clip_percentile, None
            )
            print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] "
                  f"({args.clip_percentile} percentile)")

        colormap = choose_colormap(spec.colormap, spec.high_means, args.out, spec.diverging)
        if spec.diverging:
            print(f"    colormap    {colormap}  (high = {spec.high_means})")
        else:
            print(f"    colormap    {colormap}")

        encoded = encode_uint8(vol, clip_lo, clip_hi)  # (age, month, nlat, nlon)

        frame_dir = model_dir / "frames" / spec.var_id / args.resolution_id
        frame_dir.mkdir(parents=True, exist_ok=True)
        total_mb = 0.0
        for i, fm in enumerate(frame_meta):
            out_path = frame_dir / f"{fm['id']}.bin"
            encoded[i].tofile(out_path)  # (month, nlat, nlon): depth-major, matches Data3DTexture
            total_mb += out_path.stat().st_size / 1024 / 1024
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
            expect = args.nlon * args.nlat * N_MONTHS
            first = np.fromfile(frame_dir / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(frame_dir / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert last.size == expect, f"{frame_meta[-1]['id']}.bin is {last.size}, want {expect}"
            assert not np.array_equal(first, last), \
                "first and last age frames are byte-identical -- age grouping failed"
            first3 = first.reshape(N_MONTHS, args.nlat, args.nlon)
            if spec.monthly:
                assert not np.array_equal(first3[0], first3[6]), \
                    "month 0 and month 6 are byte-identical -- month axis collapsed to one layer"
            phys = first3[0].astype(np.float32) / 255.0 * (clip_hi - clip_lo) + clip_lo
            r0 = lateral_roughness(first3[0].astype(np.float32))
            print(f"    validate    {expect} bytes/frame, decoded month-0 range "
                  f"[{phys.min():+.4g}, {phys.max():+.4g}] {spec.units}  roughness {r0:.3f}")

    ds.close()

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
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": N_MONTHS,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "T",
        "variables": variables_meta,
        # Declares the U/V pairing as data rather than a viewer-side
        # assumption -- see core/types.ts's Manifest.vector_fields and
        # windGlyphs.ts, which read this generically.
        "vector_fields": [
            {"id": "wind", "name": "Wind (1000 hPa)",
             "u_variable": "U", "v_variable": "V", "units": "m/s"},
        ],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
