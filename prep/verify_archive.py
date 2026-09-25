#!/usr/bin/env python3
"""Check that an archive contains every file its own index claims, and that
its declared format (docs/ARCHIVE_FORMAT.md) is one this checker knows.

    python prep/verify_archive.py [--archive archive]

archive.json is the viewer's only map of the archive, and nothing else
checks it against the disk. When the two disagree the viewer does not fail
loudly: a missing coastline or boundary file just leaves a plausible-looking
empty globe (see the 2026-09 reproducibility review). This walks the index,
and every manifest it points at, and stats every file those name:

  - archive.json itself: every string value that looks like a file path
    (colormaps, coastline sets, boundaries, paleomag points, ...), relative
    to the archive root.
  - each models[].path manifest: its path_template expanded over every
    variable (including vector-field u/v components), resolution and frame.
  - each reconstruction_models[].path manifest: every file path it names,
    relative to that manifest's own directory.
  - every petrify boundary-series manifest found along the way: each
    frames[].file, relative to that manifest's directory.
  - files the viewer loads by convention rather than via the index
    (surface/topography.jpg), reported as warnings, not failures.

Works on the raw archive and on a packed deploy archive alike, since it
only follows names the index and manifests actually record -- a packed
archive's index already says `.gz` where pack_deploy.mjs gzipped a file.

Exits 1 if anything the index names is missing, so it can gate a build.
"""

import argparse
import gzip
import json
import sys
from itertools import product
from pathlib import Path

# A string value is treated as a file reference if it ends in one of these
# and looks like a relative path, not prose or a URL.
FILE_SUFFIXES = (".json", ".bin", ".gz", ".jpg", ".png", ".geojson")

# docs/ARCHIVE_FORMAT.md
SUPPORTED_FORMAT = 1

# Loaded by the viewers at a fixed path, not named in archive.json.
CONVENTIONAL_FILES = ["surface/topography.jpg"]


def looks_like_path(s):
    return (s.endswith(FILE_SUFFIXES) and " " not in s and "://" not in s
            and not s.startswith("/"))


def string_paths(obj):
    """Every path-like string value anywhere in a JSON tree."""
    if isinstance(obj, str):
        if looks_like_path(obj):
            yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from string_paths(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from string_paths(v)


def read_json(path):
    """Read JSON, gzipped or not -- the viewer sniffs the magic number too."""
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


class Report:
    def __init__(self):
        self.sections = {}   # name -> [n_checked, missing list]

    def check(self, section, root, rel):
        n, missing = self.sections.setdefault(section, [0, []])
        self.sections[section][0] = n + 1
        path = root / rel
        if not path.is_file():
            missing.append(str(path))
            return None
        return path

    def missing_total(self):
        return sum(len(m) for _, m in self.sections.values())


def check_boundary_series(report, section, archive, manifest_path):
    """A petrify BoundarySeries: frames[].file relative to its own dir."""
    try:
        series = read_json(manifest_path)
    except (OSError, ValueError) as e:
        report.sections.setdefault(section, [0, []])[1].append(f"{manifest_path}: unreadable ({e})")
        return
    if not isinstance(series, dict) or "frames" not in series:
        return
    for frame in series["frames"]:
        if isinstance(frame, dict) and "file" in frame:
            report.check(section, manifest_path.parent, frame["file"])


def check_paths_in(report, section, archive, base, obj):
    """Stat every path-like string in `obj` (relative to `base`), and follow
    any that turn out to be boundary-series manifests."""
    for rel in string_paths(obj):
        path = report.check(section, base, rel)
        if path is not None and "boundaries" in rel and rel.endswith((".json", ".json.gz")):
            check_boundary_series(report, section, archive, path)


def check_model(report, archive, entry):
    section = f"model {entry['id']}"
    manifest_path = report.check(section, archive, entry["path"])
    if manifest_path is None:
        return
    m = read_json(manifest_path)
    base = manifest_path.parent
    variables = [v["id"] for v in m.get("variables", [])]
    for vf in m.get("vector_fields", []):
        variables += [vf["u_variable"], vf["v_variable"]]
    resolutions = [r["id"] for r in m.get("resolutions", [])]
    frames = [f["id"] for f in m.get("frames", [])]
    template = m["path_template"]
    for var, res, frame in product(dict.fromkeys(variables), resolutions, frames):
        report.check(section, base, template.format(variable=var, resolution=res, frame=frame))
    # An imported Model names its Ingest Config (docs/ARCHIVE_FORMAT.md).
    if "ingest_config" in m:
        report.check(section, base, m["ingest_config"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    args = ap.parse_args()
    archive = args.archive

    index_path = archive / "archive.json"
    if not index_path.is_file():
        sys.exit(f"{index_path}: not found -- nothing to verify")
    index = read_json(index_path)
    fmt = index.get("format", 1)
    if fmt > SUPPORTED_FORMAT:
        sys.exit(f"{index_path} is archive format {fmt}; this checker knows up to "
                 f"{SUPPORTED_FORMAT} (docs/ARCHIVE_FORMAT.md)")
    print(f"  archive format {fmt}" + ("" if "format" in index else " (not stated; format 1 assumed)"))
    report = Report()

    for entry in index.get("models", []):
        check_model(report, archive, entry)

    for entry in index.get("reconstruction_models", []):
        section = f"reconstruction {entry['id']}"
        manifest_path = report.check(section, archive, entry["path"])
        if manifest_path is not None:
            check_paths_in(report, section, archive, manifest_path.parent,
                           read_json(manifest_path))

    # Everything else in the index: coastline sets, boundaries, colormaps,
    # paleomag points, and whatever top-level section is added next.
    for key, value in index.items():
        if key in ("models", "reconstruction_models"):
            continue
        check_paths_in(report, key, archive, archive, value)

    width = max((len(s) for s in report.sections), default=0)
    for section, (n, missing) in report.sections.items():
        status = "ok" if not missing else f"MISSING {len(missing)}"
        print(f"  {section:{width}s}  {n:6d} files  {status}")
        for path in missing[:5]:
            print(f"      {path}")
        if len(missing) > 5:
            print(f"      ... and {len(missing) - 5} more")

    for rel in CONVENTIONAL_FILES:
        if not (archive / rel).is_file():
            print(f"  warning: {archive / rel} not found -- viewers that load it "
                  f"by convention will render without it")

    n_missing = report.missing_total()
    n_checked = sum(n for n, _ in report.sections.values())
    if n_missing:
        print(f"\nFAIL: {n_missing} of {n_checked} files named by {index_path} are missing")
        sys.exit(1)
    print(f"\nok: all {n_checked} files named by {index_path} are present")


if __name__ == "__main__":
    main()
