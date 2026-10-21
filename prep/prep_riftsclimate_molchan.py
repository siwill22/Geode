#!/usr/bin/env python3
"""Build the RiftsClimate Molchan viewer's archive section (`molchan.html`).

The science belongs to the RiftsClimate repository: its `prep/geode_molchan_export.py` writes
the inputs of the one-factor Molchan test (step 1 of its factor-combination ladder) to
`data/geode/molchan/`, after checking every skill against its own pipeline. This script only
repacks those files into compact ones the page can load. Nothing here computes a value.

What the archive already holds is READ by the page, never copied: the Merdith 2021 coastlines,
margin lines and continent polygons (archive/riftsclimate/index.json, written by
prep_riftsclimate.py). New content goes under archive/riftsclimate/molchan/ only:

  index.json      factors (label, column, unit, kind), deposit types, the Molchan curves
                  (every deposit's share, sorted) and skills, counts, provenance
  boxes.json.gz   every place's id and, for each place and time slice, where
                  the place was (Merdith 2021), its weight, its weight in the test (time slices
                  merged in pairs), each factor's value and each factor's share of the test's
                  ground rated higher; place-major, null where the place has no box
  deposits.json.gz  the SEDEX, MVT and Cu-sed deposits the test uses: name, type, age, where they formed
                  (Merdith 2021) and are today, region, each factor's value and share, and
                  where each was at every time slice's own age (RiftsClimate's positions.csv.gz;
                  deposit-major, null where it cannot be placed), so it moves with its plate

Run with the RiftsClimate environment, like prep_riftsclimate.py:
    env -u PYTHONPATH conda run -n riftsclimate python prep/prep_riftsclimate_molchan.py
"""

import argparse
import datetime
import gzip
import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

RIFTSCLIMATE = Path("/Users/simon/GIT/RiftsClimate")
PLATE_MODEL = "merdith2021"          # the id in archive/riftsclimate/index.json
FORMAT = 2                 # 2: deposits carry their position at every time slice
TYPES = {"PbZn-CD": "SEDEX (clastic-dominated Pb-Zn)", "PbZn-MVT": "MVT (Mississippi Valley-type Pb-Zn)",
         "Cu-sed": "Cu-sed (sediment-hosted stratiform Cu)"}
# Each column's unit, and how many decimals to keep.
COLUMNS = {
    "post_rift_km": ("km", 0), "syn_rift_km": ("km", 0), "line_any_stage_km": ("km", 0),
    "craton_edge_km": ("km", 0), "subduction_km": ("km", 0), "abs_lat_Merdith2021": ("°", 1),
    "collision_km": ("km", 0), "line_post_collision_km": ("km", 0),
}
# How each factor rates the ground, in words (the export's FACTORS, as text for the page).
RATING = {
    "passive margin": "nearer a passive (post-rift) margin at the time rates higher",
    "active rift axis": "nearer an active (syn-rift) axis at the time rates higher",
    "margin line, any stage": "nearer a margin line in any stage at the time rates higher",
    "margin line after collision": "nearer a margin line whose collision had ended by the time rates higher",
    "craton edge": "nearer the craton edge (present-day map) rates higher",
    "subduction window 800-1800 km": "800-1800 km from a subduction zone at the time rates 1, elsewhere 0",
    "distance from the equator": "nearer the equator (palaeolatitude) rates higher",
    "evaporite hump 19 by 18": "a bell curve in palaeolatitude, highest at 19°, width 18°",
    "collision at the time 500 km": "within 500 km of a margin in collision at the time rates 1, elsewhere 0",
}


def write_gz_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(raw)
    return path.stat().st_size


def rounded(values, decimals):
    """A list for JSON: rounded floats, None where missing."""
    v = np.asarray(values, float)
    out = np.round(v, decimals)
    return [None if not np.isfinite(x) else (int(x) if decimals == 0 else float(x)) for x in out]


