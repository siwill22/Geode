#!/usr/bin/env python3
"""Export Paleobiology Database occurrences for the paleobiology viewer.

Two case studies, deliberately not one dataset with a switch:

  corals  Anthozoa through the Phanerozoic under Scotese -- latitudinal
          distribution, diversity, and the turnover in dominant taxa across the
          mass extinctions.
  panama  The Panama gateway, 15-0 Ma under Muller et al. 2019 -- the isthmus
          closing as a JOIN (two land faunas mix) and a SPLIT (two marine
          faunas diverge) at the same moment.

Everything domain-specific lives here; everything generic lives upstream in
`deep_time_map` (its ADR-0001 names "querying a live species database" as the
worked example of that split). This script produces the plain payloads
`PointLayer`, `AggregateLayer` and `attachLatitudePanel` already know how to
render, and nothing in `viewer/vendor/deep-time-map/js` knows what a coral is.

---- Why paleocoordinates are recomputed, not taken from PBDB ------------------

PBDB serves paleocoordinates (`pln`/`pla`) and even offers `pgm=scotese` as one
of its three paleomodels. They are not used, for a decisive reason: they are
computed at ONE age only (`ps1: "mid"`, the midpoint of that occurrence's own
age range). That is a single frozen position per point, so a map built from them
would silently mix reference frames and could not animate at all. `PointLayer`
needs a rotation series.

PBDB's own `gpl` plate id is ignored for the same discipline (ADR-0004): it
belongs to PBDB's model, not to the Reconstruction Model this viewer draws
coastlines from. Plate ids are assigned here, by partitioning against the
chosen model's own static polygons -- the `prep_boucot.py` path.

---- Two facts measured while writing this, worth knowing ----------------------

1. `PointLayer.isLive()`'s `plate_begin_age` rule (ADR-0032/0033) costs far more
   in the CENOZOIC than in the Paleozoic, which is the opposite of the intuition.
   Measured on all 68,641 Anthozoa records against Scotese: Paleozoic 4.3%,
   Mesozoic 1.9%, Cenozoic 27.3%. True begin-age violations are only 2.0% --
   Scotese's static polygons are ancient continental blocks (median begin age
   600 Ma). The loss is UNASSIGNED points (plate 0), and they concentrate in the
   Cenozoic because young occurrences sit on oceanic reefs and islands that
   continental static polygons do not cover. On the Panama marine box this is
   14.5% under Scotese and 0.0% under Muller 2019, which is why the two case
   studies use different Reconstruction Models. The script reports the figure for
   every export rather than leaving it to be rediscovered.

2. PBDB's API disagrees with itself on record counts: `occs/list.json?...
   &rowcount` reports 45,602 for Anthozoa while `occs/list.csv?...&limit=all`
   returns 68,641 rows. The CSV is used throughout -- it is the larger set and
   the one actually carrying the data -- and the count is printed so the
   discrepancy stays visible.

Usage:
  conda run -n pygmt17 python prep/prep_pbdb.py               # both datasets
  conda run -n pygmt17 python prep/prep_pbdb.py --dataset corals
"""

import argparse
import csv
import gzip
import io
import json
import math
import pickle
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

DEEP_TIME_MAP_PY = Path(__file__).parent.parent / "viewer" / "vendor" / "deep-time-map" / "python"
sys.path.insert(0, str(DEEP_TIME_MAP_PY))

PBDB = "https://paleobiodb.org/data1.2"
CACHE = Path(__file__).parent / "cache" / "pbdb"

# `loc` is what carries `cc`. Note that `cc` in a RESPONSE is the country code (US, AR),
# while `cc=` in a QUERY accepts continent codes (NOA, SOA) -- they are not the same
# vocabulary. Continent membership is therefore taken by querying each continent
# separately and tagging the result, never by mapping country to continent here: that
# table would be invented rather than read from PBDB.
SHOW = "coords,class,loc"


# --------------------------------------------------------------------------- config

def rgb(r, g, b):
    return f"rgb({r},{g},{b})"


