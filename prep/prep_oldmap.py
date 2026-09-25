#!/usr/bin/env python3
"""Export hachured-mountain glyph positions for the Old Map viewer.

See docs/plans/old-map-viewer.md and docs/adr/0037. The Old Map viewer draws
three style elements; two of them (the coastal wash, the offshore rings) are
screen-space decoration produced in the browser and need no prep at all. This
script produces the third, which is the only one that makes a claim about where
something was:

    a mountain glyph stands where crust is >300 km inland AND <800 km from a
    subduction zone AND on that trench's OVERRIDING side -- and keeps standing,
    fading, for a while after the trench goes away.

Both distances are true great-circle distances, never approximated and never
computed in pixels. That is the whole reason this runs here rather than in the
browser.

The overriding-side clause is the third condition and the one with the most
geology in it; see "Why the side test, and not a plate-id match" below.

Output (default archive/reconstructions/<id>/oldmap/mountains.json):

    {"model": "Merdith2021", "time_step": 1, "decay_myr": 100,
     "count": 121043,
     "frames": {"100": {"id":       [12, 47, ...],        stable candidate id
                        "lonlat":   [-58.1, -22.4, ...],  reconstructed, paired
                        "orogenAge":[0, 34, ...]}}}       Myr since satisfied

`id` is stable across frames so the viewer can fade a glyph rather than blink
it; see "Why the candidates ride plates" below.

Usage:
  python prep/prep_oldmap.py --model Merdith2021
  python prep/prep_oldmap.py --check-distances


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


---- Why the side test, and not a plate-id match ------------------------------

Proximity to a trench says nothing about which plate is being shortened. Without
a side test a glyph appears on the DOWNGOING plate just as readily as on the
overriding one -- measured on Merdith2021, 110 of 270 glyphs at 0 Ma, and 22-41%
across 0-200 Ma, including a band of them out on the Nazca plate beside the
Andes.

The obvious fix is to compare the candidate's plate id with the trench's
overriding plate id. That does not work, for a reason worth recording so it is
not retried: the two ids come from different vocabularies. Candidates are
partitioned against `continent_polygons` (426 distinct ids in Merdith2021,
running to 80121 -- terrane ids), while the overriding plate id comes from a
resolved topology. Only 28 of those 426 ids are also topological plate ids at
0 Ma, and 6 of 426 at 200 Ma, so an equality test deletes almost every mountain.

What is used instead is the geometric side, taken from gpml:subductionPolarity:

    at each trench vertex, left = v x tangent (left-of-travel in vertex order),
    and the overriding side is `left` for polarity 'Left', `-left` for 'Right'.
    A candidate is on that side iff dot(candidate, side) > 0 -- exact, because
    `side` is tangent at the trench point, so the trench itself scores zero.

Three reasons this is the right primitive rather than a fallback:

  - It is the SAME datum the map's subduction teeth are drawn from (see
    petrify/boundaries.py and its verify.check_polarity), so a mountain
    can never appear on the opposite side from the triangles pointing at it.
  - It is always available: 100% of subduction sub-segments carry Left or Right
    at 0, 50, 100, 150 and 200 Ma, where the overriding plate id fails to
    resolve for up to 28% of them (segments not shared by exactly two
    topologies -- model edges and triple junctions).
  - find_overriding_and_subducting_plates() DERIVES the overriding plate from
    this same polarity plus the topology's winding, so the plate id is not an
    independent check on the side. It cannot disagree about which side; it can
    only be missing.

The sign is not asserted. `--check-polarity` probes a point on the claimed
overriding side of each segment and asks the resolved topologies which plate it
landed in; a flipped convention would mirror every trench on the map while
looking entirely plausible. Visually, the same thing shows up as the Andean
glyphs jumping from South America into the Pacific.

KNOWN AND ACCEPTED: continental collision builds mountains on BOTH plates, and
this rule allows them only on the overriding one. At 0 Ma that removes the
Atlas, the Zagros, and the Indian-plate side of the Himalaya, because Africa,
Arabia and India are the downgoing plates there. This was a deliberate choice of
the simple global rule over a continent-continent special case; the alternative
considered was to allow the downgoing side wherever the crust on both sides of
the trench is continental, which the land mask below could support.


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
from collections import namedtuple
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


TrenchSources = namedtuple(
    'TrenchSources', 'xyz side over_id sub_id skipped corrected')


def trench_sources(model, time, tessellate_deg=0.1):
    """Tessellated trench points, each carrying which way the overriding plate is.

    Returns a TrenchSources: `xyz` unit position vectors, `side` unit vectors
    TANGENT at each of those points aimed at the overriding plate, `over_id` the
    overriding plate id per point (-1 where unresolved -- carried for the
    verification in check_polarity, not used by the rule), `skipped` sub-segments
    dropped for want of a usable gpml:subductionPolarity, and `corrected`
    sub-segments whose side was flipped to agree with pygplates.

    Resolved topological SECTIONS, not snapshot.get_boundary_features(): the
    polarity lives on the sub-segment's feature, and the sharing topologies that
    corroborate it are only reachable this way.

    A segment with polarity 'Unknown' or absent is dropped from the source set
    entirely rather than contributed without a side. Contributing it would
    reinstate the original bug on exactly those trenches while the run still
    reported a side test as applied -- a silent partial rule is worse than a
    visibly missing trench. Merdith2021 drops none of these at any age tested;
    the count is printed so another model cannot lose trenches quietly.
    """
    snapshot = model.plate_snapshot(time)
    polygons = {}
    for topology in snapshot.resolved_topologies:
        pid = topology.get_resolved_feature().get_reconstruction_plate_id()
        polygons.setdefault(pid, []).append(topology.get_resolved_boundary())

    xyz, side, over, under = [], [], [], []
    skipped = 0
    corrected = 0
    for section in snapshot.resolved_topological_sections:
        for sub_segment in section.get_shared_sub_segments():
            feature = sub_segment.get_feature()
            if str(feature.get_feature_type()) != 'gpml:SubductionZone':
                continue
            polarity = feature.get_enumeration(
                pygplates.PropertyName.gpml_subduction_polarity)
            if polarity not in ('Left', 'Right'):
                skipped += 1
                continue
            geometry = sub_segment.get_resolved_geometry()
            if geometry is None or len(geometry.get_points()) < 2:
                skipped += 1
                continue

            ll = np.asarray(
                geometry.to_tessellated(np.radians(tessellate_deg)).to_lat_lon_list())
            v = lonlat_to_xyz(ll[:, 1], ll[:, 0])

            # Unit tangent in VERTEX ORDER, which is what 'Left'/'Right' are
            # named against. Forward difference; the last vertex reuses the
            # previous tangent because there is no vertex after it.
            t = np.diff(v, axis=0)
            t = np.vstack([t, t[-1:]])
            # Project onto the tangent plane -- a chord between two vertices has
            # a radial component, and near the poles it is not negligible.
            t -= np.sum(t * v, axis=1)[:, None] * v
            norm = np.linalg.norm(t, axis=1)
            good = norm > 1e-12
            t[good] /= norm[good][:, None]

            # v x tangent is left-of-travel on the sphere: at a point on the
            # equator heading north it points west. Same construction as
            # petrify.verify.check_polarity, which is what validates it.
            left = np.cross(v, t)
            s = (left if polarity == 'Left' else -left)

            # Corroborate against pygplates' own answer, and flip where they
            # disagree. They CAN disagree: both start from the same polarity, but
            # this builds the side from the resolved geometry's vertex order
            # while find_overriding_and_subducting_plates() uses the topology's
            # winding and reversal flags. Measured on Merdith2021 over 0-200 Ma,
            # 3 of 260 segments disagree -- two are degenerate slivers a few
            # hundred metres long at triple junctions, but one is 1.34 deg and
            # stays flipped at a 27x finer probe, so it is a real inconsistency
            # and not a resolution artefact. One probe per SEGMENT, not per
            # point, so this is cheap.
            flipped, over_id, sub_id = _probe_verdict(
                v, s, sub_segment, time, polygons)
            if flipped:
                s = -s
                corrected += 1

            xyz.append(v[good])
            side.append(s[good])
            over.append(np.full(int(good.sum()), over_id, dtype=np.int64))
            under.append(np.full(int(good.sum()), sub_id, dtype=np.int64))

    if not xyz:
        return TrenchSources(np.zeros((0, 3)), np.zeros((0, 3)),
                             np.zeros(0, dtype=np.int64),
                             np.zeros(0, dtype=np.int64), skipped, corrected)
    return TrenchSources(np.vstack(xyz), np.vstack(side), np.concatenate(over),
                         np.concatenate(under), skipped, corrected)


# How far off a trench to step when asking which plate is on a side. Large enough
# to clear coordinate rounding, small enough to stay inside a narrow plate.
# Measured: 0.25 and 0.05 deg return identical verdicts on every Merdith2021
# segment, while 0.75 leaves four more segments indeterminate.
PROBE_DEG = 0.25


def _probe_verdict(v, side, sub_segment, time, polygons):
    """(should_flip, overriding_plate_id, subducting_plate_id).

    should_flip is True only where a probe onto the claimed overriding side lands
    unambiguously in the SUBDUCTING plate. Only an unambiguous answer counts: a
    probe landing in a third plate or outside every polygon -- which happens at
    triple junctions -- is not evidence either way, and treating it as evidence
    would flip trenches on no information. overriding_plate_id is -1 where
    pygplates could not resolve it.
    """
    import contextlib
    import io
    from gprm.utils.geometry import find_overriding_and_subducting_plates

    with contextlib.redirect_stderr(io.StringIO()):
        resolved = find_overriding_and_subducting_plates(sub_segment, time)
    if resolved is None:
        return False, -1, -1
    over_id = resolved[0].get_resolved_feature().get_reconstruction_plate_id()
    sub_id = resolved[1].get_resolved_feature().get_reconstruction_plate_id()

    i = len(v) // 2
    r = np.radians(PROBE_DEG)
    p = v[i] * np.cos(r) + side[i] * np.sin(r)
    point = pygplates.PointOnSphere(
        float(np.degrees(np.arcsin(np.clip(p[2], -1.0, 1.0)))),
        float(np.degrees(np.arctan2(p[1], p[0]))))
    in_over = any(q.is_point_in_polygon(point) for q in polygons.get(over_id, []))
    in_sub = any(q.is_point_in_polygon(point) for q in polygons.get(sub_id, []))
    return (in_sub and not in_over), over_id, sub_id


def subduction_points(model, time):
    """Trench positions alone, as (lons, lats) -- for the distance check, which
    is about the search and not about polarity."""
    xyz = trench_sources(model, time).xyz
    if not len(xyz):
        return np.zeros(0), np.zeros(0)
    return (np.degrees(np.arctan2(xyz[:, 1], xyz[:, 0])),
            np.degrees(np.arcsin(np.clip(xyz[:, 2], -1.0, 1.0))))


def nearest_trench(query_lons, query_lats, trench_xyz, trench_side):
    """(distance_m, on_overriding_side) for each query point.

    The side test is `dot(candidate, side_at_nearest_trench_point) > 0`. It is
    exact rather than a small-angle approximation: `side` is tangent at its own
    trench point, so that point scores exactly zero and the sign is purely which
    way the candidate is displaced from the trench.
    """
    if not len(trench_xyz):
        return (np.full(len(query_lons), np.inf),
                np.zeros(len(query_lons), dtype=bool))
    q = lonlat_to_xyz(query_lons, query_lats)
    chord, idx = cKDTree(trench_xyz).query(q, k=1)
    return chord_to_great_circle(chord), np.sum(q * trench_side[idx], axis=1) > 0


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
    ap.add_argument('--check-polarity', action='store_true',
                    help='verify that the overriding-side vectors really point at '
                         'the overriding plate, by probing the resolved topologies; '
                         'then exit')
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

    if args.check_polarity:
        check_polarity(model, args)
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
    skipped_total = 0
    corrected_total = 0
    wrong_side_total = 0
    near_total = 0
    print(f'\n  {"age":>5s}  {"trench pts":>10s}  {"near":>5s}  {"wrong side":>10s}  '
          f'{"satisfied":>9s}  {"drawn":>5s}')
    for k, time in enumerate(ages):
        mask = land_mask(continent_file, model.rotation_model, float(time),
                         args.sampling, args.anchor)
        coast_lon, coast_lat = coastal_ocean_points(mask, lat_axis, lon_axis)
        trench = trench_sources(model, float(time))
        skipped_total += trench.skipped
        corrected_total += trench.corrected

        rlon, rlat = reconstruct_candidates(cand_lon, cand_lat, cand_plate,
                                            model.rotation_model, float(time), args.anchor)
        d_inland = nearest_distance(rlon, rlat, coast_lon, coast_lat)
        d_trench, on_overriding = nearest_trench(rlon, rlat, trench.xyz, trench.side)

        # Reported, not just applied: "near a trench but on the downgoing plate"
        # is the population this rule exists to exclude, so its size travels with
        # every run rather than being something a future reader has to re-derive.
        near = (d_inland > args.min_inland) & (d_trench < args.max_trench)
        satisfied = near & on_overriding
        near_total += int(near.sum())
        wrong_side_total += int((near & ~on_overriding).sum())
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
            print(f'  {time:5.0f}  {len(trench.xyz):10d}  {int(near.sum()):5d}  '
                  f'{int((near & ~on_overriding).sum()):10d}  '
                  f'{int(satisfied.sum()):9d}  {n_drawn:5d}')

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'model': args.model,
        'time_step': args.age_step,
        'age_min': 0.0,
        'age_max': args.age_max,
        'decay_myr': args.decay,
        'min_inland_m': args.min_inland,
        'max_trench_m': args.max_trench,
        # What the third condition was. Recorded in the payload because a glyph
        # set built without it looks entirely plausible -- the difference is
        # which SIDE of a trench the mountains sit on, which no count reveals.
        'overriding_side_only': True,
        'candidate_count': int(len(cand_lon)),
        'count': total,
        'frames': frames,
    }
    out.write_text(json.dumps(payload, separators=(',', ':')))
    print(f'\nwrote {out}  ({len(frames)} frames, {total} glyphs, '
          f'{out.stat().st_size / 1e6:.1f} MB)')
    if near_total:
        print(f'overriding-side rule: {wrong_side_total} of {near_total} '
              f'near-trench candidate-frames ({100 * wrong_side_total / near_total:.0f}%) '
              f'were on the downgoing plate and are excluded')
    if corrected_total:
        print(f'  {corrected_total} sub-segment-frames had their side flipped to agree '
              'with find_overriding_and_subducting_plates()')
    if skipped_total:
        print(f'WARNING: {skipped_total} subduction sub-segment-frames had no usable '
              'gpml:subductionPolarity and contributed NO trench sources at all')
    update_manifest(out.parent.parent, args)


def update_manifest(model_dir, args):
    """Add an "oldmap" field to the Reconstruction Model's own manifest.

    Read-modify-write, the same additive pattern prep_boucot.py uses for
    "paleolithology", rather than a full prep_reconstruction.py re-run: this is
    an extra export hung off an already-cataloged model, not a change to it.

    `continents` is recorded but NOT produced here -- it comes from
    petrify's own polygon exporter (see docs/plans/old-map-viewer.md), and
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


