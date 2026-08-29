#!/usr/bin/env python3
"""Build the surface topography texture from GEBCO.

Produces an equirectangular RGB image the surface sphere samples directly:
elevation coloured with GMT's `geo` relief map and multiplied by a hillshade.

`geo` is normalised over -1..1 with a HARD HINGE at 0, meaning its colour break
is pinned to sea level by construction. Elevations are mapped onto that: ocean
depths fill -1..0 and land fills 0..1, so the raster's shoreline always agrees
with the coastline vectors drawn over it.

The hillshade matters for more than looks. A flat-shaded sphere reads as a
disc; relief that catches a light gives the eye something to resolve curvature
from, which is the whole point of drawing a globe rather than a map.

Default source is the GEBCO One Minute Grid (21601 x 10801), decimated to the
output size.
"""

import argparse
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

GEBCO = Path("/Users/simon/Data/SedThickness/GEBCO1m/GridOne.nc")
GEO_CPT = Path(
    "/Users/simon/anaconda3/envs/pygmt17/share/gmt/cpt/gmt/geo.cpt"
)


def _parse_colour(tok):
    """A GMT colour token: 'r/g/b', a named colour, or a grey level."""
    if "/" in tok:
        return [float(v) for v in tok.split("/")]
    try:
        g = float(tok)
        return [g, g, g]
    except ValueError:
        from matplotlib.colors import to_rgb
        return [255.0 * c for c in to_rgb(tok)]


def read_gmt_cpt(path):
    """Control points from a GMT .cpt: returns (z, rgb) sorted by z.

    Unlike the 256-entry tables used for the velocity ramps, `geo` is a coarse
    set of control points and has to be interpolated between.
    """
    zs, cs = [], []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line[0] in "BFN":
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        z0, c0, z1, c1 = parts[0], parts[1], parts[2], parts[3]
        zs.append(float(z0)); cs.append(_parse_colour(c0))
        zs.append(float(z1)); cs.append(_parse_colour(c1))
    z = np.array(zs, dtype=np.float64)
    c = np.array(cs, dtype=np.float64)
    order = np.argsort(z, kind="stable")
    return z[order], c[order]


def lookup(z_ctrl, c_ctrl, z):
    """Piecewise-linear colour lookup, per channel."""
    out = np.empty(z.shape + (3,), dtype=np.float64)
    for ch in range(3):
        out[..., ch] = np.interp(z, z_ctrl, c_ctrl[:, ch])
    return out


def colourise(elev, cpt, sea_range, land_range):
    """Map elevation to colour with the palette's midpoint pinned to sea level.

    `geo` is hinged at 0, so ocean is scaled onto -1..0 and land onto 0..1.
    That pins the break to exactly 0 m rather than wherever the global min/max
    happens to put it -- otherwise continental shelves come out land coloured
    and the raster stops agreeing with the coastline vectors drawn over it.

    The ranges are deliberately NOT the data's own min/max. Normalising the
    ocean by the deepest trench (-10559 m in GEBCO) pushes the abyssal plains,
    which are most of the sea floor at around -4000 m, into the pale half of the
    ramp, and the whole ocean comes out washed-out lavender. Clipping to a
    representative depth instead puts typical sea floor in the dark blues where
    it belongs, at the cost of flattening the few deepest trenches.
    """
    z_ctrl, c_ctrl = cpt
    z = np.where(
        elev <= 0,
        -np.clip(-elev / sea_range, 0, 1),   # ocean onto -1..0
        np.clip(elev / land_range, 0, 1),    # land onto 0..1
    )
    return np.clip(lookup(z_ctrl, c_ctrl, z), 0, 255).astype(np.uint8)