DATASETS = {
    "corals": {
        "name": "Corals through the Phanerozoic",
        "caption": (
            "Every Anthozoa occurrence in the Paleobiology Database, reconstructed "
            "under the Scotese plate model. Scotese is the only cataloged "
            "reconstruction reaching the Ordovician; it carries no plate boundaries."
        ),
        "citation": "Paleobiology Database (paleobiodb.org), accessed via data1.2. "
                    "Reconstruction: Scotese (2008) PALEOMAP.",
        "model": "Scotese",
        "reconstruction_model": "scotese",
        "base_model": "paleogeography-scotese",
        "climate_model": "climate-pohl2022",
        "age_min": 0.0, "age_max": 540.0, "age_step": 5.0,
        # Where the camera opens. A global dataset opens on the whole globe; a
        # regional one opens on its region, because a viewer that starts showing
        # the far side of the Earth makes the reader hunt for the data before
        # they can see anything.
        "view_centre": [10.0, 15.0], "view_distance": 3.7,
        "pools": [{"id": "corals", "realm": "Marine", "query": "base_name=Anthozoa"}],
        "groupings": [{
            "id": "subclass",
            "label": "Subclass",
            "derived": False,
            "rule": "PBDB's own taxonomic hierarchy, by base_name membership.",
            "kind": "taxon",
            # Each key is a real PBDB taxon queried for its own occurrence ids. No
            # hand-written order-to-subclass table: the membership comes from PBDB.
            "categories": [
                ("Rugosa", "Rugose corals", rgb(203, 87, 68)),
                ("Tabulata", "Tabulate corals", rgb(233, 163, 62)),
                ("Scleractinia", "Scleractinian corals", rgb(80, 150, 205)),
                ("Octocorallia", "Octocorals", rgb(122, 184, 136)),
            ],
        }],
    },
    "panama": {
        "name": "The Panama gateway: a join and a split",
        "caption": (
            "The isthmus closing joins two land faunas while severing two marine "
            "ones. Land mammals from North and South America, and Caribbean/Pacific "
            "molluscs and corals, 15-0 Ma under Muller et al. 2019 -- which loses "
            "none of the marine record to unassigned plates, where Scotese loses "
            "14.5%."
        ),
        "citation": "Paleobiology Database (paleobiodb.org), accessed via data1.2. "
                    "Reconstruction: Muller et al. (2019).",
        "model": "Muller2019",
        "reconstruction_model": "muller2019",
        # No base raster. The only Phanerozoic paleogeography in the catalog is
        # Scotese & Wright's, which carries Scotese's own continent positions --
        # drawing it beneath Muller 2019 coastlines is precisely the ADR-0004
        # misplacement. Coastlines and land fill only, which over 15 Myr is
        # nearly all the context there is anyway.
        "base_model": None,
        "climate_model": None,
        "age_min": 0.0, "age_max": 15.0, "age_step": 0.5,
        "view_centre": [-82.0, 8.0], "view_distance": 2.6,
        "pools": [
            # 12-0 Ma, NOT the 12-2 Ma window the plan first sized this at. Measured:
            # with min_ma=2 the export's own diversity table came out with
            # richness_north_america == 0 for every stage younger than the Gelasian and
            # immigrant fractions pinned near zero -- because the interchange peaks AFTER
            # ~2.7 Ma, so a window ending at 2 Ma cuts off the signal the case study
            # exists to show. The original bound was chosen to size the download, which
            # is not a reason.
            {"id": "mammals_noa", "realm": "Terrestrial", "continent": "North America",
             "query": "base_name=Mammalia&cc=NOA&max_ma=12&min_ma=0"},
            {"id": "mammals_soa", "realm": "Terrestrial", "continent": "South America",
             "query": "base_name=Mammalia&cc=SOA&max_ma=12&min_ma=0"},
            # Box widened west and south from the plan's first cut (-100..-55,
            # -5..30). Measured on that box: the eastern Pacific held 2,789 records
            # against the Caribbean's 35,945, and FIVE of ten stages had zero sampled
            # Pacific genera -- not because the Pacific record is empty but because
            # latmin=-5 cut off the Ecuador/Peru Neogene molluscs, which are most of it.
            # A basin-similarity series computed from that would have been comparing one
            # basin against nothing for half its length.
            {"id": "marine", "realm": "Marine",
             "query": "base_name=Scleractinia,Mollusca&lngmin=-110&lngmax=-55"
                      "&latmin=-20&latmax=30&max_ma=15&min_ma=0"},
        ],
        "groupings": [
            {"id": "origin", "label": "Land mammals: first appears in", "derived": True,
             "rule": "The continent holding the genus's OLDEST occurrence in the full "
                     "PBDB North+South American mammal record. Ambiguous where the two "
                     "continents' oldest age intervals overlap. Derived, not recorded: "
                     "PBDB does not say where a lineage came from.",
             "kind": "origin",
             "categories": [
                 ("North America", "First appears in North America", rgb(214, 96, 77)),
                 ("South America", "First appears in South America", rgb(69, 117, 180)),
                 ("Ambiguous", "Age intervals overlap", rgb(150, 150, 155)),
             ]},
            {"id": "basin", "label": "Marine: which side", "derived": False,
             "rule": "Present-day position relative to the line from (95W, 16N) to "
                     "(75W, 5S) approximating the Central American land barrier. "
                     "Observed from coordinates, not inferred.",
             "kind": "basin",
             "categories": [
                 ("Caribbean", "Caribbean / W Atlantic", rgb(33, 132, 172)),
                 ("Pacific", "Eastern Pacific", rgb(244, 165, 79)),
             ]},
            {"id": "realm", "label": "Realm", "derived": False,
             "rule": "Which pool the occurrence came from.",
             "kind": "realm",
             "categories": [
                 ("Terrestrial", "Land mammals", rgb(188, 128, 74)),
                 ("Marine", "Molluscs and corals", rgb(70, 160, 180)),
             ]},
        ],
    },
}


