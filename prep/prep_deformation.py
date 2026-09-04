#!/usr/bin/env python3
"""Convert one `defamation` pipeline run into two Geode models.

See docs/plans/deformation-viewer.md for the design this implements.

  <id>-deformation    time-varying: the 8 strain/style variables from
                      deformation_grids/deformation_{T}Ma.nc, plus thickness
                      from thickness_grids/thickness_{T}Ma.nc -- same grid,
                      same frame series, so thickness rides along as one more
                      Variable (the LANDFRAC-in-climate-540myr precedent).
  <id>-age-heatflux   static, present-day only: tectonothermal_age,
                      subduction_age, composite_age, subduction_dist_min
                      (from tectonothermal_age/*.nc), and heat_flux
                      restricted to nominal/ensemble_mean/ensemble_range.

Both keep the run's native 0.5 deg grid (721x361) rather than resampling to
Geode's usual 360x181 -- see the plan doc for the measured archive-size
argument (~23 MB gzipped for the whole time-varying model, because the
fields are ~92% no-data and compress accordingly).

NaN handling differs from prep_model.py on purpose. That script fills NaN by
nearest-neighbour because its no-data is a thin edge case (a trimmed depth
shell); here no-data is ~92% of the grid and IS the point being shown (a
Deformation zone is a small fraction of the globe by construction). Real
values are quantised into bytes 0..254; byte 255 is reserved as NO_DATA and
never produced by real data, because clip and categorical band-centre maths
are chosen so the top of their range clamps to 254, not 255. Manifests carry
`"no_data_sentinel": 255` so the viewer knows to treat that byte specially
(ADR-0005) rather than colour-ramp it like every other model.

Percentile clips are computed by POOLING across every requested Frame, not
per-frame -- this project has been burned by per-frame percentile clipping
before (see prep_paleogeography.py's hillshade fix): it makes intensity
incomparable age to age, which is exactly what a time-scrubbed viewer must
not do.

Example
-------
    python prep_deformation.py \\
        --run-dir /Users/simon/GIT/defamation/output/Muller2019_deformation_pipeline \\
        --id muller2019 --name "Muller 2019 Deformation" \\
        --source "Muller et al. 2019 Tectonics; defamation pipeline" \\
        --age-min 0 --age-max 240 --validate
"""

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr
import yaml

NO_DATA = 255           # reserved; never produced by real data (see below)
CLIP_PERCENTILE = 99.5


def sig(x, n=6):
    """Round to N significant figures, not N decimal places.

    round(x, 6) on a strain rate (~1e-14 s^-1) rounds straight to 0.0 --
    caught by a boot-time smoke test that read the manifest back and found
    every diverging strain variable's clip range collapsed to [0, 0],
    which then divides by zero in physicalToEncoded() and blanks the whole
    ramp. round()'s decimal-places semantics only make sense for values that
    are already order-1; every value stored in a manifest here can be
    anywhere from 1e-14 (a strain rate) to 1e3 (a subduction distance).
    """
    if x == 0 or not np.isfinite(x):
        return float(x)
    return float(f"{x:.{n}g}")


def find_reconstruction_model(run_dir):
    """The reconstruction this run actually used, per its OWN copied config
    (run_pipeline.py writes the exact settings used into output_dir -- see
    the module docstring of run_pipeline.py). Read from the run, never
    assumed from --id or the run directory's name: those are labels a
    caller chose by hand and can drift from what the pipeline actually
    reconstructed against, which is exactly the failure mode this manifest
    field exists to close off -- the viewer must show whichever coastlines
    this value names, not whichever the caller happened to wire up.
    """
    configs = sorted(run_dir.glob("*.yaml")) + sorted(run_dir.glob("*.yml"))
    if len(configs) != 1:
        raise SystemExit(
            f"expected exactly one config yaml in {run_dir}, found "
            f"{len(configs)}: {configs}")
    cfg = yaml.safe_load(configs[0].read_text())
    fetch = (cfg.get("model") or {}).get("fetch")
    if not fetch:
        raise SystemExit(f"{configs[0]} has no model.fetch")
    return fetch

