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

Source: gprm.datasets.Paleogeography.fetch_Paleomap().

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/elevation/<resolution>/<age_ma>.bin

and a "geo" entry merged into archive/colormaps.json: GMT's own relief
colormap (see make_geo_colormap), sourced from GMT's master geo.cpt rather
than a matplotlib ramp, so it is generated here rather than by
prep_colormaps.py.

Example
-------
    python prep_paleogeography.py --validate
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pygmt
import xarray as xr

from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    LAT_NAMES,
    LON_NAMES,
    drop_duplicate_seam,
    encode_uint8,
    find_coord,
    normalise_longitude,
    resample_horizontal,
)

DEFAULT_HILLSHADE_CLIP_PERCENTILE = 99.5


def load_fetch_paleomap():
    """Return gprm.datasets.Paleogeography.fetch_Paleomap.

    This used to side-load the module by file path, from a gprm checkout assumed to be at
    ~/GIT/GPlatesReconstructionModel, purely to avoid the cost of `import gprm` -- the
    package __init__ eagerly pulled in pygplates, ptt and pygmt, none of which this step
    needs. gprm now imports its submodules lazily, so the ordinary import is cheap and
    works against an installed gprm rather than one specific checkout.
    """
    from gprm.datasets.Paleogeography import fetch_Paleomap

    return fetch_Paleomap


def match_existing_frames(ages, existing_frames, tol_myr=1.0):
    """Pair this run's source ages 1:1 with an existing manifest's frames,
    nearest age within `tol_myr`, returning the EXISTING frames' entries in
    the order of `ages`. Exits, listing the offenders, if any age has no
    frame within tolerance or two ages claim the same frame."""
    matched, problems, taken = [], [], set()
    for age in ages:
        nearest = min(existing_frames, key=lambda f: abs(f['age_ma'] - age))
        if abs(nearest['age_ma'] - age) > tol_myr:
            problems.append(f"{age:g} Ma: nearest existing frame is {nearest['age_ma']:g} Ma")
        elif nearest['id'] in taken:
            problems.append(f"{age:g} Ma: frame {nearest['id']} already matched to another age")
        else:
            taken.add(nearest['id'])
            matched.append(nearest)
            if nearest['age_ma'] != age:
                print(f"  source age {age:g} Ma -> existing frame {nearest['id']} "
                      f"({nearest['age_ma']:g} Ma)")
    if len(existing_frames) != len(ages):
        problems.append(f"{len(ages)} source ages vs {len(existing_frames)} existing frames")
    if problems:
        raise SystemExit("this run's ages do not pair up with the existing manifest's frames:\n  "
                         + "\n  ".join(problems))
    return matched


def load_geo_master_cpt():
    """Parse GMT's own master geo.cpt: relief colours with a HARD_HINGE at
    sea level (see the file's header comment), designed by P. Wessel for
    exactly this purpose -- global bathymetry/topography. Its z column is
    normalised to [-1, 1] representing +-8000 m; read that literally from the
    file's own numbers rather than hardcoding what the header text claims, in
    case a GMT version ever updates one without the other.

    Read from the copy vendored at prep/data/geo.cpt rather than located via
    `gmt --show-sharedir`. That call assumed a gmt binary sitting beside
    sys.executable, which is only true when this script is run with a specific
    conda env's python; the vendored file works however it is invoked.

    Returns (z_stops, rgb_stops) as parallel arrays spanning [-1, 1].
    """
    path = Path(__file__).parent / 'data' / 'geo.cpt'
    if not path.exists():
        raise SystemExit(f"{path} not found -- expected the vendored geo.cpt master table")

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
    # general=False: this ramp's ocean/land hinge is baked in at THIS
    # variable's own encode range (see docstring above) -- reused for another
    # variable, the hinge would land at whatever arbitrary value happens to
    # map to elevation=0 here, not that variable's own zero. Excluded from
    # the tomography viewer's generic colormap picker (colormapOptions() in
    # viewer/src/tomography/instance.ts) for that reason.
    return {'diverging': False, 'high_end': None, 'general': False, 'colors': colors}