# --------------------------------------------------------------------------- fetch

def _cache_path(kind, key):
    CACHE.mkdir(parents=True, exist_ok=True)
    safe = urllib.parse.quote(key, safe="")[:180]
    return CACHE / f"{kind}__{safe}"


def fetch_csv(query, label=None):
    """PBDB occurrences as a DataFrame, cached on disk by query string."""
    path = _cache_path("occs", query).with_suffix(".csv")
    if not path.exists():
        url = f"{PBDB}/occs/list.csv?{query}&show={SHOW}&limit=all"
        print(f"  fetching {label or query} ...", flush=True)
        with urllib.request.urlopen(url, timeout=1800) as r:
            path.write_bytes(r.read())
    return pd.read_csv(path, low_memory=False)


def fetch_occurrence_ids(base_name):
    """The set of occurrence_no below a PBDB taxon -- membership from PBDB's own
    hierarchy rather than a hand-written mapping table."""
    path = _cache_path("ids", base_name).with_suffix(".csv")
    if not path.exists():
        url = f"{PBDB}/occs/list.csv?base_name={urllib.parse.quote(base_name)}&limit=all"
        print(f"  fetching membership of {base_name} ...", flush=True)
        with urllib.request.urlopen(url, timeout=1800) as r:
            path.write_bytes(r.read())
    df = pd.read_csv(path, low_memory=False, usecols=["occurrence_no"])
    return set(df["occurrence_no"].astype(np.int64))


def fetch_stages():
    """ICS stages (PBDB calls them `age`), oldest-first, from the international scale."""
    path = _cache_path("intervals", "scale1").with_suffix(".json")
    if not path.exists():
        with urllib.request.urlopen(f"{PBDB}/intervals/list.json?scale_id=1&limit=1000",
                                    timeout=300) as r:
            path.write_bytes(r.read())
    recs = json.loads(path.read_text())["records"]
    stages = [{"name": r["nam"], "from": float(r["eag"]), "to": float(r["lag"])}
              for r in recs if r.get("itp") == "age"]
    stages.sort(key=lambda s: -s["from"])
    return stages


# --------------------------------------------------------------------------- grouping rules

