#!/usr/bin/env python3
"""Cross-check the viewer's spherical scanline against pygplates.

The mask is rasterised in TypeScript because the polygon is drawn interactively
in the browser, where pygplates is not available. But pygplates IS the reference
implementation for point-in-polygon on a sphere, so it holds the scanline to
account offline.

Run viewer/scripts/dump_masks.mjs first to produce the JSON this reads.

    node scripts/dump_masks.mjs /tmp/masks.json      # in viewer/
    python test-data/check_mask.py /tmp/masks.json
"""

import json
import sys
from pathlib import Path

import pygplates

# Points within this angular distance of the boundary are skipped: the mask is a
# 2048x1024 raster, so a texel is ~0.18 deg and disagreement right on the edge is
# quantisation, not a logic error.
EDGE_TOLERANCE_DEG = 0.4


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/masks.json")
    blob = json.loads(path.read_text())
    samples = blob["samples"]

    print(f"{len(samples)} sample points per case, "
          f"mask {blob['mask_w']}x{blob['mask_h']}\n")

    all_ok = True
    for name, case in blob["cases"].items():
        poly = pygplates.PolygonOnSphere(
            [pygplates.PointOnSphere(lat, lon) for lon, lat in case["vertices"]]
        )
        # pygplates' interior is orientation-defined; the viewer marks the
        # SMALLER region. Compare against whichever pygplates region is smaller,
        # which is the same rule.
        area = poly.get_area()  # steradians / (4pi) is the sphere fraction
        pyg_marks_smaller = area <= 2 * 3.141592653589793

        mismatches = 0
        skipped = 0
        for (lon, lat), verdict in zip(samples, case["verdicts"]):
            point = pygplates.PointOnSphere(lat, lon)
            dist = pygplates.GeometryOnSphere.distance(point, poly)
            if dist * 180.0 / 3.141592653589793 < EDGE_TOLERANCE_DEG:
                skipped += 1
                continue
            inside = poly.is_point_in_polygon(point)
            expected = inside if pyg_marks_smaller else (not inside)
            if bool(verdict) != bool(expected):
                mismatches += 1

        checked = len(samples) - skipped
        pct = 100.0 * mismatches / max(1, checked)
        status = "ok " if mismatches == 0 else "FAIL"
        if mismatches:
            all_ok = False
        print(f"  [{status}] {name:26s} "
              f"{checked:5d} checked, {skipped:4d} near edge, "
              f"{mismatches:4d} mismatched ({pct:.2f}%)  "
              f"marked {100 * case['marked_area_fraction']:.1f}%")

    print()
    if all_ok:
        print("scanline agrees with pygplates on every case")
        return 0
    print("scanline DISAGREES with pygplates -- see cases marked FAIL above")
    return 1


if __name__ == "__main__":
    sys.exit(main())
