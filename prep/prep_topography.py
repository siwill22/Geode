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

Default source is NOAA's ETOPO 2022 60 arc-second global relief (21600 x 10800),
downloaded on first use and cached. Any other equirectangular elevation grid works
via --input; the GEBCO One Minute Grid was the original source and is equivalent.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image
from scipy.interpolate import interp1d

# GMT's geo relief palette, vendored so that building this texture needs no GMT
# installation just to read a 1 kB text file. See prep/data/geo.cpt.README.
GEO_CPT = Path(__file__).parent / "data" / "geo.cpt"


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


def blueness(rgb):
    """Blue minus red.

    Used instead of a land/ocean classifier. Any fixed RGB threshold has to
    guess where `geo` stops looking like sea, and it guesses badly: the palette's
    shelf colours are pale enough that a blue-dominance test misses a seventh of
    the ocean and is no better than chance at the shoreline, which is precisely
    where the positional signal lives. Blue-minus-red instead varies smoothly
    from deep ocean through shelf to high ground, so it carries far more
    information and needs no threshold at all.
    """
    return rgb[..., 2].astype(np.float64) - rgb[..., 0].astype(np.float64)


def validate(out_path, z, lon_full, lat_full, width, height,
             cpt, sea_range, land_range):
    """Check the written image is georeferenced where the shader thinks it is.

    Independent of the resampling code: it samples the SAVED image exactly as
    the shader does, and correlates it against the SOURCE grid pushed through
    the SAME palette. Both sides therefore treat shelf colours identically, and
    correlation is scale-invariant, so the hillshade's brightness modulation
    does not bias it.

    The fit is done separately in each of six longitude bands, and likewise in
    latitude. Per band rather than globally is the point: a constant offset
    shows up as the same non-zero value in every band, whereas a SCALE error --
    the truncation bug this check was written for -- shows up as a systematic
    ramp across them, which a single global fit would average into something
    small and unremarkable.
    """
    img = np.asarray(Image.open(out_path).convert("RGB"))
    actual = blueness(img)

    # Sample away from the poles, where a stretch has little room to show.
    LON, LAT = np.meshgrid(np.linspace(-179.5, 179.5, 720),
                           np.linspace(-75.0, 75.0, 300))
    lon_f, lat_f = LON.ravel(), LAT.ravel()

    si = np.clip(np.round((lon_f - lon_full[0])
                          / (lon_full[-1] - lon_full[0]) * (len(lon_full) - 1)
                          ).astype(int), 0, len(lon_full) - 1)
    sj = np.clip(np.round((lat_f - lat_full[0])
                          / (lat_full[-1] - lat_full[0]) * (len(lat_full) - 1)
                          ).astype(int), 0, len(lat_full) - 1)
    expected = blueness(colourise(z[sj, si], cpt, sea_range, land_range))

    def score(dlon, dlat, sel):
        lo = (lon_f[sel] + dlon + 180.0) % 360.0
        la = np.clip(lat_f[sel] + dlat, -90.0, 90.0)
        i = np.clip((lo / 360.0 * width).astype(int), 0, width - 1)
        j = np.clip(((la + 90.0) / 180.0 * height).astype(int), 0, height - 1)
        a = actual[height - 1 - j, i]      # image row 0 is the north edge
        e = expected[sel]
        if a.std() < 1e-9 or e.std() < 1e-9:
            return 0.0
        return float(np.corrcoef(a, e)[0, 1])

    offsets = np.arange(-20.0, 20.01, 0.25)
    worst = 0.0
    print("  validate    best-fit offset per band (0.00 means correctly placed)")

    for axis, label in (("lon", "longitude"), ("lat", "latitude")):
        edges = (np.linspace(-180, 180, 7) if axis == "lon"
                 else np.linspace(-75, 75, 7))
        cells = []
        for a, b in zip(edges[:-1], edges[1:]):
            sel = ((lon_f >= a) & (lon_f < b) if axis == "lon"
                   else (lat_f >= a) & (lat_f < b))
            if sel.sum() < 200 or expected[sel].std() < 5.0:
                cells.append(f"{a:+4.0f}..{b:+4.0f}:  n/a ")
                continue
            scores = [score(d, 0, sel) if axis == "lon" else score(0, d, sel)
                      for d in offsets]
            best = offsets[int(np.argmax(scores))]
            worst = max(worst, abs(best))
            cells.append(f"{a:+4.0f}..{b:+4.0f}: {best:+5.2f}")
        print(f"                {label:9s} " + "  ".join(cells))

    allpts = np.ones(lon_f.shape, bool)
    print(f"                correlation with the source at zero offset: "
          f"{score(0.0, 0.0, allpts):.3f}  ({lon_f.size} points)")
    return worst


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=None,
                    help="elevation grid; if omitted, ETOPO 2022 60s is downloaded and cached")
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
    ap.add_argument("--source", default=None,
                    help="citation for the elevation grid, recorded in surface/source.json and "
                         "shown in the viewer's credit line. Defaults to ETOPO 2022 when that "
                         "is what was fetched; required in spirit with --input, where only the "
                         "file name is known otherwise")
    ap.add_argument("--no-validate", action="store_true")
    ap.add_argument("--max-offset-deg", type=float, default=0.75,
                    help="fail if any band's best-fit offset exceeds this")
    args = ap.parse_args()

    if args.input is None:
        from _inputs import fetch_etopo
        args.input = fetch_etopo()
        if args.source is None:
            args.source = "NOAA ETOPO 2022 60 arc-second global relief"
    if args.source is None:
        args.source = f"unrecorded (built from {args.input.name})"

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
    lon = lon_full[::sx]

    # Resample onto the texel centres the shader actually samples.
    #
    # Striding alone does not land on them: 21601 columns strided by 5 gives
    # 4321, not 4096. An earlier version TRUNCATED to the output size, which
    # silently kept only lon -180..+161.3 and lat -90..+80.7 and then let the
    # shader stretch that across the whole globe -- a 1.0547x scale error
    # anchored at the bottom-left corner of the image. It is not a constant
    # offset, so it grows with distance from lon -180 / lat -90: about 15 deg of
    # longitude at Sumatra and 5 deg of latitude at the equator. Every other
    # layer derives lon/lat from world position, so only the topography moved,
    # which is exactly how it was spotted.
    #
    # The shader reads uv = ((lon+180)/360, (lat+90)/180) with linear filtering,
    # so texel i is centred on lon = -180 + (i+0.5)*360/W, and likewise in lat.
    tlon = -180.0 + (np.arange(args.width) + 0.5) * 360.0 / args.width
    tlat = -90.0 + (np.arange(args.height) + 0.5) * 180.0 / args.height
    # Both target grids fall strictly inside the source's -180..180 / -90..90,
    # so the duplicated +180 column needs no special handling: it is simply an
    # interpolation endpoint that no target texel sits on.
    elev = interp1d(lon, elev, axis=1, kind="linear")(tlon)
    elev = interp1d(lat, elev, axis=0, kind="linear")(tlat).astype(np.float32)
    lat = tlat
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
    # Provenance travels with the data: build_archive_index.py collects every
    # <section>/source.json into archive.json's `sources`, and the viewer
    # credits only what the archive states for the layers that loaded.
    (args.out.parent / "source.json").write_text(json.dumps({"source": args.source}, indent=2))
    print(f"source      {args.source}")

    if not args.no_validate:
        worst = validate(args.out, z, lon_full, lat_full, args.width, args.height,
                         cpt, args.sea_range, args.land_range)
        if worst > args.max_offset_deg:
            raise SystemExit(
                f"\nFAIL: topography is misplaced by up to {worst:.2f} deg. "
                "An offset that VARIES across the bands is a scale error, not a "
                "shift -- check the resampling onto the texel-centre grid.")
        print(f"  validate    OK, worst band offset {worst:.2f} deg")


if __name__ == "__main__":
    main()
