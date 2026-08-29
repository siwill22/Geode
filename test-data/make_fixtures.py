#!/usr/bin/env python3
"""Synthetic volumes whose correct rendering is unambiguous by eye.

Real tomography hides axis-order errors, latitude flips and depth inversion --
a wrong render still looks like plausible mantle.  These do not.

  checkerboard  spherical-harmonic checkerboard whose sign flips at 660 km and
                1800 km.  Catches axis order, latitude flip, longitude flip and
                depth inversion.

  ramp          a pure function of depth.  Isolates the depth axis, including
                the half-texel offsets: the ramp's extreme values must land
                exactly at depth_min_km and depth_max_km, not half a level in.

  drift         a blob that moves east with age, over the same 11 frames as the
                convection model.  Isolates the TIME axis, which nothing else
                here tests: a real convection series looks entirely plausible
                with its frames off by one, or in the wrong order altogether.
                At 0 Ma the blob sits on the prime meridian; at 200 Ma it is
                100 deg east.  If it starts east and moves west, age and frame
                index are inverted.

All are written through the same manifest schema as a real model, so the viewer
cannot tell them apart from REVEAL or OPT1.
"""

import argparse
import json
from pathlib import Path

import numpy as np

NLON, NLAT, NDEPTH = 360, 181, 192
DEPTH_MIN, DEPTH_MAX = 0.0, 2840.0

# Match the convection series so the two can be compared frame for frame.
DRIFT_AGES = list(range(0, 201, 20))
DRIFT_RATE_DEG_PER_MYR = 0.5
DRIFT_DEPTH_KM = (500.0, 1500.0)


def grids():
    lon = np.linspace(-180.0, 180.0, NLON, endpoint=False)
    lat = np.linspace(-90.0, 90.0, NLAT)
    depth = np.linspace(DEPTH_MIN, DEPTH_MAX, NDEPTH)
    return lon, lat, depth


def checkerboard():
    """Sign flips every 30 deg of longitude, 30 deg of latitude, and at the
    660 and 1800 km discontinuities."""
    lon, lat, depth = grids()
    lo = np.sign(np.sin(np.radians(lon) * 6.0))       # 6 cycles -> 30 deg cells
    la = np.sign(np.sin(np.radians(lat) * 6.0))
    de = np.where(depth < 660.0, 1.0, np.where(depth < 1800.0, -1.0, 1.0))
    vol = de[:, None, None] * la[None, :, None] * lo[None, None, :]
    return vol.astype(np.float32) * 2.0  # +-2 %


def ramp():
    """Linear in depth only: -1 at the top of the volume, +1 at the bottom."""
    _, _, depth = grids()
    t = (depth - DEPTH_MIN) / (DEPTH_MAX - DEPTH_MIN) * 2.0 - 1.0
    return np.repeat(np.repeat(t[:, None, None], NLAT, 1), NLON, 2).astype(np.float32)


def drift(age_ma):
    """A Gaussian blob on the equator, `age * rate` degrees east of Greenwich."""
    lon, lat, depth = grids()
    centre = age_ma * DRIFT_RATE_DEG_PER_MYR

    # Angular distance from the blob centre, on the sphere -- not sqrt(dlon^2 +
    # dlat^2), which would smear the blob into a band near the poles.
    dlon = np.radians(((lon - centre + 180.0) % 360.0) - 180.0)
    la = np.radians(lat)
    cosd = np.cos(la)[:, None] * np.cos(dlon)[None, :]
    ang = np.degrees(np.arccos(np.clip(cosd, -1.0, 1.0)))
    horiz = np.exp(-(ang / 20.0) ** 2)

    d0, d1 = DRIFT_DEPTH_KM
    mid, half = (d0 + d1) / 2, (d1 - d0) / 2
    vert = np.exp(-((depth - mid) / half) ** 2)

    return (2.0 * vert[:, None, None] * horiz[None, :, :]).astype(np.float32)


def write(name, display, frames, out_root, colormap="RdBu", high_means="fast",
          units="%"):
    """`frames` is a list of (age_ma, volume). Encoding range spans them all."""
    m = max(max(abs(float(v.min())), abs(float(v.max()))) for _, v in frames)
    lo = min(float(v.min()) for _, v in frames)
    hi = max(float(v.max()) for _, v in frames)

    model_dir = out_root / "models" / name
    frame_dir = model_dir / "frames" / "v" / "std"
    frame_dir.mkdir(parents=True, exist_ok=True)

    meta = []
    for age, vol in frames:
        enc = np.clip((vol + m) / (2 * m) * 255.0, 0, 255).astype(np.uint8)
        fid = f"{int(round(age)):03d}"
        enc.tofile(frame_dir / f"{fid}.bin")
        meta.append({"id": fid, "age_ma": float(age)})

    manifest = {
        "id": name, "name": display, "type": "tomography",
        "source": "synthetic fixture",
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": DEPTH_MIN, "depth_max_km": DEPTH_MAX,
        "dtype": "uint8",
        "default_resolution": "std",
        "resolutions": [{"id": "std", "nlon": NLON, "nlat": NLAT, "ndepth": NDEPTH}],
        "frames": meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "v",
        "variables": [{
            "id": "v", "name": "value", "source_var": "synthetic",
            "units": units, "diverging": True, "high_means": high_means,
            "encode_min": -m, "encode_max": m,
            "value_min": lo, "value_max": hi,
            "default_clip_min": -m, "default_clip_max": m,
            "default_colormap": colormap,
        }],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    total = sum((frame_dir / f"{f['id']}.bin").stat().st_size for f in meta)
    print(f"  {name:14s} {len(meta):3d} frame(s)  {total / 1024 / 1024:.1f} MB  "
          f"range [{lo:+.2f}, {hi:+.2f}]")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    args = ap.parse_args()

    write("fixture-check", "Fixture: checkerboard",
          [(0, checkerboard())], args.out)
    write("fixture-ramp", "Fixture: depth ramp",
          [(0, ramp())], args.out)
    write("fixture-drift", "Fixture: drifting blob",
          [(a, drift(a)) for a in DRIFT_AGES], args.out,
          colormap="RdBu_hot", high_means="hot", units="K")

    print("\nExpected on a cutaway wall:")
    print("  checkerboard  30 deg cells; sign inverts crossing 660 and 1800 km")
    print("  ramp          smooth top-to-bottom gradient, no lon/lat variation;")
    print("                extremes exactly at 0 and 2840 km")
    print("  drift         one warm blob at 500-1500 km, on the equator, at")
    print(f"                lon = age x {DRIFT_RATE_DEG_PER_MYR}: 0 deg at 0 Ma, "
          f"{DRIFT_AGES[-1] * DRIFT_RATE_DEG_PER_MYR:.0f} deg E at "
          f"{DRIFT_AGES[-1]} Ma.")
    print("                Moving west with increasing age means the frame")
    print("                order is inverted.")


if __name__ == "__main__":
    main()
