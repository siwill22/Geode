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
                                     age_min, age_max, has_boundaries,
                                     has_static_polygons
  coastlines/geometry.bin           see prep_coastlines.py
  coastlines/rotations.json         shared by coastlines AND static polygons
                                     -- covers the union of both sources'
                                     plate ids, not just coastlines' own
  boundaries/boundaries.json        only if the model has resolvable
  boundaries/frames/*.geojson       topologies -- see docs/adr/0019 (some
                                     Reconstruction Models, e.g. Scotese,
                                     never have this, permanently)
  staticpolygons/geometry.bin       only if the model has static polygons --
                                     see prep_staticpolygons.py and
                                     docs/adr/0025 (Plate-Frame Point)

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
from prep_staticpolygons import export_static_polygons  # noqa: E402
from prep_plate_names import export_plate_names  # noqa: E402

PETRIFY_PY = Path(__file__).parent.parent / "viewer" / "vendor" / "petrify" / "python"
sys.path.insert(0, str(PETRIFY_PY))


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
    ap.add_argument("--simplify-deg", type=float, default=0.0,
                    help="topology-preserving coastline simplification "
                         "tolerance in degrees (0 = off); see topo_simplify.py")
    ap.add_argument("--extra-rotation-plates", type=int, nargs="*", default=[],
                    help="plate ids to add to rotations.json although no exported "
                         "geometry sits on them -- e.g. a plate a viewer anchors "
                         "on (reconstructionGroupConfig.ts anchorPlates)")
    ap.add_argument("--out", type=Path, default=None,
                    help="default: archive/reconstructions/<id>/")
    ap.add_argument("--skip-boundaries", action="store_true",
                    help="don't export topology even if the model has it")
    ap.add_argument("--skip-static-polygons", action="store_true",
                    help="don't export static polygons even if the model has them")
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
    has_static_polygons = bool(m.static_polygon_files) and not args.skip_static_polygons

    print(f"  geometry source : {source_kind} ({len(geometry_files)} file(s))")
    print(f"  rotation files  : {len(rotation_files)} file(s)")
    print(f"  boundaries      : "
          f"{'yes' if has_boundaries else 'no (no dynamic polygons in this model)'}")
    print(f"  static polygons : "
          f"{'yes' if has_static_polygons else 'no (no static polygons in this model)'}")

    plate_ids, line_counts = export_geometry(
        geometry_files, out / "coastlines" / "geometry.bin", args.fill_spacing_deg,
        args.simplify_deg)

    has_plate_names = False
    if has_static_polygons:
        static_plate_ids, static_counts = export_static_polygons(
            args.model, m.static_polygon_files, out / "staticpolygons" / "geometry.bin")
        plate_ids = sorted(set(plate_ids) | set(static_plate_ids))
        for pid, (n, npts) in static_counts.items():
            ln, lp = line_counts.get(pid, (0, 0))
            line_counts[pid] = (ln + n, lp + npts)

        # Same source feature collection static polygons already came from --
        # see prep_plate_names.py. Absent (not an empty file) when that
        # source carries no name data at all (e.g. Scotese).
        plate_names = export_plate_names(
            m.static_polygon_files, out / "staticpolygons" / "plate_names.json")
        has_plate_names = plate_names is not None

    plate_ids = sorted(set(plate_ids) | set(args.extra_rotation_plates))
    ages = np.arange(args.age_min, args.age_max + args.age_step / 2, args.age_step)
    export_rotations(rotation_files, plate_ids, ages, args.anchor,
                      out / "coastlines" / "rotations.json", line_counts)

    if has_boundaries:
        from petrify.export import export_series
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
        "has_static_polygons": has_static_polygons,
        "coastlines": {
            "geometry": "coastlines/geometry.bin",
            "rotations": "coastlines/rotations.json",
            "age_min": float(args.age_min),
            "age_max": float(args.age_max),
        },
    }
    if args.simplify_deg > 0:
        manifest["coastlines"]["simplify_deg"] = args.simplify_deg
        manifest["coastlines"]["simplify_report"] = "coastlines/simplify_report.json"
    if has_boundaries:
        manifest["boundaries"] = "boundaries/boundaries.json"
    if has_static_polygons:
        manifest["static_polygons"] = {
            "geometry": "staticpolygons/geometry.bin",
            # Same rotation table as coastlines (see prep_staticpolygons.py) --
            # plate ids from both sources were unioned before it was written.
            "rotations": "coastlines/rotations.json",
        }
        manifest["has_plate_names"] = has_plate_names
        if has_plate_names:
            manifest["static_polygons"]["plate_names"] = "staticpolygons/plate_names.json"
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {out}/manifest.json")


if __name__ == "__main__":
    main()
