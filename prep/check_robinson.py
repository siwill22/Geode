"""Measure Geode's Robinson table against PROJ.

The projection is tabulated: 19 nodes at 5 deg of latitude, linearly
interpolated between them. PROJ interpolates the same nodes with a higher-order
scheme, so the two disagree *between* nodes by construction. Linear is not an
oversight -- the identical arithmetic has to run per-fragment in GLSL, where a
Stineman/Newton evaluation is not worth its cost.

What matters is how big that disagreement is, and nothing asserted it until
this existed. It is quoted in core/robinson.ts's doc comment, so it should be
measured rather than believed.

The table now lives upstream in petrify (one copy, two consumers -- see
its CHANGELOG for v0.6.0), and is read from there rather than retyped here:
a check with its own third transcription of the numbers would pass while the
shipped ones were wrong.

    python prep/check_robinson.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
from pyproj import CRS, Transformer

JS = Path(__file__).resolve().parents[1] / "viewer/vendor/petrify/js/robinson.js"

# As a fraction of the map's half-extent. A full-screen map is ~2000 px across,
# so half-width is ~1000 px and one pixel is ~1e-3.
#
# Set from what this actually measures. Both numbers below were guessed first
# and both guesses were wrong, in the optimistic direction, which is the whole
# argument for the check existing.
#
# Measured worst case is 1.4e-3 of half-width in x and 1.8e-3 of half-height in
# y -- roughly 1.5 px on a full-screen map -- in the last table interval,
# 85-90 deg, where Robinson's parallel-length factor turns hardest and linear
# interpolation has the most to miss. Below 85 deg it is 8.5e-4, under a pixel,
# and that band holds essentially all the map's content.
#
# Accepted rather than fixed: tightening it means more table nodes or a
# higher-order scheme, and the identical arithmetic has to run per-fragment in
# GLSL. These are ceilings to notice a REGRESSION against, set just above the
# measurement, not targets that were aimed for.
TOLERANCE = 2e-3
TOLERANCE_MAIN = 1e-3   # below 85 deg, where the content is


def read_table(name: str) -> np.ndarray:
    """Pull one exported array out of the JS, so there is exactly one copy."""
    src = JS.read_text()
    m = re.search(rf"export const {name} = \[(.*?)\];", src, re.S)
    if not m:
        sys.exit(f"could not find {name} in {JS}")
    # JS tolerates the trailing comma the source is formatted with; JSON does not.
    body = re.sub(r",\s*$", "", m.group(1).replace("\n", " ").strip())
    return np.array(json.loads("[" + body + "]"))


def main() -> int:
    X = read_table("ROBINSON_X")
    Y = read_table("ROBINSON_Y")
    KX = float(re.search(r"ROBINSON_KX = ([\d.]+)", JS.read_text()).group(1))
    KY = float(re.search(r"ROBINSON_KY = ([\d.]+)", JS.read_text()).group(1))

    nodes = np.arange(0, 91, 5.0)
    lat = np.arange(-90, 90.001, 0.25)
    lon = np.array([0.0, 45.0, 90.0, 135.0, 180.0])

    # Ours: linear interpolation of the table, exactly as robinsonForward does.
    xf = np.interp(np.abs(lat), nodes, X)
    yf = np.interp(np.abs(lat), nodes, Y)

    # PROJ's, on a unit sphere so both are in the same projection units. The
    # SOURCE has to be a unit sphere too, not EPSG:4326 -- PROJ refuses to
    # transform between two different celestial bodies, and an Earth ellipsoid
    # to a unit sphere is exactly that. Since the projection here is defined on
    # a sphere anyway, this is the honest pairing rather than a workaround.
    tf = Transformer.from_crs(CRS.from_proj4("+proj=longlat +R=1 +no_defs"),
                              CRS.from_proj4("+proj=robin +R=1 +no_defs"),
                              always_xy=True)

    inner = np.abs(lat) <= 85.0

    worst_x = worst_y = worst_inner = 0.0
    worst_at = None
    for lo in lon:
        px, py = tf.transform(np.full_like(lat, lo), lat)
        ox = KX * np.radians(lo) * xf
        oy = KY * np.where(lat < 0, -yf, yf)
        dx = np.abs(px - ox)
        dy = np.abs(py - oy)
        if dx.max() > worst_x:
            worst_x, worst_at = dx.max(), (lo, lat[int(dx.argmax())])
        worst_y = max(worst_y, dy.max())
        worst_inner = max(worst_inner, dx[inner].max(), dy[inner].max())

    half_width = KX * np.pi
    print(f"  samples            : {lat.size * lon.size}")
    print(f"  worst |dx|         : {worst_x:.3e}  ({worst_x / half_width:.2e} of map half-width)")
    print(f"  worst |dy|         : {worst_y:.3e}  ({worst_y / KY:.2e} of map half-height)")
    print(f"  worst at           : lon {worst_at[0]:.0f}, lat {worst_at[1]:.2f}")
    print(f"  worst below 85 deg : {worst_inner:.3e}  ({worst_inner / half_width:.2e} of half-width)")
    print(f"  tolerance          : {TOLERANCE:.0e} overall, {TOLERANCE_MAIN:.0e} below 85 deg")

    # At the nodes themselves the two must agree to the 4 dp the table carries,
    # since there is no interpolation left to disagree about. This is the part
    # that catches a genuinely wrong or mistyped entry, as opposed to the
    # expected between-node wobble.
    nx, _ = tf.transform(np.full_like(nodes, 180.0), nodes)
    node_err = np.abs(nx - KX * np.pi * X).max()
    print(f"  worst at a NODE    : {node_err:.3e}")

    ok = (worst_x / half_width < TOLERANCE
          and worst_y / KY < TOLERANCE
          and worst_inner / half_width < TOLERANCE_MAIN
          and node_err < 1e-4)
    print("\nOK" if ok else "\nFAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