def check_polarity(model, args):
    """Do the side vectors the export actually uses point at the overriding plate?

    Verifies `trench_sources()`'s OUTPUT rather than re-deriving it, which
    matters: the sides are built from gpml:subductionPolarity and vertex order
    and then corrected against find_overriding_and_subducting_plates(), so a
    check that recomputed the raw construction would grade something the export
    does not use.

    The whole rule rests on one sign, and getting it backwards mirrors every
    trench while looking entirely plausible -- the Andean glyphs would sit in the
    Pacific instead of on South America. So every tessellated trench point is
    probed: step PROBE_DEG along its claimed overriding side and ask the resolved
    topologies which plate the probe landed in.

    Points landing in a third plate or outside every polygon are indeterminate,
    not failures -- that is ordinary near triple junctions and where a narrow
    plate is thinner than the probe.
    """
    print(f'polarity check, {args.model}, probe {PROBE_DEG} deg, '
          f'verifying trench_sources() output\n')
    print(f'  {"age":>5s}  {"points":>7s}  {"agree":>7s}  {"FLIPPED":>7s}  '
          f'{"indet":>6s}  {"unresolved":>10s}  {"corrected":>9s}')
    bad = 0
    for time in (0.0, 50.0, 100.0, 150.0, 200.0):
        snapshot = model.plate_snapshot(time)
        polygons = {}
        for topology in snapshot.resolved_topologies:
            pid = topology.get_resolved_feature().get_reconstruction_plate_id()
            polygons.setdefault(pid, []).append(topology.get_resolved_boundary())

        trench = trench_sources(model, time)
        agree = flipped = indeterminate = unresolved = 0
        # Every 20th point: the tessellation is 0.1 deg, so consecutive points
        # sit far closer together than the probe and test the same thing.
        for i in range(0, len(trench.xyz), 20):
            over_id, sub_id = int(trench.over_id[i]), int(trench.sub_id[i])
            if over_id < 0:
                unresolved += 1
                continue
            r = np.radians(PROBE_DEG)
            p = trench.xyz[i] * np.cos(r) + trench.side[i] * np.sin(r)
            point = pygplates.PointOnSphere(
                float(np.degrees(np.arcsin(np.clip(p[2], -1.0, 1.0)))),
                float(np.degrees(np.arctan2(p[1], p[0]))))
            in_over = any(q.is_point_in_polygon(point)
                          for q in polygons.get(over_id, []))
            in_sub = any(q.is_point_in_polygon(point)
                         for q in polygons.get(sub_id, []))
            if in_over and not in_sub:
                agree += 1
            elif in_sub and not in_over:
                flipped += 1
            else:
                indeterminate += 1

        bad += flipped
        print(f'  {time:5.0f}  {len(trench.xyz):7d}  {agree:7d}  {flipped:7d}  '
              f'{indeterminate:6d}  {unresolved:10d}  {trench.corrected:9d}')

    # A SIGN error -- the failure this check exists to catch -- is all-or-nothing:
    # swapping Left and Right mirrors every trench, and the flipped count would be
    # most of the sample, not a trickle. So the threshold is deliberately loose,
    # and the residual is reported rather than hidden.
    #
    # Measured on Merdith2021: 2 of 1495 sampled points (0.13%), at 150 and 200 Ma,
    # on segments whose own midpoint probe was correct -- so the per-segment
    # correction did not reach them. The likely cause is untested: either the last
    # vertex of a segment reusing the previous tangent across a sharp corner, or a
    # plate narrower than the 0.25 deg probe. It is 2 points out of ~6000 per frame
    # feeding a decorative glyph, and it was not chased further.
    total_graded = bad + 1  # avoid a zero denominator on an empty model
    print(f'\n  {bad} flipped')
    print('  ' + ('PASS -- no systematic sign error'
                  if bad <= max(5, total_graded // 100) else
                  f'FAIL -- {bad} trench points face the SUBDUCTING plate, which is '
                  'too many to be triple-junction noise; suspect a flipped convention'))


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
