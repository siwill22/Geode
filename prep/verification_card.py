#!/usr/bin/env python3
"""Draw an imported Model's Verification Card, and fail if its bytes are wrong.

    python prep/verification_card.py --archive DIR --model ID [--depths 660 1000 2000]

The evidence that a Model in an Archive says what its source says (CONTEXT.md,
docs/adr/0056). It re-reads the SOURCE independently of prep_model.py -- with
plain xarray, not prep_model's own loader and resampler -- so it is not
checking the pipeline against itself, and compares it with the Archive's
stored bytes decoded exactly as the viewer decodes them
(docs/ARCHIVE_FORMAT.md). Written to models/<id>/verification/:

  card.png     source | stored | difference at each chosen depth, on the
               Archive's own present-day coastlines, plus a table of spot
               values and the Ingest Config's judgement calls in words
  card.json    the same numbers, machine-readable

Gate (exit 1): wherever a stored sample sits exactly on a source grid node
and the source value is inside the encode range, the decoded value must lie
within one stored level below the source (encoding truncates). Clamped
values and interpolated positions are reported, not gated.

Needs only numpy, xarray and matplotlib: no PyGMT, no cartopy, no map
downloads, so it runs anywhere the import does. Plain lon/lat panels are
used on purpose: each pixel is one grid cell, which is what a cell-by-cell
comparison needs; this is a check, not a map for readers.

Currently handles the slice-directory input (one 2D grid per depth).
"""

import argparse
import gzip
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
import xarray as xr

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Labelled by geography only -- places to read a number off, not claims
# about what structure lies beneath them.
SPOT_POINTS = [
    ("central North America", -95.0, 38.0),
    ("northern India", 78.0, 25.0),
    ("central Pacific", -160.0, 0.0),
    ("western Europe", 5.0, 47.0),
    ("southern Africa", 25.0, -25.0),
]


def read_bytes(path):
    raw = path.read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def decoded_volume(model_dir, manifest, variable):
    res = next(r for r in manifest["resolutions"] if r["id"] == manifest["default_resolution"])
    rel = manifest["path_template"].format(
        variable=variable["id"], resolution=res["id"], frame=manifest["frames"][0]["id"])
    b = np.frombuffer(read_bytes(model_dir / rel), dtype=np.uint8)
    b = b.reshape(res["ndepth"], res["nlat"], res["nlon"]).astype(np.float64)
    lo, hi = variable["encode_min"], variable["encode_max"]
    vol = lo + b / 255.0 * (hi - lo)
    # docs/ARCHIVE_FORMAT.md sample positions (core/glsl/geographic.ts volumeUVW).
    lon = -180.0 + np.arange(res["nlon"]) * 360.0 / res["nlon"]
    lat = -90.0 + np.arange(res["nlat"]) * 180.0 / (res["nlat"] - 1)
    dmin, dmax = manifest["depth_min_km"], manifest["depth_max_km"]
    depth = dmin + np.arange(res["ndepth"]) * (dmax - dmin) / (res["ndepth"] - 1)
    return vol, lon, lat, depth, (hi - lo) / 255.0


def source_slices(config):
    """{depth_km: DataArray(lat, lon)} straight from the source files."""
    inp = config["input"]
    if "path" in inp:
        src = Path(inp["path"])
    else:
        from _inputs import fetch_zip_members
        src = fetch_zip_members(inp["zip_url"], inp["members"])
    rx = re.compile(config.get("depth_regex", r"_(\d+)\.(?:nc|grd)$"))
    var = config.get("slice_var")
    out = {}
    for f in sorted(src.iterdir()):
        m = rx.search(f.name)
        if m and f.suffix.lower() in (".nc", ".grd"):
            ds = xr.open_dataset(f)
            da = ds[var or list(ds.data_vars)[0]]
            lon_n = next(n for n in da.dims if n.lower().startswith("lon") or n == "x")
            lat_n = next(n for n in da.dims if n.lower().startswith("lat") or n == "y")
            da = da.rename({lon_n: "lon", lat_n: "lat"}).load()
            ds.close()
            # Put the source on -180..180 without interpolating: shift, drop the repeat.
            da = da.assign_coords(lon=((da.lon + 180.0) % 360.0) - 180.0)
            da = da.isel(lon=~da.lon.to_index().duplicated()).sortby("lon").sortby("lat")
            out[float(m.group(1))] = da
    return out


