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
"""

import argparse
import json
from pathlib import Path

import numpy as np
from matplotlib import colormaps

DIVERGING = ["RdBu", "Spectral", "coolwarm", "seismic", "bwr"]
SEQUENTIAL = ["viridis", "magma", "cividis"]

# Suffix for the warm-at-high variant. The unsuffixed name keeps its original
# meaning (cool at high) so manifests written before this change still resolve.
HOT_SUFFIX = "_hot"


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

    if failures:
        raise SystemExit(f"\npolarity check failed for: {', '.join(failures)}")

    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    print(f"\nwrote {p}  ({p.stat().st_size / 1024:.1f} kB, {len(out)} maps)")


if __name__ == "__main__":
    main()