def provenance(rc):
    def git(*a):
        try:
            return subprocess.run(["git", "-C", str(rc), *a], capture_output=True, text=True,
                                  check=True).stdout.strip()
        except Exception:
            return None
    script = "prep/geode_molchan_export.py"
    status = git("status", "--porcelain", "--", script) or ""
    return {
        "riftsclimate_commit": git("rev-parse", "--short", "HEAD"),
        "script": script,
        "script_state": ("untracked" if status.startswith("??") else
                         "uncommitted changes" if status else "committed"),
        "data": "data/geode/molchan/",
        "data_written": datetime.datetime.fromtimestamp(
            (rc / "data/geode/molchan/boxes.csv.gz").stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
        "packed": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--riftsclimate", type=Path, default=RIFTSCLIMATE)
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    args = ap.parse_args()
    src = args.riftsclimate / "data" / "geode" / "molchan"
    out = args.archive / "riftsclimate" / "molchan"

    boxes = pd.read_csv(src / "boxes.csv.gz")
    deposits = pd.read_csv(src / "deposits.csv")
    meta = json.loads((src / "molchan.json").read_text())
    factors = meta["factors"]
    unknown = set(RATING) ^ set(factors)
    if unknown:
        raise SystemExit(f"factors differ between the export and this script: {sorted(unknown)}")

    # --- boxes: one value per place x time slice -------------------------------------------
    snaps = boxes.groupby("snapshot_ma")[["from_ma", "to_ma"]].agg(["min", "max"])
    if ((snaps[("from_ma", "min")] != snaps[("from_ma", "max")]).any()
            or (snaps[("to_ma", "min")] != snaps[("to_ma", "max")]).any()):
        raise SystemExit("time slices do not share one from/to per slice across places")
    snap_ma = snaps.index.to_numpy(float)
    sidx = {s: i for i, s in enumerate(snap_ma)}
    place_ids = np.sort(boxes["place"].unique())
    pidx = {int(p): i for i, p in enumerate(place_ids)}
    P, S = len(place_ids), len(snap_ma)
    flat = boxes["place"].map(pidx).to_numpy() * S + boxes["snapshot_ma"].map(sidx).to_numpy()

    def grid(col):
        g = np.full(P * S, np.nan)
        g[flat] = boxes[col].to_numpy(float)
        return g

    # Present-day position of each place: the box at 0 Ma where it has one, else its youngest.
    youngest = boxes.sort_values("snapshot_ma").drop_duplicates("place").set_index("place")
    box_obj = {
        "layout": "value[place_index * n_snapshots + snapshot_index]; null where the place has no box",
        "places": {"id": [int(p) for p in place_ids]},
        "snapshots": {
            "snapshot_ma": rounded(snap_ma, 2),
            "from_ma": rounded(snaps[("from_ma", "min")], 2),       # young end
            "to_ma": rounded(snaps[("to_ma", "min")], 2),           # old end
        },
        "m_lon": rounded(grid("m_lon"), 2),
        "m_lat": rounded(grid("m_lat"), 2),
        "weight": rounded(grid("weight") / 1e6, 4),                 # million km² x Myr
        "weight_in_test": rounded(grid("weight_in_test") / 1e6, 4),
        "values": {c: rounded(grid(c), d) for c, (_, d) in COLUMNS.items()},
        "shares": {f: rounded(grid(f"share|{f}"), 3) for f in factors},
    }
    size = write_gz_json(out / "boxes.json.gz", box_obj)
    print(f"boxes: {P} places x {S} time slices ({len(boxes)} boxes, "
          f"{int((boxes.weight_in_test > 0).sum())} in the test), {size / 1e6:.2f} MB")

    # --- deposits ---------------------------------------------------------------------------
    dep_obj = {
        "deposit_id": deposits["deposit_id"].tolist(),
        "name": deposits["deposit"].fillna("").tolist(),
        "type": deposits["deposit_class"].tolist(),
        "age_ma": rounded(deposits["age_ma"], 2),
        "lon": rounded(deposits["lon"], 3), "lat": rounded(deposits["lat"], 3),
        "m_lon": rounded(deposits["m_lon"], 3), "m_lat": rounded(deposits["m_lat"], 3),
        "region": deposits["region"].fillna("").tolist(),
        "values": {c: rounded(deposits[c], d) for c, (_, d) in COLUMNS.items()},
        "shares": {f: rounded(deposits[f"share|{f}"], 4) for f in factors},
    }
    # Where each deposit was at each time slice's own age: deposit-major, null where RiftsClimate
    # could not place it (no continent polygon yet, or no real rotation).
    pos = pd.read_csv(src / "positions.csv.gz")
    didx = {d: i for i, d in enumerate(deposits["deposit_id"])}
    pos = pos[pos["deposit_id"].isin(didx)]
    at = pos["deposit_id"].map(didx).to_numpy() * S + pos["snapshot_ma"].map(sidx).to_numpy()
    assert not np.isnan(at.astype(float)).any(), "a position's time slice is not one of the boxes'"
    for c in ("lon", "lat"):
        g = np.full(len(deposits) * S, np.nan)
        g[at] = pos[c].to_numpy(float)
        dep_obj[f"slice_{c}"] = rounded(g, 3)
    size = write_gz_json(out / "deposits.json.gz", dep_obj)
    print(f"deposits: {len(deposits)} ({deposits.deposit_class.value_counts().to_dict()}), {size / 1e3:.0f} kB")

    # --- index ------------------------------------------------------------------------------
    index = {
        "title": "RiftsClimate: the one-factor Molchan test, its inputs",
        "format": FORMAT,
        "plate_model": PLATE_MODEL,
        "age_max": int(np.ceil(snaps[("to_ma", "max")].max())),
        "types": [{"id": t, "label": TYPES[t]} for t in TYPES],
        "factors": [{"id": f, "column": v["column"], "unit": COLUMNS[v["column"]][0],
                     "rating": RATING[f], "types": ["PbZn-MVT"] if v["mvt_only"] else list(TYPES)}
                    for f, v in factors.items()],
        "curves": meta["curves"],
        "counts": {"places": P, "snapshots": S, "boxes": len(boxes),
                   "boxes_in_test": int((boxes.weight_in_test > 0).sum()),
                   "deposits": deposits.deposit_class.value_counts().to_dict()},
        "files": {"boxes": "riftsclimate/molchan/boxes.json.gz", "deposits": "riftsclimate/molchan/deposits.json.gz"},
        "built_from": provenance(args.riftsclimate),
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {out}/index.json")


if __name__ == "__main__":
    main()
