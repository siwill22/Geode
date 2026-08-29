#!/usr/bin/env python3
"""Emit the viewer's colour ramps as 256-entry JSON.

Sourced from matplotlib rather than any external colour-map distribution, so
the project carries no extra data dependency.

POLARITY IS THE POINT. Seismic velocity anomaly is signed, and the convention
these maps must honour is:

    fast (positive dV)  ->  COLD colours (blue)   -- subducting slabs
    slow (negative dV)  ->  WARM colours (red)    -- plumes, hotspots, LLSVPs

The shader maps the low end of the data range to colour index 0, so index 0 must
be RED and index 255 must be BLUE. That is the reverse of most diverging maps as
they ship, which run blue-to-red; where that is the case the name below carries
matplotlib's `_r` suffix. Getting this backwards paints every slab red and every
plume blue, which looks entirely plausible and is entirely wrong.
"""

import argparse
import json

import numpy as np
from matplotlib import colormaps

# name in the viewer -> (matplotlib name, diverging?)
# Diverging entries are ordered red-at-low / blue-at-high.
WANTED = {
    "RdBu":      ("RdBu", True),        # ships red->blue already
    "Spectral":  ("Spectral", True),    # ships red->blue already
    "coolwarm":  ("coolwarm_r", True),  # ships blue->red, so reversed
    "seismic":   ("seismic_r", True),   # ships blue->red, so reversed
    "bwr":       ("bwr_r", True),       # ships blue->red, so reversed
    "viridis":   ("viridis", False),
    "magma":     ("magma", False),
    "cividis":   ("cividis", False),
}


def sample(mpl_name):
    cmap = colormaps[mpl_name]
    xs = np.linspace(0.0, 1.0, 256)
    rgba = cmap(xs)
    return (np.clip(rgba[:, :3], 0, 1) * 255).round().astype(int).tolist()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="archive/colormaps.json")
    args = ap.parse_args()

    out = {}
    for name, (mpl_name, diverging) in WANTED.items():
        colors = sample(mpl_name)
        out[name] = {"diverging": diverging, "colors": colors}
        lo, hi = colors[0], colors[-1]
        kind = "diverging" if diverging else "sequential"
        note = ""
        if diverging:
            warm_low = lo[0] > lo[2]      # more red than blue at the low end
            cold_high = hi[2] > hi[0]     # more blue than red at the high end
            note = "  slow=warm fast=cold OK" if (warm_low and cold_high) else \
                   "  ** POLARITY WRONG **"
        print(f"  {name:10s} {kind:11s} low={tuple(lo)} high={tuple(hi)}{note}")

    from pathlib import Path
    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    print(f"\nwrote {p}  ({p.stat().st_size / 1024:.1f} kB, {len(out)} maps)")


if __name__ == "__main__":
    main()
