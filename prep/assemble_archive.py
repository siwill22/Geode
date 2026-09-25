#!/usr/bin/env python3
"""Assemble a standalone Archive: copied layers plus imported Models.

    python prep/assemble_archive.py --out DIR --from-release data-v22 \\
        --copy colormaps.json coastlines boundaries surface \\
        --model path/to/model.ingest.json [--model ...]

An Archive never refers to another (CONTEXT.md, docs/adr/0054). What it needs
from the main Geode Archive is copied in as the PACKED bytes of a named data
release, exactly as published; only the new Models are built from source,
each from its Ingest Config (docs/adr/0056). Steps:

  1. fetch the release tarball once (cached) and extract only the named
     sections into --out; each copied directory's source.json gains a
     "copied_from" line
  2. graft those sections' entries -- already naming their .gz files -- and
     their `sources` verbatim from the release's own archive.json
  3. import each Model with prep_model.py --config, into the same Archive
     (it needs colormaps.json there to choose a polarity-correct ramp)
  4. write archive.json (format 1), then run verify_archive.py and each
     Model's Verification Card; exit 1 if either fails

Pip-only and conda-free, like the rest of the import path.
"""

import argparse
import json
import subprocess
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_archive_index import ARCHIVE_FORMAT, model_entry  # noqa: E402

REPO = "siwill22/Geode"
ASSET = "archive-deploy.tar.gz"

# Index keys that belong to each copyable top-level name.
SECTION_KEYS = {
    "colormaps.json": ["colormaps"],
    "coastlines": ["coastlines"],
    "boundaries": ["boundaries"],
    "scotese_coastlines": ["scotese_coastlines"],
    "surface": [],          # loaded by convention (surface/topography.jpg)
}


def fetch_release(tag):
    """The release tarball, downloaded once into gprm's cache."""
    from gprm.datasets import cache_path
    from pooch import retrieve

    url = f"https://github.com/{REPO}/releases/download/{tag}/{ASSET}"
    try:
        return Path(retrieve(url=url, known_hash=None, fname=f"{tag}-{ASSET}",
                             path=cache_path("geode"), progressbar=True))
    except Exception as e:
        from _inputs import _fetch_error
        raise _fetch_error(f"Geode data release {tag}", url,
                           Path(cache_path("geode")) / f"{tag}-{ASSET}", e) from e


def pack_model(manifest_path):
    """Gzip a Model's frames and rewrite path_template to match -- the same
    packing prep/pack_deploy.mjs gives the main Archive, so the whole
    Archive is uniformly packed (docs/ARCHIVE_FORMAT.md: .gz is named)."""
    import gzip
    m = json.loads(manifest_path.read_text())
    if not m["path_template"].endswith(".bin"):
        return m
    raw = packed = 0
    for f in sorted((manifest_path.parent / "frames").rglob("*.bin")):
        data = f.read_bytes()
        gz = gzip.compress(data, compresslevel=9, mtime=0)
        f.with_name(f.name + ".gz").write_bytes(gz)
        f.unlink()
        raw += len(data); packed += len(gz)
    m["path_template"] += ".gz"
    manifest_path.write_text(json.dumps(m, indent=2))
    print(f"  packed  {m['id']}: {raw / 1e6:.1f} -> {packed / 1e6:.1f} MB")
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--from-release", required=True, help="Geode data release tag, e.g. data-v22")
    ap.add_argument("--copy", nargs="+", required=True, choices=sorted(SECTION_KEYS))
    ap.add_argument("--model", type=Path, action="append", required=True,
                    help="an Ingest Config; repeatable")
    args = ap.parse_args()
    if "colormaps.json" not in args.copy or "coastlines" not in args.copy:
        ap.error("an Archive needs colormaps.json and coastlines (docs/ARCHIVE_FORMAT.md)")

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    origin = f"Geode {args.from_release}"

    # 1. copy
    tar_path = fetch_release(args.from_release)
    with tarfile.open(tar_path) as tar:
        names = tar.getnames()
        release_index = json.load(tar.extractfile(
            next(n for n in names if n.lstrip("./") == "archive.json")))
        wanted = [n for n in names
                  if any(n.lstrip("./") == s or n.lstrip("./").startswith(s + "/") for s in args.copy)]
        tar.extractall(out, members=[tar.getmember(n) for n in wanted], filter="data")
    for section in args.copy:
        src_json = out / section / "source.json"
        if src_json.exists():
            meta = json.loads(src_json.read_text())
            meta["copied_from"] = origin
            src_json.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        print(f"  copied  {section:16s} from {origin}")

    # 2. graft index sections
    index = {"format": ARCHIVE_FORMAT}
    for section in args.copy:
        for key in SECTION_KEYS[section]:
            if key in release_index:
                index[key] = release_index[key]
    release_sources = release_index.get("sources", {})
    sources = {s: release_sources[s] for s in args.copy if s in release_sources}

    # 3. import Models
    models = []
    for cfg in args.model:
        subprocess.run([sys.executable, str(Path(__file__).with_name("prep_model.py")),
                        "--config", str(cfg), "--out", str(out), "--validate"], check=True)
        model_id = json.loads(cfg.read_text())["id"]
        manifest_path = out / "models" / model_id / "manifest.json"
        manifest = pack_model(manifest_path)
        models.append(model_entry(manifest))
    index["models"] = models
    if sources:
        index["sources"] = sources

    # 4. index, then checks
    (out / "archive.json").write_text(json.dumps(index, indent=2, ensure_ascii=False))
    print(f"\nwrote {out / 'archive.json'}  ({len(models)} model(s), copied from {origin})")
    failed = subprocess.run([sys.executable, str(Path(__file__).with_name("verify_archive.py")),
                             "--archive", str(out)]).returncode != 0
    for m in models:
        failed |= subprocess.run([sys.executable, str(Path(__file__).with_name("verification_card.py")),
                                  "--archive", str(out), "--model", m["id"]]).returncode != 0
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