def coastline_lines(archive):
    """Present-day coastline polylines, as (lon, lat) arrays, from the Archive's
    own geometry.bin(.gz) -- layout in prep_coastlines.py's docstring, parsed
    the same way as core/coastlines.ts parseGeometry(): b"ESCL", u32 version
    (3), u32 n_lines, then per line i32 plate_id, f32 appear, f32 disappear,
    u32 n_points, u32 n_land, u32 n_tris, followed by n_points unit-sphere xyz
    float32 triples, n_land more, and n_tris u32 index triples."""
    idx = json.loads((archive / "archive.json").read_text())
    try:
        raw = read_bytes(archive / idx["coastlines"]["geometry"])
    except (KeyError, FileNotFoundError):
        return []
    if raw[:4] != b"ESCL" or struct.unpack_from("<I", raw, 4)[0] != 3:
        return []
    (n_lines,) = struct.unpack_from("<I", raw, 8)
    o, lines = 12, []
    for _ in range(n_lines):
        _, appear, disappear, n_pts, n_land, n_tris = struct.unpack_from("<iffIII", raw, o)
        o += 24
        xyz = np.frombuffer(raw, dtype="<f4", count=3 * n_pts, offset=o).reshape(n_pts, 3)
        o += 12 * (n_pts + n_land) + 12 * n_tris
        if appear >= 0 >= disappear:   # present at 0 Ma
            x, y, z = xyz.T.astype(np.float64)
            lines.append(np.column_stack([np.degrees(np.arctan2(y, x)),
                                          np.degrees(np.arcsin(np.clip(z, -1, 1)))]))
    return lines