# Longitude of the American continental divide at a given latitude -- the vertices of
# a coarse polyline down the Pacific coast, from Baja California to southern Peru. A
# point west of it is eastern Pacific; east of it is Caribbean / western Atlantic.
#
# This replaced a single straight line, which was wrong as soon as the query box
# extended south of the isthmus: a point on the Atlantic coast of Brazil fell on the
# "Pacific" side of any line drawn through Central America. The divide has to bend,
# because the coastline does.
#
# It is an approximation and the legend says so. What it is NOT is an inference about
# the fossils: it reads present-day coordinates only, which is what keeps this an
# Observed rather than a Derived Grouping (see CONTEXT.md).
# (latitude, longitude) vertices placed just INLAND of the Pacific coast, so an
# offshore point (smaller longitude) is Pacific and everything else is not. Sign
# matters and is easy to get backwards: the divide must lie EAST of the coast.
#
# These are hand-specified, which is a weaker footing than the rest of this file, so
# `--verify-basins` renders `basin_check.png` -- every classified occurrence in its
# assigned colour with the divide drawn over it. Look at the map rather than trusting
# the numbers; a misplaced vertex is obvious there and invisible in a count.
DIVIDE = [(30, -114.8), (25, -111.0), (20, -104.5), (15, -94.5), (10, -84.5),
          (5, -76.5), (0, -79.5), (-5, -80.4), (-10, -77.4), (-15, -74.7),
          (-18, -69.8), (-20, -69.5)]


def basin_of(lon, lat):
    """'Pacific' or 'Caribbean' for a present-day coordinate, by the DIVIDE polyline."""
    lats = [d[0] for d in DIVIDE]
    lons = [d[1] for d in DIVIDE]
    # DIVIDE runs north to south, so reverse for np.interp's ascending-x requirement.
    edge = float(np.interp(lat, lats[::-1], lons[::-1]))
    return "Pacific" if lon < edge else "Caribbean"


def origin_by_first_appearance(by_continent):
    """{genus: 'North America' | 'South America' | 'Ambiguous'}.

    @param by_continent  {continent label: DataFrame}, one query per continent. Split
                         this way because a response's `cc` is a COUNTRY code while the
                         query's is a continent code -- deriving one from the other here
                         would mean inventing a country-to-continent table instead of
                         using PBDB's own.

    A genus is assigned the continent holding its OLDEST occurrence. "Oldest" is an
    interval, not a point: each continent's oldest occurrence contributes its whole
    [min_ma, max_ma], and the call is only made when the two intervals are disjoint.
    Where they overlap the record does not distinguish them, so the answer is
    Ambiguous rather than whichever midpoint happened to be larger.

    This is a DERIVED grouping. PBDB records where a fossil was found, never where a
    lineage came from, and the UI says "first appears in" for that reason.
    """
    best = defaultdict(dict)   # genus -> continent -> (max_ma, min_ma)
    for continent, df in by_continent.items():
        for genus, mx, mn in zip(df["genus"], df["max_ma"], df["min_ma"]):
            if not isinstance(genus, str):
                continue
            cur = best[genus].get(continent)
            if cur is None or mx > cur[0]:
                best[genus][continent] = (float(mx), float(mn))

    north, south = "North America", "South America"
    out = {}
    for genus, by_cont in best.items():
        n, s = by_cont.get(north), by_cont.get(south)
        if n and not s:
            out[genus] = north
        elif s and not n:
            out[genus] = south
        elif n and s:
            if n[1] > s[0]:
                out[genus] = north      # N's whole interval is older than S's
            elif s[1] > n[0]:
                out[genus] = south
            else:
                out[genus] = "Ambiguous"
    return out


def assign_stages(df, stages):
    """Per-record stage index, -1 where the record does not resolve to exactly one.

    Containment, not overlap: a record counts only if its whole [min_ma, max_ma] sits
    inside one stage. A record spanning two stages constrains neither, and splitting
    it between them would invent precision the fossil does not have.
    """
    frm = np.array([s["from"] for s in stages])
    to = np.array([s["to"] for s in stages])
    eps = 1e-6
    out = np.full(len(df), -1, dtype=np.int64)
    mx = df["max_ma"].to_numpy(float)
    mn = df["min_ma"].to_numpy(float)
    for i in range(len(df)):
        inside = np.flatnonzero((mx[i] <= frm + eps) & (mn[i] >= to - eps))
        if len(inside) == 1:
            out[i] = inside[0]
    return out