# (source_var, id, display name, diverging, high_means, units)
DEFORMATION_VARS = [
    ("horizontal_divergence", "horizontal_divergence", "Horizontal Divergence",
     True, "extension", "s^-1"),
    ("volumetric_strain", "volumetric_strain", "Volumetric Strain Rate",
     True, "extension", "s^-1"),
    ("max_principal_strain", "max_principal_strain", "Max Principal Strain Rate",
     True, "extension", "s^-1"),
    ("min_principal_strain", "min_principal_strain", "Min Principal Strain Rate",
     True, "extension", "s^-1"),
    ("effective_strain_rate", "effective_strain_rate", "Effective Strain Rate",
     False, None, "s^-1"),
    ("shear_strain", "shear_strain", "Maximum Shear Strain Rate",
     False, None, "s^-1"),
    ("obliquity", "obliquity", "Deformation Obliquity",
     False, None, "degrees"),
]

# Order MUST match prep_colormaps.py's DEFORMATION_STYLE_COLORS.
# Source flag_values are 0..9 for the ten real styles, -1 for "undefined".
DEFORMATION_STYLE_CLASSES = [
    "negligible", "pure_extension", "pure_compression", "simple_shear",
    "transpression", "transtension", "pure_shear", "strike_slip",
    "extension_dominated", "compression_dominated", "undefined",
]
N_STYLE_CLASSES = len(DEFORMATION_STYLE_CLASSES)  # 11
STYLE_SOURCE_TO_CLASS = {i: i for i in range(10)}
STYLE_SOURCE_TO_CLASS[-1] = 10  # undefined -> last class

HEAT_FLUX_SCENARIOS = [
    ("nominal", "Heat Flux (nominal)"),
    ("ensemble_mean", "Heat Flux (ensemble mean)"),
    ("ensemble_range", "Heat Flux (ensemble range)"),
]


# ---------------------------------------------------------------------------
# Grid handling -- the run's native grid already matches Geode's convention
# (lon/lat ascending, -90..90) except for the duplicate +/-180 seam column
# every prep_model.py-ingested model also has to drop.
# ---------------------------------------------------------------------------


def load_grid(ds, varname):
    da = ds[varname]
    lon = np.asarray(ds["lon"].values, dtype=np.float64)
    lat = np.asarray(ds["lat"].values, dtype=np.float64)
    data = np.asarray(da.transpose("lat", "lon").values, dtype=np.float64)
    if lat[0] > lat[-1]:
        lat, data = lat[::-1], data[::-1, :]
    if len(lon) > 1 and abs((lon[-1] - lon[0]) - 360.0) < 1e-6:
        data, lon = data[:, :-1], lon[:-1]
    return data, lon, lat


def check_grid(lon, lat, nlon, nlat):
    assert lon.shape == (nlon,), f"unexpected lon shape {lon.shape}"
    assert lat.shape == (nlat,), f"unexpected lat shape {lat.shape}"


# ---------------------------------------------------------------------------
# Encoding.  Byte 255 is NO_DATA; real data is clamped to 0..254 so the two
# never collide, without changing the decode formula (byte/255*(hi-lo)+lo)
# every existing model already uses.
# ---------------------------------------------------------------------------


def encode_continuous(values, lo, hi):
    # NaN is overwritten by NO_DATA below regardless of what it scales to
    # here; nan_to_num first just avoids an "invalid value in cast" warning
    # on the intermediate NaN -> uint8 conversion.
    safe = np.nan_to_num(values, nan=lo)
    scaled = np.clip((safe - lo) / (hi - lo), 0.0, 1.0)
    byte = np.minimum(254, np.round(scaled * 255.0)).astype(np.uint8)
    return np.where(np.isfinite(values), byte, NO_DATA)


def pooled_clip(frame_values, diverging, percentile):
    """frame_values: list of per-frame float arrays for one variable."""
    finite = np.concatenate([v[np.isfinite(v)] for v in frame_values])
    if finite.size == 0:
        raise SystemExit("every frame is entirely NaN for this variable")
    if diverging:
        m = float(np.percentile(np.abs(finite), percentile))
        return -m, m
    return (float(np.percentile(finite, 100 - percentile)),
            float(np.percentile(finite, percentile)))


def encode_style(raw):
    """raw: float array of source flag values (-1..9), NaN outside any zone."""
    remapped = np.full(raw.shape, np.nan, dtype=np.float64)
    valid = np.isfinite(raw)
    rounded = np.round(raw[valid]).astype(int)
    dst = np.vectorize(STYLE_SOURCE_TO_CLASS.get)(rounded)
    remapped[valid] = dst
    band_centre = np.nan_to_num(remapped, nan=0.0) + 0.5
    scaled = np.clip(band_centre / N_STYLE_CLASSES, 0.0, 1.0)
    byte = np.minimum(254, np.round(scaled * 255.0)).astype(np.uint8)
    return np.where(np.isfinite(remapped), byte, NO_DATA)


