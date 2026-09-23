"""Topology-preserving simplification of polygon rings on the sphere.

Why this exists: some Reconstruction Models ship coastlines digitised far finer
than any map can show (Torsvik & Cocks 2017: median segment 0.014 deg, about
1/20 of a pixel on a full-screen Robinson map), and the viewer's flat-mode
rebuild costs time linear in vertex count. Simplifying is the obvious fix, and
the obvious way to do it -- each polygon on its own -- is wrong: neighbouring
plate polygons each carry their OWN copy of a common border, and two copies
simplified independently drift apart, opening slivers of ocean between
continents (or overlapping them). That is exactly the artifact a runtime
decimation attempt in the viewer produced.

So this works on the shared structure, not on polygons:

  1. SNAP   vertices of different rings lying within `snap_m` of each other
            onto one position. Most shared borders are already bit-identical;
            this turns the near-misses (independent digitisation, off by
            centimetres to metres) into exact sharing too.
  2. ARCS   split every ring at its JUNCTIONS -- vertices where the set of
            neighbouring rings changes -- and deduplicate, so a border shared
            by two polygons becomes ONE arc that both of them reference.
  3. SIMPLIFY each arc once (Douglas-Peucker, great-circle distance), endpoints
            fixed, so both sides of a border get the identical result. The
            tolerance is a ceiling: each arc is also capped at a fraction of
            the size of the smallest polygon using it, because an angle that
            is invisible on a continent is bigger than a small island and
            folds a digitised ribbon flat.
  4. ENFORCE by iterating until no arc causes a violation:
            - no crossings, and no near-misses: no simplified segment crosses
              another or passes within CLEARANCE_M of it (within an arc,
              between arcs, between rings). The clearance is what makes the
              result survive being written as float32 (~0.4 m on the Earth):
              without it, independently simplified near-coincident borders
              that clear each other in float64 were measured crossing once
              stored;
            - no side flips: no surviving vertex of any arc lies inside the
              region a shortcut swept over -- the condition that stops a
              coastline jumping across a nearby island without touching it;
            - no collapsed rings: every ring keeps three distinct vertices and
              at least COLLAPSE_AREA_FRAC of its area.
            Any arc responsible for a violation has its tolerance halved and
            is re-simplified, down to its original geometry if need be. A
            violation present in the ORIGINAL geometry cannot be caused by
            simplifying: the segments involved are pinned, so they are written
            out exactly as they were, and that exact pair is allowed.

check_coastline_topology.py verifies the result independently, from the
exported files alone.

Every test runs on the sphere. Distances are angles to great-circle ARCS (not
chords, not lines); crossings are great-circle arc intersections. The side-flip
test uses a gnomonic projection about the shortcut, because gnomonic maps great
circles to straight lines -- so a planar point-in-polygon test there is exact
for a polygon whose edges are great-circle arcs, which is not true of any
equal-area or conformal projection.
"""

from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

EARTH_KM = 6371.0


# ---- sphere primitives -----------------------------------------------------

def _unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def angle_between(a, b):
    """Angle in radians between unit vectors, stable for tiny angles (atan2 of
    |a x b| and a.b, rather than arccos of a.b, which loses precision exactly
    where coastline vertices live -- metres apart)."""
    return np.arctan2(np.linalg.norm(np.cross(a, b), axis=-1), np.sum(a * b, axis=-1))


def dist_to_arc(p, a, b):
    """Angular distance (radians) from each row of `p` to the minor great-
    circle arc a->b: perpendicular if the foot of the perpendicular falls on
    the arc, otherwise to the nearer endpoint."""
    n = np.cross(a, b)
    nn = np.linalg.norm(n)
    da = angle_between(p, a[None, :])
    db = angle_between(p, b[None, :])
    if nn < 1e-15:
        return np.minimum(da, db)
    n = n / nn
    s = p @ n
    xt = np.abs(np.arcsin(np.clip(s, -1.0, 1.0)))
    q = p - s[:, None] * n[None, :]
    within = (np.cross(a[None, :], q) @ n >= 0) & (np.cross(q, b[None, :]) @ n >= 0)
    return np.where(within, xt, np.minimum(da, db))