# --------------------------------------------------------------------------- export

def load_pools(cfg):
    """Every pool's occurrences in one frame, tagged with its realm."""
    frames = []
    for pool in cfg["pools"]:
        df = fetch_csv(pool["query"], label=pool["id"])
        df = df.dropna(subset=["lng", "lat", "max_ma", "min_ma"]).copy()
        df["pool"] = pool["id"]
        df["realm"] = pool["realm"]
        df["continent"] = pool.get("continent")
        print(f"  pool {pool['id']}: {len(df)} occurrences with coordinates and ages")
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    # `genus` is the counting unit throughout. Measured on Anthozoa: counting at genus
    # retains 95.2% of records where species-level retains 51%, and species
    # identifications are inconsistent between workers and regions, so a species-level
    # curve substantially measures who described the fauna.
    if "genus" not in df:
        df["genus"] = np.nan
    return df


def grouping_values(cfg, grouping, df):
    """Per-record category key for one grouping, or None where it does not apply.

    A record with no category in the active grouping is simply not counted under it.
    That is the honest behaviour when a grouping asks a question of only part of the
    data -- 'which side of the seaway' means nothing for a land mammal.
    """
    kind = grouping["kind"]
    if kind == "realm":
        return list(df["realm"])

    if kind == "basin":
        return [basin_of(lo, la) if realm == "Marine" else None
                for lo, la, realm in zip(df["lng"], df["lat"], df["realm"])]

    if kind == "origin":
        # First appearance is determined over the FULL North+South American mammal
        # record, not the 12-2 Ma window the map shows -- otherwise "first appears in"
        # would mean "first appears in within the window", which is a different and
        # much weaker claim.
        full = {
            "North America": fetch_csv("base_name=Mammalia&cc=NOA",
                                       label="N. American mammals, all ages"),
            "South America": fetch_csv("base_name=Mammalia&cc=SOA",
                                       label="S. American mammals, all ages"),
        }
        table = origin_by_first_appearance(full)
        print(f"    origin rule: {len(table)} genera assigned "
              f"({sum(v == 'Ambiguous' for v in table.values())} ambiguous)")
        return [table.get(g) if realm == "Terrestrial" else None
                for g, realm in zip(df["genus"], df["realm"])]

    if kind == "taxon":
        members = {}
        for key, _, _ in grouping["categories"]:
            members[key] = fetch_occurrence_ids(key)
        occ = df["occurrence_no"].astype(np.int64)
        out = []
        for o in occ:
            hit = None
            for key in members:
                if o in members[key]:
                    hit = key
                    break
            out.append(hit)
        return out

    raise ValueError(f"unknown grouping kind {kind!r}")


def declared(grouping, values):
    """The grouping block `build_aggregates`/`build_latitude` consume."""
    order = [k for k, _, _ in grouping["categories"]]
    return {
        "label": grouping["label"],
        "category_order": order,
        "categories": {k: {"label": lab, "fill": fill}
                       for k, lab, fill in grouping["categories"]},
        "values": values,
    }


def write_json(path, payload, gzip_it=True):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    if gzip_it:
        path = path.with_suffix(path.suffix + ".gz")
        path.write_bytes(gzip.compress(raw, 6))
    else:
        path.write_bytes(raw)
    print(f"    wrote {path.name} ({path.stat().st_size / 1e6:.2f} MB)")
    return path.name