def plot_coast(ax, lines):
    for ln in lines:
        lon = ln[:, 0].astype(float)
        # Break a line where it wraps the seam, so it is not drawn across the map.
        jumps = np.where(np.abs(np.diff(lon)) > 180)[0] + 1
        for seg in np.split(ln, jumps):
            ax.plot(seg[:, 0], seg[:, 1], color="k", lw=0.3)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--depths", type=float, nargs="+", default=[660.0, 1000.0, 2000.0])
    args = ap.parse_args()

    model_dir = args.archive / "models" / args.model
    manifest = json.loads((model_dir / "manifest.json").read_text())
    config = json.loads((model_dir / manifest.get("ingest_config", "ingest.json")).read_text())
    variable = manifest["variables"][0]
    vol, lon, lat, depth, step = decoded_volume(model_dir, manifest, variable)
    src = source_slices(config)
    lo, hi = variable["encode_min"], variable["encode_max"]
    units = variable.get("units", "")

    # --- gate, over every depth that has a source slice ---------------------
    gate_fail, per_depth = [], []
    clamped_total = cells_total = 0
    for k, d in enumerate(depth):
        s = src.get(round(float(d), 6)) if round(float(d), 6) in src else None
        if s is None:
            continue
        on_nodes = (np.allclose(s.lon.values, lon) and np.allclose(s.lat.values, lat))
        sv = s.values if on_nodes else s.interp(lon=lon, lat=lat).values
        inside = (sv >= lo) & (sv <= hi)
        err = vol[k] - sv
        clamped = int((~inside).sum())
        clamped_total += clamped
        cells_total += sv.size
        worst = float(np.abs(err[inside]).max()) if inside.any() else 0.0
        if on_nodes:
            bad = inside & ((err > 1e-6 * max(1, abs(hi))) | (err < -step * (1 + 1e-6)))
            if bad.any():
                gate_fail.append((float(d), int(bad.sum())))
        per_depth.append({"depth_km": float(d), "on_source_nodes": bool(on_nodes),
                          "max_abs_error_inside": worst, "clamped_cells": clamped,
                          "clamped_fraction": clamped / sv.size})

    # --- spot values ----------------------------------------------------------
    spots = []
    for name, plon, plat in SPOT_POINTS:
        for d in args.depths:
            k = int(np.argmin(np.abs(depth - d)))
            s = src.get(round(float(depth[k]), 6))
            i = int(np.argmin(np.abs(lon - plon)))
            j = int(np.argmin(np.abs(lat - plat)))
            sval = float(s.sel(lon=lon[i], lat=lat[j], method="nearest")) if s is not None else None
            spots.append({"place": name, "lon": float(lon[i]), "lat": float(lat[j]),
                          "depth_km": float(depth[k]), "source": sval,
                          "stored": float(vol[k, j, i])})

    # --- figure ---------------------------------------------------------------
    coast = coastline_lines(args.archive)
    rows = len(args.depths)
    fig = plt.figure(figsize=(16, 3.6 * rows + 6.5))
    gs = fig.add_gridspec(rows + 2, 3, height_ratios=[1] * rows + [0.9, 0.9])
    vmax = max(abs(lo), abs(hi))
    for r, d in enumerate(args.depths):
        k = int(np.argmin(np.abs(depth - d)))
        s = src.get(round(float(depth[k]), 6))
        sv = s.values if s is not None and np.allclose(s.lon.values, lon) else (
            s.interp(lon=lon, lat=lat).values if s is not None else np.full_like(vol[k], np.nan))
        clamped = (sv < lo) | (sv > hi)
        diff = np.ma.masked_where(clamped, vol[k] - sv)
        panels = [(sv, f"source, {depth[k]:.0f} km"),
                  (vol[k], f"stored in Archive (decoded), {depth[k]:.0f} km"),
                  (diff, f"stored - source (grey: clamped, {100 * clamped.mean():.2f}%)")]
        for c, (arr, title) in enumerate(panels):
            ax = fig.add_subplot(gs[r, c])
            if c < 2:
                im = ax.pcolormesh(lon, lat, arr, cmap="RdBu", vmin=-vmax, vmax=vmax,
                                   shading="nearest")
            else:
                # Scaled to the IN-RANGE error, which is what the gate is about;
                # clamped cells would otherwise set the scale and hide it.
                dv = max(step * 2, float(np.abs(diff).max()) if diff.count() else step)
                ax.pcolormesh(lon, lat, np.ma.masked_where(~clamped, np.ones_like(sv)),
                              cmap="Greys", vmin=0, vmax=2, shading="nearest")
                im = ax.pcolormesh(lon, lat, diff, cmap="PuOr", vmin=-dv, vmax=dv, shading="nearest")
            plot_coast(ax, coast)
            ax.set_xlim(-180, 180); ax.set_ylim(-90, 90); ax.set_aspect("equal")
            ax.set_title(title, fontsize=9)
            ax.tick_params(labelsize=7)
            fig.colorbar(im, ax=ax, shrink=0.8, label=units)

    ax = fig.add_subplot(gs[rows, :]); ax.axis("off")
    ax2 = fig.add_subplot(gs[rows + 1, :]); ax2.axis("off")
    ev = config.get("evidence", {})
    status = "PASS" if not gate_fail else f"FAIL at {gate_fail}"
    lines = [
        f"{manifest['name']}  ({args.model})   gate: {status}",
        f"source: {manifest['source'][:150]}",
        f"encode range [{lo:+.3f}, {hi:+.3f}] {units}; one stored level = {step:.4f} {units}; "
        f"clamped {100 * clamped_total / max(cells_total, 1):.2f}% of cells; "
        f"default display clip [{variable['default_clip_min']:+.3f}, {variable['default_clip_max']:+.3f}]",
        f"polarity: high_means = {variable.get('high_means')}; colormap {variable['default_colormap']}; "
        f"depths {manifest['depth_min_km']:.0f}-{manifest['depth_max_km']:.0f} km in "
        f"{len(depth)} levels; dropped levels: {config.get('result', {}).get('dropped_levels') or 'none'}",
    ] + [f"{k}: {v}" for k, v in ev.items()]
    ax.text(0, 1, "\n".join(_wrap(l) for l in lines), va="top", family="monospace", fontsize=7.5)
    spot_txt = "spot values (source -> stored):\n" + "\n".join(
        f"  {p['place']:22s} {p['lon']:7.1f} {p['lat']:6.1f} {p['depth_km']:6.0f} km  "
        f"{p['source']:+.3f} -> {p['stored']:+.3f}" for p in spots if p["source"] is not None)
    clamp_txt = "clamped by depth: " + ", ".join(
        f"{p['depth_km']:.0f} km {100 * p['clamped_fraction']:.1f}%"
        for p in per_depth if p["depth_km"] % 250 == 0)
    ax2.text(0, 1, _wrap(clamp_txt, 110), va="top", family="monospace", fontsize=7.5)
    ax2.text(0.62, 1, spot_txt, va="top", family="monospace", fontsize=7.5)

    out = model_dir / "verification"
    out.mkdir(exist_ok=True)
    fig.savefig(out / "card.png", dpi=110, bbox_inches="tight")
    (out / "card.json").write_text(json.dumps({
        "model": args.model, "gate": "pass" if not gate_fail else "fail",
        "gate_failures": gate_fail, "encode": [lo, hi], "stored_level": step,
        "clamped_fraction": clamped_total / max(cells_total, 1),
        "per_depth": per_depth, "spots": spots,
    }, indent=2))
    print(f"wrote {out / 'card.png'}  gate: {status}")
    print(f"  clamped {100 * clamped_total / max(cells_total, 1):.2f}% of cells; worst in-range "
          f"|error| {max((p['max_abs_error_inside'] for p in per_depth), default=0):.4f} {units} "
          f"(one level = {step:.4f})")
    sys.exit(1 if gate_fail else 0)


def _wrap(s, width=175):
    out, line = [], ""
    for word in s.split(" "):
        if len(line) + len(word) + 1 > width:
            out.append(line); line = "    " + word
        else:
            line = f"{line} {word}" if line else word
    return "\n".join(out + [line])


if __name__ == "__main__":
    main()
