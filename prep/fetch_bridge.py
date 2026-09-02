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

This is ~1.7 GB across 109 runs x 13 files (12 months + annual) -- a one-time
offline step, not something to run casually. A short delay between requests
keeps this a considerate client of a public academic server (the BRIDGE
group's own instructions explicitly demonstrate wget in a loop for bulk
access, see Using_BRIDGE_webpages.pdf, but that doesn't mean hammering it).

Output:

    prep/cache/bridge_valdes2021/<run>/<run>a.pdcl<suffix>.nc

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python fetch_bridge.py
"""

import argparse
import time
from pathlib import Path

import requests

from bridge_runs import RUNS

BASE_URL = "https://www.paleo.bristol.ac.uk/ummodel/data"
SUFFIXES = ["jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec", "ann"]


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

    total = len(RUNS) * len(SUFFIXES)
    fetched = 0
    skipped = 0
    failed = []

    for i, (run, age) in enumerate(RUNS):
        run_dir = args.cache_dir / run
        run_dir.mkdir(exist_ok=True)
        for suf in SUFFIXES:
            out_path = run_dir / f"{run}a.pdcl{suf}.nc"
            n = i * len(SUFFIXES) + SUFFIXES.index(suf) + 1
            if out_path.exists() and out_path.stat().st_size > 0:
                skipped += 1
                continue
            url = f"{BASE_URL}/{run}/climate/{run}a.pdcl{suf}.nc"
            try:
                resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"},
                                     timeout=60)
                resp.raise_for_status()
                out_path.write_bytes(resp.content)
                fetched += 1
                if fetched % 20 == 0:
                    print(f"[{n}/{total}] fetched {fetched}, skipped {skipped}, "
                          f"failed {len(failed)} -- last: {run}a.pdcl{suf}.nc "
                          f"({len(resp.content) / 1024:.0f} KB)")
                time.sleep(args.delay)
            except requests.RequestException as e:
                failed.append((run, suf, str(e)))
                print(f"[{n}/{total}] ** FAILED {run}a.pdcl{suf}.nc: {e}")

    print(f"\ndone: {fetched} fetched, {skipped} already cached, {len(failed)} failed")
    if failed:
        print("failed files:")
        for run, suf, err in failed:
            print(f"  {run}a.pdcl{suf}.nc  {err}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
