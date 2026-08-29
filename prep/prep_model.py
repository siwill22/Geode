#!/usr/bin/env python3
"""Convert a 3D mantle model into the viewer's binary volume format.

Two input shapes are supported, detected from whether --input is a file or a
directory:

  3D netCDF      one file with a 3D variable plus latitude/longitude/depth
                 coordinates.  The variable's dimension order is read from the
                 file and transposed -- it is NOT assumed.  REVEAL is
                 (lat, lon, depth) while SEMUCB-WM1 is (depth, lat, lon), so
                 assuming either one silently transposes the other.

  slice dir      one 2D file per depth (GMT .grd / .nc), depth taken from the
                 filename via --depth-regex.

Output per model:

  archive/models/<id>/manifest.json
  archive/models/<id>/frames/<variable>/<resolution>/<frame>.bin

The binary is raw uint8, longitude fastest, then latitude, then depth --
the memory order three.js Data3DTexture expects for (width, height, depth).
Latitude ascends from -90.

Example
-------
    python prep_model.py \\
        --input /path/to/REVEAL_anomaly.nc \\
        --id reveal --name REVEAL \\
        --var vs_anomaly:vs:"Vs anomaly" \\
        --var vp_anomaly:vp:"Vp anomaly" \\
        --validate
"""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import xarray as xr

# ---------------------------------------------------------------------------
# Defaults.  See spec sections 3 and 3a for why these numbers.
# ---------------------------------------------------------------------------

DEFAULT_NLON = 360
DEFAULT_NLAT = 181
DEFAULT_NDEPTH = 192  # REVEAL's native lower-mantle spacing is 15 km
DEFAULT_DEPTH_MIN = 0.0
DEFAULT_DEPTH_MAX = 2890.0  # full mantle; basal junk is trimmed by roughness
DEFAULT_CLIP_PERCENTILE = 99.5
DEFAULT_MAX_NAN_FRACTION = 0.01
DEFAULT_ROUGHNESS_FACTOR = 2.0

# Names a coordinate might go by.  CitcomS .grd files call them x and y.
LON_NAMES = ["longitude", "lon", "x"]
LAT_NAMES = ["latitude", "lat", "y"]
DEPTH_NAMES = ["depth", "z", "radius"]


def find_coord(ds, candidates):
    for name in candidates:
        if name in ds.coords or name in ds.dims:
            return name
    return None


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_3d_netcdf(path, varname):
    """Load a 3D variable, returning (data[depth, lat, lon], lon, lat, depth)."""
    ds = xr.open_dataset(path)
    if varname not in ds:
        raise SystemExit(
            f"variable {varname!r} not in {path.name}. "
            f"available: {list(ds.data_vars)}"
        )
    da = ds[varname]

    lon_n = find_coord(ds, LON_NAMES)
    lat_n = find_coord(ds, LAT_NAMES)
    dep_n = find_coord(ds, DEPTH_NAMES)
    if not all([lon_n, lat_n, dep_n]):
        raise SystemExit(f"could not identify lon/lat/depth coords in {path.name}")

    # Transpose to canonical order rather than assuming the file's order.
    da = da.transpose(dep_n, lat_n, lon_n)

    lon = np.asarray(ds[lon_n].values, dtype=np.float64)
    lat = np.asarray(ds[lat_n].values, dtype=np.float64)
    depth = np.asarray(ds[dep_n].values, dtype=np.float64)
    data = np.asarray(da.values, dtype=np.float32)
    ds.close()
    return data, lon, lat, depth


