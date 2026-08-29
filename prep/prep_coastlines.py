#!/usr/bin/env python3
"""Export coastlines for browser-side reconstruction.

Coastlines are NOT pre-baked per age.  The geometry at every age is the same
set of polylines under different finite rotations, so we ship the geometry once
in present-day coordinates and rotate it in the browser.  See
docs/adr/0001-rotate-coastlines-in-the-browser.md.

Outputs:

  geometry.bin    binary, little-endian:
                    magic   'ESCL' (4 bytes)
                    version uint32 = 1
                    nlines  uint32
                    then per line:
                      plate_id        int32
                      appear_age      float32   (larger Ma; +inf -> 1e9)
                      disappear_age   float32   (smaller Ma; -inf -> -1e9)
                      npoints         uint32
                      xyz             float32 * 3 * npoints  (unit sphere)

                  Points are stored as unit Cartesian vectors rather than
                  lon/lat: the client rotates them by a quaternion, so Cartesian
                  is what it actually needs and it avoids a per-vertex
                  trig conversion every time the age changes.

  rotations.json  {"ages": [...], "plates": {plate_id: [[x,y,z,w], ...]}}
                  Absolute finite rotations relative to the anchor plate,
                  as unit quaternions, one per age sample.

pygplates resolves the plate circuit offline, so the browser needs no
plate-hierarchy logic -- only quaternion slerp and a vector rotate.
"""

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np
import pygplates

GPLATES_ROOT = Path("/Users/simon/Data/GPlates/PublishedModels")
MULLER2019 = GPLATES_ROOT / "Muller_etal_2019_PlateMotionModel_v2.0_Tectonics"

DEFAULT_ROTATIONS = MULLER2019 / "Global_250-0Ma_Rotations_2019_v2.rot"
DEFAULT_COASTLINES = (
    MULLER2019 / "StaticGeometries" / "Coastlines"
    / "Global_coastlines_2019_v1_low_res.shp"
)

BIG = 1.0e9  # stand-in for pygplates' distant past / future


def finite_or(value, fallback):
    if value is None or math.isinf(value) or math.isnan(value):
        return fallback
    return float(value)


def interior_points(polygon, spacing_deg):
    """Lat/lon grid points lying inside the polygon, as unit vectors.

    Without these, a triangulation has vertices only on the coastline, and a
    continent-sized flat triangle chords a long way BENEATH the sphere -- the
    sagitta of a 40-degree chord is about 6% of Earth's radius. The globe's
    surface then occludes the middle of every large landmass and the fill
    renders as a hollow ribbon following the coast. Interior points keep every
    triangle small enough to hug the sphere.
    """
    lats, lons = [], []
    for p in polygon.get_points():
        la, lo = p.to_lat_lon()
        lats.append(la)
        lons.append(lo)
    lat0, lat1 = min(lats), max(lats)
    lon0, lon1 = min(lons), max(lons)
    # A polygon straddling the antimeridian has a useless lon bounding box;
    # fall back to scanning all longitudes, which is slower but correct.
    if lon1 - lon0 > 180.0:
        lon0, lon1 = -180.0, 180.0

    out = []
    lat = lat0
    while lat <= lat1:
        # Keep spacing roughly uniform on the sphere rather than in degrees.
        coslat = max(math.cos(math.radians(lat)), 0.05)
        step = spacing_deg / coslat
        lon = lon0
        while lon <= lon1:
            pt = pygplates.PointOnSphere(lat, lon)
            if polygon.is_point_in_polygon(pt):
                out.append(pt.to_xyz())
            lon += step
        lat += spacing_deg
    return np.array(out, dtype=np.float64) if out else np.zeros((0, 3))


def triangulate_polygon(pts_xyz, polygon, spacing_deg=2.0):
    """Fill a spherical polygon: returns (vertices, triangle indices).

    Rotate so the centroid is at the pole, project stereographically,
    Delaunay-triangulate, then keep only those triangles whose centroid lies
    inside the polygon -- tested back on the sphere with pygplates, not in the
    projection.

    Delaunay alone would fill the convex hull, which is wrong for anything
    concave (every real coastline). Filtering by a spherical inside-test handles
    concavity without needing a planar polygon library, and keeps the authority
    for "inside" with pygplates.
    """
    from scipy.spatial import Delaunay, QhullError

    if len(pts_xyz) < 3:
        return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.uint32)

    inner = interior_points(polygon, spacing_deg)
    verts = np.vstack([pts_xyz, inner]) if len(inner) else pts_xyz
    pts_xyz = verts
    n = len(pts_xyz)

    centroid = pts_xyz.mean(axis=0)
    empty = (np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.uint32))
    norm = np.linalg.norm(centroid)
    if norm < 1e-9:
        return empty
    centroid = centroid / norm

    # Rotation taking the centroid to +z.
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(centroid, z)
    s = np.linalg.norm(v)
    if s < 1e-12:
        rot = np.eye(3) if centroid[2] > 0 else np.diag([1.0, -1.0, -1.0])
    else:
        c = float(np.dot(centroid, z))
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        rot = np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))

    p = pts_xyz @ rot.T
    # Stereographic from the south pole; finite for everything but the antipode.
    denom = 1.0 + p[:, 2]
    if np.any(denom < 1e-6):
        return empty
    xy = np.column_stack([p[:, 0] / denom, p[:, 1] / denom])

    try:
        tri = Delaunay(xy)
    except (QhullError, ValueError):
        return empty

    keep = []
    for a, b, c_ in tri.simplices:
        mid = pts_xyz[a] + pts_xyz[b] + pts_xyz[c_]
        m = np.linalg.norm(mid)
        if m < 1e-9:
            continue
        mid = mid / m
        pt = pygplates.PointOnSphere(float(mid[0]), float(mid[1]), float(mid[2]))
        if polygon.is_point_in_polygon(pt):
            keep.append((a, b, c_))
    tris = np.array(keep, dtype=np.uint32) if keep else np.zeros((0, 3), dtype=np.uint32)
    return verts.astype(np.float32), tris


