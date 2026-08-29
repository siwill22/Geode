#!/usr/bin/env python3
"""Scan archive/models/* and write archive.json, the viewer's entry point."""

import argparse
import json
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=200.0)
    args = ap.parse_args()

    # The age slider must not offer ages the coastline rotations do not cover.
    rot_path = args.archive / "coastlines" / "rotations.json"
    if rot_path.exists():
        ages = json.loads(rot_path.read_text())["ages"]
        args.age_min, args.age_max = float(min(ages)), float(max(ages))
        print(f"  coastlines rotations cover {args.age_min:.0f}-{args.age_max:.0f} Ma")

    models = []
    for manifest_path in sorted(args.archive.glob("models/*/manifest.json")):
        m = json.loads(manifest_path.read_text())
        models.append({
            "id": m["id"],
            "name": m["name"],
            "type": m["type"],
            "source": m.get("source", ""),
            "path": f"models/{m['id']}/manifest.json",
            "variables": [
                {"id": v["id"], "name": v["name"]} for v in m["variables"]
            ],
            "depth_min_km": m["depth_min_km"],
            "depth_max_km": m["depth_max_km"],
        })
        ages = [f["age_ma"] for f in m["frames"]]
        span = (f"  {len(ages)} frames {min(ages):.0f}-{max(ages):.0f} Ma"
                if len(ages) > 1 else "")
        print(f"  {m['id']:14s} {m['name']:18s} "
              f"{len(m['variables'])} var(s)  "
              f"{m['depth_min_km']:.0f}-{m['depth_max_km']:.0f} km{span}")

    index = {
        "models": models,
        "colormaps": "colormaps.json",
        "coastlines": {
            "geometry": "coastlines/geometry.bin",
            "rotations": "coastlines/rotations.json",
            "age_min": args.age_min,
            "age_max": args.age_max,
        },
    }

    bpath = args.archive / "boundaries" / "boundaries.json"
    if bpath.exists():
        b = json.loads(bpath.read_text())
        index["boundaries"] = "boundaries/boundaries.json"
        times = [f["time"] for f in b["frames"]]
        print(f"  boundaries     {b['model']:18s} {len(times)} frames "
              f"{min(times)}-{max(times)} Ma")

    out = args.archive / "archive.json"
    out.write_text(json.dumps(index, indent=2))
    print(f"\nwrote {out}  ({len(models)} models)")


if __name__ == "__main__":
    main()