def load_slice_dir(path, depth_regex, varname=None):
    """Load a directory of 2D depth slices into (data[depth, lat, lon], ...)."""
    rx = re.compile(depth_regex)
    found = []
    for f in sorted(path.iterdir()):
        if f.suffix.lower() not in (".nc", ".grd"):
            continue
        m = rx.search(f.name)
        if m:
            found.append((float(m.group(1)), f))
    if not found:
        raise SystemExit(f"no files in {path} matched {depth_regex!r}")
    found.sort()

    slices, lon, lat = [], None, None
    for depth_km, f in found:
        ds = xr.open_dataset(f)
        name = varname or ("z" if "z" in ds else list(ds.data_vars)[0])
        lon_n = find_coord(ds, LON_NAMES)
        lat_n = find_coord(ds, LAT_NAMES)
        da = ds[name].transpose(lat_n, lon_n)
        this_lon = np.asarray(ds[lon_n].values, dtype=np.float64)
        this_lat = np.asarray(ds[lat_n].values, dtype=np.float64)
        if lon is None:
            lon, lat = this_lon, this_lat
        elif not (
            np.array_equal(lon, this_lon) and np.array_equal(lat, this_lat)
        ):
            raise SystemExit(f"grid of {f.name} differs from the first slice")
        slices.append(np.asarray(da.values, dtype=np.float32))
        ds.close()

    depth = np.array([d for d, _ in found], dtype=np.float64)
    return np.stack(slices, axis=0), lon, lat, depth


# ---------------------------------------------------------------------------
# Conditioning
# ---------------------------------------------------------------------------


def normalise_longitude(data, lon):
    """Bring longitude onto -180..180 ascending, rolling the data with it."""
    lon = lon.copy()
    if lon.max() > 180.0 + 1e-6:
        lon = np.where(lon > 180.0, lon - 360.0, lon)
        order = np.argsort(lon)
        lon = lon[order]
        data = data[:, :, order]
    return data, lon


def drop_duplicate_seam(data, lon):
    """Drop a repeated +180 column.

    The volume texture wraps on S, which assumes column 0 and column nlon are
    one step apart rather than coincident.  REVEAL ships both -180 and +180.
    """
    if len(lon) > 1 and abs((lon[-1] - lon[0]) - 360.0) < 1e-6:
        return data[:, :, :-1], lon[:-1]
    return data, lon


def clip_depth_levels(data, depth, dmin, dmax, max_nan_fraction):
    """Drop out-of-range levels and levels that are mostly empty.

    This runs *before* depth resampling so that bad levels cannot bleed into
    good ones through interpolation.
    """
    keep, dropped = [], []
    for k in range(len(depth)):
        d = depth[k]
        if d < dmin or d > dmax:
            dropped.append((d, "out of range"))
            continue
        frac = float(np.isnan(data[k]).mean())
        if frac > max_nan_fraction:
            dropped.append((d, f"{100 * frac:.1f}% NaN"))
            continue
        keep.append(k)
    if not keep:
        raise SystemExit("every depth level was dropped -- check --depth-range")
    return data[keep], depth[keep], dropped


def lateral_roughness(level):
    """Mean absolute difference between adjacent latitude rows.

    A physical mantle field is laterally smooth at depth, so this is near
    constant with depth through the lower mantle. Numerical junk is not smooth,
    and shows up here long before it shows up in the level's mean or standard
    deviation.
    """
    return float(np.nanmean(np.abs(np.diff(level, axis=0))))


