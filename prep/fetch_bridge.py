#!/usr/bin/env python3
"""Download the raw netCDF climate-mean files behind the BRIDGE `scotese_02`
run sequence (see bridge_runs.py) into a local cache for prep_bridge.py to
read.

Unlike Li et al./Pohl (already-curated files on OneDrive), this data lives on
a public HTTP server (https://www.paleo.bristol.ac.uk/ummodel/data/<run>/
climate/<run>a.pdcl<suffix>.nc, confirmed 200 OK, no login) and must be
fetched ourselves. Per-run per-suffix caching means a re-run only fetches
what's missing -- safe to interrupt and resume, and safe to re-run after
adding a new suffix/variable without re-downloading everything.

Three streams are fetched per run:
  - atmosphere (`<run>a.pdcl<suffix>.nc`): 12 months + annual, 39 variables,
    surface/atmosphere only (T, P, MSLP, wind, ice conc, ...). Feeds the
    Monthly Layer.
  - ocean surface (`<run>o.pfcl<suffix>.nc`): 12 months + annual, single
    level (~5m) -- SST, SSS, surface current, sea-ice drift, barotropic
    streamfunction, mixed-layer depth. Shares the atmosphere stream's grid
    and Month axis, so it also feeds the Monthly Layer (see
    docs/adr/0013-monthly-absorbs-bridge-ocean-surface-fields.md).
  - ocean depth (`<run>o.pgclann.nc`): annual mean ONLY (confirmed directly
    -- `<run>o.pgcl<month>.nc` 404s, there is no monthly 3D ocean archive
    here), full-depth: temperature, salinity, u/v currents and vertical
    velocity on 19-20 levels from 5m to ~5.2km (`temp_ym_dpth`,
    `salinity_ym_dpth`, `ucurrTot_ym_dpth`, `vcurrTot_ym_dpth`, `W_ym_dpth`).
    Feeds the Ocean Depth Layer.

This is ~1.7 GB across 109 runs x 13 atmosphere files, ~1.7 GB across 109
runs x 13 ocean-surface files, plus ~450 MB across 109 runs x 1 ocean-depth
file -- a one-time offline step, not something to run casually. A short
delay between requests keeps this a considerate client of a public academic
server (the BRIDGE group's own instructions explicitly demonstrate wget in a
loop for bulk access, see Using_BRIDGE_webpages.pdf, but that doesn't mean
hammering it).

Output:

    prep/cache/bridge_valdes2021/<run>/<run>a.pdcl<suffix>.nc
    prep/cache/bridge_valdes2021/<run>/<run>o.pfcl<suffix>.nc
    prep/cache/bridge_valdes2021/<run>/<run>o.pgclann.nc

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python fetch_bridge.py
"""

import argparse
import time
from pathlib import Path

import requests

from bridge_runs import RUNS, cache_dirname

BASE_URL = "https://www.paleo.bristol.ac.uk/ummodel/data"
SUFFIXES = ["jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec", "ann"]


def _filenames_for(run: str) -> list[str]:
    """Every file this run should have cached, atmosphere + both ocean
    streams -- see the module docstring for what each feeds."""
    names = [f"{run}a.pdcl{suf}.nc" for suf in SUFFIXES]
    names += [f"{run}o.pfcl{suf}.nc" for suf in SUFFIXES]
    names.append(f"{run}o.pgclann.nc")
    return names


def _fetch_one(url: str, out_path: Path, delay: float) -> bytes | None:
    """None on failure (caller records it); sleeps only after a REAL
    network request, never after a cache hit, so a fully-cached re-run
    finishes instantly instead of paying 1526 x delay for nothing."""
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    resp.raise_for_status()
    out_path.write_bytes(resp.content)
    time.sleep(delay)
    return resp.content


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--cache-dir", type=Path,
                     default=Path(__file__).parent / "cache" / "bridge_valdes2021")
    ap.add_argument("--delay", type=float, default=0.3,
                     help="seconds to sleep between requests")
    args = ap.parse_args()

    args.cache_dir.mkdir(parents=True, exist_ok=True)

    all_files = [(i, run, name) for i, (run, _age) in enumerate(RUNS)
                 for name in _filenames_for(run)]
    total = len(all_files)
    fetched = 0
    skipped = 0
    failed: list[tuple[str, str]] = []

    for n, (i, run, name) in enumerate(all_files, start=1):
        run_dir = args.cache_dir / cache_dirname(i, run)
        run_dir.mkdir(exist_ok=True)
        out_path = run_dir / name
        if out_path.exists() and out_path.stat().st_size > 0:
            skipped += 1
            continue
        url = f"{BASE_URL}/{run}/climate/{name}"
        try:
            content = _fetch_one(url, out_path, args.delay)
            fetched += 1
            if fetched % 20 == 0:
                print(f"[{n}/{total}] fetched {fetched}, skipped {skipped}, "
                      f"failed {len(failed)} -- last: {name} "
                      f"({len(content) / 1024:.0f} KB)")
        except requests.RequestException as e:
            failed.append((name, str(e)))
            print(f"[{n}/{total}] ** FAILED {name}: {e}")

    print(f"\ndone: {fetched} fetched, {skipped} already cached, {len(failed)} failed")
    if failed:
        print("failed files:")
        for name, err in failed:
            print(f"  {name}  {err}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
