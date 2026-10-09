#!/usr/bin/env python3
"""Build the RiftsClimate WP10 porphyry Cu viewer's archive section (`wp10porphyry.html`).

The science belongs to the RiftsClimate repository: its `prep/wp10_porphyry_ladder.py`
simulates porphyry Cu deposits forming at reconstructed places and times (the WP9
place-and-time boxes, 0-541 Ma, Merdith 2021) and then following Kesler & Wilkinson's
burial-exhumation random walk, for each "rung" of the ladder (where they may form) and each
walk setting, and writes what the viewer draws to `data/geode/wp10/`. This script only
repacks those files into compact ones the page can load. Nothing here computes a value.

What the archive already holds is READ by the page, never copied: the Merdith 2021
coastlines (archive/reconstructions/merdith2021/, with the 540-1000 Ma rotations the
deposit viewer added under archive/riftsclimate/merdith2021/), and the real porphyries
reconstructed on the plates the analysis gave them (archive/riftsclimate/merdith2021/
points.json.gz, written by prep_riftsclimate.py). New content goes under
archive/riftsclimate/wp10/ only:

  index.json        what the page loads first: walk settings, rungs and their fitted
                    formation parameters, the age histograms (predicted against observed,
                    5 Myr bins), the shares by subduction distance (from RiftsClimate's
                    prep/wp10_porphyry_ladder_shares.csv), provenance
  boxes.json.gz     every place (present-day position) and, for each place and time
                    snapshot, where the place was (Merdith 2021), its distance to a
                    subduction zone, each rung's formation rate and each walk's chance of
                    being found today; one value per place x snapshot, place-major, null
                    where the place has no box
  walkers.json.gz   the sample of simulated porphyries per rung and walk: place, age, fate
                    today, and the depth of the top of the body every 1 Myr from formation
  finds.json.gz     the real porphyries (their analysis values) and the predicted number of
                    porphyries found today at each place, against the real count
  boundaries.json.gz  Merdith 2021's plate boundaries at every box snapshot (RiftsClimate's
                    prep/wp10_boundaries.py): label and convergence rate along each; the
                    subduction teeth come from the archive's own Boundary Frames

Run with the RiftsClimate environment, like prep_riftsclimate.py:
    env -u PYTHONPATH conda run -n riftsclimate python prep/prep_riftsclimate_wp10.py
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
FATES = ["found today", "still buried", "eroded"]
SEP = " | "                          # key separator, as in RiftsClimate's walkers.json
AGE_MAX = 541                        # the simulation's oldest age (RiftsClimate MAX_MA)


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
    script = "prep/wp10_porphyry_ladder.py"
    status = git("status", "--porcelain", "--", script) or ""
    return {
        "riftsclimate_commit": git("rev-parse", "--short", "HEAD"),
        "script": script,
        "script_state": ("untracked" if status.startswith("??") else
                         "uncommitted changes" if status else "committed"),
        "data": "data/geode/wp10/",
        "data_written": datetime.datetime.fromtimestamp(
            (rc / "data/geode/wp10/walkers.json.gz").stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
        "packed": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--riftsclimate", type=Path, default=RIFTSCLIMATE)
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    args = ap.parse_args()
    src = args.riftsclimate / "data" / "geode" / "wp10"
    out = args.archive / "riftsclimate" / "wp10"

    places = pd.read_csv(src / "places.csv").sort_values("place").reset_index(drop=True)
    pidx = {int(p): i for i, p in enumerate(places["place"])}
    boxes = pd.read_csv(src / "boxes.csv.gz")
    porph = pd.read_csv(src / "porphyries.csv")
    curves = pd.read_csv(src / "age_curves.csv")
    finds = pd.read_csv(src / "predicted_found.csv")
    with gzip.open(src / "walkers.json.gz", "rt") as fh:
        walkers = json.load(fh)

    walk_names = list(walkers["walks"])
    # 'formation rate, rung <rung>' is the rate under the first walk setting (Kesler &
    # Wilkinson 2009); a rung fitted with the walk included (1c, 1d, 1e) also has
    # 'formation rate, rung <rung> | <walk>' for the other walk. All are relative to the
    # highest box (max 1).
    rate_cols = [c for c in boxes.columns if c.startswith("formation rate, rung ") and SEP not in c]
    rung_names = [c[len("formation rate, rung "):] for c in rate_cols]
    walk_rate_cols = {}
    for c in boxes.columns:
        if c.startswith("formation rate, rung ") and SEP in c:
            rung, wk = c[len("formation rate, rung "):].split(SEP)
            if rung not in rung_names or wk not in walk_names:
                raise SystemExit(f"unexpected column {c!r}")
            walk_rate_cols[f"{wk}{SEP}{rung}"] = c
    chance_cols = {w: f"found chance, {w}" for w in walk_names}
    missing = [c for c in chance_cols.values() if c not in boxes.columns]
    if missing:
        raise SystemExit(f"boxes.csv.gz lacks {missing}")

    # --- boxes: one value per place x snapshot -------------------------------------------
    snaps = (boxes.groupby("snapshot_ma")[["from_ma", "to_ma"]].agg(["min", "max"]))
    if ((snaps[("from_ma", "min")] != snaps[("from_ma", "max")]).any()
            or (snaps[("to_ma", "min")] != snaps[("to_ma", "max")]).any()):
        raise SystemExit("snapshots do not share one from/to per snapshot across places")
    snap_ma = snaps.index.to_numpy(float)
    sidx = {s: i for i, s in enumerate(snap_ma)}
    P, S = len(places), len(snap_ma)
    unknown = set(boxes["place"]) - set(pidx)
    if unknown:
        raise SystemExit(f"{len(unknown)} box places are not in places.csv")
    flat = boxes["place"].map(pidx).to_numpy() * S + boxes["snapshot_ma"].map(sidx).to_numpy()

    def grid(col):
        g = np.full(P * S, np.nan)
        g[flat] = boxes[col].to_numpy(float)
        return g

    box_obj = {
        "layout": "value[place_index * n_snapshots + snapshot_index]; null where the place has no box",
        "places": {
            "id": places["place"].astype(int).tolist(),
            "lon": rounded(places["lon"], 3), "lat": rounded(places["lat"], 3),
            "area_km2": rounded(places["area_km2"], 0), "region": places["region"].tolist(),
        },
        "snapshots": {
            "snapshot_ma": rounded(snap_ma, 2),
            "from_ma": rounded(snaps[("from_ma", "min")], 2),       # young end
            "to_ma": rounded(snaps[("to_ma", "min")], 2),           # old end
        },
        "m_lon": rounded(grid("m_lon"), 2),
        "m_lat": rounded(grid("m_lat"), 2),
        "subduction_km": rounded(grid("subduction_km"), 0),
        "found_chance": {w: rounded(grid(c), 4) for w, c in chance_cols.items()},
        # Per rung, the first walk setting's rate; per "<walk> | <rung>", the rate under that
        # walk where it differs (fitted rungs). The page uses the second where it exists.
        "formation_rate": {r: rounded(grid(c), 5) for r, c in zip(rung_names, rate_cols)},
        "formation_rate_by_walk": {k: rounded(grid(c), 5) for k, c in walk_rate_cols.items()},
    }
    size = write_gz_json(out / "boxes.json.gz", box_obj)
    print(f"boxes: {P} places x {S} snapshots ({len(boxes)} boxes), {size / 1e6:.2f} MB")

    # --- walkers --------------------------------------------------------------------------
    w_obj = {"fates": FATES, "factors": [], "samples": {}}
    covered = 0
    total = 0
    for key, sample in walkers["samples"].items():
        wk, rung = key.split(SEP)
        if wk not in walk_names or rung not in rung_names:
            raise SystemExit(f"walker key {key!r} is not a known walk and rung")
        ent = {
            "place": [pidx[int(s["place"])] for s in sample],
            "age_ma": [round(float(s["age_ma"]), 2) for s in sample],
            "fate": [FATES.index(s["fate"]) for s in sample],
            "depth_km": [[round(float(v), 2) for v in s["depth_km"]] for s in sample],
        }
        # Later rungs tilt the walk by a factor at each moment (climate, collision, ...).
        # RiftsClimate may then write, per deposit, the index of the factor acting at each
        # 1 Myr step (into `factors`); the chart colours each segment by it. Rungs 0-1
        # have none, and the key is simply absent.
        if all("factor" in s for s in sample):
            ent["factor"] = [list(map(int, s["factor"])) for s in sample]
        w_obj["samples"][key] = ent
        # Every simulated deposit should have a box (a position) at its formation age.
        for p, a in zip(ent["place"], ent["age_ma"]):
            s = int(np.searchsorted(box_obj["snapshots"]["to_ma"], a, side="right"))
            s = min(s, S - 1)
            total += 1
            covered += box_obj["m_lon"][p * S + s] is not None
    if "factors" in walkers:
        w_obj["factors"] = walkers["factors"]
    size = write_gz_json(out / "walkers.json.gz", w_obj)
    print(f"walkers: {len(w_obj['samples'])} rung/walk samples, {size / 1e6:.2f} MB; "
          f"{covered} of {total} have a box (a position) at their formation age")

    # --- real porphyries and predicted finds ---------------------------------------------
    pts_path = args.archive / "riftsclimate" / PLATE_MODEL / "points.json.gz"
    with gzip.open(pts_path, "rt") as fh:
        pts = {p["deposit_id"]: p for p in json.load(fh)["points"]}
    in_points = porph["deposit_id"].isin(pts.keys())
    on_plate_at_age = [bool(d in pts and pts[d]["plate_id"] and (pts[d]["plate_begin_age"] is None
                                                                 or pts[d]["plate_begin_age"] >= a))
                       for d, a in zip(porph["deposit_id"], porph["age_ma"])]
    f_obj = {
        "porphyries": {
            "deposit_id": porph["deposit_id"].tolist(),
            "name": porph["deposit"].fillna("").tolist(),
            "age_ma": rounded(porph["age_ma"], 2),
            "lon": rounded(porph["lon"], 4), "lat": rounded(porph["lat"], 4),
            "m_lon": rounded(porph["m_lon"], 3), "m_lat": rounded(porph["m_lat"], 3),
            "subduction_km": rounded(porph["subduction_km"], 0),
            "place": [pidx[int(p)] for p in porph["place"]],
        },
        "predicted_found": {},
    }
    for (wk, rung), g in finds.groupby(["walk", "rung"], sort=False):
        f_obj["predicted_found"][f"{wk}{SEP}{rung}"] = {
            "place": [pidx[int(p)] for p in g["place"]],
            "predicted": rounded(g["predicted_found"], 4),
            "real": g["real"].astype(int).tolist(),
        }
    size = write_gz_json(out / "finds.json.gz", f_obj)
    print(f"finds: {len(porph)} real porphyries ({int(in_points.sum())} in the deposit viewer's "
          f"{PLATE_MODEL} points, {sum(on_plate_at_age)} on a plate at their own age); "
          f"{len(f_obj['predicted_found'])} predicted-find maps, {size / 1e6:.2f} MB")

    # --- plate boundaries -----------------------------------------------------------------
    # RiftsClimate's prep/wp10_boundaries.py: Merdith 2021's resolved boundaries at every box
    # snapshot, ~1 degree, each with its label and a convergence rate per point (+ closing).
    # Packed per snapshot as [label index, lon[], lat[], convergence[]] per boundary.
    bnd_path = src / "boundaries.json.gz"
    bnd_file = None
    teeth = None
    if bnd_path.exists():
        with gzip.open(bnd_path, "rt") as fh:
            bnd = json.load(fh)
        labels = sorted({f["label"] for fs in bnd["snapshots_ma"].values() for f in fs})
        lidx = {l: i for i, l in enumerate(labels)}
        frames = {}
        npts = 0
        for age, fs in bnd["snapshots_ma"].items():
            out_fs = []
            for f in fs:
                ll = np.asarray(f["lonlat"], float)
                if len(ll) < 2:
                    continue
                conv = [None if c is None else round(float(c), 2) for c in f["convergence_cm_yr"]]
                out_fs.append([lidx[f["label"]], rounded(ll[:, 0], 2), rounded(ll[:, 1], 2), conv])
                npts += len(ll)
            frames[str(int(round(float(age))))] = out_fs
        b_obj = {"model": bnd.get("model"), "convergent_cm_yr": bnd.get("convergent_cm_yr"),
                 "labels": labels, "snapshots": frames}
        size = write_gz_json(out / "boundaries.json.gz", b_obj)
        bnd_file = "riftsclimate/wp10/boundaries.json.gz"
        print(f"boundaries: {len(frames)} snapshots, {npts} points, {len(labels)} labels, {size / 1e6:.2f} MB")

        # Subduction teeth: RiftsClimate's file has no polarity, so the page draws the
        # teeth from the archive's own Merdith 2021 Boundary Frames (gpml polarity, 1 Myr
        # steps), at the same whole-Myr age. Check they are the same boundaries: per
        # snapshot, the number of features labelled SubductionZone in each.
        man_path = args.archive / "reconstructions" / PLATE_MODEL / "manifest.json"
        if man_path.exists():
            man = json.loads(man_path.read_text())
            rel = f"reconstructions/{PLATE_MODEL}/{man['boundaries']}"
            idx = json.loads((args.archive / rel).read_text())
            have = {int(fr["time"]): fr for fr in idx["frames"]}
            same = differ = missing = 0
            for age, fs in frames.items():
                fr = have.get(int(age))
                if fr is None:
                    missing += 1
                    continue
                n_rc = sum(1 for f in fs if labels[f[0]] == "SubductionZone")
                if n_rc == fr["subduction"]:
                    same += 1
                else:
                    differ += 1
            teeth = {"frames": rel, "age_max": max(have), "snapshots_same_subduction_count": same,
                     "snapshots_differ": differ, "snapshots_without_frame": missing}
            print(f"teeth from {rel}: subduction-zone count agrees at {same} snapshots, differs at {differ}, "
                  f"no archive frame at {missing}")
    else:
        print(f"no {bnd_path}: no plate boundaries")

    # --- index ----------------------------------------------------------------------------
    # How far from a subduction zone porphyries formed: share of ground (weighted by the
    # chance of being found), predicted share of finds and real share, per distance band.
    # This table lives in RiftsClimate's prep/, not data/geode/.
    shares_obj = {}
    sp = args.riftsclimate / "prep" / "wp10_porphyry_ladder_shares.csv"
    if sp.exists():
        sh = pd.read_csv(sp)
        for (wk, rung), g in sh.groupby(["walk", "rung"], sort=False):
            shares_obj[f"{wk}{SEP}{rung}"] = {
                "bands": g["distance when formed"].tolist(),
                "ground": rounded(g["share of ground (weighted by chance found)"], 4),
                "predicted": rounded(g["predicted share of finds"], 4),
                "real": rounded(g["real share"], 4),
            }
        print(f"shares: {len(shares_obj)} rung/walk settings from {sp.name}")
    else:
        print(f"no {sp}: the distance-band chart will be empty")

    bins = sorted(curves["bin_start_ma"].unique())
    curve_obj = {}
    for (wk, rung), g in curves.groupby(["walk", "rung"], sort=False):
        g = g.set_index("bin_start_ma").reindex(bins)
        curve_obj[f"{wk}{SEP}{rung}"] = {"predicted": rounded(g["predicted"], 3),
                                         "observed": rounded(g["observed"], 0)}
    params = walkers.get("formation_rate_parameters", {})
    index = {
        "title": "RiftsClimate WP10: porphyry Cu, form, walk, survive",
        "plate_model": PLATE_MODEL,
        "age_max": AGE_MAX,
        "walks": [{"id": w, "label": w, **walkers["walks"][w]} for w in walk_names],
        "rungs": [{"id": r, "label": r,
                   # [b] for 1c, five band rates for 1d, [b1, b2] for 1e, null otherwise
                   "parameters": {w: params.get(f"{w}{SEP}{r}") for w in walk_names}} for r in rung_names],
        "formation_depth_km": walkers["formation_depth_km"][0],
        "formation_depth_sd_km": walkers["formation_depth_km"][1],
        "extent_km": walkers["extent_km"],
        "bin_myr": int(bins[1] - bins[0]),
        "bins_start_ma": [int(b) for b in bins],
        "curves": curve_obj,
        "shares": shares_obj,
        "counts": {"places": P, "snapshots": S, "boxes": len(boxes), "porphyries": len(porph),
                   "porphyries_in_points": int(in_points.sum()),
                   "porphyries_on_plate_at_own_age": int(sum(on_plate_at_age)),
                   "walkers_with_box_at_formation": covered, "walkers": total},
        "files": {"boxes": "riftsclimate/wp10/boxes.json.gz", "walkers": "riftsclimate/wp10/walkers.json.gz",
                  "finds": "riftsclimate/wp10/finds.json.gz", "boundaries": bnd_file},
        "teeth": teeth,
        "built_from": provenance(args.riftsclimate),
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {out}/index.json")


if __name__ == "__main__":
    main()
