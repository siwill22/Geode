#!/usr/bin/env python3
"""Emit the viewer's colour ramps as 256-entry JSON.

Sourced from matplotlib rather than any external colour-map distribution, so
the project carries no extra data dependency.

POLARITY IS THE POINT, AND IT DEPENDS ON THE VARIABLE.

    seismic velocity anomaly   positive = fast = COLD material -> blue
    temperature anomaly        positive = hot                  -> red

The same physical object -- a subducted slab -- is a positive anomaly in one and
a negative anomaly in the other. So there is no single correct orientation for a
diverging ramp; there are two, and each variable must be paired with the right
one.

Every diverging map is therefore emitted twice, and each entry declares which
end is warm:

    high_end: "cool"   index 255 is blue   -- for velocity anomaly
    high_end: "warm"   index 255 is red    -- for temperature anomaly

Orientation is MEASURED from the sampled RGB rather than hardcoded from
matplotlib's `_r` naming, and then asserted. Getting it backwards paints every
slab red and every plume blue, which looks entirely plausible and is entirely
wrong -- it has already happened twice in this project.

RUN THIS BEFORE prep_paleogeography.py, NOT AFTER. This script OVERWRITES
archive/colormaps.json wholesale (out = {} below); prep_paleogeography.py
MERGES its own 'geo' entry into whatever is already on disk. Running this
script second silently deletes 'geo' -- every variable using it (paleogeography
elevation) then fails to load with "Cannot read properties of undefined
(reading 'colors')" until prep_paleogeography.py is re-run to restore it.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from matplotlib import colormaps

DIVERGING = ["RdBu", "Spectral", "coolwarm", "seismic", "bwr"]
SEQUENTIAL = ["viridis", "magma", "cividis", "gray", "plasma"]

# Suffix for the warm-at-high variant. The unsuffixed name keeps its original
# meaning (cool at high) so manifests written before this change still resolve.
HOT_SUFFIX = "_hot"

# Order MUST match prep_climate.py's KOPPEN_CLASS_NAMES exactly -- kept as a
# literal list here rather than importing it, since prep_colormaps.py runs
# BEFORE prep_climate.py in the pipeline (see README, "Regenerating data")
# and colour choice for a qualitative palette is a display convention, not
# something that needs to share code with the classification logic itself.
# 0 = Ocean; 1-13 = the 13 land classes, tropical (blue) -> arid (red/orange)
# -> temperate (green/yellow) -> cold (purple/teal) -> polar (grey/white).
KOPPEN_COLORS = [
    (25, 60, 120),     # 0  Ocean
    (170, 170, 170),   # 1  Tundra (ET)
    (240, 240, 240),   # 2  Frost (EF)
    (180, 120, 200),   # 3  Cold, dry winter (Dw)
    (140, 0, 140),     # 4  Cold, dry summer (Ds)
    (0, 130, 130),     # 5  Cold, no dry season (Df)
    (170, 220, 120),   # 6  Temperate, dry winter (Cw)
    (230, 220, 0),     # 7  Temperate, dry summer (Cs)
    (40, 160, 40),     # 8  Temperate, no dry season (Cf)
    (220, 20, 20),     # 9  Desert (BW)
    (245, 165, 0),     # 10 Steppe (BS)
    (120, 200, 255),   # 11 Savannah (Aw)
    (0, 110, 255),     # 12 Monsoon (Am)
    (0, 0, 180),       # 13 Fully humid (Af)
]


def sample(mpl_name):
    cmap = colormaps[mpl_name]
    xs = np.linspace(0.0, 1.0, 256)
    rgba = cmap(xs)
    return (np.clip(rgba[:, :3], 0, 1) * 255).round().astype(int).tolist()


def warmth(rgb):
    """Red minus blue. Positive is warm. Crude, and entirely sufficient for
    telling which end of a red/blue diverging ramp we are looking at."""
    return rgb[0] - rgb[2]


def orient(colors, high_end):
    """Order `colors` so that the requested end is warm.

    Derived from the colours themselves, so it does not matter which way round
    matplotlib happens to ship any given map.
    """
    high_is_warm = warmth(colors[-1]) > warmth(colors[0])
    if high_is_warm != (high_end == "warm"):
        colors = colors[::-1]
    return colors


def build_categorical_colormap(colors):
    """colors: list of N (r, g, b) tuples -> 256-entry flat-colour-block RGB
    list. Texel i gets colors[floor(i/256*N)] -- matches how the viewer's
    uSteps=N quantises the ramp into N discrete bands and samples each
    band's CENTRE (see material.ts's fragment shader): every texel around a
    sampled band centre is guaranteed to be the same flat colour regardless
    of whether N divides 256 evenly, so LinearFilter interpolation never
    blends two different classes together.
    """
    n = len(colors)
    return [list(colors[min(n - 1, int(i * n / 256))]) for i in range(256)]


def check(colors, high_end):
    """Assert the ramp really does run the way its high_end claims."""
    lo, hi = colors[0], colors[-1]
    ok = (warmth(hi) > warmth(lo)) == (high_end == "warm")
    if high_end == "warm":
        ok = ok and warmth(hi) > 0 and warmth(lo) < 0
    else:
        ok = ok and warmth(hi) < 0 and warmth(lo) > 0
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="archive/colormaps.json")
    args = ap.parse_args()

    out = {}
    failures = []

    for base in DIVERGING:
        raw = sample(base)
        for high_end, suffix in (("cool", ""), ("warm", HOT_SUFFIX)):
            name = base + suffix
            colors = orient(raw, high_end)
            out[name] = {
                "diverging": True,
                "high_end": high_end,
                "colors": colors,
            }
            ok = check(colors, high_end)
            if not ok:
                failures.append(name)
            means = "fast=cold" if high_end == "cool" else "hot=warm"
            print(f"  {name:14s} diverging   high_end={high_end:4s} "
                  f"low={tuple(colors[0])} high={tuple(colors[-1])}  "
                  f"{'OK  ' + means if ok else '** POLARITY WRONG **'}")

    for base in SEQUENTIAL:
        colors = sample(base)
        out[base] = {"diverging": False, "high_end": None, "colors": colors}
        print(f"  {base:14s} sequential              "
              f"low={tuple(colors[0])} high={tuple(colors[-1])}")

    koppen_colors = build_categorical_colormap(KOPPEN_COLORS)
    # general=False: a fixed 14-class palette keyed to the Koppen class codes
    # (see KOPPEN_COLORS above), meaningless applied to any other variable --
    # excluded from the tomography viewer's generic colormap picker (see
    # colormapOptions() in viewer/src/tomography/instance.ts) even though it
    # is, mechanically, just another non-diverging 256-entry ramp.
    out["koppen"] = {
        "diverging": False, "high_end": None, "general": False, "colors": koppen_colors,
    }
    print(f"  {'koppen':14s} categorical ({len(KOPPEN_COLORS)} classes)")

    if failures:
        raise SystemExit(f"\npolarity check failed for: {', '.join(failures)}")

    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    print(f"\nwrote {p}  ({p.stat().st_size / 1024:.1f} kB, {len(out)} maps)")


if __name__ == "__main__":
    main()