def export_geometry(coastline_files, out_path, spacing_deg):
    """Write present-day polylines with plate id and valid time."""
    features = pygplates.FeatureCollection()
    for f in coastline_files:
        features.add(pygplates.FeatureCollection(str(f)))

    lines = []
    plate_ids = set()
    for feature in features:
        plate_id = feature.get_reconstruction_plate_id()
        begin, end = feature.get_valid_time()
        # Ages increase into the past: begin_time is the LARGER value and is
        # when the feature appears.  See CONTEXT.md -- this is easy to invert.
        appear = finite_or(begin, BIG)
        disappear = finite_or(end, -BIG)

        for geom in feature.get_geometries():
            if not isinstance(
                geom, (pygplates.PolylineOnSphere, pygplates.PolygonOnSphere)
            ):
                continue
            pts = np.array(
                [p.to_xyz() for p in geom.get_points()], dtype=np.float64
            )
            if len(pts) < 2:
                continue

            land_pts = np.zeros((0, 3), dtype=np.float32)
            tris = np.zeros((0, 3), dtype=np.uint32)
            if isinstance(geom, pygplates.PolygonOnSphere):
                land_pts, tris = triangulate_polygon(pts, geom, spacing_deg)
                # A PolygonOnSphere does not repeat its first point. Triangulate
                # on the open ring, then close it so the client can draw every
                # line the same way, as a strip.
                pts = np.vstack([pts, pts[:1]])

            lines.append((plate_id, appear, disappear,
                          pts.astype(np.float32), land_pts, tris))
            plate_ids.add(plate_id)

    with open(out_path, "wb") as fh:
        fh.write(b"ESCL")
        fh.write(struct.pack("<II", 3, len(lines)))
        for plate_id, appear, disappear, pts, land_pts, tris in lines:
            fh.write(struct.pack("<iffIII", plate_id, appear, disappear,
                                 len(pts), len(land_pts), len(tris)))
            pts.astype("<f4").tofile(fh)
            land_pts.astype("<f4").tofile(fh)
            tris.astype("<u4").tofile(fh)

    npts = sum(len(p) for _, _, _, p, _, _ in lines)
    nland = sum(len(p) for _, _, _, _, p, _ in lines)
    ntris = sum(len(t) for _, _, _, _, _, t in lines)
    mb = out_path.stat().st_size / 1024 / 1024
    print(f"  geometry    {len(lines)} lines, {npts} points, {mb:.2f} MB")
    print(f"  land fill   {nland} vertices, {ntris} triangles")
    print(f"  plates      {len(plate_ids)} distinct ids")
    return sorted(plate_ids)


def export_rotations(rotation_files, plate_ids, ages, anchor, out_path):
    """Absolute finite rotations per plate per age, as unit quaternions."""
    model = pygplates.RotationModel([str(f) for f in rotation_files])

    plates = {}
    for pid in plate_ids:
        quats = []
        for age in ages:
            rot = model.get_rotation(float(age), int(pid), anchor_plate_id=anchor)
            # pygplates gives an Euler pole and angle; convert to a unit
            # quaternion, which is what the client slerps.
            plat, plon, angle_deg = rot.get_lat_lon_euler_pole_and_angle_degrees()
            pole_lat = math.radians(plat)
            pole_lon = math.radians(plon)
            angle = math.radians(angle_deg)
            clat = math.cos(pole_lat)
            ax = clat * math.cos(pole_lon)
            ay = clat * math.sin(pole_lon)
            az = math.sin(pole_lat)
            s = math.sin(angle / 2.0)
            quats.append([
                round(ax * s, 7), round(ay * s, 7), round(az * s, 7),
                round(math.cos(angle / 2.0), 7),
            ])
        plates[str(pid)] = quats

    out = {"ages": [float(a) for a in ages], "anchor": anchor, "plates": plates}
    out_path.write_text(json.dumps(out))
    mb = out_path.stat().st_size / 1024 / 1024
    print(f"  rotations   {len(plates)} plates x {len(ages)} ages, {mb:.2f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--coastlines", type=Path, nargs="+", default=[DEFAULT_COASTLINES])
    ap.add_argument("--rotations", type=Path, nargs="+", default=[DEFAULT_ROTATIONS])
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=250.0)
    ap.add_argument("--age-step", type=float, default=1.0)
    ap.add_argument("--anchor", type=int, default=0)
    ap.add_argument("--fill-spacing-deg", type=float, default=2.0,
                    help="interior sample spacing for the land fill")
    ap.add_argument("--out", type=Path, default=Path("archive/coastlines"))
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"coastlines  {args.coastlines[0].name}")
    print(f"rotations   {args.rotations[0].name}")

    plate_ids = export_geometry(
        args.coastlines, args.out / "geometry.bin", args.fill_spacing_deg
    )
    ages = np.arange(args.age_min, args.age_max + args.age_step / 2, args.age_step)
    export_rotations(
        args.rotations, plate_ids, ages, args.anchor, args.out / "rotations.json"
    )
    print(f"\nwrote {args.out}/")


if __name__ == "__main__":
    main()
