#!/usr/bin/env python3
"""Export hachured-mountain glyph positions for the Old Map viewer.

See docs/plans/old-map-viewer.md and docs/adr/0037. The Old Map viewer draws
three style elements; two of them (the coastal wash, the offshore rings) are
screen-space decoration produced in the browser and need no prep at all. This
script produces the third, which is the only one that makes a claim about where
something was:

    a mountain glyph stands where crust is >300 km inland AND <800 km from a
    subduction zone -- and keeps standing, fading, for a while after the trench
    goes away.

Both distances are true great-circle distances, never approximated and never
computed in pixels. That is the whole reason this runs here rather than in the
browser.

Output (default archive/reconstructions/<id>/oldmap/mountains.json):

    {"model": "Merdith2021", "time_step": 1, "decay_myr": 100,
     "count": 121043,
     "frames": {"100": {"id":       [12, 47, ...],        stable candidate id
                        "lonlat":   [-58.1, -22.4, ...],  reconstructed, paired
                        "orogenAge":[0, 34, ...]}}}       Myr since satisfied

`id` is stable across frames so the viewer can fade a glyph rather than blink
it; see "Why the candidates ride plates" below.

Usage:
  conda run -n pygmt17 python prep/prep_oldmap.py --model Merdith2021
  conda run -n pygmt17 python prep/prep_oldmap.py --check-distances


---- Why the candidates ride plates ------------------------------------------

The reference notebook (~/GIT/degenerative_art/withMountains.ipynb) regenerates
`points_on_sphere()` identically every frame, in PRESENT-DAY absolute
coordinates. Its glyphs therefore sit on a fixed global lattice and blink on and
off as the orogen band sweeps past them -- they do not travel with the crust.
Invisible in the notebook's single JPEGs, and the first thing you would see in a
scrub.

So the candidate set is generated ONCE, each candidate is assigned a plate id
from the model's own continent polygons, and the whole set is rotated to each
frame. A candidate keeps its identity for all 251 frames, which is also what
makes the decay possible: a fade needs something stable to fade.


---- Why only continental candidates -----------------------------------------

Candidates that partition into no continent polygon are dropped at setup. They
could never satisfy the rule anyway -- ">300 km inland" is measured against a
land mask built from those same polygons, so a point off continental crust
scores zero inland distance forever.

Note the GLOBAL spiral density is what is preserved, not a continental count:
--points is the global point count and roughly the continental fraction of it
survives, which keeps on-screen glyph spacing the same as the notebook's.


---- Why the distances are nearest-neighbour queries, not raster scans -------

The notebook computes both fields with xrspatial's `proximity`, a two-pass
raster scan. Measured against brute force at 100 Ma (`--check-distances`), that
scan is wrong by a mean of 109 km and by as much as 4400 km, on 0.25 deg data.
Two independent reasons:

  - It does not wrap at +/-180. A cell near the antimeridian cannot see sources
    across the seam, so distances there come out far too large. This bites
    exactly where Mesozoic mountains live -- Aleutians, Kamchatka, the
    Antarctic-Pacific margin. The notebook's `mask_to_da` does
    `mask[:,0] = mask[:,-1]`, which patches the MASK seam and does nothing for
    the distance search that runs afterwards.
  - The scan is order-dependent even in the interior, where 13% of cells still
    move by more than a kilometre if the grid is merely rolled.

None of that needs solving, because the field is never needed as a field. Only
~2000 candidate points are ever interrogated, so this queries a KD-tree of
source positions in 3D unit-vector space instead. Chord distance in that space
is monotonic in great-circle distance, so the nearest neighbour is exact and
there is no seam to wrap -- the antimeridian is not a special place on a sphere,
only on a grid.

What remains approximate is the SOURCE SET, not the search:

  - Trench sources are the tessellated subduction geometry itself, at 0.1 deg,
    so they carry no rasterization error at all.
  - Coast sources are ocean cell centres from a rasterized land mask, so they
    are quantized to +/- half a cell (~14 km at 0.25 deg). Rasterizing is not
    avoidable here: the model's continent polygons OVERLAP when reconstructed,
    and the coastline wanted is the outline of their merged union, not the
    boundary of any individual polygon.

Polar anisotropy is a limitation of that one rasterized step, not of the search:
at 0.25 deg a cell is ~28 km wide in longitude at the equator and ~2 km at
85 deg. High-latitude glyph placement is decorative.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pygplates
from scipy.spatial import cKDTree

EARTH_RADIUS_M = 6371008.8  # IUGG mean radius, matching pygplates' Earth.mean_radius_in_kms


def lonlat_to_xyz(lons, lats):
    """Unit vectors. The KD-tree lives here because chord distance in 3D is
    monotonic in great-circle distance, which makes nearest-neighbour exact and
    seam-free."""
    rlat, rlon = np.radians(lats), np.radians(lons)
    c = np.cos(rlat)
    return np.column_stack([c * np.cos(rlon), c * np.sin(rlon), np.sin(rlat)])


def chord_to_great_circle(chord):
    """Chord length on the unit sphere -> great-circle distance in metres."""
    return 2.0 * EARTH_RADIUS_M * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))


def nearest_distance(query_lons, query_lats, src_lons, src_lats):
    """Great-circle distance from each query point to the nearest source, in
    metres. inf if there are no sources."""
    if len(src_lons) == 0:
        return np.full(len(query_lons), np.inf)
    tree = cKDTree(lonlat_to_xyz(src_lons, src_lats))
    chord, _ = tree.query(lonlat_to_xyz(query_lons, query_lats), k=1)
    return chord_to_great_circle(chord)


def build_grid(sampling):
    """Global gridline-registered axes for the land mask. `lon` omits the
    closing +180 column, which is the same meridian as the first."""
    lat = np.arange(-90.0, 90.0 + sampling / 2, sampling)
    lon = np.arange(-180.0, 180.0 - sampling / 2, sampling)
    return lat, lon


def land_mask(continent_features, rotation_model, time, sampling, anchor):
    """Rasterize the model's reconstructed continent polygons to a 1/0 land
    mask. Uses gprm's own helper so the polygons are merged exactly as the
    reference notebook merges them."""
    from gprm.utils.spatial import get_merged_cob_terrane_raster
    mask = get_merged_cob_terrane_raster(
        continent_features, rotation_model, time,
        sampling=sampling, method='rasterio', anchor_plate_id=anchor)
    return (np.asarray(mask)[:, :-1] > 0).astype(np.uint8)


def coastal_ocean_points(mask, lat_axis, lon_axis):
    """Centres of the ocean cells that touch land, as (lons, lats).

    Restricting to coastal ocean rather than all ocean is exact, not an
    approximation: the nearest ocean cell to any land point must itself touch
    land, or a nearer ocean cell would lie along the way. It is just far
    cheaper -- tens of thousands of sources instead of hundreds of thousands.

    Longitude neighbours wrap; latitude neighbours do not (there is no cell
    beyond the pole).
    """
    land = mask == 1
    touches_land = np.zeros_like(land)
    touches_land[:, :-1] |= land[:, 1:]
    touches_land[:, 1:] |= land[:, :-1]
    touches_land[:, -1] |= land[:, 0]      # longitude is periodic
    touches_land[:, 0] |= land[:, -1]
    touches_land[:-1, :] |= land[1:, :]
    touches_land[1:, :] |= land[:-1, :]

    iy, ix = np.nonzero((~land) & touches_land)
    return lon_axis[ix], lat_axis[iy]


def subduction_points(model, time):
    """Tessellated points along every resolved subduction boundary, as
    (lons, lats). 0.1 deg matches the notebook."""
    snapshot = model.plate_snapshot(time)
    lons, lats = [], []
    for sz in snapshot.get_boundary_features(boundary_types=['subduction']):
        geom = sz.get_geometry()
        if geom is None:
            continue
        for lat, lon in geom.to_tessellated(np.radians(0.1)).to_lat_lon_list():
            lons.append(lon)
            lats.append(lat)
    return np.asarray(lons), np.asarray(lats)


def make_candidates(model, n_global, seed_type='spiral'):
    """The fixed candidate set: a global spiral, partitioned onto the model's
    continent polygons, keeping only those that landed on one."""
    from gprm.utils.sphere import points_on_sphere
    lons, lats = points_on_sphere(N=n_global, distribution_type=seed_type)

    # `continent_polygons` are already-loaded FeatureCollections; it is
    # `continent_polygons_files` that holds paths. Passing one to
    # FeatureCollection(str(...)) stringifies the object into a filename.
    continents = pygplates.FeatureCollection()
    for fc in model.continent_polygons:
        continents.add(fc)

    partitioner = pygplates.PlatePartitioner(continents, model.rotation_model)
    keep_lon, keep_lat, keep_plate = [], [], []
    for lon, lat in zip(lons, lats):
        poly = partitioner.partition_point(
            pygplates.PointOnSphere(float(lat), float(lon)))
        if poly is None:
            continue
        keep_lon.append(lon)
        keep_lat.append(lat)
        keep_plate.append(poly.get_feature().get_reconstruction_plate_id())
    return (np.asarray(keep_lon), np.asarray(keep_lat),
            np.asarray(keep_plate, dtype=np.int32))


def reconstruct_candidates(lons, lats, plate_ids, rotation_model, time, anchor):
    """Rotate the whole candidate set to `time`, one finite rotation per plate
    rather than one pygplates reconstruct call per point."""
    out_lon = np.empty_like(lons)
    out_lat = np.empty_like(lats)
    for pid in np.unique(plate_ids):
        sel = plate_ids == pid
        rot = rotation_model.get_rotation(float(time), int(pid), anchor_plate_id=anchor)
        pts = pygplates.MultiPointOnSphere(
            [pygplates.PointOnSphere(float(a), float(o))
             for a, o in zip(lats[sel], lons[sel])])
        ll = np.asarray((rot * pts).to_lat_lon_array())
        out_lat[sel] = ll[:, 0]
        out_lon[sel] = ll[:, 1]
    return out_lon, out_lat


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default='Merdith2021',
                    help='gprm Reconstructions name (calls fetch_<model>)')
    ap.add_argument('--id', help='catalog id (default: --model lowercased)')
    ap.add_argument('--age-max', type=float, default=200.0,
                    help='oldest age the VIEWER shows')
    ap.add_argument('--cold-start', type=float, default=50.0,
                    help='extra Myr computed beyond --age-max, discarded before '
                         'writing, so the oldest displayed frame has history '
                         'behind it instead of every orogen starting at age 0')
    ap.add_argument('--age-step', type=float, default=1.0)
    ap.add_argument('--decay', type=float, default=100.0,
                    help='Myr a glyph persists after the rule stops being met')
    ap.add_argument('--sampling', type=float, default=0.25,
                    help='land-mask cell size in degrees')
    ap.add_argument('--points', type=int, default=5000,
                    help='GLOBAL spiral point count; the continental fraction '
                         'survives partitioning')
    ap.add_argument('--min-inland', type=float, default=300e3,
                    help='metres inland from the coast a glyph must be')
    ap.add_argument('--max-trench', type=float, default=800e3,
                    help='metres from a subduction zone a glyph must be within')
    ap.add_argument('--anchor', type=int, default=0)
    ap.add_argument('--out', type=Path, default=None)
    ap.add_argument('--check-distances', action='store_true',
                    help='measure this script\'s distances, and the notebook\'s '
                         'raster-scan alternative, against brute force; then exit')
    args = ap.parse_args()

    recon_id = args.id or args.model.lower()
    out = args.out or (Path('archive/reconstructions') / recon_id / 'oldmap' / 'mountains.json')

    from gprm.datasets import Reconstructions
    fetch = getattr(Reconstructions, f'fetch_{args.model}', None)
    if fetch is None:
        raise SystemExit(f'unknown model {args.model!r}')
    model = fetch()
    if not model.continent_polygons:
        raise SystemExit(
            f'{args.model} has no continent_polygons -- the land mask, the '
            'inland distance and the candidate partitioning all come from '
            'them, so there is nothing to do without them.')

    lat_axis, lon_axis = build_grid(args.sampling)
    continent_file = model.continent_polygons[0]

    if args.check_distances:
        check_distances(model, continent_file, lat_axis, lon_axis, args)
        return

    print(f'{args.model}: building candidate set ({args.points} global spiral points) ...')
    cand_lon, cand_lat, cand_plate = make_candidates(model, args.points)
    print(f'  {len(cand_lon)} of {args.points} landed on continental crust '
          f'({100 * len(cand_lon) / args.points:.0f}%), '
          f'{len(np.unique(cand_plate))} distinct plates')

    ages = np.arange(args.age_max + args.cold_start, -args.age_step / 2, -args.age_step)
    # Ma at which the rule last held, per candidate. -inf = never yet.
    last_satisfied = np.full(len(cand_lon), -np.inf)

    frames = {}
    total = 0
    print(f'\n  {"age":>5s}  {"trench pts":>10s}  {"satisfied":>9s}  {"drawn":>5s}')
    for k, time in enumerate(ages):
        mask = land_mask(continent_file, model.rotation_model, float(time),
                         args.sampling, args.anchor)
        coast_lon, coast_lat = coastal_ocean_points(mask, lat_axis, lon_axis)
        sz_lon, sz_lat = subduction_points(model, float(time))

        rlon, rlat = reconstruct_candidates(cand_lon, cand_lat, cand_plate,
                                            model.rotation_model, float(time), args.anchor)
        d_inland = nearest_distance(rlon, rlat, coast_lon, coast_lat)
        d_trench = nearest_distance(rlon, rlat, sz_lon, sz_lat)
        satisfied = (d_inland > args.min_inland) & (d_trench < args.max_trench)
        last_satisfied[satisfied] = time

        # Frames older than --age-max exist only to seed `last_satisfied`.
        # They are the cold start and are never written.
        n_drawn = 0
        if time <= args.age_max:
            orogen_age = last_satisfied - time
            live = np.isfinite(last_satisfied) & (orogen_age <= args.decay)
            idx = np.nonzero(live)[0]
            lonlat = np.empty(2 * len(idx))
            lonlat[0::2] = np.round(rlon[idx], 2)
            lonlat[1::2] = np.round(rlat[idx], 2)
            frames[str(int(time))] = {
                'id': idx.astype(int).tolist(),
                'lonlat': lonlat.tolist(),
                'orogenAge': np.round(orogen_age[idx], 1).tolist(),
            }
            total += len(idx)
            n_drawn = len(idx)

        if k % 25 == 0 or k == len(ages) - 1:
            print(f'  {time:5.0f}  {len(sz_lon):10d}  {int(satisfied.sum()):9d}  '
                  f'{n_drawn:5d}')

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'model': args.model,
        'time_step': args.age_step,
        'age_min': 0.0,
        'age_max': args.age_max,
        'decay_myr': args.decay,
        'min_inland_m': args.min_inland,
        'max_trench_m': args.max_trench,
        'candidate_count': int(len(cand_lon)),
        'count': total,
        'frames': frames,
    }
    out.write_text(json.dumps(payload, separators=(',', ':')))
    print(f'\nwrote {out}  ({len(frames)} frames, {total} glyphs, '
          f'{out.stat().st_size / 1e6:.1f} MB)')
    update_manifest(out.parent.parent, args)


def update_manifest(model_dir, args):
    """Add an "oldmap" field to the Reconstruction Model's own manifest.

    Read-modify-write, the same additive pattern prep_boucot.py uses for
    "paleolithology", rather than a full prep_reconstruction.py re-run: this is
    an extra export hung off an already-cataloged model, not a change to it.

    `continents` is recorded but NOT produced here -- it comes from
    deep-time-map's own polygon exporter (see docs/plans/old-map-viewer.md), and
    the field is written only if that file is actually present, so the manifest
    never promises something the archive does not have.
    """
    manifest_path = model_dir / 'manifest.json'
    if not manifest_path.exists():
        print(f'\n  NOTE: {manifest_path} does not exist, so no "oldmap" field '
              'was added. Run prep_reconstruction.py for this model first.')
        return
    manifest = json.loads(manifest_path.read_text())
    entry = {'mountains': 'oldmap/mountains.json',
             'decay_myr': args.decay,
             'age_min': 0.0,
             'age_max': args.age_max}
    if (model_dir / 'oldmap' / 'continents.json').exists():
        entry['continents'] = 'oldmap/continents.json'
    manifest['oldmap'] = entry
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f'updated {manifest_path} with an "oldmap" field'
          + ('' if 'continents' in entry else ' (continents.json not present yet)'))


def brute_force_distance(lats, lons, src_lats, src_lons):
    """True great-circle distance to the nearest source, by exhaustive search.
    O(n*m), and shares no code with the KD-tree path it is used to check."""
    plat, plon = np.radians(lats), np.radians(lons)
    slat, slon = np.radians(src_lats), np.radians(src_lons)
    out = np.empty(len(plat))
    for k in range(len(plat)):
        a = (np.sin((slat - plat[k]) / 2) ** 2
             + np.cos(plat[k]) * np.cos(slat) * np.sin((slon - plon[k]) / 2) ** 2)
        out[k] = 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0, 1))).min()
    return out


def check_distances(model, continent_file, lat_axis, lon_axis, args):
    """Measure the distance machinery instead of asserting it.

    Three things are checked, in order of how much they matter:

      1. The KD-tree query this script actually uses, against brute force. Must
         agree to floating-point noise -- it is the same quantity computed two
         ways, so any real disagreement is a bug.
      2. The notebook's raster scan against the same brute force, to record why
         it was not reused.
      3. That restricting coast sources to ocean-cells-touching-land changes
         nothing, which is the one step above that LOOKS like an approximation.
    """
    import xarray as xr
    from xrspatial import proximity

    time = 100.0
    print(f'distance check at {time:.0f} Ma, sampling {args.sampling} deg\n')
    sz_lon, sz_lat = subduction_points(model, time)
    rng = np.random.default_rng(0)
    iy = rng.integers(0, len(lat_axis), 1500)
    ix = rng.integers(0, len(lon_axis), 1500)
    q_lat, q_lon = lat_axis[iy], lon_axis[ix]

    truth = brute_force_distance(q_lat, q_lon, sz_lat, sz_lon)
    kd = nearest_distance(q_lon, q_lat, sz_lon, sz_lat)
    err = np.abs(kd - truth)
    print(f'1. KD-tree vs brute force, trench field, {len(iy)} cells, '
          f'{len(sz_lon)} sources:')
    print(f'     max |error| = {err.max():.6f} m   mean {err.mean():.9f} m'
          f'   -> {"EXACT" if err.max() < 1e-3 else "MISMATCH -- investigate"}')

    grid = np.zeros((len(lat_axis), len(lon_axis)), dtype=np.uint8)
    gx = np.mod(np.round((sz_lon + 180.0) / args.sampling).astype(int), len(lon_axis))
    gy = np.round((sz_lat - lat_axis[0]) / args.sampling).astype(int)
    ok = (gy >= 0) & (gy < grid.shape[0])
    grid[gy[ok], gx[ok]] = 1
    da = xr.DataArray(grid, coords=[('y', lat_axis), ('x', lon_axis)], name='z')
    scan = proximity(da, target_values=[1], distance_metric='GREAT_CIRCLE').data[iy, ix]
    e = scan - truth
    print(f'\n2. xrspatial raster scan (what the notebook uses) vs brute force:')
    print(f'     mean {e.mean() / 1e3:+8.2f} km   p99 {np.percentile(e, 99) / 1e3:8.2f} km'
          f'   max {e.max() / 1e3:9.2f} km')
    seam = 180.0 - np.abs(q_lon)
    near = seam < 10
    print(f'     within 10 deg of the antimeridian: mean '
          f'{e[near].mean() / 1e3:+8.2f} km over {near.sum()} cells')
    print(f'     elsewhere:                         mean '
          f'{e[~near].mean() / 1e3:+8.2f} km over {(~near).sum()} cells')

    mask = land_mask(continent_file, model.rotation_model, time,
                     args.sampling, args.anchor)
    coast_lon, coast_lat = coastal_ocean_points(mask, lat_axis, lon_axis)
    all_iy, all_ix = np.nonzero(mask == 0)
    land_iy, land_ix = np.nonzero(mask == 1)
    pick = rng.integers(0, len(land_iy), 1500)
    l_lat, l_lon = lat_axis[land_iy[pick]], lon_axis[land_ix[pick]]
    d_coastal = nearest_distance(l_lon, l_lat, coast_lon, coast_lat)
    d_all = nearest_distance(l_lon, l_lat, lon_axis[all_ix], lat_axis[all_iy])
    gap = np.abs(d_coastal - d_all).max()
    print(f'\n3. coast sources restricted to ocean-touching-land '
          f'({len(coast_lon)} of {len(all_ix)} ocean cells):')
    print(f'     max |difference| vs using every ocean cell = {gap:.6f} m'
          f'   -> {"IDENTICAL" if gap < 1e-3 else "NOT identical -- the shortcut is unsafe"}')


if __name__ == '__main__':
    main()