def compute_hillshade(data, lon, lat, azimuth=315.0):
    """RAW (unnormalized) shaded-relief intensity from a resampled elevation
    grid, for the overlay's greyscale render (see ClimateInstance's overlay
    mesh). Caller encodes across a clip range fit ONCE across the whole
    series -- see main()'s two-pass structure -- not per age; see the two
    bugs below for why.

    `data` is on the -180..180/gridline-registered grid resample_horizontal()
    already produces. grdgradient's derivative is a SLOPE, and on a lon/lat
    grid a degree of longitude covers less ground toward the poles than a
    degree of latitude does -- a plain Cartesian gradient (numpy's, or GMT
    with the grid left untagged) would get that scaling wrong and shade high
    latitudes incorrectly. Marking the grid geographic (gtype=1) makes
    grdgradient account for it. Checked concretely against a synthetic grid:
    leaving gtype at its Cartesian default vs. setting it to 1 changes the
    computed intensity by ~45% at the same point -- not a rounding
    difference.

    Two bugs found by comparing output across ages, both about to do with
    the geographic longitude axis specifically:

    1. **The pole rows are numerically degenerate.** At exactly +-90 deg
       latitude, every longitude is the same physical point, so an
       azimuthal (longitude-direction) derivative there is meaningless --
       and grdgradient does not know this, so it computes one anyway,
       producing a spurious value up to 1000x the magnitude of real
       terrain slope across the WHOLE pole row (confirmed: value 6553.6 at
       the antimeridian/south-pole corner on real data, against a real
       max elsewhere in the same grid of ~0.4). Fixed by overwriting each
       pole row with its immediate neighbour before differencing -- this
       makes the pole-to-neighbour derivative exactly zero rather than
       fabricated, which is the closest thing to correct a single grid row
       standing in for one point can be.
    2. **PyGMT's per-call `normalize` option contrast-stretches each grid
       independently.** With a single dominant outlier (bug #1) skewing
       that per-grid fit, some ages' real terrain signal was compressed to
       a THIRD of its intended dynamic range and pushed almost entirely
       to one sign (observed: std 0.07 and one-sided vs. std 0.28 and
       symmetric on an adjacent age) -- the "shading present for some ages,
       absent for others" symptom this function exists to fix. Even after
       fixing bug #1, per-grid normalization would still make otherwise
       comparable ages look inconsistently contrasted, since "stretch to
       fill the range" is relative to THAT grid's own extremes. Returning
       the raw derivative and clipping every age against ONE series-wide
       range (chosen in main()) fixes both at once.
    """
    fixed = data[0].copy()
    fixed[0, :] = fixed[1, :]
    fixed[-1, :] = fixed[-2, :]

    da = xr.DataArray(
        fixed, coords={'lat': lat, 'lon': lon}, dims=('lat', 'lon'),
    )
    da.gmt.registration = 0  # gridline-registered, matching resample_horizontal's grid
    da.gmt.gtype = 1         # geographic, NOT Cartesian -- see docstring
    raw = np.asarray(pygmt.grdgradient(grid=da, azimuth=azimuth).values, dtype=np.float32)
    raw[0, :] = 0.0   # no meaningful azimuthal slope AT a pole
    raw[-1, :] = 0.0
    return raw[np.newaxis, :, :]


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
    ap.add_argument('--hillshade-id', default='hillshade')
    ap.add_argument('--hillshade-azimuth', type=float, default=315.0)
    ap.add_argument('--hillshade-clip-percentile', type=float,
                     default=DEFAULT_HILLSHADE_CLIP_PERCENTILE,
                     help='symmetric percentile of |gradient|, computed once '
                          'across the whole series, that becomes the fixed '
                          'encode range -- see compute_hillshade()')
    ap.add_argument('--nlon', type=int, default=DEFAULT_NLON)
    ap.add_argument('--nlat', type=int, default=DEFAULT_NLAT)
    ap.add_argument('--resolution-id', default='std')
    ap.add_argument('--source-resolution', choices=['01d', '06m'], default='01d',
                     help="gprm's own PaleoDEM source grid: '01d' (1 degree, "
                          "the default) or '06m' (6 arc-minutes, ~100x the "
                          "pixel count) -- see fetch_Paleomap(). Independent "
                          "of --nlon/--nlat, the OUTPUT grid this resamples "
                          "onto; a finer source only pays off if the output "
                          "grid is also finer.")
    ap.add_argument('--encode-min', type=float, default=None,
                     help='pin elevation encode_min instead of computing it '
                          "from this run's own data -- see --encode-max")
    ap.add_argument('--encode-max', type=float, default=None,
                     help="pin elevation encode_max. Needed when generating "
                          "a second resolution: each run's own data has "
                          "slightly different extremes (finer sampling "
                          "resolves more extreme peaks), but the viewer "
                          "stores one encode_min/max per variable regardless "
                          "of resolution -- pass the FIRST run's printed "
                          "range into the second run so both write the same "
                          "encode range.")
    ap.add_argument('--hillshade-clip', type=float, default=None,
                     help='pin the symmetric hillshade encode range instead '
                          'of computing it from --hillshade-clip-percentile '
                          'on this run\'s own data -- same reasoning as '
                          '--encode-min/--encode-max.')
    ap.add_argument('--out', type=Path, default=Path('archive'))
    ap.add_argument('--validate', action='store_true')
    args = ap.parse_args()

    fetch_Paleomap = load_fetch_paleomap()
    raster_dict = fetch_Paleomap(resolution=args.source_resolution)
    ages = sorted(raster_dict.keys())
    print(f"{len(ages)} PaleoDEM maps, {ages[0]:.0f}-{ages[-1]:.0f} Ma")

    model_dir = args.out / 'models' / args.id
    frame_dir = model_dir / 'frames' / args.var_id / args.resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    shade_dir = model_dir / 'frames' / args.hillshade_id / args.resolution_id
    shade_dir.mkdir(parents=True, exist_ok=True)

    raw_min, raw_max = np.inf, -np.inf
    frame_meta = []
    # Resampled/shaded arrays kept in memory between the two passes (109 x
    # 181 x 360 float32 =~ 28 MB per variable) -- cheap enough not to need a
    # third disk read once the series-wide encode ranges are known below.
    resampled = {}
    shaded = {}

    for age in ages:
        ds = xr.open_dataset(raster_dict[age])
        # The 01d and 06m PaleoDEM series don't share coordinate names ('lat'/
        # 'lon' vs 'latitude'/'longitude') -- resolve them the same way every
        # other prep script does rather than hardcoding one series' names.
        lat_name = find_coord(ds, LAT_NAMES)
        lon_name = find_coord(ds, LON_NAMES)
        if lat_name is None or lon_name is None:
            raise SystemExit(f"{age} Ma: could not find lat/lon coords among {list(ds.coords)}")
        lat = np.asarray(ds[lat_name].values, dtype=np.float64)
        lon = np.asarray(ds[lon_name].values, dtype=np.float64)
        z = ds['z'].values.astype(np.float32)[np.newaxis, :, :]  # (1, lat, lon)
        ds.close()
        # The 06m series stores latitude descending (north to south), unlike
        # 01d's ascending order -- flip both into the ascending order the
        # rest of this pipeline (and compute_hillshade's gtype=1 gradient)
        # assumes, rather than rejecting a source that's just oriented the
        # other way.
        if lat[0] > lat[-1]:
            lat = lat[::-1]
            z = z[:, ::-1, :]

        data, lon2 = normalise_longitude(z, lon)
        data, lon2 = drop_duplicate_seam(data, lon2)
        data, lon2, lat2 = resample_horizontal(data, lon2, lat, args.nlon, args.nlat)

        raw_min = min(raw_min, float(np.nanmin(data)))
        raw_max = max(raw_max, float(np.nanmax(data)))

        fid = f"{age:g}".replace('.', '_')
        frame_meta.append({'id': fid, 'age_ma': float(age)})
        resampled[age] = data
        shaded[age] = compute_hillshade(data, lon2, lat2, args.hillshade_azimuth)

    # A second resolution of the same model (e.g. `hi` beside `std`) must
    # agree with the manifest already on disk, which serves BOTH resolutions
    # through one `frames` list and one encode range per variable:
    #
    #   - Frame ids. The 1 degree and 6 arc-minute PaleoDEM releases label
    #     two of the same maps differently (Map67.5/Map68: 385.2/390.5 Ma vs
    #     385/390 Ma), so ids derived from this run's own ages would write
    #     files the shared manifest never names -- the viewer then 404s on
    #     those frames at that resolution. Match each age to the existing
    #     frame nearest it instead, and refuse if they do not pair up 1:1.
    #   - Encode ranges and default_resolution, taken from the existing
    #     manifest unless pinned on the command line, so bytes written here
    #     decode with the same numbers the manifest states.
    manifest_path = model_dir / 'manifest.json'
    existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    merging = existing is not None and any(
        r['id'] != args.resolution_id for r in existing.get('resolutions', []))
    if merging:
        frame_meta = match_existing_frames(ages, existing['frames'])
        ev = {v['id']: v for v in existing['variables']}
        if args.encode_min is None:
            args.encode_min = ev[args.var_id]['encode_min']
        if args.encode_max is None:
            args.encode_max = ev[args.var_id]['encode_max']
        if args.hillshade_clip is None and args.hillshade_id in ev:
            args.hillshade_clip = ev[args.hillshade_id]['encode_max']
        print(f"merging with existing resolution(s) "
              f"{[r['id'] for r in existing['resolutions'] if r['id'] != args.resolution_id]}: "
              f"frame ids and encode ranges taken from {manifest_path}")

    # --encode-min/--encode-max pin the range instead of computing it from
    # THIS run's own data -- see the CLI help for why a second resolution of
    # the same variable needs to reuse the first run's range.
    encode_min = args.encode_min if args.encode_min is not None else raw_min
    encode_max = args.encode_max if args.encode_max is not None else raw_max
    sea_level_t = (0.0 - encode_min) / (encode_max - encode_min)
    print(f"elevation range {encode_min:+.0f} to {encode_max:+.0f} m "
          f"(sea level at t={sea_level_t:.4f})"
          + (' [pinned]' if args.encode_min is not None else ''))

    # ONE clip range for the whole series -- not per age -- so shading
    # intensity is comparable across time rather than each age being
    # independently contrast-stretched. See compute_hillshade()'s docstring
    # (bug #2) for what per-age normalization did instead. --hillshade-clip
    # pins this too, same reasoning as --encode-min/--encode-max above.
    all_shade = np.concatenate([s.ravel() for s in shaded.values()])
    shade_clip = args.hillshade_clip if args.hillshade_clip is not None else float(
        np.percentile(np.abs(all_shade), args.hillshade_clip_percentile)
    )
    hillshade_min, hillshade_max = -shade_clip, shade_clip
    print(f"hillshade range {float(all_shade.min()):+.3f} to {float(all_shade.max()):+.3f} raw  "
          f"(clipping to +-{shade_clip:.3f}"
          + (' [pinned]' if args.hillshade_clip is not None
             else f', the {args.hillshade_clip_percentile} percentile of '
                  f'|gradient| across all {len(ages)} ages') + ')')

    total_mb = 0.0
    for age, fm in zip(ages, frame_meta):
        vol = encode_uint8(resampled[age], encode_min, encode_max)
        out_path = frame_dir / f"{fm['id']}.bin"
        vol.tofile(out_path)
        total_mb += out_path.stat().st_size / 1024 / 1024

        shade_vol = encode_uint8(shaded[age], hillshade_min, hillshade_max)
        shade_path = shade_dir / f"{fm['id']}.bin"
        shade_vol.tofile(shade_path)
        total_mb += shade_path.stat().st_size / 1024 / 1024
    print(f"wrote       {len(frame_meta)} frames x 2 variables, {total_mb:.1f} MB total")

    # Files from an earlier run under ids the manifest no longer names (the
    # 385.bin/390.bin left beside 385_2.bin/390_5.bin by the id mismatch
    # above) are dead weight that ships in the deploy archive.
    wanted = {f"{fm['id']}.bin" for fm in frame_meta}
    for d in (frame_dir, shade_dir):
        for stale in sorted(d.glob('*.bin')):
            if stale.name not in wanted:
                stale.unlink()
                print(f"removed stale {stale}")

    # If a manifest already exists (e.g. this is the second of two resolution
    # runs against the same model id), upsert this run's entry into its
    # `resolutions` list by id rather than overwriting the whole file --
    # otherwise the second run would silently drop the first run's
    # resolution. Everything else is written fresh each run; with
    # --encode-min/--encode-max/--hillshade-clip pinned to match, the rest of
    # the manifest ends up byte-identical between runs anyway.
    resolutions = [{
        'id': args.resolution_id,
        'nlon': args.nlon, 'nlat': args.nlat, 'ndepth': 1,
    }]
    if existing is not None:
        resolutions = [r for r in existing.get('resolutions', []) if r['id'] != args.resolution_id] + resolutions
        print(f"merging into existing manifest -- resolutions now: "
              f"{[r['id'] for r in resolutions]}")

    manifest = {
        'id': args.id,
        'name': args.name,
        'type': 'paleogeography',
        'source': args.source,
        'lon_min': -180.0, 'lon_max': 180.0,
        'lat_min': -90.0, 'lat_max': 90.0,
        'depth_min_km': 0.0, 'depth_max_km': 1.0,  # unused layer axis; see prep_climate.py
        'dtype': 'uint8',
        # A second resolution is an option beside the default, not a
        # replacement for it.
        'default_resolution': existing['default_resolution'] if merging else args.resolution_id,
        'resolutions': resolutions,
        'frames': frame_meta,
        'path_template': 'frames/{variable}/{resolution}/{frame}.bin',
        'default_variable': args.var_id,
        'variables': [
            {
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
            },
            {
                # Drives ClimateInstance's shaded-relief overlay mesh only --
                # overlay_only means the variable picker in climateUi.ts
                # never offers it as a PRIMARY display choice (it has no
                # scientific meaning on its own, just a rendering aid).
                'id': args.hillshade_id,
                'name': 'Shaded relief',
                'source_var': 'z',
                'units': 'intensity',
                'diverging': False,
                'encode_min': round(hillshade_min, 4),
                'encode_max': round(hillshade_max, 4),
                'value_min': round(float(all_shade.min()), 4),
                'value_max': round(float(all_shade.max()), 4),
                'default_clip_min': round(hillshade_min, 4),
                'default_clip_max': round(hillshade_max, 4),
                'default_colormap': 'gray',
                'overlay_only': True,
            },
        ],
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

        for fm in frame_meta:
            back = np.fromfile(shade_dir / f"{fm['id']}.bin", dtype=np.uint8)
            assert back.size == expect, f"hillshade {fm['id']}.bin is {back.size}, want {expect}"
        sfirst = np.fromfile(shade_dir / f"{frame_meta[0]['id']}.bin",
                              dtype=np.uint8).reshape(args.nlat, args.nlon)
        slast = np.fromfile(shade_dir / f"{frame_meta[-1]['id']}.bin",
                             dtype=np.uint8).reshape(args.nlat, args.nlon)
        assert not np.array_equal(sfirst, slast), \
            "hillshade 0 Ma and 540 Ma frames are byte-identical -- something is wrong"
        print(f"validate    hillshade {len(frame_meta)} frames all {expect} bytes, "
              f"0 Ma != 540 Ma confirmed")


if __name__ == '__main__':
    main()
