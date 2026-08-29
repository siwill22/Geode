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

Both are written through the same manifest schema as a real model, so the
viewer cannot tell them apart from REVEAL.
"""

import argparse
import json
from pathlib import Path

import numpy as np

NLON, NLAT, NDEPTH = 360, 181, 192
DEPTH_MIN, DEPTH_MAX = 0.0, 2840.0


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


def write(name, display, vol, out_root, colormap="RdBu"):
    lo, hi = float(vol.min()), float(vol.max())
    m = max(abs(lo), abs(hi))
    enc = np.clip((vol + m) / (2 * m) * 255.0, 0, 255).astype(np.uint8)

    model_dir = out_root / "models" / name
    frame_dir = model_dir / "frames" / "v" / "std"
    frame_dir.mkdir(parents=True, exist_ok=True)
    enc.tofile(frame_dir / "000.bin")

    manifest = {
        "id": name, "name": display, "type": "tomography",
        "source": "synthetic fixture",
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": DEPTH_MIN, "depth_max_km": DEPTH_MAX,
        "dtype": "uint8",
        "default_resolution": "std",
        "resolutions": [{"id": "std", "nlon": NLON, "nlat": NLAT, "ndepth": NDEPTH}],
        "frames": [{"id": "000", "age_ma": 0}],
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "v",
        "variables": [{
            "id": "v", "name": "value", "source_var": "synthetic",
            "units": "%", "diverging": True,
            "encode_min": -m, "encode_max": m,
            "value_min": lo, "value_max": hi,
            "default_clip_min": -m, "default_clip_max": m,
            "default_colormap": colormap,
        }],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    mb = (frame_dir / "000.bin").stat().st_size / 1024 / 1024
    print(f"  {name:14s} {enc.shape}  {mb:.1f} MB  range [{lo:+.2f}, {hi:+.2f}]")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    args = ap.parse_args()
    write("fixture-check", "Fixture: checkerboard", checkerboard(), args.out)
    write("fixture-ramp", "Fixture: depth ramp", ramp(), args.out)
    print("\nExpected on a cutaway wall:")
    print("  checkerboard  30 deg cells; sign inverts crossing 660 and 1800 km")
    print("  ramp          smooth top-to-bottom gradient, no lon/lat variation;")
    print("                extremes exactly at 0 and 2840 km")


if __name__ == "__main__":
    main()