def build_dataset(key, cfg, out_root, rings):
    from deep_time_map.aggregate import build_aggregates, build_latitude, EqualAreaGrid
    from deep_time_map.points import points_from_dataframe, build_points, rotation_block
    from gprm.datasets import Reconstructions

    print(f"\n=== {key}: {cfg['name']} ===")
    df = load_pools(cfg)
    print(f"  {len(df)} occurrences total")

    groupings_cfg = cfg["groupings"]
    values = {}
    for g in groupings_cfg:
        values[g["id"]] = grouping_values(cfg, g, df)
        n = sum(v is not None for v in values[g["id"]])
        print(f"    grouping {g['id']}: {n} of {len(df)} records categorised")

    print(f"  fetching {cfg['model']} ...", flush=True)
    model = getattr(Reconstructions, f"fetch_{cfg['model']}")()

    fields = [("from", "max_ma"), ("to", "min_ma"), ("genus", "genus"),
              ("name", "accepted_name")]
    for g in groupings_cfg:
        col = f"_g_{g['id']}"
        df[col] = values[g["id"]]
        fields.append((f"g_{g['id']}", col))

    print("  partitioning against static polygons ...", flush=True)
    records, unassigned = points_from_dataframe(
        df, model, lon_field="lng", lat_field="lat", age_field="max_ma", fields=fields)
    props = [r for _, r in records]

    # The measurement that decided which Reconstruction Model each case study uses --
    # reported every run rather than left to be rediscovered. See the module docstring.
    lost = sum(
        1 for p in props
        if (p.get("plate_begin_age") is None and p.get("plate_id") == 0)
        or (p.get("plate_begin_age") is not None and p["from"] > p["plate_begin_age"])
    )
    print(f"  plate 0 (unassigned): {unassigned}   "
          f"never drawable at own age: {lost} ({100 * lost / len(props):.1f}%)")

    # `type` drives PointLayer's own symbolisation; the wrapper reassigns it when the
    # active Grouping changes, so its initial value is just the default grouping's.
    default_grouping = groupings_cfg[0]["id"]
    for p in props:
        p["type"] = p.get(f"g_{default_grouping}") or "—"

    times = np.arange(cfg["age_min"], cfg["age_max"] + cfg["age_step"] / 2, cfg["age_step"])
    plate_ids = {p["plate_id"] for p in props}

    out_dir = out_root / key
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"id": key, "files": {}}

    print("  building rotations ...", flush=True)
    rotations = rotation_block(model, plate_ids, times)

    categories = {}
    for g in groupings_cfg:
        for k, lab, fill in g["categories"]:
            categories.setdefault(k, {"symbol": "circle", "fill": fill, "label": lab})
    categories["—"] = {"symbol": "circle", "fill": "rgb(120,126,134)", "label": "uncategorised"}

    points_payload = build_points(
        model, records, times, transport="rotations",
        categories=categories, model_name=cfg["model"],
        meta={"source": cfg["citation"], "caption": cfg["caption"]})
    manifest["files"]["points"] = write_json(out_dir / "points.json", points_payload)

    grid = EqualAreaGrid(rings)
    print(f"  aggregating into {grid.n_cells} equal-area cells x {len(times)} times ...",
          flush=True)
    agg = build_aggregates(
        props, rotations, list(times),
        {g["id"]: declared(g, values[g["id"]]) for g in groupings_cfg},
        grid=grid, lifespan="range", richness_field="genus",
        model_name=cfg["model"], default_grouping=default_grouping,
        meta={"source": cfg["citation"]})
    manifest["files"]["aggregates"] = write_json(out_dir / "aggregates.json", agg)

    # ---- Time Bins: stages, single-stage records only -------------------------
    stages = [s for s in fetch_stages()
              if s["from"] > cfg["age_min"] and s["to"] < cfg["age_max"]]
    bin_of = assign_stages(df, stages)
    kept = int((bin_of >= 0).sum())
    print(f"  stage binning: {kept} of {len(df)} records resolve to exactly one of "
          f"{len(stages)} stages ({100 * (len(df) - kept) / len(df):.1f}% dropped)")

    bin_ages = [(s["from"] + s["to"]) / 2 for s in stages]
    print("  building rotations at stage midpoints ...", flush=True)
    bin_rotations = rotation_block(model, plate_ids, bin_ages)
    lat_payload = build_latitude(
        props, bin_rotations, bin_ages, stages,
        {g["id"]: declared(g, values[g["id"]]) for g in groupings_cfg},
        bin_of=bin_of, model_name=cfg["model"], default_grouping=default_grouping,
        meta={"dropped": len(df) - kept, "total": len(df)})
    manifest["files"]["latitude"] = write_json(out_dir / "latitude.json", lat_payload)

    # ---- diversity + the sampling proxy, one consistent rule -------------------
    manifest["files"]["diversity"] = write_diversity(
        out_dir, df, bin_of, stages, values, groupings_cfg, key)

    manifest.update({
        "name": cfg["name"],
        "caption": cfg["caption"],
        "citation": cfg["citation"],
        "reconstruction_model": cfg["reconstruction_model"],
        "base_model": cfg["base_model"],
        "climate_model": cfg["climate_model"],
        "age_min": cfg["age_min"], "age_max": cfg["age_max"],
        "view_centre": cfg["view_centre"], "view_distance": cfg["view_distance"],
        "occurrences": len(df),
        "unassigned": unassigned,
        "never_drawable": lost,
        "stage_records": kept,
        "stage_dropped": len(df) - kept,
        "default_grouping": default_grouping,
        "groupings": [{"id": g["id"], "label": g["label"],
                       "derived": g["derived"], "rule": g["rule"]}
                      for g in groupings_cfg],
    })
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def write_diversity(out_dir, df, bin_of, stages, values, groupings_cfg, key):
    """time_ma, richness, occurrences, collections [, per-category richness, + Panama's
    two derived series].

    Everything here is computed from the SAME single-stage-assigned records the
    latitude panel uses, under one rule. PBDB's own `occs/diversity.json` would supply
    a sampled-in-bin count with its own binning rule; mixing the two on one chart would
    put two different denominators on one axis. The sampling proxy travels alongside the
    richness rather than being corrected out of it -- raw Phanerozoic richness
    substantially tracks how much rock and how many workers there were, and the honest
    response is to show the reader the correlation, not to assert it was handled.
    """
    genus = df["genus"].to_numpy(object)
    coll = (df["collection_no"].to_numpy() if "collection_no" in df
            else np.zeros(len(df)))

    rows = []
    default_id = groupings_cfg[0]["id"]
    cat_values = np.array(values[default_id], dtype=object)
    cat_keys = [k for k, _, _ in groupings_cfg[0]["categories"]]

    origin = np.array(values.get("origin", [None] * len(df)), dtype=object)
    basin = np.array(values.get("basin", [None] * len(df)), dtype=object)
    realm = df["realm"].to_numpy(object)

    for bi, stage in enumerate(stages):
        sel = np.flatnonzero(bin_of == bi)
        if not len(sel):
            continue
        g = genus[sel]
        valid = np.array([isinstance(x, str) for x in g])
        row = {
            "time_ma": round((stage["from"] + stage["to"]) / 2, 3),
            "stage": stage["name"],
            "duration_myr": round(stage["from"] - stage["to"], 3),
            "richness": len(set(g[valid])),
            "occurrences": len(sel),
            "collections": len(set(coll[sel].tolist())),
        }
        for k in cat_keys:
            m = sel[cat_values[sel] == k]
            gk = genus[m]
            row[f"richness_{_slug(k)}"] = len(
                {x for x in gk if isinstance(x, str)})

        if key == "panama":
            # Immigrant fraction: among land occurrences on one continent, the share
            # whose genus first appears on the other. Rises as the bridge opens.
            land = sel[realm[sel] == "Terrestrial"]
            continent = df["continent"].to_numpy(object)
            for here, other, name in (("South America", "North America", "immigrant_frac_south"),
                                      ("North America", "South America", "immigrant_frac_north")):
                sub = land[continent[land] == here]
                row[name] = (round(float(np.mean(origin[sub] == other)), 4)
                             if len(sub) else "")
            # Faunal similarity between the two marine basins. Falls as the seaway shuts.
            sea = sel[realm[sel] == "Marine"]
            a = {x for x, b in zip(genus[sea], basin[sea])
                 if isinstance(x, str) and b == "Caribbean"}
            b = {x for x, bb in zip(genus[sea], basin[sea])
                 if isinstance(x, str) and bb == "Pacific"}
            # Blank, not zero, when EITHER basin is unsampled in this stage. A Jaccard
            # of 0 means "these faunas share nothing", which is the headline claim of
            # this whole case study; "we have no record on one side" means nothing at
            # all. Writing 0 for the second would draw a flat line through the
            # pre-closure stages that reads as the strongest possible evidence for a
            # separation that has not been measured. (Measured: under the earlier
            # `if (a or b)` test, Langhian through Messinian all reported 0.0 on exactly
            # this mistake.)
            row["basin_similarity"] = (round(len(a & b) / len(a | b), 4)
                                       if (a and b) else "")
            row["basin_genera_caribbean"] = len(a)
            row["basin_genera_pacific"] = len(b)
        rows.append(row)

    rows.sort(key=lambda r: r["time_ma"])
    path = out_dir / "diversity.csv"
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"    wrote {path.name} ({len(rows)} stages)")
    return path.name