def trim_bad_base(data, depth, factor):
    """Drop a contiguous block of corrupt levels at the base of the model.

    REVEAL is the case this exists for, and it needs TWO tests because its
    contamination changes character with depth:

      2750-2855 km  the field goes spiky row to row while its MEAN still looks
                    like plausible mantle (+0.3%). Caught by lateral roughness.
      2870-2891 km  the field goes smooth again but the mean runs away to +20%.
                    Caught by the mean, and invisible to roughness.

    Clipping on the mean alone -- which an earlier version did, at 2850 km --
    removes the second block and leaves the first, so about 100 km of spiky
    junk survives and renders as latitude banding across the base of a cutaway.

    The baseline comes from the DEEP mantle, not the whole model: roughness
    legitimately rises toward the surface where crustal structure is genuinely
    sharp, so a whole-model baseline is inflated and catches nothing. Only a
    contiguous run at the bottom is trimmed, so real shallow detail is never
    at risk.
    """
    if len(depth) < 8 or factor <= 0:
        return data, depth, []

    rough = np.array([lateral_roughness(level) for level in data])
    means = np.array([float(np.nanmean(level)) for level in data])

    # Deep mantle, clear of both the crust and the contaminated base.
    deep = (depth > 1500.0) & (depth < 2500.0)
    if deep.sum() < 4:
        lo = depth.min() + 0.4 * np.ptp(depth)
        hi = depth.min() + 0.8 * np.ptp(depth)
        deep = (depth > lo) & (depth < hi)
    if deep.sum() < 4:
        return data, depth, []

    rough_limit = factor * float(np.median(rough[deep]))
    mean_base = float(np.median(means[deep]))
    # Scale the mean test by how much the field itself varies WITHIN a level,
    # not by how much the level means vary with depth. The mean genuinely
    # trends toward the CMB -- REVEAL's rises smoothly from 0 to +0.36% -- and
    # scaling by that trend flags perfectly good levels. Only a mean that runs
    # away relative to the actual signal amplitude is evidence of corruption.
    stds = np.array([float(np.nanstd(level)) for level in data])
    mean_limit = 5.0 * float(np.median(stds[deep]))

    cut = len(depth)
    dropped = []
    while cut > 1:
        k = cut - 1
        why = None
        if rough[k] > rough_limit:
            why = f"lateral roughness {rough[k]:.3f} > {rough_limit:.3f}"
        elif abs(means[k] - mean_base) > mean_limit:
            why = f"mean {means[k]:+.2f}% departs from {mean_base:+.2f}%"
        if why is None:
            break
        dropped.append((depth[k], why))
        cut -= 1

    return data[:cut], depth[:cut], list(reversed(dropped))


def fill_nan(data):
    """Fill residual scattered NaN by nearest-neighbour, per level.

    A reserved uint8 sentinel is not usable: the volume texture is linearly
    filtered, so a sentinel blends with its neighbours and paints a halo of
    fabricated values around every gap.  Validity is instead recorded as the
    model's depth range and handled geometrically in the shader.
    """
    from scipy import ndimage

    total = 0
    for k in range(data.shape[0]):
        m = np.isnan(data[k])
        if not m.any():
            continue
        total += int(m.sum())
        idx = ndimage.distance_transform_edt(
            m, return_distances=False, return_indices=True
        )
        data[k] = data[k][tuple(idx)]
    return data, total


def _interp_axis(y, x, xnew, axis):
    """Linear interpolation along one axis of an N-d array, vectorised."""
    from scipy.interpolate import interp1d

    f = interp1d(x, y, axis=axis, kind="linear",
                 bounds_error=False, fill_value=(
                     np.take(y, 0, axis=axis), np.take(y, -1, axis=axis)))
    return f(xnew).astype(np.float32)


def resample_depth(data, depth, ndepth, dmin, dmax):
    """Resample onto uniformly spaced depth levels.

    The shader assumes uniform spacing on the texture's third axis; no source
    model on disk has it (REVEAL's spacing runs from 0.01 to 15 km).
    """
    target = np.linspace(dmin, dmax, ndepth)
    return _interp_axis(data, depth, target, axis=0), target


def resample_horizontal(data, lon, lat, nlon, nlat):
    """Decimate/interpolate onto a regular nlon x nlat equirectangular grid."""
    # Target longitudes exclude the +180 duplicate (the texture wraps on S);
    # latitudes include both poles.
    tlon = np.linspace(-180.0, 180.0, nlon, endpoint=False)
    tlat = np.linspace(-90.0, 90.0, nlat)
    if len(lon) == nlon and len(lat) == nlat:
        return data, lon, lat

    if len(lat) != nlat:
        data = _interp_axis(data, lat, tlat, axis=1)
    if len(lon) != nlon:
        # Pad by one wrapped column so targets past the last source longitude
        # interpolate across the seam rather than clamping to it.
        lon_p = np.append(lon, lon[0] + 360.0)
        data_p = np.concatenate([data, data[:, :, :1]], axis=2)
        data = _interp_axis(data_p, lon_p, tlon, axis=2)
    return data, tlon, tlat


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def encode_uint8(data, clip_lo, clip_hi):
    scaled = (data - clip_lo) / (clip_hi - clip_lo)
    return np.clip(scaled * 255.0, 0, 255).astype(np.uint8)


