#!/usr/bin/env python3
"""Build the RiftsClimate deposit viewer's archive section (`riftsclimate.html`).

The science values belong to the RiftsClimate repository: its `prep/geode_export.py`
writes `data/geode/{deposits.csv, fields.json, rifts_<phase>.gpmlz}`. This script only
turns them, plus RiftsClimate's defamation deformation grids, into files the viewer can
draw. Nothing here computes a deposit value.

Everything the Geode archive already holds is READ, never copied: the coastline geometry
and 0-540 Ma rotations of each Reconstruction Model (archive/reconstructions/<id>/), the
BRIDGE climate Model (archive/models/bridge-valdes2021-monthly/). New content goes under
archive/riftsclimate/ only:

  index.json                  what the page loads first: plate models, their layers, counts
  fields.json                 the value catalogue, with distributions (from RiftsClimate)
  values.json.gz              every deposit's values, by column
  source.json                 provenance line (picked up by build_archive_index.py)
  <model>/points.json.gz      the deposits as a petrify points.json, reconstructed with the
                              plate each deposit was given BY THE ANALYSIS (RiftsClimate's
                              continent-polygon assignment), rotations 0-1000 Ma
  <model>/coastline_rotations_540-1000.json.gz
                              rotations for the SAME coastline plates the archive's own
                              reconstruction carries, from 540 to 1000 Ma only; the page
                              appends them to the archive's 0-540 Ma table
  merdith2021/rifts_<phase>/{geometry.bin, rotations.json.gz}
                              Jackson & MacDonald margins by phase (Merdith 2021 only), in
                              prep_coastlines.py's geometry.bin format
  <model>/polygons/<group>/geometry.bin, <model>/polygons/rotations.json.gz
                              the model's continent polygon outlines in RiftsClimate's four
                              begin-age groups (original; unchanged; extended; could be
                              extended but is not), for checking the begin-age corrections
                              (RiftsClimate ADR-0004) by eye
  models/defamation-<model>/  the defamation deformation grids as a Geode Model (frames
                              gzipped; horizontal divergence and deformation style)

Each plate model's layers are only ever that model's (ADR-0004, ADR-0034, ADR-0057).

The deformation encoding is adapted from GeodeViewers/Deformation/prep/prep_deformation.py
(byte 255 = no data, pooled clip across every frame, categorical style classes); that
script wants one pipeline run with thickness grids, which RiftsClimate's step-1-only runs
do not have.

Run with the RiftsClimate environment, so the rotation models are the very ones the
analysis used (gprm pinned there):
    env -u PYTHONPATH conda run -n riftsclimate python prep/prep_riftsclimate.py
"""

import argparse
import gzip
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "viewer" / "vendor" / "petrify" / "python"))

RIFTSCLIMATE = Path("/Users/simon/GIT/RiftsClimate")
AGE_MAX = 1000
ARCHIVE_AGE_MAX = 540      # what the archive's own reconstructions cover

# key -> (gprm fetch, archive reconstruction id, label, defamation run folder, prefix
# of this model's columns in deposits.csv)
MODELS = {
    "scotese": ("Scotese", "scotese", "Scotese", "Scotese", "scotese"),
    "merdith2021": ("Merdith2021", "merdith2021", "Merdith 2021", "Merdith2021", "merdith"),
}
POLYGON_GROUPS = [
    ("original", "Original begin ages (all polygons)", "#c8ced6"),
    ("unchanged", "Unchanged", "#7f8a96"),
    ("extended", "Extended (used by the analysis)", "#5ad17a"),
    ("candidate", "Could be extended, not used", "#ffb020"),
]
PHASES = [
    ("syn_rift", "Syn-rift margins", "#ff8c42"),
    ("post_rift", "Post-rift margins", "#4fc3f7"),
    ("collision", "Collision margins", "#e84a8a"),
]
NO_DATA = 255
# Most deforming cells barely deform (pooled median |divergence| ~4e-17 1/s, against the
# analysis's 3e-16 1/s "active" threshold), so a 99th-percentile clip leaves almost
# everything near the ramp's white middle. The 90th keeps active zones coloured.
DIVERGENCE_CLIP_PERCENTILE = 90.0
STYLE_CLASSES = [
    "negligible", "pure_extension", "pure_compression", "simple_shear",
    "transpression", "transtension", "pure_shear", "strike_slip",
    "extension_dominated", "compression_dominated", "undefined",
]


def sig(x, n=6):
    if x == 0 or not np.isfinite(x):
        return float(x)
    return float(f"{x:.{n}g}")