def _slug(s):
    return "".join(c.lower() if c.isalnum() else "_" for c in s)


def verify_basins(out_dir):
    """Draw the basin classification so a person can check it.

    A count cannot show a misplaced vertex; a map can. This plots every marine
    occurrence in its assigned colour with the DIVIDE polyline over the top, so
    "Pacific points are west of Central America and Caribbean points are east of it" is
    something you look at rather than something this script asserts.
    """
    import pygmt

    cfg = DATASETS["panama"]
    pool = next(p for p in cfg["pools"] if p["id"] == "marine")
    df = fetch_csv(pool["query"], label="marine").dropna(subset=["lng", "lat"])
    df["basin"] = [basin_of(a, b) for a, b in zip(df["lng"], df["lat"])]
    print(df["basin"].value_counts().to_string())

    region = [-115, -50, -25, 33]
    fig = pygmt.Figure()
    fig.basemap(region=region, projection="M17c", frame=["af", "WSne"])
    fig.coast(land="gray85", water="gray97", shorelines="1/0.25p,gray50")
    for name, colour in (("Caribbean", "33/132/172"), ("Pacific", "244/165/79")):
        sub = df[df["basin"] == name]
        fig.plot(x=sub["lng"], y=sub["lat"], style="c0.09c",
                 fill=colour, transparency=45, label=f"{name} ({len(sub)})")
    fig.plot(x=[d[1] for d in DIVIDE], y=[d[0] for d in DIVIDE],
             pen="1.6p,black,-", label="DIVIDE polyline")
    fig.legend(position="JBL+jBL+o0.3c", box="+gwhite+p0.5p")
    path = out_dir / "basin_check.png"
    out_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(path), dpi=160)
    print(f"wrote {path} -- check that orange sits west of Central America and blue east")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", choices=sorted(DATASETS), action="append",
                    help="repeatable; default is every dataset")
    ap.add_argument("--out", type=Path, default=Path("archive/paleobio"))
    ap.add_argument("--rings", type=int, default=40,
                    help="latitude rings in the equal-area grid; cells = 2*rings^2")
    ap.add_argument("--verify-basins", action="store_true",
                    help="render basin_check.png -- the Caribbean/Pacific split drawn on "
                         "a map, so the hand-specified DIVIDE polyline can be checked by "
                         "eye instead of trusted")
    args = ap.parse_args()

    if args.verify_basins:
        verify_basins(args.out)
        return

    keys = args.dataset or sorted(DATASETS)
    args.out.mkdir(parents=True, exist_ok=True)
    entries = []
    for key in keys:
        entries.append(build_dataset(key, DATASETS[key], args.out, args.rings))

    index_path = args.out / "index.json"
    existing = {}
    if index_path.exists():
        existing = {d["id"]: d for d in json.loads(index_path.read_text())["datasets"]}
    for e in entries:
        existing[e["id"]] = {**e, "path": e["id"]}
    index_path.write_text(json.dumps(
        {"datasets": [existing[k] for k in sorted(existing)]}, indent=2))
    print(f"\nwrote {index_path}")


if __name__ == "__main__":
    main()
