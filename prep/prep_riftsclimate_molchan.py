#!/usr/bin/env python3
"""Build the RiftsClimate Molchan viewer's archive section (`molchan.html`).

The science belongs to the RiftsClimate repository: its `prep/geode_molchan_export.py` writes
the inputs of the one-factor Molchan test (step 1 of its factor-combination ladder) to
`data/geode/molchan/`, after checking every skill against its own pipeline. This script only
repacks those files into compact ones the page can load. Nothing here computes a value.

What the archive already holds is READ by the page, never copied: the Merdith 2021 coastlines,
margin lines and continent polygons (archive/riftsclimate/index.json, written by
prep_riftsclimate.py). New content goes under archive/riftsclimate/molchan/ only:

  index.json      factors (label, column, unit, kind, group), deposit types, the Molchan curves
                  (every deposit's share, sorted) and skills (for the new candidate factors also
                  the within-period and region-by-region skills), counts, provenance
  boxes.json.gz   every place's id and, for each place and time slice, where
                  the place was (Merdith 2021), its weight, its weight in the test (time slices
                  merged in pairs), each factor's value and each factor's share of the test's
                  ground rated higher; place-major, null where the place has no box
  combos/<type>/<map>.json.gz
                  one combination's held-out map (step 3 of the ladder, RiftsClimate's
                  prep/geode_combo_export.py): every place x time slice's share of its region's
                  continental area rated higher, by the map made without that region, in
                  thousandths (place-major, as boxes; the older slice of a merged pair carries the
                  younger one's value, as the test sees it), and each deposit's share
  combos/<type>/ranked.json.gz
                  every combination of the type with its regional skill, each region's, and the
                  map that draws it, if any
  boundaries.json.gz
                  Merdith 2021's plate boundaries at every time slice (RiftsClimate's
                  prep/geode_boundaries_export.py, checked there against the subduction and ridge
                  distances the analysis measured): per boundary [label index, lon[], lat[],
                  convergence cm/yr per point], as the WP10 viewer's
  ../merdith2021/boundary_frames/  (not written here) Geode's own Boundary Frames of Merdith 2021,
                  0-1000 Ma every 1 Myr, with each subduction zone's polarity (petrify's
                  export_series; built once, see the README): the page draws the subduction
                  teeth from them, checked here to have the same subduction zones as
                  boundaries.json.gz at every time slice
  deposits.json.gz  the SEDEX, MVT, Cu-sed, VMS and porphyry Cu deposits the test uses: name, type, age, where they formed
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
FORMAT = 5                 # 2: deposits' positions at every slice; 3: combinations; 4: plate boundaries;
                           # 5: the new candidate factors (steps 1-2), with within-period and regional skills
TYPES = {"PbZn-CD": "SEDEX (clastic-dominated Pb-Zn)", "PbZn-MVT": "MVT (Mississippi Valley-type Pb-Zn)",
         "Cu-sed": "Cu-sed (sediment-hosted stratiform Cu)", "VMS": "VMS (volcanogenic massive sulfide)",
         "Cu-por": "Cu-por (porphyry Cu)", "Kimberlite": "Kimberlites (Tappe et al. 2018)",
         "Carbonatite": "Carbonatites (Humphreys-Williams & Zahirovic 2021)"}
# Each column's unit, and how many decimals to keep.
COLUMNS = {
    "post_rift_km": ("km", 0), "syn_rift_km": ("km", 0), "line_any_stage_km": ("km", 0),
    "craton_edge_km": ("km", 0), "subduction_km": ("km", 0), "abs_lat_Merdith2021": ("°", 1),
    "collision_km": ("km", 0), "line_post_collision_km": ("km", 0),
    # the new candidate factors for mantle-derived magmas (RiftsClimate's prep/combo_new_factors.py)
    "llsvp_edge_km": ("km", 0), "llsvp_inside": ("yes/no", 0), "opt1_cmb_k": ("K", 0),
    "opt1_basal_edge_km": ("km", 0), "opt1_um_k": ("K", 0), "lip_km": ("km", 0),
    "craton_edge_signed_km": ("km", 0), "tc1_age_ma": ("Ma", 0), "inside_craton": ("yes/no", 0),
    "lab_km": ("km", 0),
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
    # the new candidate factors (steps 1-2 only); mantle structure is measured where the place was
    # in Muller 2022's mantle frame, though the square is drawn at its Merdith 2021 position
    "LLSVP edge (SMEAN)": "nearer the edge of the LLSVPs (SMEAN 1% slow outline, Muller 2022 mantle frame) rates higher",
    "within 10 degrees of the LLSVP edge": "within 1110 km of the LLSVP edge (Muller 2022 mantle frame) rates 1, elsewhere 0",
    "above an LLSVP": "above an LLSVP (inside the SMEAN outline, Muller 2022 mantle frame) rates 1, elsewhere 0",
    "core-mantle boundary temperature (OPT1)": "hotter at 2840 km in Muller 2022's OPT1 flow model at the time rates higher",
    "hot basal structure edge (OPT1)": "nearer the edge of the hottest 20.9% of the core-mantle boundary (OPT1, at the time) rates higher",
    "upper-mantle temperature at 293 km (OPT1)": "hotter at 293 km in the OPT1 flow model at the time rates higher",
    "LIP within 10 Myr": "nearer a LIP emplaced within 10 Myr of the time rates higher; no value for ages older than 660 Ma",
    "farther from subduction": "farther from a subduction zone at the time rates higher",
    "subduction 1000-1500 km inboard": "1000-1500 km from a subduction zone at the time rates 1, elsewhere 0",
    "200-300 km inside the craton edge": "200-300 km inside the craton edge (present-day map) rates 1, elsewhere 0",
    "within 600 km of the craton edge": "within 600 km of the craton edge (present-day map) rates 1, elsewhere 0",
    "tectonothermal age (TC1)": "older lithosphere (Artemieva 2006 TC1, present-day map) rates higher",
    "Archean lithosphere (TC1)": "Archean lithosphere (TC1 age 2500 Ma or more, present-day map) rates 1, elsewhere 0",
    "inside thick lithosphere": "inside the craton edge (present-day map) rates 1, elsewhere 0",
    "lithosphere at least 150 km": "lithosphere 150 km thick or more (present-day map) rates 1, elsewhere 0",
    "lithosphere thickness": "thicker lithosphere (present-day map) rates higher",
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


TEETH_FRAMES = "riftsclimate/merdith2021/boundary_frames/boundaries.json"


def pack_boundaries(path, out, snap_ma, archive):
    """RiftsClimate's plate boundaries per time slice, packed as the WP10 viewer's
    (prep_riftsclimate_wp10.py): per slice (whole Myr), [label index, lon[], lat[],
    convergence[]] per boundary. Every slice of the boxes must have its boundaries."""
    if not path.exists():
        print(f"no {path}: no plate boundaries")
        return None, None
    with gzip.open(path, "rt") as fh:
        bnd = json.load(fh)
    labels = sorted({f["label"] for fs in bnd["snapshots_ma"].values() for f in fs})
    lidx = {l: i for i, l in enumerate(labels)}
    frames, npts = {}, 0
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
    missing = sorted({int(round(a)) for a in snap_ma} - {int(k) for k in frames})
    if missing:
        raise SystemExit(f"plate boundaries missing for time slices {missing[:10]}")
    size = write_gz_json(out / "boundaries.json.gz", {"model": bnd.get("model"),
                                                      "convergent_cm_yr": bnd.get("convergent_cm_yr"),
                                                      "labels": labels, "snapshots": frames})
    print(f"boundaries: {len(frames)} time slices, {npts} points, {len(labels)} labels, {size / 1e6:.2f} MB")

    # Subduction teeth: RiftsClimate's boundaries carry no polarity, so the page draws the teeth
    # from Geode's Boundary Frames of the same model at the same whole-Myr age (as the WP10
    # viewer). Every slice must have a frame with the same number of subduction zones.
    idx_path = archive / TEETH_FRAMES
    if not idx_path.exists():
        raise SystemExit(f"no {idx_path}: build the Boundary Frames 0-1000 Ma first (README)")
    have = {int(fr["time"]): fr for fr in json.loads(idx_path.read_text())["frames"]}
    bad = []
    for age, fs in frames.items():
        fr = have.get(int(age))
        n_rc = sum(1 for f in fs if labels[f[0]] == "SubductionZone")
        if fr is None or fr["subduction"] != n_rc:
            bad.append((age, n_rc, fr and fr["subduction"]))
    if bad:
        raise SystemExit(f"teeth: the Boundary Frames differ from the boundaries at {len(bad)} slices, e.g. {bad[:5]}")
    print(f"teeth from {TEETH_FRAMES}: the same subduction zones at all {len(frames)} time slices")
    return "riftsclimate/molchan/boundaries.json.gz", {"frames": TEETH_FRAMES, "age_max": max(have)}


def pack_combos(src, out, boxes, pidx, sidx, P, S, deposits):
    """The combinations' held-out maps, ranked lists, factor gains and fake worlds, as
    RiftsClimate's prep/geode_combo_export.py wrote them. Returns the index entry per type and
    each place's region."""
    # Each box's value comes from the box the test keeps for its pair: itself if it carries
    # weight in the test, else the next younger slice of the same place.
    b = boxes.sort_values(["place", "snapshot_ma"]).reset_index(drop=True)
    flat = b["place"].map(pidx).to_numpy() * S + b["snapshot_ma"].map(sidx).to_numpy()
    in_test = (b["weight_in_test"] > 0).to_numpy()
    prev = np.r_[-1, flat[:-1]]
    same_place = np.r_[False, b["place"].to_numpy()[1:] == b["place"].to_numpy()[:-1]]
    if not (in_test | same_place).all():
        raise SystemExit("a box out of the test has no younger slice of its place to take its value from")
    from_flat = np.where(in_test, flat, prev)
    dep_order = {d: i for i, d in enumerate(deposits["deposit_id"])}

    entries, place_region = {}, None
    # each type's main step 3 run, and where written its run with screened new factors
    # (RiftsClimate's COMBO_STUDY=screened, folder <type>-screened), as the key "<type>|screened"
    sets = [(t, t, None) for t in TYPES] + [(f"{t}|screened", f"{t}-screened", "with screened new factors")
                                             for t in TYPES]
    for key, folder, set_label in sets:
        t = key
        d = src / folder
        if not (d / "maps.json").exists():
            if set_label is None:
                print(f"combos {t}: none written (run prep/geode_combo_export.py in RiftsClimate)")
            continue
        maps = json.loads((d / "maps.json").read_text())["maps"]
        cells = pd.read_csv(d / "cells.csv.gz")
        cflat = cells["place"].map(pidx).to_numpy() * S + cells["snapshot_ma"].map(sidx).to_numpy()
        if set(cflat) != set(flat[in_test]):
            raise SystemExit(f"combos {t}: the cells are not the boxes in the test")
        pos = pd.Series(np.arange(len(cells)), index=cflat)
        take = pos.reindex(from_flat).to_numpy()
        if place_region is None:
            reg = cells.groupby("place")["region"].first()
            place_region = [reg.get(p, "") if isinstance(reg.get(p, ""), str) else "" for p in sorted(pidx, key=pidx.get)]
        dc = pd.read_csv(d / "deposits.csv")
        drow = dc["deposit_id"].map(dep_order).to_numpy()
        if np.isnan(drow.astype(float)).any():
            raise SystemExit(f"combos {t}: a deposit is not in the viewer's deposits")
        size = 0
        for m in maps:
            grid = np.full(P * S, np.nan)
            grid[flat] = cells[m["id"]].to_numpy(float)[take]
            dep = np.full(len(deposits), np.nan)
            dep[drow] = dc[m["id"]].to_numpy(float)
            # the skill must come back from the deposits' shares as written
            got = 0.5 - np.nanmean(dep)
            if abs(got - m["skill"]) > 1e-3:
                raise SystemExit(f"combos {t} {m['id']}: deposits give {got:.4f}, RiftsClimate {m['skill']:.4f}")
            m["file"] = f"riftsclimate/molchan/combos/{folder}/{m['id']}.json.gz"
            size += write_gz_json(out / "combos" / folder / f"{m['id']}.json.gz",
                                  {"id": m["id"], "boxes": rounded(grid * 1000, 0), "deposits": rounded(dep, 4)})
        r = pd.read_csv(d / "ranked.csv")
        regions = [c.split("|")[1] for c in r.columns if c.startswith("region|")]
        ranked = {"combination": r["combination"].tolist(), "skill": rounded(r["region_skill"], 4),
                  "by_region": {g: rounded(r[f"region|{g}|skill"], 4) for g in regions},
                  "with_collision": r["with_collision"].astype(bool).tolist(),
                  "n_factors": r["n_factors"].astype(int).tolist(),
                  "map": [m if isinstance(m, str) else None for m in r["map"]]}
        size += write_gz_json(out / "combos" / folder / "ranked.json.gz", ranked)
        gains = pd.read_csv(d / "gains.csv")
        gw = pd.read_csv(d / "gain_worlds.csv") if (d / "gain_worlds.csv").exists() else pd.DataFrame(
            columns=["skill", "factor", "gain"])
        wd = pd.read_csv(d / "worlds.csv")
        entries[t] = {
            "step": "3: equal weights, percentiles",
            "set": set_label or "main candidates",
            "regions": regions,
            "maps": maps,
            "ranked": f"riftsclimate/molchan/combos/{folder}/ranked.json.gz",
            "count": len(r),
            "gains": {k: [{"group": x.group, "factor": x.factor, "gain": round(float(x.gain), 4),
                           "worlds": int(x.worlds) if np.isfinite(x.worlds) else 0,
                           "median": None if not np.isfinite(x.chance_median) else round(float(x.chance_median), 4),
                           "highest": None if not np.isfinite(x.chance_highest) else round(float(x.chance_highest), 4),
                           "at_or_above": None if not np.isfinite(x.worlds_at_or_above) else int(x.worlds_at_or_above),
                           "world_gains": rounded(gw[(gw.skill == k) & (gw.factor == x.factor)]["gain"], 4)}
                          for x in g.itertuples()]
                      for k, g in gains.groupby("skill")},
            "worlds": {k: {"real": round(float(g[g.world == "real"]["value"].iloc[0]), 4),
                           "real_nc": round(float(g[g.world == "real"]["value_nc"].iloc[0]), 4),
                           "worlds": rounded(g[g.world != "real"]["value"], 4),
                           "worlds_nc": rounded(g[g.world != "real"]["value_nc"], 4)}
                       for k, g in wd.groupby("skill")},
        }
        print(f"combos {t}: {len(maps)} maps, {len(r)} combinations ranked, {size / 1e6:.1f} MB")
    return entries, place_region


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
    # the types RiftsClimate has written step 1 for (a type still running is left out)
    types = [t for t in TYPES if t in meta["curves"]]
    if set(meta["curves"]) - set(TYPES):
        raise SystemExit(f"types this script has no label for: {sorted(set(meta['curves']) - set(TYPES))}")
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

    combos, place_region = pack_combos(src / "combos", out, boxes, pidx, sidx, P, S, deposits)
    boundaries_file, teeth = pack_boundaries(src / "boundaries.json.gz", out, snap_ma, args.archive)

    # --- index ------------------------------------------------------------------------------
    index = {
        "title": "RiftsClimate: the one-factor Molchan test, its inputs",
        "format": FORMAT,
        "plate_model": PLATE_MODEL,
        "age_max": int(np.ceil(snaps[("to_ma", "max")].max())),
        "types": [{"id": t, "label": TYPES[t]} for t in types],
        # group: "ladder" for the factors of steps 1-3, "new" for the new candidates (steps 1-2 only)
        "factors": [{"id": f, "column": v["column"], "unit": COLUMNS[v["column"]][0],
                     "rating": RATING[f], "types": ["PbZn-MVT"] if v["mvt_only"] else types,
                     "group": "new" if v.get("new") else "ladder"}
                    for f, v in factors.items()],
        "curves": meta["curves"],
        "counts": {"places": P, "snapshots": S, "boxes": len(boxes),
                   "boxes_in_test": int((boxes.weight_in_test > 0).sum()),
                   "deposits": deposits.deposit_class.value_counts().to_dict()},
        "files": {"boxes": "riftsclimate/molchan/boxes.json.gz", "deposits": "riftsclimate/molchan/deposits.json.gz",
                  "boundaries": boundaries_file},
        "built_from": provenance(args.riftsclimate),
        # subduction teeth: the Boundary Frames to draw them from (polarity), or null
        "teeth": teeth,
        # step 3 of the ladder (combinations), per type; the region each place lies in today
        "combos": combos,
        "place_region": place_region,
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {out}/index.json")


if __name__ == "__main__":
    main()
