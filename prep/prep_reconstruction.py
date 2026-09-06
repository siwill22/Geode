#!/usr/bin/env python3
"""Export one Reconstruction Model's coastlines and (if available) boundary
topologies from a single gprm.datasets.Reconstructions.fetch_<model>() call.

See docs/adr/0021-reconstruction-models-get-their-own-catalog-section.md: a
Reconstruction Model's rotations, present-day geometry, and topology all come
from the SAME fetch call, never independently hand-picked file paths -- that
is what keeps them a coherent, cannot-be-mixed set (see
docs/adr/0004-per-run-coastline-rotations.md). Different models even ship
different KINDS of present-day geometry -- confirmed directly:
fetch_Scotese() returns an empty coastlines_files but a populated
continent_polygons_files, while the Müller family is the other way round --
so the choice of which one to reconstruct is made here, from the fetched
object, never by a human picking a file.

Outputs, under --out (default archive/reconstructions/<id>/):
  manifest.json                     id, name, citation, source_fetch,
                                     age_min, age_max, has_boundaries
  coastlines/geometry.bin           see prep_coastlines.py
  coastlines/rotations.json
  boundaries/boundaries.json        only if the model has resolvable
  boundaries/frames/*.geojson       topologies -- see docs/adr/0019 (some
                                     Reconstruction Models, e.g. Scotese,
                                     never have this, permanently)

Usage:
  conda run -n pygmt17 python prep/prep_reconstruction.py \\
      --model Muller2019 --name "Müller et al. 2019" \\
      --citation "Müller, R.D., et al. (2019), Tectonics" --age-max 240
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from prep_coastlines import export_geometry, export_rotations  # noqa: E402

DEEP_TIME_MAP_PY = Path(__file__).parent.parent / "viewer" / "vendor" / "deep-time-map" / "python"
sys.path.insert(0, str(DEEP_TIME_MAP_PY))


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True,
                    help="gprm Reconstructions name, e.g. Muller2019 "
                         "(calls Reconstructions.fetch_<model>)")
    ap.add_argument("--id", help="catalog id (default: --model lowercased)")
    ap.add_argument("--name", required=True, help="display name")
    ap.add_argument("--citation", default="", help="attribution / citation string")
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=250.0)
    ap.add_argument("--age-step", type=float, default=1.0)
    ap.add_argument("--anchor", type=int, default=0)
    ap.add_argument("--fill-spacing-deg", type=float, default=2.0,
                    help="interior sample spacing for the land fill")
    ap.add_argument("--out", type=Path, default=None,
                    help="default: archive/reconstructions/<id>/")
    ap.add_argument("--skip-boundaries", action="store_true",
                    help="don't export topology even if the model has it")
    args = ap.parse_args()

    from gprm.datasets import Reconstructions
    fetch = getattr(Reconstructions, f"fetch_{args.model}", None)
    if fetch is None:
        available = sorted(
            n[len("fetch_"):] for n in dir(Reconstructions) if n.startswith("fetch_"))
        raise SystemExit(f"unknown model {args.model!r}. Available: {', '.join(available)}")

    recon_id = args.id or args.model.lower()
    out = args.out or (Path("archive/reconstructions") / recon_id)
    (out / "coastlines").mkdir(parents=True, exist_ok=True)

    print(f"fetching {args.model} via Reconstructions.fetch_{args.model}() ...")
    m = fetch()

    geometry_files = list(m.coastlines_files) or list(m.continent_polygons_files)
    if not geometry_files:
        raise SystemExit(
            f"{args.model} has neither coastlines_files nor continent_polygons_files "
            "-- nothing to reconstruct")
    source_kind = "coastlines" if m.coastlines_files else "continent_polygons"
    rotation_files = list(m.rotation_files)
    has_boundaries = bool(m.dynamic_polygon_files) and not args.skip_boundaries

    print(f"  geometry source : {source_kind} ({len(geometry_files)} file(s))")
    print(f"  rotation files  : {len(rotation_files)} file(s)")
    print(f"  boundaries      : "
          f"{'yes' if has_boundaries else 'no (no dynamic polygons in this model)'}")

    plate_ids, line_counts = export_geometry(
        geometry_files, out / "coastlines" / "geometry.bin", args.fill_spacing_deg)
    ages = np.arange(args.age_min, args.age_max + args.age_step / 2, args.age_step)
    export_rotations(rotation_files, plate_ids, ages, args.anchor,
                      out / "coastlines" / "rotations.json", line_counts)

    if has_boundaries:
        from deep_time_map.export import export_series
        boundaries_dir = out / "boundaries"
        print(f"\nexporting boundaries to {boundaries_dir} ...")
        export_series(model_name=args.model, start=int(args.age_min),
                      end=int(args.age_max), step=int(args.age_step),
                      anchor_plate=args.anchor, out_dir=str(boundaries_dir))

    manifest = {
        "id": recon_id,
        "name": args.name,
        "citation": args.citation,
        "source_fetch": f"fetch_{args.model}",
        "age_min": float(args.age_min),
        "age_max": float(args.age_max),
        "has_boundaries": has_boundaries,
        "coastlines": {
            "geometry": "coastlines/geometry.bin",
            "rotations": "coastlines/rotations.json",
            "age_min": float(args.age_min),
            "age_max": float(args.age_max),
        },
    }
    if has_boundaries:
        manifest["boundaries"] = "boundaries/boundaries.json"
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {out}/manifest.json")


if __name__ == "__main__":
    main()