def choose_clip(data, diverging, percentile, override):
    """Pick the uint8 encoding range.

    Default is a percentile, NOT the absolute maximum.  REVEAL's vs reaches
    +-35% in the crust while lower-mantle structure lives at +-2%; scaling to
    the absolute max quantises the whole lower mantle into a few codes and
    renders it flat.
    """
    if override is not None:
        return float(override[0]), float(override[1])
    finite = data[np.isfinite(data)]
    if diverging:
        m = float(np.percentile(np.abs(finite), percentile))
        return -m, m
    return float(np.percentile(finite, 100 - percentile)), float(
        np.percentile(finite, percentile)
    )


# ---------------------------------------------------------------------------


def parse_var_spec(spec):
    """--var source[:id[:display name]]"""
    parts = spec.split(":")
    source = parts[0]
    vid = parts[1] if len(parts) > 1 and parts[1] else source
    name = parts[2] if len(parts) > 2 and parts[2] else vid
    return source, vid, name


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--id", required=True, help="model id, e.g. reveal")
    ap.add_argument("--name", required=True, help="display name, e.g. REVEAL")
    ap.add_argument("--source", default="", help="citation")
    ap.add_argument("--type", default="tomography", choices=["tomography", "convection"])
    ap.add_argument(
        "--var", action="append", required=True,
        help="source[:id[:display name]]; repeatable",
    )
    ap.add_argument("--units", default="%")
    ap.add_argument("--sequential", action="store_true",
                    help="treat fields as sequential rather than diverging")
    ap.add_argument("--colormap", default=None)
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--ndepth", type=int, default=DEFAULT_NDEPTH)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--depth-range", nargs=2, type=float,
                    default=[DEFAULT_DEPTH_MIN, DEFAULT_DEPTH_MAX])
    ap.add_argument("--clip", nargs=2, type=float, default=None,
                    help="override the uint8 encoding range")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--default-clip", nargs=2, type=float, default=None,
                    help="initial colour-ramp range shown in the viewer")
    ap.add_argument("--max-nan-fraction", type=float, default=DEFAULT_MAX_NAN_FRACTION)
    ap.add_argument("--roughness-factor", type=float, default=DEFAULT_ROUGHNESS_FACTOR,
                    help="drop basal levels this many times rougher than the "
                         "mid-mantle baseline; 0 disables")
    ap.add_argument("--depth-regex", default=r"_(\d+)\.(?:nc|grd)$",
                    help="slice-directory mode: capture depth in km")
    ap.add_argument("--slice-var", default=None)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    dmin, dmax = args.depth_range
    diverging = not args.sequential
    colormap = args.colormap or ("RdBu" if diverging else "viridis")

    model_dir = args.out / "models" / args.id
    model_dir.mkdir(parents=True, exist_ok=True)

    variables, grid = [], None

    for spec in args.var:
        source_var, vid, vname = parse_var_spec(spec)
        print(f"\n=== {args.id}:{vid}  ({source_var})")

        if args.input.is_dir():
            data, lon, lat, depth = load_slice_dir(
                args.input, args.depth_regex, args.slice_var
            )
        else:
            data, lon, lat, depth = load_3d_netcdf(args.input, source_var)
        print(f"  loaded      {data.shape}  depth {depth.min():.0f}-{depth.max():.0f} km")

        if depth[0] > depth[-1]:  # ensure ascending depth
            depth, data = depth[::-1], data[::-1]
        if lat[0] > lat[-1]:  # ensure ascending latitude
            lat, data = lat[::-1], data[:, ::-1, :]

        data, lon = normalise_longitude(data, lon)
        data, lon = drop_duplicate_seam(data, lon)

        raw_min = float(np.nanmin(data))
        raw_max = float(np.nanmax(data))

        data, depth, dropped = clip_depth_levels(
            data, depth, dmin, dmax, args.max_nan_fraction
        )
        data, depth, rough_dropped = trim_bad_base(
            data, depth, args.roughness_factor
        )
        dropped = dropped + rough_dropped
        if dropped:
            print(f"  dropped     {len(dropped)} levels:")
            for d, why in dropped[:6]:
                print(f"                {d:8.1f} km  ({why})")
            if len(dropped) > 6:
                print(f"                ... and {len(dropped) - 6} more")

        data, nan_filled = fill_nan(data)
        if nan_filled:
            print(f"  filled      {nan_filled} residual NaN by nearest-neighbour")

        # The model's true valid range, after clipping -- not the mantle's.
        valid_min = float(depth.min())
        valid_max = float(depth.max())

        data, lon, lat = resample_horizontal(data, lon, lat, args.nlon, args.nlat)
        data, depth = resample_depth(data, depth, args.ndepth, valid_min, valid_max)
        print(f"  resampled   {data.shape}  ({valid_min:.0f}-{valid_max:.0f} km, uniform)")

        clip_lo, clip_hi = choose_clip(
            data, diverging, args.clip_percentile, args.clip
        )
        vol = encode_uint8(data, clip_lo, clip_hi)

        frame_dir = model_dir / "frames" / vid / args.resolution_id
        frame_dir.mkdir(parents=True, exist_ok=True)
        out_path = frame_dir / "000.bin"
        vol.tofile(out_path)
        mb = out_path.stat().st_size / 1024 / 1024
        print(f"  encoded     [{clip_lo:+.2f}, {clip_hi:+.2f}] -> uint8   {mb:.1f} MB")

        if args.default_clip:
            dclip = [float(args.default_clip[0]), float(args.default_clip[1])]
        elif diverging:
            # Open on something that shows mantle structure rather than crust.
            m = float(np.percentile(np.abs(data), 95)) * 0.5
            dclip = [-m, m]
        else:
            dclip = [clip_lo, clip_hi]

        variables.append({
            "id": vid,
            "name": vname,
            "source_var": source_var,
            "units": args.units,
            "diverging": diverging,
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(dclip[0], 4),
            "default_clip_max": round(dclip[1], 4),
            "default_colormap": colormap,
        })
        grid = (valid_min, valid_max)

        if args.validate:
            back = np.fromfile(out_path, dtype=np.uint8)
            assert back.size == args.nlon * args.nlat * args.ndepth, "size mismatch"
            phys = back.astype(np.float32) / 255.0 * (clip_hi - clip_lo) + clip_lo
            print(f"  validate    {back.size} bytes, decoded range "
                  f"[{phys.min():+.2f}, {phys.max():+.2f}] {args.units}")
            vol3 = back.reshape(args.ndepth, args.nlat, args.nlon)
            r = [lateral_roughness(vol3[k].astype(np.float32))
                 for k in (0, args.ndepth // 2, args.ndepth - 1)]
            print(f"  roughness   top {r[0]:.2f}  mid {r[1]:.2f}  base {r[2]:.2f}"
                  f"   (base >> mid means basal junk survived)")

    manifest = {
        "id": args.id,
        "name": args.name,
        "type": args.type,
        "source": args.source,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": round(grid[0], 3),
        "depth_max_km": round(grid[1], 3),
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": args.ndepth,
        }],
        "frames": [{"id": "000", "age_ma": 0}],
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": variables[0]["id"],
        "variables": variables,
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")
    return manifest


if __name__ == "__main__":
    main()
