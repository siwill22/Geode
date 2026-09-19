#!/usr/bin/env python3
"""Export volcano-symbol positions for the Old Map viewer.

A companion to prep_oldmap.py, which produces the mountain glyphs. Same viewer,
same model, same output directory, deliberately a separate file: the mountain
rule is about where crust is being shortened, and these are about where magma
reaches the surface. They share only geometry helpers.

Two populations, and they are NOT the same kind of thing:

  ridge   Evenly spaced along resolved mid-ocean ridges. These are features of
          the plate boundary network, resolved afresh at every frame, so they
          have no identity from frame to frame -- exactly like the trench points
          in prep_oldmap.py and unlike its mountain candidates.

  plume   Named hotspots in the MANTLE reference frame. These do not ride
          plates; the plates ride over them. Deep plumes only (Whittaker's
          PlumeType), in the ocean only.

  lip     Large Igneous Province eruption sites, drawn for a window around each
          province's own age. Independent of the plumes: a LIP compilation
          already records where the province is and how old it is, so nothing
          here needs a hotspot to vouch for one. An earlier version paired them
          geometrically and found an age for 1 of 16, which was a way of losing
          LIPs rather than of placing them.

Output (default archive/reconstructions/<id>/oldmap/volcanoes.json):

    {"model": "Merdith2021", "time_step": 1, ...
     "frames": {"100": {"ridge": [lon, lat, ...],
                        "plume": {"name": [...], "lonlat": [...]},
                        "lip":   {"name": [...], "lonlat": [...]}}}}

Three independent populations. The viewer decides how each is drawn -- small for
ridge and plume, large for lip -- and prep only says where they are.

Usage:
  conda run -n pygmt17 python prep/prep_oldmap_volcanoes.py --model Merdith2021
  conda run -n pygmt17 python prep/prep_oldmap_volcanoes.py --resolve-names


---- Why the plumes are in the mantle frame -----------------------------------

A mountain candidate is partitioned onto a plate and rotated with it, because
crust moves. A plume is the opposite claim: it is a feature of the deep mantle
that the plate slides over, which is the whole reason a hotspot track is a line
of progressively older volcanoes rather than a single point.

`Hotspot_Surface_Motion_PD2012` carries PLATEID1 = 0 for every record, so
positions are already absolute and must NOT be reconstructed with a plate
rotation. Doing so would drag Hawaii across the Pacific with the Pacific plate
and destroy the one thing the dataset exists to record.

The dataset gives each hotspot its own position at each age -- plumes are not
held fixed, they drift slowly in the mantle -- which is why this reads positions
per frame rather than taking a present-day coordinate and leaving it there.


---- What is NOT decided here -------------------------------------------------

Which plumes count as DEEP. Nothing in the hotspot dataset records depth of
origin: the attribute table is Hotspot/Age/Longitude/Latitude/Value/PLATEID1/
TYPE/FROMAGE/TOAGE/DESCR, TYPE is 'HS' for all 2831 records and DESCR is the
model name. Li et al. (2023)'s LIPs_plume_centres.shp does carry a `Criteria`
field, but it describes how the centre was LOCATED (radiating dyke swarm,
extrapolated linear swarm, ...) and not where it came from, and only 17 of its
130 centres are younger than 200 Ma.

So `--deep-list` takes a file, and without one every hotspot is exported with
`deep` unset. A list of primary/deep plumes written from recollection is exactly
the invented reference table this project has been bitten by before, so it is
not attempted here.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pygplates

sys.path.insert(0, str(Path(__file__).parent))
from prep_oldmap import (EARTH_RADIUS_M, build_grid, chord_to_great_circle,
                         land_mask, lonlat_to_xyz)

EARTH_RADIUS_KM = EARTH_RADIUS_M / 1000.0

# Torsvik & Cocks (2017) hotspot surface-motion model, as cached by gprm. Named
# explicitly rather than discovered by glob: a different hotspot file with the
# same columns would change every plume position with nothing on screen to say so.
# Asked of gprm rather than written out: the cache is ~/Library/Caches/gprm on macOS
# but ~/.cache/gprm on Linux, so a literal path silently fails on the wrong platform.
from gprm.datasets import cache_path  # noqa: E402

HOTSPOT_SHP = cache_path('TorsvikCocks2017', 'Hotspot_Surface_Motion_PD2012.shp')

# LIP compilations exported by the StoryMaps LIPs build, all reconstructed under
# Merdith2021 -- the same model the Old Map viewer uses, which is what makes it
# legitimate to pair them (ADR-0004).
#
# NOT self-contained: this is a separate, unpublished repo. Override with $GEODE_LIP_DIR.
LIP_DIR = Path(os.environ.get('GEODE_LIP_DIR',
                              Path.home() / 'GIT' / 'StoryMaps' / 'lips' / 'data'))

# Whittaker's hotspot catalogue -- what says a plume is DEEP, and the reason this
# script does not guess. A second copy exists at
# data/LIPs/LIPS2014/WhittakerHotSpotCatalogue with the same 68 features and
# different columns (Trail, Region, KeyRef, real PlateID1). It is NOT read: the
# only field it adds is Region, which this file already carries as DESCR, and
# joining the two on FEATURE_ID fails because not every record in that copy has
# one. One file, no join, no partial merge.
#
# NOT self-contained: a local copy with no recorded provenance. Override with
# $GEODE_WHITTAKER_HOTSPOTS.
WHITTAKER_JW = Path(os.environ.get(
    'GEODE_WHITTAKER_HOTSPOTS',
    Path.home() / 'data' / 'LIPs' / 'Shapefiles' / 'HotSpotCatalogue'
    / 'JW_HotspotCatalogue.shp'))

# PlumeType values counted as deep by default. The catalogue's own Type_1 column
# is exactly this pair -- verified across all 68 records, 13 'Deep' and 10
# 'Potentially Deep' have Type_1 = 1 and the other 45 have 0 -- so this default
# reproduces the compiler's own binary rather than imposing a new one. The
# remaining values are 'Secondary/Tertiary' (20), '?' (17), 'mid-mantle' (5) and
# 'upper mantle' (3).
DEEP_TYPES = ('Deep', 'Potentially Deep')


# --------------------------------------------------------------------------- ridges

def ridge_points(snapshot, spacing_km):
    """Evenly spaced points along every resolved mid-ocean ridge.

    Returns (lons, lats, sampled_km, dropped_km).

    Spacing is measured along each sub-segment separately, starting half a
    spacing in. Carrying a remainder across segments would make the result
    depend on the order pygplates happens to return them in, which is not a
    property of the Earth; starting each segment at half a spacing keeps the
    density right without clustering glyphs at segment ends.

    A segment shorter than half a spacing gets no volcano at all. `dropped_km`
    reports how much ridge that silently discards, because "some ridges have no
    symbol" should be a number someone can look at rather than a surprise.
    """
    lons, lats = [], []
    sampled = dropped = 0.0
    for section in snapshot.resolved_topological_sections:
        for sub_segment in section.get_shared_sub_segments():
            if str(sub_segment.get_feature().get_feature_type()) != 'gpml:MidOceanRidge':
                continue
            geometry = sub_segment.get_resolved_geometry()
            if geometry is None or len(geometry.get_points()) < 2:
                continue
            length_km = geometry.get_arc_length() * EARTH_RADIUS_KM
            if length_km < spacing_km / 2:
                dropped += length_km
                continue
            sampled += length_km

            # Cumulative arc length along a finely tessellated copy, then pick
            # the vertices nearest each target distance. Tessellating first keeps
            # this on great circles rather than interpolating in lon/lat, which
            # would cut corners worst near the poles.
            ll = np.asarray(
                geometry.to_tessellated(np.radians(0.1)).to_lat_lon_list())
            v = lonlat_to_xyz(ll[:, 1], ll[:, 0])
            step = np.arccos(np.clip(np.sum(v[:-1] * v[1:], axis=1), -1, 1))
            cumulative = np.concatenate([[0.0], np.cumsum(step)]) * EARTH_RADIUS_KM
            targets = np.arange(spacing_km / 2, cumulative[-1], spacing_km)
            idx = np.searchsorted(cumulative, targets)
            idx = np.clip(idx, 0, len(ll) - 1)
            lons.extend(ll[idx, 1].tolist())
            lats.extend(ll[idx, 0].tolist())
    return np.asarray(lons), np.asarray(lats), sampled, dropped


# --------------------------------------------------------------------------- plumes

def load_hotspots(path=HOTSPOT_SHP):
    """{name: (ages, lons, lats)} from the hotspot surface-motion model.

    One shapefile record per (hotspot, age). PLATEID1 is 0 throughout -- these
    are absolute mantle-frame positions and are never reconstructed with a plate
    rotation; see the module docstring.
    """
    if not path.exists():
        raise SystemExit(
            f'{path} not found. It ships with gprm\'s TorsvikCocks2017 bundle; '
            'fetch that model once and it will be cached.')
    rows = {}
    for feature in pygplates.FeatureCollection(str(path)):
        attributes = feature.get_shapefile_attributes()
        rows.setdefault(attributes['Hotspot'], []).append(
            (float(attributes['Age']), float(attributes['Longitude']),
             float(attributes['Latitude'])))
    out = {}
    for name, records in rows.items():
        records.sort()
        arr = np.asarray(records)
        out[name] = (arr[:, 0], arr[:, 1], arr[:, 2])
    return out


def plume_positions(hotspots, time, tolerance_myr=1.0):
    """(names, lons, lats) for every hotspot the model covers at `time`.

    A hotspot whose track does not reach this age is ABSENT, not held at its
    oldest position. The model runs 0-140 Ma, so plumes genuinely stop before the
    viewer's 200 Ma limit, and freezing them there would draw a stationary
    hotspot for 60 Myr of invented history.
    """
    names, lons, lats = [], [], []
    for name, (ages, lon, lat) in hotspots.items():
        i = int(np.argmin(np.abs(ages - time)))
        if abs(ages[i] - time) > tolerance_myr:
            continue
        names.append(name)
        lons.append(float(lon[i]))
        lats.append(float(lat[i]))
    return names, np.asarray(lons), np.asarray(lats)


def in_ocean(lons, lats, mask, lat_axis, lon_axis):
    """Boolean per point: is this position off continental crust at this age?

    Uses prep_oldmap's own land mask, so "ocean" means exactly what it means for
    the mountain rule -- outside the model's reconstructed continent polygons --
    rather than a second, subtly different definition.
    """
    if not len(lons):
        return np.zeros(0, dtype=bool)
    iy = np.clip(np.round((lats - lat_axis[0]) / (lat_axis[1] - lat_axis[0])
                          ).astype(int), 0, len(lat_axis) - 1)
    ix = np.mod(np.round((lons - lon_axis[0]) / (lon_axis[1] - lon_axis[0])
                         ).astype(int), len(lon_axis))
    return mask[iy, ix] == 0


# --------------------------------------------------------------------------- LIPs

def load_lips(key):
    """[(name, age_ma, [(plate_id, lon, lat), ...])] from one compilation.

    Grouped by LIP NAME, not by the file's own feature key. The compilations
    store a fragmented province as several independent entries -- Park 2020 has
    55 entries for 33 LIPs, with Caribbean-Colombian alone split ten ways -- and
    treating each fragment as a separate LIP counts one eruption ten times and
    reports ten nearly identical rows.

    Each fragment keeps its OWN plate id and present-day centroid, because
    fragments of one province can end up on different plates; they are
    reconstructed separately and combined only afterwards, at their shared
    eruption age.
    """
    path = LIP_DIR / f'lips_{key}.json'
    if not path.exists():
        raise SystemExit(f'{path} not found (compilations: '
                         f'{sorted(p.stem for p in LIP_DIR.glob("lips_*.json"))})')
    payload = json.loads(path.read_text())
    meta = payload['lips']
    grouped = {}
    for feature in payload['features']:
        entry = meta.get(feature['n'].split(':')[-1], {}) if isinstance(meta, dict) else {}
        name = entry.get('name', feature['n'])
        age = float(entry.get('age', feature['b']))
        xy = np.asarray(feature['xy']).reshape(-1, 2)
        v = lonlat_to_xyz(xy[:, 0], xy[:, 1]).mean(axis=0)
        n = np.linalg.norm(v)
        if n < 1e-12:
            continue
        v /= n
        grouped.setdefault((name, age), []).append((
            int(feature['p']),
            float(np.degrees(np.arctan2(v[1], v[0]))),
            float(np.degrees(np.arcsin(np.clip(v[2], -1, 1)))),
        ))
    out = [(name, age, parts) for (name, age), parts in grouped.items()]
    return out, payload.get('source', ''), payload.get('note', '')


def reconstructed_centre(parts, age, rotation_model, anchor=0):
    """(lon, lat) of a LIP at its eruption age, averaging its fragments AFTER
    each has been rotated by its own plate."""
    vectors = []
    for plate_id, lon, lat in parts:
        rotation = rotation_model.get_rotation(age, plate_id, anchor_plate_id=anchor)
        rlat, rlon = (rotation * pygplates.PointOnSphere(lat, lon)).to_lat_lon()
        vectors.append(lonlat_to_xyz(np.asarray([rlon]), np.asarray([rlat]))[0])
    v = np.mean(vectors, axis=0)
    n = np.linalg.norm(v)
    if n < 1e-12:
        return None
    v /= n
    return (float(np.degrees(np.arctan2(v[1], v[0]))),
            float(np.degrees(np.arcsin(np.clip(v[2], -1, 1)))))


def lip_sites(lips, time, window_myr, rotation_model, anchor=0):
    """(names, lons, lats) for every LIP erupting at `time`.

    A LIP is its own eruption site. Nothing here consults a plume: the
    compilation already records where the province is and how old it is, so
    pairing it with a hotspot first was an unnecessary step that could only lose
    LIPs -- and did, leaving 1 of 16.

    Each fragment is rotated by its own plate id and then combined, so a province
    split across plates lands in one place rather than smeared between them.
    """
    names, lons, lats = [], [], []
    for name, age, parts in lips:
        if abs(time - age) > window_myr / 2:
            continue
        centre = reconstructed_centre(parts, float(time), rotation_model, anchor)
        if centre is None:
            continue
        names.append(name)
        lons.append(centre[0])
        lats.append(centre[1])
    return names, np.asarray(lons), np.asarray(lats)


# --------------------------------------------------------------------------- main

def normalise(name):
    """Hotspot names for comparison across compilations: letters only, lowercased.

    Enough to bridge 'Cape_Verde' vs 'Cape Verde'. Deliberately NOT enough to
    bridge 'Tahiti_Society' vs 'Tahiti' or 'Tristan_da_Cunha' vs 'Tristan' --
    those need a judgement about whether two compilations mean the same plume,
    and a hand-written equivalence table invented here is exactly the kind of
    reference data this project has been burned by. They are REPORTED as
    unmatched instead, for a person to resolve.
    """
    # Alphanumeric, NOT letters-only: the catalogue contains both 'Caroline'
    # and 'Caroline2', which a letters-only rule collapses into one key, silently
    # dropping a hotspot (68 records became 67). Keeping digits makes them
    # distinct, so 'Caroline2' is reported as having no track instead of quietly
    # overwriting 'Caroline'.
    return ''.join(c for c in str(name).lower() if c.isalnum())


# Resolving a Whittaker hotspot name to a motion-model track name by POSITION.
# Both compilations carry a present-day coordinate, so "is Whittaker's
# Tristan_da_Cunha the motion model's Tristan" is measurable rather than
# remembered. Thresholds come from a control run over the plumes that DO match by
# name (--resolve-names): those sit at 8-391 km, median 79.
#
# The gap test is not belt-and-braces. In the control, Macdonald's nearest
# neighbour is Tahiti at 1128 km rather than its own name-matched track, so
# nearest-position alone demonstrably mis-assigns where two hotspots are close.
# Requiring the runner-up to be far away is what makes a match safe.
ALIAS_MAX_KM = 400.0
ALIAS_MIN_RATIO = 3.0


def resolve_track_names(catalogue, hotspots, extra_aliases=None, verbose=True):
    """{whittaker name: motion-model name} for plumes whose names differ.

    Exact (normalised) name matches are not included -- they need no alias. A
    positional alias is accepted only when all three hold:

      - within ALIAS_MAX_KM at present day,
      - the runner-up is at least ALIAS_MIN_RATIO times further,
      - the target track is not already claimed by an exact name match.

    The third rule is what stops Cook-Austral being aliased onto Macdonald's
    track, which Macdonald itself already owns; two plumes sharing one track
    would draw one symbol and silently lose the other.

    Everything rejected is printed with its distance, so a pairing this declines
    to make can be forced with --alias rather than argued with.
    """
    names0, lon0, lat0 = plume_positions(hotspots, 0.0)
    if not names0:
        return dict(extra_aliases or {})
    v0 = lonlat_to_xyz(lon0, lat0)
    claimed = {normalise(n) for n in hotspots} & {normalise(e['name'])
                                                  for e in catalogue.values()}

    aliases = {}
    rejected = []
    for entry in sorted(catalogue.values(), key=lambda e: e['name']):
        name = entry['name']
        if normalise(name) in {normalise(n) for n in hotspots}:
            continue
        here = lonlat_to_xyz(np.asarray([entry['lon']]), np.asarray([entry['lat']]))
        d = chord_to_great_circle(np.linalg.norm(v0 - here, axis=1)) / 1000.0
        order = np.argsort(d)
        best, second = names0[order[0]], d[order[1]] if len(order) > 1 else np.inf
        why = None
        if d[order[0]] > ALIAS_MAX_KM:
            why = f'{d[order[0]]:.0f} km away'
        elif second < ALIAS_MIN_RATIO * d[order[0]]:
            why = (f'ambiguous: {best} {d[order[0]]:.0f} km vs '
                   f'{names0[order[1]]} {second:.0f} km')
        elif normalise(best) in claimed:
            why = f'{best} is already claimed by its own name match'
        elif best in aliases.values():
            why = (f'{best} was already aliased from '
                   f'{next(k for k, v in aliases.items() if v == best)}')
        if why:
            rejected.append((name, why))
        else:
            aliases[name] = best

    if verbose:
        for name, target in sorted(aliases.items()):
            print(f'  alias by position: {name} -> {target}')
        for name, why in rejected:
            print(f'  NOT aliased: {name} -- {why}')
    aliases.update(extra_aliases or {})
    return aliases


def load_whittaker_catalogue():
    """{normalised name: {name, plume_type, deep, lip_assoc, source, region}}."""
    if not WHITTAKER_JW.exists():
        raise SystemExit(f'{WHITTAKER_JW} not found -- the Whittaker hotspot '
                         'catalogue is what classifies a plume as deep.')
    out = {}
    for feature in pygplates.FeatureCollection(str(WHITTAKER_JW)):
        a = feature.get_shapefile_attributes()
        name = a['HotspotNam']
        out[normalise(name)] = {
            'name': name,
            'plume_type': a['PlumeType'],
            'deep': a['PlumeType'] in DEEP_TYPES,
            # Whittaker records WHETHER a hotspot has an associated LIP, not
            # which one: there is no LIP name or age anywhere in the catalogue,
            # and matching by name recovers only 1 of the 16 deep LIPAss
            # hotspots (Iceland). So this flags eligibility for the eruption
            # pulse; the age has to come from somewhere else.
            'lip_assoc': str(a['LIPAss']) == '1',
            'source': a['Source'],
            'region': a.get('DESCR', ''),
            'lon': float(a['Long']),
            'lat': float(a['Lat']),
        }
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default='Merdith2021')
    ap.add_argument('--id', help='catalog id (default: --model lowercased)')
    ap.add_argument('--age-max', type=float, default=200.0)
    ap.add_argument('--age-step', type=float, default=1.0)
    ap.add_argument('--sampling', type=float, default=0.25,
                    help='land-mask cell size in degrees, for the ocean test')
    ap.add_argument('--ridge-spacing', type=float, default=500.0,
                    help='km between ridge volcanoes; ~100,000 km of ridge means '
                         '500 km gives about 200 glyphs, comparable to the mountains')
    ap.add_argument('--lips', default='park',
                    help='LIP compilation key (park, park_remnant, earthbyte, jw)')
    ap.add_argument('--lip-window', type=float, default=10.0,
                    help='Myr a LIP eruption site stays drawn, centred on its age')
    ap.add_argument('--deep-types', default=','.join(DEEP_TYPES),
                    help="Whittaker PlumeType values counted as deep. Default "
                         "reproduces the catalogue's own Type_1 binary; pass "
                         "'Deep' alone for the strict 13")
    ap.add_argument('--all-plumes', action='store_true',
                    help='ignore the depth classification entirely')
    ap.add_argument('--alias', action='append', default=[], metavar='WHITTAKER=TRACK',
                    help='force a name equivalence the positional test declines '
                         'to make, e.g. --alias Bouvet_Shona=Meteor. Repeatable.')
    ap.add_argument('--resolve-names', action='store_true',
                    help='print the name resolution between the catalogue and '
                         'the motion model, then exit')
    ap.add_argument('--anchor', type=int, default=0)
    ap.add_argument('--out', type=Path, default=None)
    args = ap.parse_args()

    recon_id = args.id or args.model.lower()
    out = args.out or (Path('archive/reconstructions') / recon_id
                       / 'oldmap' / 'volcanoes.json')

    from gprm.datasets import Reconstructions
    fetch = getattr(Reconstructions, f'fetch_{args.model}', None)
    if fetch is None:
        raise SystemExit(f'unknown model {args.model!r}')
    model = fetch()

    hotspots = load_hotspots()
    covered = max(a.max() for a, _lo, _la in hotspots.values())
    print(f'{len(hotspots)} hotspots, tracks reaching {covered:.0f} Ma')

    lips, lip_source, lip_note = load_lips(args.lips)
    print(f'{len(lips)} LIPs from {args.lips!r}: {lip_source}')

    catalogue = load_whittaker_catalogue()
    extra = dict(a.split('=', 1) for a in args.alias)
    print('\nresolving catalogue names against the motion model:')
    aliases = resolve_track_names(catalogue, hotspots, extra)
    for k, v in extra.items():
        print(f'  alias forced by --alias: {k} -> {v}')
    if args.resolve_names:
        return

    wanted = tuple(t.strip() for t in args.deep_types.split(','))
    deep_names = {e['name'] for e in catalogue.values() if e['plume_type'] in wanted}
    print(f'Whittaker catalogue: {len(catalogue)} hotspots, '
          f'{len(deep_names)} with PlumeType in {wanted}')

    # Which deep plumes actually have a track to be drawn along. Reported, not
    # silently dropped: a deep plume with no track simply never appears, and
    # that should be a list someone can read rather than a hole in the map.
    if args.all_plumes:
        deep = None
        print('--all-plumes: no depth filter applied')
    else:
        # A deep plume's track is either its own name or an alias resolved above.
        wanted_tracks = set()
        missing = []
        for d in sorted(deep_names):
            if normalise(d) in {normalise(n) for n in hotspots}:
                wanted_tracks.add(next(n for n in hotspots if normalise(n) == normalise(d)))
            elif d in aliases:
                wanted_tracks.add(aliases[d])
            else:
                missing.append(d)
        deep = wanted_tracks
        print(f'  {len(deep)} of those have a track in the motion model')
        if missing:
            print(f'  NO TRACK, so never drawn: {missing}')

    lat_axis, lon_axis = build_grid(args.sampling)
    continent_file = model.continent_polygons[0]

    frames = {}
    n_ridge = n_plume = n_erupting = 0
    ridge_dropped_km = 0.0
    print(f'\n  {"age":>5s}  {"ridge":>6s}  {"plume":>6s}  {"lip":>8s}')
    for time in np.arange(0.0, args.age_max + args.age_step / 2, args.age_step):
        snapshot = model.plate_snapshot(float(time))
        mask = land_mask(continent_file, model.rotation_model, float(time),
                         args.sampling, args.anchor)

        rlon, rlat, _sampled, dropped = ridge_points(snapshot, args.ridge_spacing)
        ridge_dropped_km += dropped

        names, plon, plat = plume_positions(hotspots, float(time))
        if names:
            visible = in_ocean(plon, plat, mask, lat_axis, lon_axis)
            if deep is not None:
                visible &= np.array([n in deep for n in names])
            keep = np.nonzero(visible)[0]
        else:
            keep = np.zeros(0, dtype=int)

        # LIP eruption sites, entirely independent of the plumes. A LIP knows
        # where it is and how old it is, so it needs no hotspot to vouch for it.
        lip_names, llon, llat = lip_sites(lips, float(time), args.lip_window,
                                          model.rotation_model, args.anchor)

        def pairs(lon, lat):
            out = np.empty(2 * len(lon))
            if len(lon):
                out[0::2] = np.round(lon, 2)
                out[1::2] = np.round(lat, 2)
            return out.tolist()

        frames[str(int(time))] = {
            'ridge': pairs(rlon, rlat),
            'plume': {'name': [names[i] for i in keep],
                      'lonlat': pairs(plon[keep], plat[keep])},
            'lip': {'name': lip_names, 'lonlat': pairs(llon, llat)},
        }
        n_ridge += len(rlon)
        n_plume += len(keep)
        n_erupting += len(lip_names)

        if int(time) % 25 == 0:
            print(f'  {time:5.0f}  {len(rlon):6d}  {len(keep):6d}  {len(lip_names):8d}')

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        'model': args.model,
        'time_step': args.age_step,
        'age_min': 0.0,
        'age_max': args.age_max,
        'ridge_spacing_km': args.ridge_spacing,
        'plume_source': str(HOTSPOT_SHP.name),
        'plume_track_max_ma': float(covered),
        'lip_compilation': args.lips,
        'lip_source': lip_source,
        'lip_note': lip_note,

        'lip_window_myr': args.lip_window,
        # null means NO depth filter was applied -- see the module docstring.
        'deep_filter': sorted(deep) if deep is not None else None,
        'deep_types': list(wanted) if deep is not None else None,
        'name_aliases': aliases,
        'plume_classification_source':
            'Whittaker hotspot catalogue (PlumeType), citing Montelli et al. 2006, '
            'Courtillot et al. 2003, Anderson & Schramm 2005, Steinberger et al. 2000',
        'ridge_count': n_ridge,
        'plume_count': n_plume,
        'frames': frames,
    }, separators=(',', ':')))
    print(f'\nwrote {out}  ({len(frames)} frames, {n_ridge} ridge, '
          f'{n_plume} plume, {n_erupting} lip, '
          f'{out.stat().st_size / 1e6:.1f} MB)')
    if ridge_dropped_km:
        # Per frame, not summed over frames: the total across 201 frames reads
        # like a catastrophe when it is about 1% of the ridge in any one frame.
        print(f'  {ridge_dropped_km / len(frames):.0f} km of ridge per frame was in '
              f'segments shorter than half a spacing and carries no symbol')
    if covered < args.age_max:
        print(f'  NOTE: hotspot tracks stop at {covered:.0f} Ma, so frames older '
              f'than that have no plumes at all')
    update_manifest(out.parent.parent, args, out.name)


def update_manifest(model_dir, args, filename):
    """Add the volcano export to the model's "oldmap" manifest entry.

    Read-modify-write of the field prep_oldmap.py already creates, rather than a
    second top-level key: to the viewer these are two layers of one old map, not
    two datasets.
    """
    path = model_dir / 'manifest.json'
    if not path.exists():
        print(f'\n  NOTE: {path} does not exist, so no manifest field was added.')
        return
    manifest = json.loads(path.read_text())
    entry = manifest.setdefault('oldmap', {})
    entry['volcanoes'] = f'oldmap/{filename}'
    entry['lip_window_myr'] = args.lip_window
    path.write_text(json.dumps(manifest, indent=2))
    print(f'updated {path} with oldmap.volcanoes')


if __name__ == '__main__':
    main()
