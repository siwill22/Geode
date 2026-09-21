#!/usr/bin/env python3
"""Export the Boucot, Chen & Scotese (2013) paleolithology indicator points
for the climate viewer's "Boucot paleolithology" overlay toggle.

Uses the petrify generic point pipeline (points_from_dataframe/
build_points, see viewer/vendor/petrify/python/petrify/points.py)
-- the same primitive CONTEXT.md's Plate-Frame Point entry names for "a
dataset whose points are locations on a plate": present-day coordinates with
no plate id of their own, assigned one by partitioning against a
Reconstruction Model's static polygons (here, Scotese -- the same
reconstruction climate.html's own coastlines/paleogeography/Plate-Frame Point
already use, via gprm.datasets.Reconstructions.fetch_Scotese()).

Category fill colours come from the GMT .cpt file Boucot's own LithCode
letters were originally symbolised with (--cpt), baked into points.json's
`categories` field at prep time -- the white edge is a client-side
PointLayer `keyline` option instead (uniform, not per-category, so it has no
reason to live in this export).

Output: <out>/points.json (default archive/reconstructions/scotese/paleolithology/).
Also updates <reconstruction-manifest>'s own manifest.json with a
"paleolithology": {"points": "paleolithology/points.json"} field, the same
conditional-field pattern prep_reconstruction.py uses for static_polygons --
read-modify-write here rather than a full prep_reconstruction.py re-run,
since this is additive to an already-exported Reconstruction Model.

Usage:
  conda run -n pygmt17 python prep/prep_boucot.py
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

PETRIFY_PY = Path(__file__).parent.parent / "viewer" / "vendor" / "petrify" / "python"
sys.path.insert(0, str(PETRIFY_PY))

DEFAULT_CPT = Path("/Users/simon/GIT/pygplates-paleo/Boucot/boucot_paleolithology_cpt.cpt")


def parse_lith_cpt(path):
    """{LithCode: (r, g, b)} from a GMT categorical .cpt keyed by quoted codes.

    The trailing unquoted B/F/N lines (background/foreground/NaN) are GMT's
    own footer convention, not lithology categories -- skipped by the same
    "starts with a quote" test that picks out every real entry. One entry in
    the source file, "D" 176/266/255, has a component past 255 (a literal
    anomaly in the file, not a transcription choice here) -- clamped to a
    valid colour rather than silently left to overflow or guessed at a
    "corrected" value.
    """
    codes = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line.startswith('"'):
            continue
        code, _, rest = line[1:].partition('"')
        r, g, b = (min(255, max(0, int(v))) for v in rest.strip().split('/'))
        codes[code] = (r, g, b)
    return codes


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cpt", type=Path, default=DEFAULT_CPT,
                    help="LithCode -> RGB categorical palette")
    ap.add_argument("--reconstruction-dir", type=Path,
                    default=Path("archive/reconstructions/scotese"),
                    help="the Scotese Reconstruction Model's own archive directory "
                         "(already exported by prep_reconstruction.py)")
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=540.0)
    ap.add_argument("--age-step", type=float, default=5.0,
                    help="'rotations' transport scales with plates x times, not "
                         "points x times, and PointLayer slerps between samples, "
                         "so a coarser step than coastlines' own stays smooth")
    args = ap.parse_args()

    manifest_path = args.reconstruction_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(
            f"{manifest_path} not found -- run prep_reconstruction.py --model Scotese first")

    from petrify.points import points_from_dataframe, build_points

    from gprm.datasets import Reconstructions
    from gprm.datasets.Strat import PaleoLithology

    print(f"loading Boucot paleolithology points via gprm.datasets.Strat.PaleoLithology() ...")
    gdf = PaleoLithology()
    gdf["Lon"] = gdf.geometry.x
    gdf["Lat"] = gdf.geometry.y
    print(f"  {len(gdf)} points, {gdf['LithCode'].nunique()} LithCode categories")

    print("fetching Scotese via Reconstructions.fetch_Scotese() ...")
    model = Reconstructions.fetch_Scotese()

    records, unassigned = points_from_dataframe(
        gdf, model, lon_field="Lon", lat_field="Lat", age_field="FROMAGE",
        fields=[
            ("type", "LithCode"), ("from", "FROMAGE"), ("to", "TOAGE"),
            # PaleoLithology() already carries the full display name per row
            # (gprm.datasets.Strat's own BOUCOT_INDICATORS lookup) -- reused
            # here rather than re-deriving it, so the hover tooltip shows
            # "Coal"/"Bauxite"/... not a bare LithCode letter.
            ("indicator", "Indicator"),
        ],
    )
    plate_ids = {r["plate_id"] for _, r in records}
    print(f"  {len(plate_ids)} distinct plates, {unassigned} point(s) unassigned (plate 0)")

    lith_colors = parse_lith_cpt(args.cpt)
    missing = {r["type"] for _, r in records} - set(lith_colors)
    if missing:
        raise SystemExit(f"{args.cpt}: no colour for LithCode(s) {sorted(missing)}")
    categories = {
        code: {"symbol": "circle", "fill": f"rgb({r},{g},{b})"}
        for code, (r, g, b) in lith_colors.items()
    }

    times = np.arange(args.age_min, args.age_max + args.age_step / 2, args.age_step)
    payload = build_points(
        model, records, times, transport="rotations",
        categories=categories, model_name="Scotese",
    )

    out_dir = args.reconstruction_dir / "paleolithology"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "points.json"
    out_path.write_text(json.dumps(payload))
    mb = out_path.stat().st_size / 1024 / 1024
    print(f"wrote {out_path} ({mb:.2f} MB, {len(times)} times)")

    manifest = json.loads(manifest_path.read_text())
    manifest["paleolithology"] = {"points": "paleolithology/points.json"}
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"updated {manifest_path} with a \"paleolithology\" field")


if __name__ == "__main__":
    main()