def choose_colormap(base, high_means, archive):
    """As prep_model.py's, extended with 'extension' (also warm at high --
    positive horizontal divergence is extension, the CONTEXT.md convention),
    since prep_model.py's own version only knows 'fast'/'hot'."""
    want = {"fast": "cool", "hot": "warm", "extension": "warm"}[high_means]
    path = archive / "colormaps.json"
    maps = json.loads(path.read_text())
    if base in maps and maps[base].get("high_end") == want:
        return base
    for name, entry in maps.items():
        if entry.get("high_end") == want and name.startswith(base):
            return name
    raise SystemExit(f"no diverging colormap based on {base!r} has high_end={want!r}")


def write_frame_bin(model_dir, resolution_id, variable_id, frame_id, byte_arr):
    d = model_dir / "frames" / variable_id / resolution_id
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{frame_id}.bin"
    byte_arr.tofile(path)
    return path


# ---------------------------------------------------------------------------
# The time-varying Deformation model
# ---------------------------------------------------------------------------


def build_deformation_model(run_dir, out, model_id, name, source,
                             age_min, age_max, age_step, resolution_id,
                             reconstruction_model, validate):
    model_dir = out / "models" / f"{model_id}-deformation"
    ages = list(range(age_min, age_max + 1, age_step))
    frames_meta = [{"id": str(t), "age_ma": t} for t in ages]

    def_dir = run_dir / "deformation_grids"
    thick_dir = run_dir / "thickness_grids"

    nlon = nlat = None
    variables_meta = []

    # --- pass 1: pool every frame's finite values per variable, to pick ONE
    # clip range used for every frame (see module docstring). ---
    print("=== pass 1/2: pooling percentiles across all frames ===")
    pooled = {vid: [] for _, vid, *_ in DEFORMATION_VARS}
    pooled["thickness"] = []
    for t in ages:
        ds = xr.open_dataset(def_dir / f"deformation_{t}Ma.nc")
        for source_var, vid, *_ in DEFORMATION_VARS:
            data, lon, lat = load_grid(ds, source_var)
            if nlon is None:
                nlon, nlat = len(lon), len(lat)
                check_grid(lon, lat, nlon, nlat)
            pooled[vid].append(data)
        ds.close()
        th = xr.open_dataset(thick_dir / f"thickness_{t}Ma.nc")
        data, lon, lat = load_grid(th, "thickness")
        pooled["thickness"].append(data)
        th.close()

    clips = {}
    for source_var, vid, vname, diverging, high_means, units in DEFORMATION_VARS:
        lo, hi = pooled_clip(pooled[vid], diverging, CLIP_PERCENTILE)
        clips[vid] = (lo, hi)
        print(f"  {vid:24s} clip [{lo:+.4g}, {hi:+.4g}] {units}  "
              f"(diverging={diverging})")
    th_lo, th_hi = pooled_clip(pooled["thickness"], False, CLIP_PERCENTILE)
    clips["thickness"] = (th_lo, th_hi)
    print(f"  {'thickness':24s} clip [{th_lo:.4g}, {th_hi:.4g}] km")
    del pooled  # done with the pooled arrays

    # --- pass 2: encode every frame against the pooled clip. ---
    print("\n=== pass 2/2: encoding frames ===")
    for source_var, vid, vname, diverging, high_means, units in DEFORMATION_VARS:
        lo, hi = clips[vid]
        total_bytes = 0
        for t in ages:
            ds = xr.open_dataset(def_dir / f"deformation_{t}Ma.nc")
            data, lon, lat = load_grid(ds, source_var)
            ds.close()
            byte = encode_continuous(data, lo, hi)
            p = write_frame_bin(model_dir, resolution_id, vid, str(t), byte)
            total_bytes += p.stat().st_size
        colormap = choose_colormap("RdBu", high_means, out) if diverging else "viridis"
        print(f"  {vid:24s} {len(ages)} frames, {total_bytes / 1e6:6.1f} MB, "
              f"colormap={colormap}")
        variables_meta.append({
            "id": vid, "name": vname, "source_var": source_var,
            "units": units, "diverging": diverging,
            **({"high_means": high_means} if high_means else {}),
            "encode_min": sig(lo), "encode_max": sig(hi),
            "default_clip_min": sig(lo), "default_clip_max": sig(hi),
            "default_colormap": colormap,
        })

    # deformation_style: categorical, its own encode path
    total_bytes = 0
    for t in ages:
        ds = xr.open_dataset(def_dir / f"deformation_{t}Ma.nc")
        raw, lon, lat = load_grid(ds, "deformation_style")
        ds.close()
        byte = encode_style(raw)
        p = write_frame_bin(model_dir, resolution_id, "deformation_style", str(t), byte)
        total_bytes += p.stat().st_size
    print(f"  {'deformation_style':24s} {len(ages)} frames, {total_bytes / 1e6:6.1f} MB, "
          f"colormap=deformation_style (categorical)")
    variables_meta.append({
        "id": "deformation_style", "name": "Dominant Deformation Style",
        "source_var": "deformation_style", "units": "class", "diverging": False,
        "categorical": True, "class_names": DEFORMATION_STYLE_CLASSES,
        "encode_min": 0.0, "encode_max": float(N_STYLE_CLASSES),
        "default_clip_min": 0.0, "default_clip_max": float(N_STYLE_CLASSES),
        "default_colormap": "deformation_style",
    })

    # thickness rides the same frame series (LANDFRAC-in-climate precedent)
    lo, hi = clips["thickness"]
    total_bytes = 0
    for t in ages:
        th = xr.open_dataset(thick_dir / f"thickness_{t}Ma.nc")
        data, lon, lat = load_grid(th, "thickness")
        th.close()
        byte = encode_continuous(data, lo, hi)
        p = write_frame_bin(model_dir, resolution_id, "thickness", str(t), byte)
        total_bytes += p.stat().st_size
    print(f"  {'thickness':24s} {len(ages)} frames, {total_bytes / 1e6:6.1f} MB, "
          f"colormap=viridis")
    variables_meta.append({
        "id": "thickness", "name": "Crustal Thickness", "source_var": "thickness",
        "units": "km", "diverging": False,
        "encode_min": sig(lo), "encode_max": sig(hi),
        "default_clip_min": sig(lo), "default_clip_max": sig(hi),
        "default_colormap": "viridis",
    })

    manifest = {
        "id": f"{model_id}-deformation",
        "name": f"{name} (deformation)",
        "type": "convection",
        "source": source,
        "reconstruction_model": reconstruction_model,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": 0.0, "depth_max_km": 1.0,  # placeholder; no layer axis
        "dtype": "uint8",
        "no_data_sentinel": NO_DATA,
        "default_resolution": resolution_id,
        "resolutions": [{"id": resolution_id, "nlon": nlon, "nlat": nlat, "ndepth": 1}],
        "frames": frames_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "horizontal_divergence",
        "variables": variables_meta,
    }
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")

    if validate:
        mid_t = ages[len(ages) // 2]
        back = np.fromfile(
            model_dir / "frames" / "horizontal_divergence" / resolution_id / f"{mid_t}.bin",
            dtype=np.uint8)
        assert back.size == nlon * nlat, "size mismatch"
        no_data_frac = float((back == NO_DATA).mean())
        print(f"  validate    {mid_t} Ma horizontal_divergence: "
              f"{back.size} bytes, {100 * no_data_frac:.1f}% no-data "
              f"(expect roughly 90%+)")

    return manifest


# ---------------------------------------------------------------------------
# The static Age & Heat Flux model
# ---------------------------------------------------------------------------


def build_age_heatflux_model(run_dir, out, model_id, name, source,
                              resolution_id, reconstruction_model, validate):
    model_dir = out / "models" / f"{model_id}-age-heatflux"
    age_dir = run_dir / "tectonothermal_age"
    hf_dir = run_dir / "heat_flux"

    # Find the *_tectonothermal_age.nc / *_composite_tectonothermal_age.nc
    # by suffix rather than assuming model_name -- RunOutputs prefixes both
    # with the run's own model name, which this script does not otherwise need.
    age_files = sorted(age_dir.glob("*_tectonothermal_age.nc"))
    composite_files = sorted(age_dir.glob("*_composite_tectonothermal_age.nc"))
    if not age_files or not composite_files:
        raise SystemExit(f"expected tectonothermal age files under {age_dir}")

    nlon = nlat = None
    variables_meta = []
    age_sources = [
        (age_files[0], "tectonothermal_age", "tectonothermal_age",
         "Tectonothermal Age", "Ma"),
        (composite_files[0], "subduction_age", "subduction_age",
         "Subduction-based Tectonothermal Age", "Ma"),
        (composite_files[0], "composite_age", "composite_age",
         "Composite Tectonothermal Age", "Ma"),
        (composite_files[0], "subduction_dist_min", "subduction_dist_min",
         "Minimum Distance to Subduction Zone", "km"),
    ]

    for path, source_var, vid, vname, units in age_sources:
        ds = xr.open_dataset(path)
        data, lon, lat = load_grid(ds, source_var)
        ds.close()
        if nlon is None:
            nlon, nlat = len(lon), len(lat)
        lo, hi = pooled_clip([data], False, CLIP_PERCENTILE)
        byte = encode_continuous(data, lo, hi)
        p = write_frame_bin(model_dir, resolution_id, vid, "0", byte)
        print(f"  {vid:24s} clip [{lo:.4g}, {hi:.4g}] {units}  "
              f"{p.stat().st_size / 1e3:.1f} KB")
        variables_meta.append({
            "id": vid, "name": vname, "source_var": source_var, "units": units,
            "diverging": False,
            "encode_min": sig(lo), "encode_max": sig(hi),
            "default_clip_min": sig(lo), "default_clip_max": sig(hi),
            "default_colormap": "magma",
        })

    for scenario, vname in HEAT_FLUX_SCENARIOS:
        path = hf_dir / f"heat_flux_{scenario}.nc"
        if not path.exists():
            raise SystemExit(f"missing {path}")
        ds = xr.open_dataset(path)
        data, lon, lat = load_grid(ds, "heat_flux")
        ds.close()
        lo, hi = pooled_clip([data], False, CLIP_PERCENTILE)
        byte = encode_continuous(data, lo, hi)
        vid = f"heat_flux_{scenario}"
        p = write_frame_bin(model_dir, resolution_id, vid, "0", byte)
        print(f"  {vid:24s} clip [{lo:.4g}, {hi:.4g}] mW/m^2  "
              f"{p.stat().st_size / 1e3:.1f} KB")
        variables_meta.append({
            "id": vid, "name": vname, "source_var": "heat_flux", "units": "mW m-2",
            "diverging": False,
            "encode_min": sig(lo), "encode_max": sig(hi),
            "default_clip_min": sig(lo), "default_clip_max": sig(hi),
            "default_colormap": "magma",
        })

    manifest = {
        "id": f"{model_id}-age-heatflux",
        "name": f"{name} (age & heat flux)",
        "type": "tomography",  # single Frame, exactly the mantle viewer's
                                # mechanism for keeping Reconstruction Age
                                # meaningful while the data itself is static
        "source": source,
        "reconstruction_model": reconstruction_model,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": 0.0, "depth_max_km": 1.0,
        "dtype": "uint8",
        "no_data_sentinel": NO_DATA,
        "default_resolution": resolution_id,
        "resolutions": [{"id": resolution_id, "nlon": nlon, "nlat": nlat, "ndepth": 1}],
        "frames": [{"id": "0", "age_ma": 0}],
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "composite_age",
        "variables": variables_meta,
    }
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")

    if validate:
        back = np.fromfile(
            model_dir / "frames" / "composite_age" / resolution_id / "0.bin",
            dtype=np.uint8)
        assert back.size == nlon * nlat
        print(f"  validate    composite_age: {back.size} bytes, "
              f"{100 * float((back == NO_DATA).mean()):.1f}% no-data")

    return manifest


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-dir", type=Path, required=True,
                     help="a defamation pipeline run's output_dir")
    ap.add_argument("--id", required=True, help="model id prefix, e.g. muller2019")
    ap.add_argument("--name", required=True, help="display name, e.g. 'Muller 2019 Deformation'")
    ap.add_argument("--source", default="")
    ap.add_argument("--age-min", type=int, default=0)
    ap.add_argument("--age-max", type=int, default=240)
    ap.add_argument("--age-step", type=int, default=1)
    ap.add_argument("--resolution-id", default="native")
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--skip-deformation", action="store_true")
    ap.add_argument("--skip-age-heatflux", action="store_true")
    args = ap.parse_args()

    reconstruction_model = find_reconstruction_model(args.run_dir)
    print(f"reconstruction model (from {args.run_dir}'s own config): {reconstruction_model}")

    if not args.skip_deformation:
        print(f"\n{'=' * 70}\n{args.id}-deformation\n{'=' * 70}")
        build_deformation_model(
            args.run_dir, args.out, args.id, args.name, args.source,
            args.age_min, args.age_max, args.age_step, args.resolution_id,
            reconstruction_model, args.validate)

    if not args.skip_age_heatflux:
        print(f"\n{'=' * 70}\n{args.id}-age-heatflux\n{'=' * 70}")
        build_age_heatflux_model(
            args.run_dir, args.out, args.id, args.name, args.source,
            args.resolution_id, reconstruction_model, args.validate)


if __name__ == "__main__":
    main()
