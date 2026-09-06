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
            # Which reconstruction this output was actually built against,
            # per that run's own copied config (see
            # prep_deformation.py's find_reconstruction_model()) -- absent
            # for models this field predates. The viewer must use THIS to
            # pick coastlines, never assume one from the model id.
            "reconstruction_model": m.get("reconstruction_model"),
            # Which role this Model plays within its own reconstruction's
            # family (e.g. "Deformation" vs "Age & Heat Flux") -- a declared
            # catalog fact (see prep_deformation.py), never inferred from the
            # model id, so a generator recipe can group several Models into
            # a comparison viewer purely from archive.json without knowing
            # any id-naming convention. Absent for a Model with no such
            # family concept (most models -- this is currently only set by
            # prep_deformation.py).
            "comparison_role": m.get("comparison_role"),
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

    # Scotese continent polygons, reconstructed the same way as `coastlines`
    # (rotate present-day geometry in the browser) but for the paleoclimate
    # viewer -- the Li et al. climate simulations and the Scotese & Wright
    # PaleoDEMs both sit on the Scotese plate model, so this is the
    # geographically-consistent overlay for climate.html, not `coastlines`
    # above (Muller, used by the tomography viewer).
    scpath = args.archive / "scotese_coastlines" / "rotations.json"
    if scpath.exists():
        ages = json.loads(scpath.read_text())["ages"]
        index["scotese_coastlines"] = {
            "geometry": "scotese_coastlines/geometry.bin",
            "rotations": "scotese_coastlines/rotations.json",
            "age_min": float(min(ages)),
            "age_max": float(max(ages)),
        }
        print(f"  scotese coastlines cover {min(ages):.0f}-{max(ages):.0f} Ma")

    # Per-run coastlines under that run's OWN native rotations -- see
    # docs/adr/0004-per-run-coastline-rotations.md. Deliberately separate from
    # `coastlines` above, which pairs the same geometry with Muller 2022's
    # rotations for the mantle viewer's OPT1 frame; reusing that entry here
    # would put a deformation run's data under continents rotated by however
    # far that run's own rotation file disagrees with Muller 2022's.
    #
    # Discovered generically (archive/coastlines_<key>_native/) rather than
    # one hardcoded block per run, and keyed by <key> (lowercase
    # reconstruction_model, e.g. "muller2019", "cao2024") so the deformation
    # viewer can look up a model's coastlines FROM that model's own
    # reconstruction_model field -- see prep_deformation.py -- instead of
    # assuming one by naming convention. A run whose coastlines are not
    # exported here just renders without a coastline overlay.
    native_coastlines = {}
    for rot_path in sorted(args.archive.glob("coastlines_*_native/rotations.json")):
        key = rot_path.parent.name[len("coastlines_"):-len("_native")]
        ages = json.loads(rot_path.read_text())["ages"]
        native_coastlines[key] = {
            "geometry": f"{rot_path.parent.name}/geometry.bin",
            "rotations": f"{rot_path.parent.name}/rotations.json",
            "age_min": float(min(ages)), "age_max": float(max(ages)),
        }
        print(f"  {key}-native coastlines cover {min(ages):.0f}-{max(ages):.0f} Ma")
    if native_coastlines:
        index["native_coastlines"] = native_coastlines

    # Reconstruction Models as a first-class catalog section -- see
    # docs/adr/0021-reconstruction-models-get-their-own-catalog-section.md.
    # Purely additive: none of the ad hoc buckets above change, and this
    # array is the ONLY thing new consumers (the reconstruction-comparison
    # wrapper) should read. Each entry's own manifest.json (under
    # reconstructions/<id>/) may point at files living anywhere in the
    # archive, including the legacy buckets above -- no data is duplicated
    # just to appear in this list.
    reconstruction_models = []
    for manifest_path in sorted(args.archive.glob("reconstructions/*/manifest.json")):
        rm = json.loads(manifest_path.read_text())
        reconstruction_models.append({
            "id": rm["id"],
            "name": rm["name"],
            "source": rm.get("citation", ""),
            "path": f"reconstructions/{rm['id']}/manifest.json",
            "has_boundaries": bool(rm.get("has_boundaries")),
        })
        print(f"  reconstruction {rm['id']:14s} {rm['name']:24s} "
              f"{rm['age_min']:.0f}-{rm['age_max']:.0f} Ma  "
              f"boundaries={'yes' if rm.get('has_boundaries') else 'no'}")
    if reconstruction_models:
        index["reconstruction_models"] = reconstruction_models

    out = args.archive / "archive.json"
    out.write_text(json.dumps(index, indent=2))
    print(f"\nwrote {out}  ({len(models)} models)")


if __name__ == "__main__":
    main()
