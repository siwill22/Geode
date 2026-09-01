#!/usr/bin/env python3
"""Convert the Scotese & Wright (2018) PaleoDEM series into the viewer format.

This REPLACES the Muller et al. coastline/plate-boundary overlay for the
paleoclimate viewer: the Li et al. 2022 climate simulations were built on the
Scotese plate model, not Muller's, so drawing Muller coastlines over them
mixed two different reconstructions of the same ages -- internally
inconsistent, and the reason this script exists. There is no plate-boundary
line data for the Scotese model, only these reconstructed elevation/bathymetry
rasters, so "paleogeography" here means a land/ocean surface, not boundary
lines.

109 maps, 0-540 Ma, IRREGULARLY spaced (every 5 Myr through the Mesozoic,
coarser and slightly off-grid --  385.2, 390.5 Ma -- older than that). Every
one of the climate model's own 55 ages (0, 10, ..., 540 Ma, all multiples of
10) has a match within 2.5 Myr, so this ships its own 109-frame manifest and
lets nearestFrame() (same mechanism as every other model in the archive) find
the closest map to whatever age the shared slider is on -- no attempt to
force these onto the climate model's 55-frame list.

Source: gprm.datasets.Paleogeography.fetch_Paleomap(), loaded by file path
rather than `import gprm` because gprm's package __init__ pulls in pygplates/
ptt machinery this prep step does not need and pygmt17 does not have.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/elevation/<resolution>/<age_ma>.bin

and a "geo" entry merged into archive/colormaps.json: GMT's own relief
colormap (see make_geo_colormap), sourced from GMT's master geo.cpt rather
than a matplotlib ramp, so it is generated here rather than by
prep_colormaps.py.

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python prep_paleogeography.py --validate
"""

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import xarray as xr

from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    drop_duplicate_seam,
    encode_uint8,
    normalise_longitude,
    resample_horizontal,
)

GPRM_REPO = Path.home() / 'GIT' / 'GPlatesReconstructionModel'


