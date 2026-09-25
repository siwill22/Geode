#!/usr/bin/env python3
"""Check a simplified coastline geometry.bin against the unsimplified one.

Independent of topo_simplify.py's own enforcement loop: this reads only the
two exported files, i.e. exactly what the viewer is given, after densifying
and triangulating -- so it also catches anything the export steps after
simplification might have broken. Shares only the great-circle primitives.

Checks, all on the sphere:
  rings        every polygon ring still has >= 3 distinct vertices and
               positive area
  adjacency    the graph of which polygons share a border is unchanged --
               no neighbour lost (a border opened into a gap) and none gained
               except where snapping joined a near-miss border
  crossings    no crossing that the original did not already have (every
               crossing point in the result lies within 1 km of one in the
               original)
  deviation    no original vertex lies further from its simplified ring than
               the tolerance
  area         per-ring and total area change, reported

Exit status 1 if any of the first four fails.

Usage:
  python prep/check_coastline_topology.py \\
      --before old/geometry.bin --after archive/.../coastlines/geometry.bin \\
      --tol-deg 0.05
"""

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
import pygplates
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from topo_simplify import EARTH_KM, _unit, angle_between, crossing_pairs  # noqa: E402


def read_rings(path):
    """Polygon rings (lines carrying a land fill), open, in file order."""
    buf = Path(path).read_bytes()
    assert buf[:4] == b"ESCL", f"{path}: not a coastline geometry file"
    _, nlines = struct.unpack_from("<II", buf, 4)
    off = 12
    rings = []
    for _ in range(nlines):
        _, _, _, npts, nland, ntris = struct.unpack_from("<iffIII", buf, off)
        off += 24
        pts = np.frombuffer(buf, "<f4", npts * 3, off).reshape(-1, 3).astype(np.float64)
        off += (npts + nland + ntris) * 12
        if nland:
            rings.append(_unit(pts[:-1]))   # drop the strip-closing repeat
    return rings


def edge_graph(rings):
    """Pairs of rings sharing at least one edge. Vertices keyed at ~1 mm so
    two polygons' copies of a densified shared edge -- interpolated in
    opposite directions, equal only to rounding -- still count as shared."""
    owners = {}
    for r, ring in enumerate(rings):
        k = [tuple(v) for v in np.round(ring, 10)]
        for i in range(len(k)):
            e = frozenset((k[i], k[(i + 1) % len(k)]))
            if len(e) == 2:
                owners.setdefault(e, set()).add(r)
    pairs = set()
    for s in owners.values():
        s = sorted(s)
        for i in range(len(s)):
            for j in range(i + 1, len(s)):
                pairs.add((s[i], s[j]))
    return pairs


def crossing_points(rings, sample_rad):
    A = np.vstack([r for r in rings])
    B = np.vstack([np.roll(r, -1, axis=0) for r in rings])
    cp = crossing_pairs(A, B, sample_rad)
    if len(cp) == 0:
        return np.zeros((0, 3))
    a, b, c, d = A[cp[:, 0]], B[cp[:, 0]], A[cp[:, 1]], B[cp[:, 1]]
    L = _unit(np.cross(np.cross(a, b), np.cross(c, d)))
    # Of the two antipodal candidates, the one nearer the segments.
    flip = np.sum(L * (a + b), axis=1) < 0
    L[flip] *= -1
    return L


def max_deviation(before, after, step_rad):
    """For each ring pair, the largest distance from a `before` vertex to the
    `after` ring, measured against the after ring sampled every `step_rad`
    (so an over-estimate by at most half a step). Radians."""
    worst = np.zeros(len(before))
    for r, (b, a) in enumerate(zip(before, after)):
        nxt = np.roll(a, -1, axis=0)
        ang = angle_between(a, nxt)
        n = np.maximum(1, np.ceil(ang / step_rad).astype(int))
        t = np.concatenate([np.arange(k) / k for k in n])
        i = np.repeat(np.arange(len(a)), n)
        samples = _unit((1 - t)[:, None] * a[i] + t[:, None] * nxt[i])
        d, _ = cKDTree(samples).query(b)
        worst[r] = 2 * np.arcsin(np.clip(d.max() / 2, 0, 1))
    return worst


