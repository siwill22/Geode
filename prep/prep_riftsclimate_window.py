#!/usr/bin/env python3
"""Build the archive section of the RiftsClimate skill-by-time-window page (`skillwindow.html`).

The science belongs to the RiftsClimate repository: its `prep/geode_window_export.py` writes, for
step 1 of its factor-combination ladder (the plain Molchan test, one factor at a time), each
factor's rating rank for every cell (place x time slice) and every deposit, and the skills the
page must reproduce in a set of windows. The page computes the skill for any window from these.
This script only copies and gzips the files and records where they came from. Nothing here
computes a value.

Writes, under archive/riftsclimate/window/:
  index.json                RiftsClimate's index.json, with the files' names and provenance
  ground.bin.gz             every cell's time slice and area and each factor's ranks (see
                            RiftsClimate's script for the layout)
  deposits_<type>.json.gz   the deposits, their ranks and district pairs
  expected_<type>.json.gz   RiftsClimate's skills in the checked windows (read by
                            viewer/scripts/check_skillwindow.mjs)

Run:
    python prep/prep_riftsclimate_window.py
"""

import argparse
import datetime
import gzip
import json
import shutil
import subprocess
from pathlib import Path

RIFTSCLIMATE = Path("/Users/simon/GIT/RiftsClimate")
FORMAT = 1


def provenance(rc):
    def git(*a):
        try:
            return subprocess.run(["git", "-C", str(rc), *a], capture_output=True, text=True,
                                  check=True).stdout.strip()
        except Exception:
            return None
    script = "prep/geode_window_export.py"
    status = git("status", "--porcelain", "--", script) or ""
    return {
        "riftsclimate_commit": git("rev-parse", "--short", "HEAD"),
        "script": script,
        "script_state": ("untracked" if status.startswith("??") else
                         "uncommitted changes" if status else "committed"),
        "data": "data/geode/window/",
        "data_written": datetime.datetime.fromtimestamp(
            (rc / "data/geode/window/ground.bin").stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
    }


def gz(src, dst):
    with open(src, "rb") as f, gzip.open(dst, "wb", compresslevel=6) as g:
        shutil.copyfileobj(f, g)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--riftsclimate", type=Path, default=RIFTSCLIMATE)
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    args = ap.parse_args()
    src = args.riftsclimate / "data/geode/window"
    out = args.archive / "riftsclimate/window"
    out.mkdir(parents=True, exist_ok=True)
    index = json.loads((src / "index.json").read_text())
    gz(src / "ground.bin", out / "ground.bin.gz")
    for t in index["types"]:
        gz(src / f"deposits_{t}.json", out / f"deposits_{t}.json.gz")
        gz(src / f"expected_{t}.json", out / f"expected_{t}.json.gz")
        index["types"][t].update(deposits_file=f"deposits_{t}.json.gz", expected_file=f"expected_{t}.json.gz")
    index.update(format=FORMAT, ground_file="ground.bin.gz", built_from=provenance(args.riftsclimate))
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {out}: {index['cells']} cells, {len(index['factors'])} factors, types {list(index['types'])}")


if __name__ == "__main__":
    main()