def arcs_cross(a, b, c, d, eps=1e-14):
    """Vectorised: do minor arcs a->b and c->d (rows) intersect?

    Arcs meeting only at a shared endpoint are NOT reported -- that is how
    consecutive segments, and arcs meeting at a junction, are supposed to
    touch. Arcs on the same great circle are not reported either (parallel
    normals give no unique crossing point); an overlapping collinear pair is
    already impossible for arcs that went through the dedupe in `build_arcs`.
    """
    shared = (np.all(a == c, axis=1) | np.all(a == d, axis=1)
              | np.all(b == c, axis=1) | np.all(b == d, axis=1))
    n1 = np.cross(a, b)
    n2 = np.cross(c, d)
    L = np.cross(n1, n2)
    ln = np.linalg.norm(L, axis=1)
    ok = ln > 1e-18
    L = np.where(ok[:, None], L / np.where(ok, ln, 1.0)[:, None], 0.0)
    hit = np.zeros(len(a), dtype=bool)
    for sgn in (1.0, -1.0):
        x = sgn * L
        on1 = (np.sum(np.cross(a, x) * n1, 1) >= -eps) & (np.sum(np.cross(x, b) * n1, 1) >= -eps)
        on2 = (np.sum(np.cross(c, x) * n2, 1) >= -eps) & (np.sum(np.cross(x, d) * n2, 1) >= -eps)
        hit |= on1 & on2
    return hit & ok & ~shared


def point_arc_dist(p, a, b):
    """Row-wise `dist_to_arc`: angular distance from p[i] to arc a[i]->b[i]."""
    n = np.cross(a, b)
    nn = np.linalg.norm(n, axis=1)
    ok = nn > 1e-15
    n = n / np.where(ok, nn, 1.0)[:, None]
    s = np.sum(p * n, axis=1)
    xt = np.abs(np.arcsin(np.clip(s, -1.0, 1.0)))
    q = p - s[:, None] * n
    within = (np.sum(np.cross(a, q) * n, 1) >= 0) & (np.sum(np.cross(q, b) * n, 1) >= 0)
    ends = np.minimum(angle_between(p, a), angle_between(p, b))
    return np.where(ok & within, xt, ends)


def close_pairs(A, B, sample_rad, clearance_rad):
    """Pairs of segments that cross OR pass within `clearance_rad` of each
    other without sharing an endpoint.

    The clearance is what makes "no crossings" survive storage: coordinates
    are written as float32 (about 0.4 m on the Earth's surface), so two
    segments that clear each other by less than that in float64 can cross once
    written. Two minor arcs that do not cross are closest at an endpoint of
    one of them, so four point-to-arc distances give the separation exactly.
    """
    return crossing_pairs(A, B, sample_rad, clearance_rad)


def crossing_pairs(A, B, sample_rad, clearance_rad=0.0):
    """Every pair (i, j), i < j, of segments A[i]->B[i] that cross.

    Candidates come from a KD-tree over points sampled along each segment at
    spacing <= `sample_rad`: two segments that cross each have a sample within
    half a spacing of the crossing, so no crossing pair is further apart than
    one spacing, and `query_pairs(sample_rad)` cannot miss it. Then the exact
    arc test above.
    """
    seg_len = angle_between(A, B)
    n_s = np.maximum(1, np.ceil(seg_len / sample_rad).astype(int))
    owner = np.repeat(np.arange(len(A)), n_s)
    k = np.concatenate([np.arange(n) for n in n_s]) if len(n_s) else np.zeros(0, int)
    t = (k + 0.5) / n_s[owner]
    ang = seg_len[owner]
    sa = np.sin(ang)
    small = sa < 1e-12
    w0 = np.where(small, 1 - t, np.sin((1 - t) * ang) / np.where(small, 1, sa))
    w1 = np.where(small, t, np.sin(t * ang) / np.where(small, 1, sa))
    P = _unit(w0[:, None] * A[owner] + w1[:, None] * B[owner])
    # Two segments that come within `clearance_rad` have samples within one
    # spacing plus the clearance of each other.
    r = sample_rad + clearance_rad
    pairs = cKDTree(P).query_pairs(2 * np.sin(r / 2) * 1.0001, output_type="ndarray")
    if len(pairs) == 0:
        return np.zeros((0, 2), dtype=int)
    sp = np.sort(owner[pairs], axis=1)
    sp = sp[sp[:, 0] != sp[:, 1]]
    sp = np.unique(sp, axis=0)
    a, b, c, d = A[sp[:, 0]], B[sp[:, 0]], A[sp[:, 1]], B[sp[:, 1]]
    hit = arcs_cross(a, b, c, d)
    if clearance_rad > 0:
        shared = (np.all(a == c, axis=1) | np.all(a == d, axis=1)
                  | np.all(b == c, axis=1) | np.all(b == d, axis=1))
        sep = np.minimum.reduce([point_arc_dist(a, c, d), point_arc_dist(b, c, d),
                                 point_arc_dist(c, a, b), point_arc_dist(d, a, b)])
        hit |= (sep < clearance_rad) & ~shared
    return sp[hit]


