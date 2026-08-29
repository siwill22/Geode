#!/usr/bin/env python3
"""Verify the exported plate boundaries, against the model they came from.

deep_time_map.verify does the actual checking. This wrapper exists for one
reason: its CLI takes `--model`, defaulting to `Merdith2021`, and does NOT read
the model name from the export's own manifest. Point it at a Muller2022 export
and it silently resolves Merdith2021 topologies instead, then reports the
mismatch as a polarity failure.

That failure is very convincing. The two models share Merdith's topologies, so
the feature counts match exactly; only the rotations differ. Agreement therefore
degrades smoothly with age, in step with the rotation difference:

    age      Muller2022 vs Muller2019 rotations     verify against the wrong model
      0 Ma   0.00 deg                               75 agree /  3 disagree
     50 Ma   2.92 deg                               18       / 24
    100 Ma   6.19 deg                               14       / 16
    150 Ma   6.38 deg                               14       / 19

which reads exactly like a real, progressively worsening polarity bug in the
deep-time part of the model. It is not: with `--model Muller2022` the same
export gives 0 disagreements at 50, 100, 150 and 200 Ma.

So: always take the model from the manifest.

    python prep/check_boundaries.py --data archive/boundaries --time 100
"""

import argparse
import json
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path("archive/boundaries"))
    ap.add_argument("--time", type=float, nargs="+",
                    default=[0, 50, 100, 150, 200])
    ap.add_argument("--figures", action="store_true")
    args = ap.parse_args()

    manifest = json.loads((args.data / "boundaries.json").read_text())
    model = manifest["model"]

    from deep_time_map import verify

    print(f"{model}, {len(manifest['frames'])} frames, "
          f"anchor plate {manifest['anchor_plate_id']}")
    bad = 0
    for t in args.time:
        print(f"\n--- {t:g} Ma " + "-" * 50)
        bad += verify(data_dir=str(args.data), model_name=model, time=t,
                      figures=args.figures)
    if bad:
        print(f"\n{bad} frame(s) FAILED", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