def write_gz_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", compresslevel=9) as fh:
        json.dump(obj, fh, separators=(",", ":"), allow_nan=False)
    return path.stat().st_size


def clean(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    return None if not math.isfinite(f) else f


# --- deposits ------------------------------------------------------------------------


def deposit_points(model, dep, prefix, label):
    from petrify.points import build_points

    records = []
    for _, row in dep.iterrows():
        pid = int(row[f"{prefix}_plate"])
        begin = clean(row[f"{prefix}_plate_from_ma"])
        records.append((None, {
            "lon": round(float(row["lon"]), 4), "lat": round(float(row["lat"]), 4),
            "age": clean(row["age_ma"]),
            "plate_id": pid,
            # The continent polygon's own begin age: PointLayer never draws a deposit
            # older than the crust it was put on (ADR-0032/0033).
            "plate_begin_age": begin if pid != 0 else None,
            "type": row["class"],
            "deposit_id": row["deposit_id"], "name": row["name"],
            "age_uncertainty_ma": clean(row["age_uncertainty_ma"]),
        }))
    times = list(range(0, AGE_MAX + 1))
    payload = build_points(model, records, times, transport="rotations", model_name=label,
                           meta={"source": "RiftsClimate data/geode/deposits.csv"})
    return payload


def count_drawable(dep, prefix, model):
    pid = dep[f"{prefix}_plate"].to_numpy(int)
    begin = dep[f"{prefix}_plate_from_ma"].to_numpy(float)
    end = dep[f"{prefix}_plate_to_ma"].to_numpy(float)
    age = dep["age_ma"].to_numpy(float)
    unassigned = pid == 0
    too_old = ~unassigned & ~(np.nan_to_num(begin, nan=-1) >= age)
    # A rotation that is the identity above 0 Ma means the model does not cover that
    # plate at that age (pygplates returns identity silently) -- same test as
    # RiftsClimate's coregistration.has_rotation.
    no_rotation = np.zeros(len(dep), bool)
    for i in np.where(~unassigned & ~too_old)[0]:
        if age[i] > 0:
            angle = model.rotation_model.get_rotation(float(age[i]), int(pid[i])) \
                .get_lat_lon_euler_pole_and_angle_degrees()[2]
            no_rotation[i] = angle == 0
    ends_early = ~unassigned & (np.nan_to_num(end, nan=0) > 0)
    drawable = ~unassigned & ~too_old & ~no_rotation
    placed = np.isfinite(dep[f"{prefix}_palaeolat"].to_numpy(float))
    return {
        "deposits": int(len(dep)),
        "drawable_at_own_age": int(drawable.sum()),
        "unassigned": int(unassigned.sum()),
        "older_than_their_plate": int(too_old.sum()),
        "no_rotation_at_own_age": int(no_rotation.sum()),
        "plate_polygon_ends_before_present": int(ends_early.sum()),
        "placed_by_analysis": int(placed.sum()),
        "disagree_with_analysis": int((drawable != placed).sum()),
    }


# --- coastlines ----------------------------------------------------------------------


def geometry_plate_ids(path, older_than=None):
    """Plate ids in a prep_coastlines.py geometry.bin (version 3); with `older_than`,
    only plates carrying a line that already exists before that age."""
    buf = Path(path).read_bytes()
    assert buf[:4] == b"ESCL", path
    version, n = struct.unpack_from("<II", buf, 4)
    assert version == 3, f"{path}: geometry version {version}"
    o, ids = 12, set()
    for _ in range(n):
        pid, appear, _, npts, nland, ntris = struct.unpack_from("<iffIII", buf, o)
        o += 24 + npts * 12 + nland * 12 + ntris * 12
        if older_than is None or appear > older_than:
            ids.add(pid)
    return sorted(ids)


def quaternion(rotation):
    plat, plon, angle_deg = rotation.get_lat_lon_euler_pole_and_angle_degrees()
    pl, po, a = math.radians(plat), math.radians(plon), math.radians(angle_deg)
    s = math.sin(a / 2.0)
    return [round(math.cos(pl) * math.cos(po) * s, 7), round(math.cos(pl) * math.sin(po) * s, 7),
            round(math.sin(pl) * s, 7), round(math.cos(a / 2.0), 7)]


def rotation_table(model, plate_ids, ages):
    rm = model.rotation_model
    return {"ages": [float(a) for a in ages], "anchor": 0,
            "plates": {str(p): [quaternion(rm.get_rotation(float(a), int(p))) for a in ages]
                       for p in plate_ids}}


def extend_coastline_rotations(archive, recon_id, model, out_path):
    """540-1000 Ma rotations for the archive's own coastline plates, checked against the
    archive's table at the join so the two are known to be the same rotation model."""
    manifest = json.loads((archive / "reconstructions" / recon_id / "manifest.json").read_text())
    base = archive / "reconstructions" / recon_id
    existing = json.loads((base / manifest["coastlines"]["rotations"]).read_text())
    # Every plate the archive's table carries (it is shared with the static polygons,
    # so it can hold more plates than the coastline geometry), so the two join exactly.
    ids = sorted(int(p) for p in existing["plates"])
    missing = set(geometry_plate_ids(base / manifest["coastlines"]["geometry"])) - set(ids)
    if missing:
        raise SystemExit(f"{recon_id}: coastline plates {sorted(missing)} not in its rotation table")
    last = existing["ages"][-1]
    step = existing["ages"][1] - existing["ages"][0]
    ages = np.arange(last, AGE_MAX + step / 2, step)
    table = rotation_table(model, ids, ages)
    worst = 0.0
    for p in ids:
        a = np.array(existing["plates"][str(p)][-1])
        b = np.array(table["plates"][str(p)][0])
        worst = max(worst, min(np.abs(a - b).max(), np.abs(a + b).max()))
    if worst > 1e-5:
        raise SystemExit(f"{recon_id}: rotations at {last} Ma differ from the archive's by {worst:.2g}"
                         " -- not the same rotation model")
    old_geometry = set(geometry_plate_ids(base / manifest["coastlines"]["geometry"], older_than=last))
    stuck = [p for p in ids if p in old_geometry
             and all(q == table["plates"][str(p)][0] for q in table["plates"][str(p)])]
    size = write_gz_json(out_path, table)
    print(f"  coastlines  {len(ids)} plates, {last:g}-{AGE_MAX} Ma appended "
          f"(join agrees to {worst:.1g}); {len(stuck)} plate(s) with pre-{last:g} Ma coastlines "
          f"do not move over {last:g}-{AGE_MAX} Ma {stuck}; "
          f"{size / 1e6:.2f} MB")
    return {
        "geometry": f"reconstructions/{recon_id}/{manifest['coastlines']['geometry']}",
        "rotations": f"reconstructions/{recon_id}/{manifest['coastlines']['rotations']}",
        "rotations_extension": str(out_path.relative_to(archive)),
        "age_min": 0.0, "age_max": float(AGE_MAX),
        "name": manifest["name"], "citation": manifest.get("citation", ""),
        "plates_fixed_540_1000": len(stuck),
    }


def export_rifts(archive, model, geode_dir, out_dir):
    from prep_coastlines import export_geometry

    phases = []
    for phase, label, colour in PHASES:
        src = geode_dir / f"rifts_{phase}.gpmlz"
        d = out_dir / f"rifts_{phase}"
        d.mkdir(parents=True, exist_ok=True)
        print(f"  rifts {phase}:")
        ids, _ = export_geometry([src], d / "geometry.bin", 2.0)
        size = write_gz_json(d / "rotations.json.gz", rotation_table(model, ids, range(0, AGE_MAX + 1)))
        phases.append({"id": phase, "label": label, "colour": colour,
                       "geometry": str((d / "geometry.bin").relative_to(archive)),
                       "rotations": str((d / "rotations.json.gz").relative_to(archive))})
        print(f"    rotations {len(ids)} plates, {size / 1e3:.0f} kB")
    return phases


def export_polygons(archive, model, geode_dir, prefix, out_dir):
    """The four continent-polygon groups RiftsClimate's geode_export.py wrote, each as a
    geometry.bin, sharing one 0-1000 Ma rotation table."""
    from prep_coastlines import export_geometry

    groups, plates = [], set()
    for group, label, colour in POLYGON_GROUPS:
        src = geode_dir / f"polygons_{prefix}_{group}.gpmlz"
        d = out_dir / "polygons" / group
        d.mkdir(parents=True, exist_ok=True)
        print(f"  polygons {group}:")
        ids, _ = export_geometry([src], d / "geometry.bin", 2.0)
        plates |= set(ids)
        groups.append({"id": group, "label": label, "colour": colour,
                       "geometry": str((d / "geometry.bin").relative_to(archive))})
    rot = out_dir / "polygons" / "rotations.json.gz"
    size = write_gz_json(rot, rotation_table(model, sorted(plates), range(0, AGE_MAX + 1)))
    print(f"    rotations {len(plates)} plates, {size / 1e6:.1f} MB")
    for g in groups:
        g["rotations"] = str(rot.relative_to(archive))
    return groups


# --- deformation ---------------------------------------------------------------------


def load_grid(ds, name):
    lon = ds["lon"].values
    lat = ds["lat"].values
    data = np.asarray(ds[name].transpose("lat", "lon").values, dtype=np.float64)
    if lat[0] > lat[-1]:
        lat, data = lat[::-1], data[::-1, :]
    if abs((lon[-1] - lon[0]) - 360.0) < 1e-6:     # duplicate +/-180 seam column
        data, lon = data[:, :-1], lon[:-1]
    return data, lon, lat


def encode_continuous(values, lo, hi):
    safe = np.nan_to_num(values, nan=lo)
    scaled = np.clip((safe - lo) / (hi - lo), 0.0, 1.0)
    byte = np.minimum(254, np.round(scaled * 255.0)).astype(np.uint8)
    return np.where(np.isfinite(values), byte, NO_DATA).astype(np.uint8)


def encode_style(raw):
    valid = np.isfinite(raw)
    cls = np.full(raw.shape, np.nan)
    r = np.round(raw[valid]).astype(int)
    cls[valid] = np.where(r < 0, len(STYLE_CLASSES) - 1, r)
    scaled = np.clip((np.nan_to_num(cls, nan=0.0) + 0.5) / len(STYLE_CLASSES), 0.0, 1.0)
    byte = np.minimum(254, np.round(scaled * 255.0)).astype(np.uint8)
    return np.where(np.isfinite(cls), byte, NO_DATA).astype(np.uint8)


def build_deformation_model(archive, run_dir, model_id, label, reconstruction_id, config_note):
    import xarray as xr

    grids = run_dir / "deformation_grids"
    ages = [t for t in range(0, AGE_MAX + 1) if (grids / f"deformation_{t}Ma.nc").exists()]
    missing = AGE_MAX + 1 - len(ages)
    out = archive / "riftsclimate" / "models" / model_id

    finite = []
    nlon = nlat = None
    for t in ages:
        with xr.open_dataset(grids / f"deformation_{t}Ma.nc") as ds:
            h, lon, lat = load_grid(ds, "horizontal_divergence")
        nlon, nlat = len(lon), len(lat)
        finite.append(np.abs(h[np.isfinite(h)]).astype(np.float32))
    m = float(np.percentile(np.concatenate(finite), DIVERGENCE_CLIP_PERCENTILE))
    lo, hi = -m, m
    del finite

    total = 0
    for t in ages:
        with xr.open_dataset(grids / f"deformation_{t}Ma.nc") as ds:
            h, _, _ = load_grid(ds, "horizontal_divergence")
            s, _, _ = load_grid(ds, "deformation_style")
        for vid, byte in (("horizontal_divergence", encode_continuous(h, lo, hi)),
                          ("deformation_style", encode_style(s))):
            d = out / "frames" / vid / "native"
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"{t}.bin.gz"
            p.write_bytes(gzip.compress(byte.tobytes(), 9))
            total += p.stat().st_size

    manifest = {
        "id": model_id,
        "name": f"defamation deformation, {label}",
        "type": "convection",
        "source": f"defamation step 1 (deformation grids), run for RiftsClimate in {label}; "
                  f"settings {config_note}",
        "reconstruction_model": reconstruction_id,
        "lon_min": -180.0, "lon_max": 180.0, "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": 0.0, "depth_max_km": 1.0,
        "dtype": "uint8",
        "no_data_sentinel": NO_DATA,
        "default_resolution": "native",
        "resolutions": [{"id": "native", "nlon": nlon, "nlat": nlat, "ndepth": 1}],
        "frames": [{"id": str(t), "age_ma": float(t)} for t in ages],
        "path_template": "frames/{variable}/{resolution}/{frame}.bin.gz",
        "default_variable": "horizontal_divergence",
        "variables": [
            {"id": "horizontal_divergence", "name": "Horizontal divergence",
             "source_var": "horizontal_divergence", "units": "1/s", "diverging": True,
             "high_means": "extension",
             "encode_min": sig(lo), "encode_max": sig(hi),
             "default_clip_min": sig(lo), "default_clip_max": sig(hi),
             "clip_note": f"±{DIVERGENCE_CLIP_PERCENTILE}th percentile of |value|, pooled over every frame",
             "default_colormap": "RdBu_hot"},
            {"id": "deformation_style", "name": "Deformation style",
             "source_var": "deformation_style", "units": "class", "diverging": False,
             "categorical": True, "class_names": STYLE_CLASSES,
             "encode_min": 0.0, "encode_max": float(len(STYLE_CLASSES)),
             "default_clip_min": 0.0, "default_clip_max": float(len(STYLE_CLASSES)),
             "default_colormap": "deformation_style"},
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"  deformation {len(ages)} frames ({missing} missing), divergence clip ±{m:.3g} 1/s, "
          f"{total / 1e6:.1f} MB")
    return {"base": "riftsclimate", "path": f"riftsclimate/models/{model_id}/manifest.json",
            "id": model_id, "frames": len(ages)}


# --- main ----------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--riftsclimate", type=Path, default=RIFTSCLIMATE)
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    ap.add_argument("--skip-deformation", action="store_true")
    args = ap.parse_args()

    from gprm.datasets import Reconstructions

    archive = args.archive
    geode_dir = args.riftsclimate / "data" / "geode"
    out = archive / "riftsclimate"
    out.mkdir(parents=True, exist_ok=True)

    dep = pd.read_csv(geode_dir / "deposits.csv")
    catalogue = json.loads((geode_dir / "fields.json").read_text())
    (out / "fields.json").write_text(json.dumps(catalogue, separators=(",", ":")))

    def column(key, kind):
        v = pd.to_numeric(dep[key], errors="coerce").to_numpy(float)
        if kind == "bool":
            return [None if not np.isfinite(x) else int(x) for x in v]
        return [None if not np.isfinite(x) else float(f"{x:.6g}") for x in v]

    values = {"ids": dep["deposit_id"].tolist(), "classes": dep["class"].tolist(),
              "columns": {f["key"]: column(f["key"], f["kind"]) for f in catalogue["fields"]}}
    size = write_gz_json(out / "values.json.gz", values)
    print(f"values: {len(dep)} deposits x {len(catalogue['fields'])} values, {size / 1e6:.2f} MB")

    archive_index = json.loads((archive / "archive.json").read_text())
    bridge = next((m for m in archive_index["models"] if m["id"] == "bridge-valdes2021-monthly"), None)

    models = []
    for key, (fetch, recon_id, label, run, prefix) in MODELS.items():
        print(f"\n{label}")
        model = getattr(Reconstructions, f"fetch_{fetch}")()
        pts = deposit_points(model, dep, prefix, fetch)
        size = write_gz_json(out / key / "points.json.gz", pts)
        counts = count_drawable(dep, prefix, model)
        print(f"  deposits    {len(pts['rotations'])} plates, {size / 1e6:.2f} MB; {counts}")
        coast = extend_coastline_rotations(
            archive, recon_id, model, out / key / "coastline_rotations_540-1000.json.gz")
        entry = {
            "id": key, "label": label, "gprm": f"fetch_{fetch}",
            "age_min": 0, "age_max": AGE_MAX,
            "points": f"riftsclimate/{key}/points.json.gz",
            "coastlines": coast,
            "counts": counts,
            # Climate Models exist ONLY in the Scotese frame (BRIDGE is run on Scotese
            # palaeogeography); none is ever shown under Merdith 2021.
            "climate_model": (bridge["path"] if key == "scotese" and bridge else None),
            "climate_age_max": 541 if key == "scotese" else None,
            "rifts": None,
            "polygons": export_polygons(archive, model, geode_dir, prefix, out / key),
            "deformation": None,
        }
        if key == "merdith2021":
            entry["rifts"] = export_rifts(archive, model, geode_dir, out / key)
        if not args.skip_deformation:
            run_dir = args.riftsclimate / "data" / "rifts" / "defamation" / run
            entry["deformation"] = build_deformation_model(
                archive, run_dir, f"defamation-{key}", label, recon_id,
                f"RiftsClimate prep/defamation/config_{run}.yaml")
        else:
            prev = out / "index.json"
            if prev.exists():
                old = {m["id"]: m for m in json.loads(prev.read_text())["models"]}
                entry["deformation"] = old.get(key, {}).get("deformation")
        models.append(entry)

    index = {
        "title": "RiftsClimate deposits",
        "fields": "riftsclimate/fields.json",
        "values": "riftsclimate/values.json.gz",
        "classes": catalogue["classes"],
        "built_from": catalogue["meta"],
        "models": models,
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    (out / "source.json").write_text(json.dumps({
        "source": "RiftsClimate deposit values (Hoggard et al. 2020 deposits; WP5 covariates) and "
                  "defamation deformation grids, from the RiftsClimate repository"}))
    print(f"\nwrote {out}/index.json")


if __name__ == "__main__":
    main()