# ---- 1. snap ---------------------------------------------------------------

def drop_repeats(ring):
    """Remove consecutive duplicate vertices (including the wrap-around)."""
    if len(ring) < 2:
        return ring
    keep = np.any(ring != np.roll(ring, 1, axis=0), axis=1)
    if not keep.any():
        return ring[:1]
    return ring[keep]


def snap_shared(rings, snap_m=10.0, max_cluster_m=20.0):
    """Snap vertices of DIFFERENT rings within `snap_m` metres onto one
    existing position (the lowest-indexed member's, so the result is always a
    real source vertex, not an average).

    Only MUTUAL nearest neighbours are joined: vertex a of ring A pairs with
    b of ring B when b is A-vertex a's nearest vertex in B and a is b's
    nearest in A. Chaining every pair within `snap_m` instead lets one ring's
    own closely spaced vertices (common in dense digitisation: tens of
    thousands of same-ring pairs under 10 m on Torsvik) merge into a
    cluster, which then has to be skipped wholesale. A cluster is still
    skipped when it ends up holding two vertices of one ring, or chaining
    carries it past `max_cluster_m`. Returns (rings, stats).
    """
    # Explicitly closed rings repeat their first vertex at the end (true of
    # nearly every Torsvik ring); that duplicate would otherwise read as two
    # vertices of one ring in the same cluster.
    rings = [drop_repeats(r) for r in rings]
    sizes = [len(r) for r in rings]
    allv = np.vstack(rings)
    ring_of = np.repeat(np.arange(len(rings)), sizes)
    pairs = cKDTree(allv).query_pairs(snap_m / 1000.0 / EARTH_KM, output_type="ndarray")
    pairs = pairs[ring_of[pairs[:, 0]] != ring_of[pairs[:, 1]]]
    if len(pairs):
        d = angle_between(allv[pairs[:, 0]], allv[pairs[:, 1]])
        # Both directions, then each vertex's single nearest partner per ring.
        src = np.concatenate([pairs[:, 0], pairs[:, 1]])
        dst = np.concatenate([pairs[:, 1], pairs[:, 0]])
        dd = np.concatenate([d, d])
        order = np.lexsort((dd, ring_of[dst], src))
        src, dst = src[order], dst[order]
        first = np.ones(len(src), dtype=bool)
        first[1:] = (src[1:] != src[:-1]) | (ring_of[dst[1:]] != ring_of[dst[:-1]])
        best = set(zip(src[first].tolist(), dst[first].tolist()))
        pairs = np.array([(a, b) for a, b in best if a < b and (b, a) in best],
                         dtype=int).reshape(-1, 2)

    parent = np.arange(len(allv))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, j in pairs:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    members = defaultdict(list)
    for v in np.unique(pairs):
        members[find(v)].append(v)

    out = allv.copy()
    moved = skipped = 0
    max_move_m = 0.0
    for root, mem in members.items():
        mem = sorted(mem)
        if len(set(ring_of[mem])) < len(mem):
            skipped += 1
            continue
        rep = allv[mem[0]]
        d = angle_between(allv[mem], rep[None, :]) * EARTH_KM * 1000.0
        if d.max() > max_cluster_m:
            skipped += 1
            continue
        moved += int((d > 0).sum())
        max_move_m = max(max_move_m, float(d.max()))
        out[mem] = rep

    offs = np.cumsum([0] + sizes)
    snapped = [drop_repeats(out[offs[k]:offs[k + 1]]) for k in range(len(rings))]
    return snapped, {"moved": moved, "clusters_skipped": skipped, "max_move_m": max_move_m}