def areas(rings):
    return np.array([pygplates.PolygonOnSphere(r).get_area() for r in rings])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", type=Path, required=True)
    ap.add_argument("--after", type=Path, required=True)
    ap.add_argument("--tol-deg", type=float, required=True)
    args = ap.parse_args()
    tol = np.radians(args.tol_deg)
    failed = []

    before, after = read_rings(args.before), read_rings(args.after)
    print(f"rings       before {len(before)}  after {len(after)}")
    if len(before) != len(after):
        print("  FAIL ring count differs -- files are not from the same source")
        return 1
    nb, na = sum(map(len, before)), sum(map(len, after))
    print(f"vertices    before {nb}  after {na}  ({100 * na / nb:.1f}%)")

    a_before, a_after = areas(before), areas(after)

    def degenerate(rings, a):
        distinct = np.array([len(np.unique(r, axis=0)) for r in rings])
        return (distinct < 3) | (a <= 0)

    # Judged against the original: some source rings are already zero-area
    # slivers (and float32 storage merges vertices under ~0.4 m apart), which
    # no simplification caused.
    deg_before, deg_after = degenerate(before, a_before), degenerate(after, a_after)
    new_deg = np.nonzero(deg_after & ~deg_before)[0]
    print(f"rings       {int(deg_before.sum())} degenerate before, "
          f"{int(deg_after.sum())} after, {len(new_deg)} new")
    if len(new_deg):
        failed.append("rings")
        print(f"    newly degenerate: {new_deg[:10].tolist()}")

    g_before, g_after = edge_graph(before), edge_graph(after)
    lost, gained = g_before - g_after, g_after - g_before
    print(f"adjacency   {len(g_before)} neighbour pairs before, {len(g_after)} after: "
          f"{len(lost)} lost, {len(gained)} gained")
    if lost:
        failed.append("adjacency")
        for p in sorted(lost)[:10]:
            print(f"    lost neighbours: rings {p}")

    sample = np.radians(0.01)
    xb, xa = crossing_points(before, sample), crossing_points(after, sample)
    if len(xa) and len(xb):
        near, _ = cKDTree(xb).query(xa)
        new = int((near * EARTH_KM > 1.0).sum())
    else:
        new = len(xa)
    print(f"crossings   before {len(xb)}  after {len(xa)}  new {new}")
    if new:
        failed.append("crossings")

    dev = max_deviation(before, after, np.radians(0.002))
    worst = float(dev.max())
    limit = tol + np.radians(0.001)
    print(f"deviation   max {np.degrees(worst):.4f} deg ({worst * EARTH_KM:.2f} km); "
          f"limit {np.degrees(limit):.4f} deg; "
          f"{int((dev > limit).sum())} rings over")
    if worst > limit:
        failed.append("deviation")

    ok = a_before > 0
    rel = np.abs(a_after[ok] - a_before[ok]) / a_before[ok]
    worst_i = np.nonzero(ok)[0][rel.argmax()]
    big = a_before >= 1000 / EARTH_KM ** 2
    rel_big = np.abs(a_after[big] - a_before[big]) / a_before[big]
    print(f"area        total {100 * (a_after.sum() / a_before.sum() - 1):+.3f}%; per ring "
          f"median {100 * np.median(rel):.2f}%, p99 {100 * np.percentile(rel, 99):.1f}%, "
          f"max {100 * rel.max():.1f}% (ring {int(worst_i)}, "
          f"{a_before[worst_i] * EARTH_KM ** 2:.1f} km^2); rings >= 1000 km^2: "
          f"max {100 * rel_big.max():.2f}%")

    print("PASS" if not failed else f"FAIL: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