def load_fetch_paleomap():
    """Import gprm.datasets.Paleogeography.fetch_Paleomap without triggering
    gprm/__init__.py (which imports pygplates/ptt utilities this script does
    not use and that pygmt17 does not have installed)."""
    path = GPRM_REPO / 'gprm' / 'datasets' / 'Paleogeography.py'
    if not path.exists():
        raise SystemExit(
            f"{path} not found -- expected the gprm repo checked out at {GPRM_REPO}"
        )
    spec = importlib.util.spec_from_file_location('gprm_paleogeography', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.fetch_Paleomap


def load_geo_master_cpt():
    """Parse GMT's own master geo.cpt: relief colours with a HARD_HINGE at
    sea level (see the file's header comment), designed by P. Wessel for
    exactly this purpose -- global bathymetry/topography. Its z column is
    normalised to [-1, 1] representing +-8000 m; read that literally from the
    file's own numbers rather than hardcoding what the header text claims, in
    case a GMT version ever updates one without the other. Location comes
    from `gmt --show-sharedir`, run as a sibling of sys.executable rather
    than relying on 'gmt' being on PATH -- this script is normally invoked
    with the pygmt17 env's python binary directly (see the module docstring),
    which does not itself put that env's bin/ on PATH.
    Returns (z_stops, rgb_stops) as parallel arrays spanning [-1, 1].
    """
    gmt_bin = Path(sys.executable).parent / 'gmt'
    gmt_bin = gmt_bin if gmt_bin.exists() else 'gmt'  # fall back to PATH
    sharedir = subprocess.run(
        [str(gmt_bin), '--show-sharedir'], capture_output=True, text=True, check=True,
    ).stdout.strip()
    path = Path(sharedir) / 'cpt' / 'gmt' / 'geo.cpt'
    if not path.exists():
        raise SystemExit(f"{path} not found -- expected GMT's own geo.cpt master table")

    # geo.cpt's very first stop is the bare GMT colour name "black" rather
    # than "0/0/0" -- everything else in the table is already r/g/b.
    named = {'black': [0, 0, 0], 'white': [255, 255, 255]}

    def parse_color(token):
        return named[token] if token in named else [int(c) for c in token.split('/')]

    zs, rgbs = [], []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line[0] in '#NFB':
            continue
        z0, rgb0, z1, rgb1 = line.split()
        if not zs:
            zs.append(float(z0))
            rgbs.append(parse_color(rgb0))
        zs.append(float(z1))
        rgbs.append(parse_color(rgb1))
    return np.array(zs), np.array(rgbs, dtype=np.float64)


def make_geo_colormap(encode_min, encode_max, master_half_range_m=8000.0):
    """Sample GMT's 'geo' relief colormap onto THIS variable's own encode
    range, anchored so elevation=0 always lands on the master table's hard
    hinge -- not assumed to be at t=0.5, since the real extremes here
    (-9000..+10500 m) are not symmetric about sea level. A naive linear
    rescale of the whole master table onto an asymmetric target range would
    drag the ocean/land boundary away from actual sea level; sampling each
    physical elevation against the master's own +-8000 m axis instead keeps
    the hinge exactly where the data says it belongs. Values beyond the
    master's native range clamp to its outermost colour (near-black abyssal
    trench / white mountain peak).
    """
    zs, rgbs = load_geo_master_cpt()
    colors = []
    for i in range(256):
        t = i / 255.0
        elev = encode_min + t * (encode_max - encode_min)
        z_norm = float(np.clip(elev / master_half_range_m, -1.0, 1.0))
        rgb = [float(np.interp(z_norm, zs, rgbs[:, c])) for c in range(3)]
        colors.append([int(round(c)) for c in rgb])
    return {'diverging': False, 'high_end': None, 'colors': colors}


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument('--id', default='paleogeography-scotese')
    ap.add_argument('--name', default='Scotese & Wright 2018 Paleogeography')
    ap.add_argument('--source', default=(
        'Scotese, C.R. and Wright, N., 2018. PALEOMAP Paleodigital Elevation '
        'Models (PaleoDEMS) for the Phanerozoic. PALEOMAP Project.'
    ))
    ap.add_argument('--var-id', default='elevation')
    ap.add_argument('--var-name', default='Paleogeography (elevation)')
    ap.add_argument('--units', default='m')
    ap.add_argument('--nlon', type=int, default=DEFAULT_NLON)
    ap.add_argument('--nlat', type=int, default=DEFAULT_NLAT)
    ap.add_argument('--resolution-id', default='std')
    ap.add_argument('--out', type=Path, default=Path('archive'))
    ap.add_argument('--validate', action='store_true')
    args = ap.parse_args()

    fetch_Paleomap = load_fetch_paleomap()
    raster_dict = fetch_Paleomap(resolution='01d')
    ages = sorted(raster_dict.keys())
    print(f"{len(ages)} PaleoDEM maps, {ages[0]:.0f}-{ages[-1]:.0f} Ma")

    model_dir = args.out / 'models' / args.id
    frame_dir = model_dir / 'frames' / args.var_id / args.resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)

    raw_min, raw_max = np.inf, -np.inf
    frame_meta = []
    # Resampled arrays kept in memory between the two passes (109 x 181 x 360
    # float32 =~ 28 MB) -- cheap enough not to need a third disk read once the
    # series-wide encode range is known below.
    resampled = {}

    for age in ages:
        ds = xr.open_dataset(raster_dict[age])
        lat = np.asarray(ds['lat'].values, dtype=np.float64)
        lon = np.asarray(ds['lon'].values, dtype=np.float64)
        z = ds['z'].values.astype(np.float32)[np.newaxis, :, :]  # (1, lat, lon)
        ds.close()
        if lat[0] > lat[-1]:
            raise SystemExit(f"{age} Ma: expected ascending latitude")

        data, lon2 = normalise_longitude(z, lon)
        data, lon2 = drop_duplicate_seam(data, lon2)
        data, lon2, lat2 = resample_horizontal(data, lon2, lat, args.nlon, args.nlat)

        raw_min = min(raw_min, float(np.nanmin(data)))
        raw_max = max(raw_max, float(np.nanmax(data)))

        fid = f"{age:g}".replace('.', '_')
        frame_meta.append({'id': fid, 'age_ma': float(age)})
        resampled[age] = data

    encode_min, encode_max = raw_min, raw_max
    sea_level_t = (0.0 - encode_min) / (encode_max - encode_min)
    print(f"elevation range {encode_min:+.0f} to {encode_max:+.0f} m "
          f"(sea level at t={sea_level_t:.4f})")

    total_mb = 0.0
    for age, fm in zip(ages, frame_meta):
        vol = encode_uint8(resampled[age], encode_min, encode_max)
        out_path = frame_dir / f"{fm['id']}.bin"
        vol.tofile(out_path)
        total_mb += out_path.stat().st_size / 1024 / 1024
    print(f"wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")

    manifest = {
        'id': args.id,
        'name': args.name,
        'type': 'paleogeography',
        'source': args.source,
        'lon_min': -180.0, 'lon_max': 180.0,
        'lat_min': -90.0, 'lat_max': 90.0,
        'depth_min_km': 0.0, 'depth_max_km': 1.0,  # unused layer axis; see prep_climate.py
        'dtype': 'uint8',
        'default_resolution': args.resolution_id,
        'resolutions': [{
            'id': args.resolution_id,
            'nlon': args.nlon, 'nlat': args.nlat, 'ndepth': 1,
        }],
        'frames': frame_meta,
        'path_template': 'frames/{variable}/{resolution}/{frame}.bin',
        'default_variable': args.var_id,
        'variables': [{
            'id': args.var_id,
            'name': args.var_name,
            'source_var': 'z',
            'units': args.units,
            'diverging': False,
            'encode_min': round(encode_min, 2),
            'encode_max': round(encode_max, 2),
            'value_min': round(raw_min, 2),
            'value_max': round(raw_max, 2),
            'default_clip_min': round(encode_min, 2),
            'default_clip_max': round(encode_max, 2),
            'default_colormap': 'geo',
        }],
    }
    (model_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(f"wrote {model_dir / 'manifest.json'}")

    cmap_path = args.out / 'colormaps.json'
    if not cmap_path.exists():
        raise SystemExit(f"{cmap_path} not found -- run prep_colormaps.py first")
    colormaps = json.loads(cmap_path.read_text())
    colormaps.pop('landocean', None)  # superseded by 'geo'; drop the stale entry
    colormaps['geo'] = make_geo_colormap(encode_min, encode_max)
    cmap_path.write_text(json.dumps(colormaps))
    print(f"added 'geo' to {cmap_path}")

    if args.validate:
        expect = args.nlon * args.nlat * 1
        for fm in frame_meta:
            back = np.fromfile(frame_dir / f"{fm['id']}.bin", dtype=np.uint8)
            assert back.size == expect, f"{fm['id']}.bin is {back.size}, want {expect}"
        first = np.fromfile(frame_dir / f"{frame_meta[0]['id']}.bin",
                             dtype=np.uint8).reshape(args.nlat, args.nlon)
        last = np.fromfile(frame_dir / f"{frame_meta[-1]['id']}.bin",
                            dtype=np.uint8).reshape(args.nlat, args.nlon)
        assert not np.array_equal(first, last), \
            "0 Ma and 540 Ma frames are byte-identical -- something is wrong"
        print(f"validate    {len(frame_meta)} frames all {expect} bytes, "
              f"0 Ma != 540 Ma confirmed")


if __name__ == '__main__':
    main()