def hillshade(elev, lat, azimuth_deg=315.0, altitude_deg=45.0, exaggeration=60.0):
    """Standard hillshade, with the longitude gradient corrected for latitude.

    Cell width in metres shrinks as cos(lat), so on an equirectangular grid the
    east-west gradient must be divided by cos(lat) or the relief flattens out
    toward the equator and blows up at the poles.
    """
    dy, dx = np.gradient(elev.astype(np.float64))
    coslat = np.clip(np.cos(np.radians(lat))[:, None], 0.05, 1.0)
    dx = dx / coslat

    dx *= exaggeration / 1000.0
    dy *= exaggeration / 1000.0

    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dy, dx)
    az = np.radians(360.0 - azimuth_deg + 90.0)
    alt = np.radians(altitude_deg)

    shade = (np.sin(alt) * np.cos(slope)
             + np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(shade, 0, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=GEBCO)
    ap.add_argument("--cpt", type=Path, default=GEO_CPT)
    ap.add_argument("--width", type=int, default=4096)
    ap.add_argument("--height", type=int, default=2048)
    ap.add_argument("--shade-strength", type=float, default=0.55)
    ap.add_argument("--sea-range", type=float, default=6000.0,
                    help="depth in m mapped to the darkest ocean colour")
    ap.add_argument("--land-range", type=float, default=4500.0,
                    help="elevation in m mapped to the highest land colour")
    ap.add_argument("--out", type=Path, default=Path("archive/surface/topography.jpg"))
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    print(f"reading {args.input.name}")
    ds = xr.open_dataset(args.input, decode_cf=False)

    if "xysize" in ds.dims:
        # Old flat GMT format (GEBCO GridOne): z is 1-D, x fastest, and rows run
        # NORTH to SOUTH. `dimension` gives (nx, ny).
        nx, ny = (int(v) for v in ds["dimension"].values)
        x0, x1 = (float(v) for v in ds["x_range"].values)
        y0, y1 = (float(v) for v in ds["y_range"].values)
        print(f"  flat GMT grid {nx} x {ny}, lon {x0}..{x1}, lat {y0}..{y1}")
        z = np.asarray(ds["z"].values, dtype=np.float32).reshape(ny, nx)
        z = z[::-1]  # to south-to-north
        lat_full = np.linspace(y0, y1, ny)
        lon_full = np.linspace(x0, x1, nx)
    else:
        var = [v for v in ds.data_vars][0]
        lat_name = "lat" if "lat" in ds.coords else (
            "latitude" if "latitude" in ds.coords else "y")
        lon_name = "lon" if "lon" in ds.coords else (
            "longitude" if "longitude" in ds.coords else "x")
        z = np.asarray(ds[var].values, dtype=np.float32)
        lat_full = np.asarray(ds[lat_name].values, dtype=np.float64)
        lon_full = np.asarray(ds[lon_name].values, dtype=np.float64)
        if lat_full[0] > lat_full[-1]:
            lat_full, z = lat_full[::-1], z[::-1]

    ny, nx = z.shape
    sy = max(1, ny // args.height)
    sx = max(1, nx // args.width)
    elev = z[::sy, ::sx]
    lat = lat_full[::sy]

    # Drop a duplicate +180 column: the texture wraps, so the first and last
    # columns must be one step apart rather than coincident.
    if abs((lon_full[-1] - lon_full[0]) - 360.0) < 1e-6:
        elev = elev[:, :-1]
    if elev.shape[1] > args.width:
        elev = elev[:, : args.width]
    if elev.shape[0] > args.height:
        elev = elev[: args.height]
        lat = lat[: args.height]
    print(f"  grid {elev.shape}  {elev.min():.0f} to {elev.max():.0f} m")

    cpt = read_gmt_cpt(args.cpt)
    rgb = colourise(elev, cpt, args.sea_range, args.land_range).astype(np.float32)

    shade = hillshade(elev, lat)[..., None]
    # Blend toward the shade rather than multiplying outright, so deep ocean
    # does not go black.
    rgb *= (1.0 - args.shade_strength) + args.shade_strength * shade
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)

    # Texture row 0 is latitude -90; images are top-down, so flip.
    img = Image.fromarray(rgb[::-1])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.suffix.lower() in (".jpg", ".jpeg"):
        img.save(args.out, quality=args.quality, optimize=True)
    else:
        img.save(args.out, optimize=True)

    mb = args.out.stat().st_size / 1024 / 1024
    print(f"wrote {args.out}  {img.size[0]}x{img.size[1]}  {mb:.2f} MB")


if __name__ == "__main__":
    main()