# ---- 2. arcs ---------------------------------------------------------------

def _key(v):
    return v.tobytes()


def build_arcs(rings):
    """Split rings at junctions and deduplicate shared borders.

    Returns (arcs, ring_arcs): `arcs` is a list of (m, 3) point arrays, one
    per distinct arc, with arcs[i][0] and arcs[i][-1] the junction endpoints
    (equal for a closed arc, i.e. a ring with no junction at all);
    `ring_arcs[r]` is the ordered list of (arc_id, reversed) making up ring r.
    """
    keys = [[_key(v) for v in r] for r in rings]

    nbrs = defaultdict(set)
    count = defaultdict(int)
    for kr in keys:
        n = len(kr)
        for i, k in enumerate(kr):
            count[k] += 1
            nbrs[k].add(frozenset((kr[i - 1], kr[(i + 1) % n])))
    # A junction: a position used more than once whose neighbours are not the
    # same everywhere it is used -- where a shared border starts, ends, or
    # meets a third polygon.
    junction = {k for k, c in count.items() if c > 1 and len(nbrs[k]) > 1}

    arc_id = {}
    arcs = []
    ring_arcs = []
    for r, kr in zip(rings, keys):
        n = len(kr)
        js = [i for i, k in enumerate(kr) if k in junction]
        if not js:
            # Closed arc. Start at the smallest key so every copy of an
            # identical ring (and its reverse) canonicalises the same way.
            s = min(range(n), key=lambda i: kr[i])
            idx = list(range(s, n)) + list(range(0, s)) + [s]
            pieces = [idx]
        else:
            pieces = []
            for a, b in zip(js, js[1:] + [js[0] + n]):
                pieces.append([i % n for i in range(a, b + 1)])
        entry = []
        for idx in pieces:
            kt = tuple(kr[i] for i in idx)
            rev = kt[::-1]
            if rev < kt:
                canon, flipped = rev, True
            else:
                canon, flipped = kt, False
            aid = arc_id.get(canon)
            if aid is None:
                aid = len(arcs)
                arc_id[canon] = aid
                pts = r[idx]
                arcs.append(pts[::-1].copy() if flipped else pts.copy())
            entry.append((aid, flipped))
        ring_arcs.append(entry)
    return arcs, ring_arcs


def assemble(arc_pts, ring_arcs):
    """Rebuild each ring (open, not repeating its first vertex) from arcs."""
    rings = []
    for entry in ring_arcs:
        parts = []
        for aid, flipped in entry:
            p = arc_pts[aid][::-1] if flipped else arc_pts[aid]
            parts.append(p[:-1])
        rings.append(np.vstack(parts))
    return rings


# ---- 3. simplify -----------------------------------------------------------

def dp_keep(pts, tol, force_interior=False, pinned=None):
    """Douglas-Peucker keep-mask for an arc, endpoints fixed, distances to
    great-circle arcs. A closed arc (first == last) is split at its farthest
    point from the start first, since a chord from a point to itself has no
    direction. `force_interior` keeps each half's farthest interior point even
    within tolerance, the minimum that stops a small ring collapsing to two
    points. `pinned` vertices are always kept, and simplification runs only
    between consecutive kept ones -- which leaves any segment with both ends
    pinned exactly as it was."""
    m = len(pts)
    keep = np.zeros(m, dtype=bool)
    keep[0] = keep[-1] = True
    if m <= 2:
        return keep
    closed = np.array_equal(pts[0], pts[-1])
    force = force_interior
    if closed:
        far = 1 + int(np.argmax(angle_between(pts[1:-1], pts[0][None, :])))
        keep[far] = True
        force = True
    if pinned is not None:
        keep |= pinned
    ki = np.nonzero(keep)[0]
    spans = list(zip(ki[:-1], ki[1:]))
    for i0, j0 in spans:
        stack = [(i0, j0)]
        first = True
        while stack:
            i, j = stack.pop()
            if j <= i + 1:
                first = False
                continue
            d = dist_to_arc(pts[i + 1:j], pts[i], pts[j])
            k = int(np.argmax(d))
            if d[k] > tol or (first and force):
                keep[i + 1 + k] = True
                stack.append((i, i + 1 + k))
                stack.append((i + 1 + k, j))
            first = False
    return keep


# ---- 4. enforce ------------------------------------------------------------

def _gnomonic(points, centre):
    """Gnomonic projection about `centre` onto its tangent plane, as 2D."""
    e1 = np.cross(centre, [0.0, 0.0, 1.0])
    if np.linalg.norm(e1) < 1e-8:
        e1 = np.cross(centre, [0.0, 1.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(centre, e1)
    g = points / (points @ centre)[:, None]
    return np.column_stack([g @ e1, g @ e2])


def _points_in_polygon(pts2, poly2):
    """Even-odd ray casting, vectorised over points."""
    x, y = pts2[:, 0][:, None], pts2[:, 1][:, None]
    x1, y1 = poly2[:, 0][None, :], poly2[:, 1][None, :]
    x2, y2 = np.roll(poly2[:, 0], -1)[None, :], np.roll(poly2[:, 1], -1)[None, :]
    straddle = (y1 > y) != (y2 > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        xint = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
    return np.sum(straddle & (x < xint), axis=1) % 2 == 1


COLLAPSE_AREA_FRAC = 0.25


def _area(ring):
    """Spherical area in steradians -- pygplates', the authority for polygon
    geometry on the sphere here."""
    import pygplates
    return pygplates.PolygonOnSphere(ring).get_area()


CLEARANCE_M = 2.0


def _pair_key(a, b, c, d):
    """Order-free identity of a pair of segments, by their exact endpoints."""
    s1 = tuple(sorted((a.tobytes(), b.tobytes())))
    s2 = tuple(sorted((c.tobytes(), d.tobytes())))
    return (s1, s2) if s1 <= s2 else (s2, s1)


def find_violations(arcs, keeps, ring_arcs, sample_rad, ring_area=None,
                    allowed_pairs=frozenset()):
    """Arcs whose current simplification breaks topology.

    Returns (crossing_arcs, sideflip_arcs, collapsed_rings, pair_info) where
    pair_info lists every offending segment pair as (key, arc, i, arc2, j),
    i and j being indices into the ORIGINAL arcs. A pair whose key is in
    `allowed_pairs` -- the same two segments, unchanged, that the source
    geometry already had too close -- is not counted. `ring_area`, each
    ring's original area, enables the area half of the collapse test.
    """
    # Segments of the simplified geometry, remembering where each came from.
    A, B, seg_arc, seg_i, seg_j = [], [], [], [], []
    for aid, (pts, kp) in enumerate(zip(arcs, keeps)):
        ki = np.nonzero(kp)[0]
        if len(ki) < 2:
            continue
        A.append(pts[ki[:-1]])
        B.append(pts[ki[1:]])
        seg_arc.append(np.full(len(ki) - 1, aid))
        seg_i.append(ki[:-1])
        seg_j.append(ki[1:])
    A, B = np.vstack(A), np.vstack(B)
    seg_arc, seg_i, seg_j = map(np.concatenate, (seg_arc, seg_i, seg_j))
    cp = close_pairs(A, B, sample_rad, CLEARANCE_M / 1000.0 / EARTH_KM)
    crossing = set()
    pair_info = []
    for s, t in cp:
        key = _pair_key(A[s], B[s], A[t], B[t])
        if key in allowed_pairs:
            continue
        crossing.add(int(seg_arc[s]))
        crossing.add(int(seg_arc[t]))
        pair_info.append((key, int(seg_arc[s]), int(seg_i[s]), int(seg_arc[t]), int(seg_i[t])))

    # Side flips: a surviving vertex inside the region a shortcut swept.
    # Every shortcut's swept region lies within `reach` of its chord midpoint,
    # so one batched ball query finds every vertex that could be inside it.
    kv = np.vstack([pts[kp] for pts, kp in zip(arcs, keeps)])
    tree = cKDTree(kv)
    shortcuts = []
    for aid, (pts, kp) in enumerate(zip(arcs, keeps)):
        ki = np.nonzero(kp)[0]
        for i, j in zip(ki[:-1], ki[1:]):
            if j > i + 1:
                shortcuts.append((aid, i, j))
    sideflip = set()
    if shortcuts:
        mids = np.empty((len(shortcuts), 3))
        radii = np.empty(len(shortcuts))
        for s, (aid, i, j) in enumerate(shortcuts):
            pts = arcs[aid]
            m = pts[i] + pts[j]
            n = np.linalg.norm(m)
            # A shortcut between antipodal points has no midpoint; it would
            # also be longer than any tolerance could allow.
            mids[s] = m / n if n > 1e-12 else pts[i]
            reach = max(angle_between(pts[i:j + 1], mids[s][None, :]).max(), 1e-9)
            radii[s] = 2 * np.sin(reach / 2) * 1.001
        balls = tree.query_ball_point(mids, radii)
        for (aid, i, j), mid, cand in zip(shortcuts, mids, balls):
            if aid in sideflip or len(cand) <= 2:
                continue
            pts = arcs[aid]
            c = kv[cand]
            c = c[~(np.all(c == pts[i], axis=1) | np.all(c == pts[j], axis=1))]
            if len(c) == 0:
                continue
            chain = pts[i:j + 1]
            if np.any(_points_in_polygon(_gnomonic(c, mid), _gnomonic(chain, mid))):
                sideflip.add(aid)

    # Built exactly as `assemble` builds the output ring -- orientation
    # included, since dropping the closing point of a REVERSED arc without
    # reversing it first drops the wrong junction. A ring that keeps three
    # distinct vertices can still fold flat (a ribbon's out-and-back), so
    # losing almost all its area counts as collapsing too.
    arc_pts = [pts[kp] for pts, kp in zip(arcs, keeps)]
    collapsed = []
    for r, ring in enumerate(assemble(arc_pts, ring_arcs)):
        if len(np.unique(ring, axis=0)) < 3:
            collapsed.append(r)
        elif ring_area is not None and ring_area[r] > 0:
            if _area(ring) < COLLAPSE_AREA_FRAC * ring_area[r]:
                collapsed.append(r)
    return crossing, sideflip, collapsed, pair_info


def simplify_rings(rings, tol_deg, snap_m=10.0, size_frac=0.05, max_iter=20,
                   floor_frac=1 / 64, log=print):
    """Topology-preserving simplification of `rings` (list of (N, 3) unit-
    vector arrays, open -- first vertex not repeated). Returns (rings, report).

    `tol_deg` is the ceiling. Each arc's actual tolerance is also capped at
    `size_frac` times the linear size (sqrt of area) of the smallest ring
    using it: a fixed angle that is invisible on a continent is larger than a
    small island, and folds a digitised ribbon flat. The vertices are in the
    big coastlines, which the cap does not touch, so it costs little.
    """
    tol0 = np.radians(tol_deg)
    rings, snap_stats = snap_shared(rings, snap_m=snap_m)
    arcs, ring_arcs = build_arcs(rings)
    n_arcs = len(arcs)
    ring_area = np.array([_area(r) for r in rings])
    cap = np.full(n_arcs, tol0)
    for r, entry in enumerate(ring_arcs):
        s = size_frac * np.sqrt(ring_area[r])
        for aid, _ in entry:
            cap[aid] = min(cap[aid], s)
    tol_init = cap.copy()
    tol = tol_init.copy()
    force = np.zeros(n_arcs, dtype=bool)
    # Candidate spacing for the crossing search: well under the tolerance, so
    # it is never the thing that lets a crossing through.
    sample_rad = tol0 / 2

    uses = np.zeros(n_arcs, dtype=int)
    for e in ring_arcs:
        for aid, _ in e:
            uses[aid] += 1

    # What the ORIGINAL geometry already violates cannot be caused by
    # simplifying, and must survive it unchanged rather than be chased. Every
    # segment in a source violation is PINNED -- both its endpoints always
    # kept, so it is written out exactly as it was -- and that exact pair is
    # then allowed. Pinning the segments rather than freezing their whole
    # arcs matters: the source has tens of thousands of such pairs (densely
    # digitised coasts pass within 2 m of themselves constantly), and
    # freezing every arc that contains one keeps a third of all vertices.
    orig_keeps = [np.ones(len(a), dtype=bool) for a in arcs]
    _, _, src_collapsed, src_info = find_violations(
        arcs, orig_keeps, ring_arcs, sample_rad, ring_area)
    allowed = frozenset(p[0] for p in src_info)
    pinned = [np.zeros(len(a), dtype=bool) for a in arcs]
    for _, a1, i1, a2, i2 in src_info:
        pinned[a1][i1] = pinned[a1][i1 + 1] = True
        pinned[a2][i2] = pinned[a2][i2 + 1] = True
    src_collapsed = set(src_collapsed)

    log(f"  topo        {len(rings)} rings -> {n_arcs} arcs "
        f"({int((uses > 1).sum())} shared by 2+ rings); snapped "
        f"{snap_stats['moved']} vertices (max {snap_stats['max_move_m']:.2f} m, "
        f"{snap_stats['clusters_skipped']} clusters left alone)")
    log(f"  source      {len(allowed)} segment pairs already crossing or within "
        f"{CLEARANCE_M:g} m, {len(src_collapsed)} degenerate rings "
        f"({sum(int(p.sum()) for p in pinned)} vertices pinned, not chased)")

    keeps = [dp_keep(a, t, f, p) for a, t, f, p in zip(arcs, tol, force, pinned)]
    it = 0
    for it in range(1, max_iter + 1):
        crossing, sideflip, collapsed, _ = find_violations(
            arcs, keeps, ring_arcs, sample_rad, ring_area, allowed)
        # Only an arc that still HAS a tolerance can be at fault: one at zero
        # is original geometry, and whatever it meets must give way instead.
        tighten = {a for a in crossing | sideflip if tol[a] > 0}
        newly_forced = set()
        for r in collapsed:
            if r in src_collapsed:
                continue
            for aid, _ in ring_arcs[r]:
                if not force[aid]:
                    force[aid] = True
                    newly_forced.add(aid)
        log(f"  enforce {it:2d}  new-crossing arcs {len(crossing):5d}  "
            f"side-flip arcs {len(sideflip):5d}  "
            f"collapsed rings {len(set(collapsed) - src_collapsed):4d}")
        if not tighten and not newly_forced:
            break
        for a in tighten:
            tol[a] = tol[a] / 2 if tol[a] / 2 >= tol_init[a] * floor_frac else 0.0
        # A collapsed ring whose arcs are already forced and still collapses
        # needs its tolerance cut as well -- forcing one interior point per
        # arc is not always enough to reopen it.
        for r in collapsed:
            if r in src_collapsed:
                continue
            for aid, _ in ring_arcs[r]:
                if force[aid] and aid not in newly_forced and tol[aid] > 0:
                    tol[aid] = tol[aid] / 2 if tol[aid] / 2 >= tol_init[aid] * floor_frac else 0.0
                    tighten.add(aid)
        for a in tighten | newly_forced:
            keeps[a] = dp_keep(arcs[a], tol[a], force[a], pinned[a])
    else:
        raise RuntimeError(f"topology enforcement did not converge in {max_iter} iterations")

    arc_pts = [a[k] for a, k in zip(arcs, keeps)]
    out = assemble(arc_pts, ring_arcs)
    before = sum(len(r) for r in rings)
    after = sum(len(r) for r in out)
    report = {
        "tol_deg": tol_deg,
        "vertices_before": before,
        "vertices_after": after,
        "arcs": n_arcs,
        "shared_arcs": int((uses > 1).sum()),
        "size_frac": size_frac,
        "arcs_capped_by_size": int((tol_init < tol0).sum()),
        "arcs_tightened": int((tol < tol_init).sum()),
        "arcs_reverted": int((tol == 0).sum()),
        "iterations": it,
        "snap": snap_stats,
        "clearance_m": CLEARANCE_M,
        "source_violating_pairs": len(allowed),
        "pinned_vertices": sum(int(p.sum()) for p in pinned),
    }
    log(f"  simplified  {before} -> {after} vertices "
        f"({100 * after / before:.1f}%); {report['arcs_capped_by_size']} arcs "
        f"capped by polygon size, {report['arcs_tightened']} tightened by "
        f"enforcement, {report['arcs_reverted']} reverted to original")
    return out, report
