#!/usr/bin/env python3
"""Convert the Li et al. 2022 paleoclimate simulation set into the viewer format.

Phase 2: real monthly resolution, four variables. The volume's third axis is
month (ndepth=12, depth_min_km=0, depth_max_km=11) rather than the Phase 1
placeholder (ndepth=1) -- the same generic "layer axis" the manifest format
always supported, just finally carrying real data. DepthSlice.setDepthKm(0..11)
now selects a calendar month instead of landing on the single Phase 1 layer.

Source: 55 CESM1.2.2 snapshot simulations, one every 10 Myr from 0-540 Ma.
T, P, SALB, U, V carry real (month, lat, lon) resolution; LANDFRAC is
(lat, lon) only -- CESM does not simulate a seasonal land/ocean mask -- and
is broadcast to every layer so every variable in this manifest shares one
grid shape (see the Phase 2 plan for why: a per-variable ndepth would need
core/volume.ts to stop reading grid shape from manifest.default_resolution,
a real change to shared engine code, to save ~40 MB raw against a site
nowhere near its 1 GB Pages cap).

Phase 3 adds U/V (1000 hPa zonal/meridional wind): they ride the same
percentile-clip / uint8-encode pipeline as every other variable here, marked
`vector_only` so the viewer's variable picker skips them -- they back
core/windGlyphs.ts's arrow field, not a colour-mapped display of their own.
See `vector_fields` in the manifest below for how the U/V pairing is
declared as data.

Phase 4 adds three more layers, all derived rather than pulled straight from
the source:

  - An "Annual" 13th layer on the existing month axis (LAYER index N_MONTHS,
    see add_annual_layer()) -- the mean of the 12 real months for T/P/SALB/
    U/V, the same static value again for LANDFRAC. Chosen as a 13th layer on
    the SAME axis, not a separate control, because every variable here
    already shares one generic "layer" slot (see above) and this is exactly
    what it was designed to carry.
  - T_RANGE ("seasonality"/continentality): warmest-month-mean minus
    coldest-month-mean temperature, per age -- a genuinely new field, not
    reachable by scrubbing the month slider.
  - KOPPEN: a 13-class simplified Koppen-Geiger classification (matching
    Pohl et al. 2022 Table 3, not the fuller ~30-subtype Peel, Finlayson &
    McMahon 2007 taxonomy), ported from a working reference implementation
    at /Users/simon/GIT/albedo/notebooks/albedo.ipynb's make_koppen_grid()
    -- see compute_koppen()'s own docstring for a bug that reference had and
    the fix applied here before trusting it.

Longitude arrives as 0..358.75 (0-360 convention) and must be normalised to
the -180..180 grid the viewer's shaders assume -- get this wrong and every
field is offset from the coastline overlay by a fixed longitude shift that
looks entirely plausible until you check a landmark.

Output:

    archive/models/<id>/manifest.json
    archive/models/<id>/frames/<variable>/<resolution>/<age_ma:03d>.bin

Example
-------
    /Users/simon/anaconda3/envs/pygmt17/bin/python prep_climate.py \\
        --input "/Users/simon/Library/CloudStorage/OneDrive-UniversityofTasmania/Work/Climate/High_Resolution_Climate_Simulation_Dataset_540_Myr.nc" \\
        --id climate-540myr --name "Li et al. 2022 Paleoclimate" --validate
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xarray as xr

from prep_model import (
    DEFAULT_NLAT,
    DEFAULT_NLON,
    choose_clip,
    choose_colormap,
    drop_duplicate_seam,
    encode_uint8,
    lateral_roughness,
    normalise_longitude,
    resample_horizontal,
)

N_MONTHS = 12  # the real calendar months in the source -- see add_annual_layer()
N_LAYERS = N_MONTHS + 1  # + the derived "Annual" layer, index N_MONTHS
ANNUAL_LAYER = N_MONTHS
# The layer axis spans the WHOLE grid.z range 0..N_LAYERS-1: see volumeUVW()
# in viewer/src/core/glsl/geographic.ts, which maps depth_min_km/depth_max_km
# onto texel centres via (p*(grid.z-1)+0.5)/grid.z. depth_min=0, depth_max=
# N_LAYERS-1 with ndepth=N_LAYERS lands layer index i exactly on its own
# texel, for any i -- real months 0-11 and the Annual layer (12) alike.
LAYER_MIN_KM = 0.0
LAYER_MAX_KM = float(N_LAYERS - 1)

DEFAULT_CLIP_PERCENTILE = 99.5

# 0-indexed (month 0 = January -- checked directly against the .nc file's
# own 'month' coordinate comment, 'From January to December'). This is the
# fix for a real bug found in the reference implementation
# (/Users/simon/GIT/albedo/notebooks/albedo.ipynb's make_koppen_grid()),
# which wrote these as 1-indexed (Jan=1..Dec=12) but tested them against the
# same 0-indexed coordinate -- see compute_koppen()'s docstring.
NH_SUMMER_MONTHS = [3, 4, 5, 6, 7, 8]      # Apr-Sep
SH_SUMMER_MONTHS = [0, 1, 2, 9, 10, 11]    # Jan-Mar, Oct-Dec

# Index 0 = Ocean (LANDFRAC < 0.5), matching the "Ocean, assumed" entry the
# reference implementation's own koppen_albedo table already carries;
# 1-13 = the 13 land classes, ordered to match compute_koppen()'s class list.
KOPPEN_CLASS_NAMES = [
    "Ocean",
    "Tundra (ET)", "Frost (EF)",
    "Cold, dry winter (Dw)", "Cold, dry summer (Ds)", "Cold, no dry season (Df)",
    "Temperate, dry winter (Cw)", "Temperate, dry summer (Cs)",
    "Temperate, no dry season (Cf)",
    "Desert (BW)", "Steppe (BS)",
    "Savannah (Aw)", "Monsoon (Am)", "Fully humid (Af)",
]
N_KOPPEN_CLASSES = len(KOPPEN_CLASS_NAMES)


@dataclass
class VarSpec:
    source_var: str
    var_id: str
    display_name: str
    monthly: bool
    units: str
    diverging: bool
    high_means: str | None = None
    fixed_range: tuple[float, float] | None = None  # None => percentile clip
    colormap: str = "viridis"
    # True for a variable that only backs a render layer (here: the wind
    # glyph field) rather than being offered as a primary display choice --
    # same idea as prep_paleogeography.py's overlay_only, see VariableInfo
    # in core/types.ts. colormap is irrelevant for these (never colour-mapped)
    # so it's left at an arbitrary valid value rather than adding a branch
    # that skips choose_colormap for them.
    vector_only: bool = False


VARIABLES = [
    VarSpec("T", "T", "Surface temperature", True, "°C",
            diverging=True, high_means="hot", fixed_range=(-70.0, 65.0), colormap="RdBu"),
    VarSpec("P", "P", "Precipitation", True, "mm/month",
            diverging=False, fixed_range=None, colormap="viridis"),
    VarSpec("SALB", "SALB", "Surface albedo", True, "fraction",
            diverging=False, fixed_range=(0.0, 1.0), colormap="magma"),
    VarSpec("LANDFRAC", "LANDFRAC", "Land fraction", False, "fraction",
            diverging=False, fixed_range=(0.0, 1.0), colormap="cividis"),
    VarSpec("U", "U", "Zonal wind (1000 hPa)", True, "m/s",
            diverging=False, fixed_range=None, colormap="gray", vector_only=True),
    VarSpec("V", "V", "Meridional wind (1000 hPa)", True, "m/s",
            diverging=False, fixed_range=None, colormap="gray", vector_only=True),
]


def load_and_condition(ds, spec: VarSpec, nlon: int, nlat: int):
    """Return (vol[age, N_MONTHS, nlat, nlon] float32, lon2, lat2, raw_min, raw_max).

    Always the 12 REAL months (or that many broadcast copies of a static
    field) -- the Annual 13th layer is added afterwards by
    add_annual_layer(), once, on whichever array is actually going to be
    encoded; T_RANGE and KOPPEN need these 12-layer physical arrays
    untouched by that (see main()).

    normalise_longitude/drop_duplicate_seam/resample_horizontal only touch the
    trailing (lat, lon) axes, so a monthly variable's (age, month) leading axes
    are flattened into one axis before calling them and restored after -- this
    runs all 55*12 = 660 slices through the identical resampling path in one
    call, guaranteeing every age and month lands on the same target grid.
    """
    da = ds[spec.source_var]
    lat = np.asarray(ds["lat"].values, dtype=np.float64)
    lon = np.asarray(ds["lon"].values, dtype=np.float64)
    if lat[0] > lat[-1]:
        raise SystemExit("expected ascending latitude -- source grid changed")

    n_age = da.sizes["simulation"]
    if spec.monthly:
        flat = da.values.astype(np.float32).reshape(n_age * N_MONTHS, *da.shape[-2:])
    else:
        flat = da.values.astype(np.float32)  # (age, lat, lon)

    raw_min = float(np.nanmin(flat))
    raw_max = float(np.nanmax(flat))

    flat, lon2 = normalise_longitude(flat, lon)
    flat, lon2 = drop_duplicate_seam(flat, lon2)
    # len(lon2) == nlon would false-positive on resample_horizontal's count-only
    # fast path if the native grid happened to match -- it doesn't here (288x192
    # native vs 360x181 target), so the real interpolation branch always runs.
    flat, lon2, lat2 = resample_horizontal(flat, lon2, lat, nlon, nlat)

    if spec.monthly:
        vol = flat.reshape(n_age, N_MONTHS, nlat, nlon)
    else:
        # No month axis in the source -- broadcast each age's single field to
        # all N_MONTHS layers so this variable shares the manifest's one grid
        # shape with the monthly variables (see module docstring).
        vol = np.repeat(flat[:, np.newaxis, :, :], N_MONTHS, axis=1)

    return vol, lon2, lat2, raw_min, raw_max


def add_annual_layer(vol, monthly: bool):
    """(age, N_MONTHS, nlat, nlon) -> (age, N_LAYERS, nlat, nlon), appending
    the Annual layer at index N_MONTHS: the real mean of the 12 months for
    monthly data, or an exact copy (not a recomputed mean -- avoids
    introducing float noise into an already-uniform field) for broadcast
    static data, where every month is already identical.
    """
    annual = vol.mean(axis=1, keepdims=True) if monthly else vol[:, :1, :, :]
    return np.concatenate([vol, annual], axis=1)


def broadcast_static(field2d, n_layers: int):
    """(age, nlat, nlon) -> (age, n_layers, nlat, nlon), the same per-age
    value repeated across every layer -- for a field with no month axis of
    its own (T_RANGE, KOPPEN), the same pattern LANDFRAC already uses.
    """
    return np.repeat(field2d[:, np.newaxis, :, :], n_layers, axis=1)


def compute_seasonality_range(t_phys):
    """t_phys: (age, N_MONTHS, nlat, nlon) physical degC -> (age, nlat, nlon).

    Warmest-month-mean minus coldest-month-mean temperature at each grid
    cell -- "continentality" in the paleoclimate/biogeography literature.
    """
    return t_phys.max(axis=1) - t_phys.min(axis=1)


def compute_koppen(t_phys, p_phys, landfrac2d, lat2):
    """t_phys, p_phys: (age, N_MONTHS, nlat, nlon) physical (degC, mm/month).
    landfrac2d: (age, nlat, nlon) fraction. lat2: (nlat,) degrees.

    Returns (age, nlat, nlon) uint8 class index -- 0 = Ocean, 1-13 = the 13
    classes in KOPPEN_CLASS_NAMES[1:], the simplified Koppen-Geiger scheme
    (Pohl et al. 2022 Table 3), ported from a working reference
    implementation at
    /Users/simon/GIT/albedo/notebooks/albedo.ipynb's make_koppen_grid().

    Two differences from that reference, both deliberate:

    1. **The reference had a real bug**, found and fixed here rather than
       carried over: its summer/winter month lists
       (`sh_summer = [1,2,3,10,11,12]`, `nh_summer = [4,5,6,7,8,9]`) are
       written as 1-indexed (Jan=1..Dec=12), but were tested against the
       source's actual 0-indexed `month` coordinate (Jan=0..Dec=11 --
       checked directly against the .nc file's own comment, 'From January
       to December'). Confirmed empirically against the real coordinate:
       `sh_summer` as written selects {Feb,Mar,Apr,Nov,Dec} (`12` never
       matches a valid 0-11 index, so it's short a month too) instead of the
       intended {Jan,Feb,Mar,Oct,Nov,Dec}; `nh_summer` selects {May..Oct}
       instead of the intended {Apr..Sep}. Both windows shifted a month
       late. NH_SUMMER_MONTHS/SH_SUMMER_MONTHS above are the corrected,
       0-indexed versions.
    2. **Land mask uses LANDFRAC >= 0.5**, not the reference's exact
       `LANDFRAC == 1` -- our LANDFRAC is a resampled fraction (see
       prep_model.resample_horizontal), so exact equality would leave
       partial coastal cells inconsistently classified rather than cleanly
       assigned to land or ocean.

    The aridity threshold (`P_thresh = 2*MAT + 14`) always uses the
    "aseasonal" constant rather than the fuller Koppen standard's 70%-rule
    adjustment for summer/winter-concentrated precipitation (+28/+0/+14) --
    kept as the reference implementation has it, since that is what the
    cited Table 3 scheme actually specifies, not the fuller Peel, Finlayson
    & McMahon (2007) taxonomy this is deliberately a simplification of.
    """
    n_months = t_phys.shape[1]
    nh_summer_1d = np.zeros(n_months, dtype=bool)
    nh_summer_1d[NH_SUMMER_MONTHS] = True
    sh_summer_1d = np.zeros(n_months, dtype=bool)
    sh_summer_1d[SH_SUMMER_MONTHS] = True

    is_nh = (lat2 >= 0)[None, None, :, None]  # (1, 1, nlat, 1)
    summer_mask = np.where(
        is_nh,
        nh_summer_1d[None, :, None, None],
        sh_summer_1d[None, :, None, None],
    )
    summer_mask = np.broadcast_to(summer_mask, t_phys.shape)
    winter_mask = ~summer_mask

    T_cold = t_phys.min(axis=1)
    T_hot = t_phys.max(axis=1)
    MAT = t_phys.mean(axis=1)
    MAP = p_phys.sum(axis=1)  # total annual precip -- a SUM, not the mean
    # the UI's "Annual" P layer uses (see add_annual_layer()); kept separate.
    P_dry = p_phys.min(axis=1)

    p_summer = np.where(summer_mask, p_phys, np.nan)
    p_winter = np.where(winter_mask, p_phys, np.nan)
    P_swet = np.nanmax(p_summer, axis=1)
    P_sdry = np.nanmin(p_summer, axis=1)
    P_wwet = np.nanmax(p_winter, axis=1)
    P_wdry = np.nanmin(p_winter, axis=1)

    P_thresh = 2.0 * MAT + 14.0
    arid = MAP < 10.0 * P_thresh
    desert = arid & (MAP < 5.0 * P_thresh)
    steppe = arid & ~desert

    tropical = (T_cold >= 18.0) & ~arid
    fully_humid = tropical & (P_dry >= 60.0)
    monsoon = tropical & (P_dry < 60.0) & (P_dry >= (100.0 - MAP / 25.0))
    savannah = tropical & (P_dry < 60.0) & (P_dry < (100.0 - MAP / 25.0))

    temperate = (T_hot >= 10.0) & (T_cold > 0.0) & (T_cold < 18.0) & ~arid
    temperate_dry_summer = temperate & (P_sdry < 40.0) & (P_sdry < P_wwet / 3.0)
    temperate_dry_winter = temperate & (P_wdry < P_swet / 10.0) & ~temperate_dry_summer
    temperate_no_dry_season = temperate & ~temperate_dry_summer & ~temperate_dry_winter

    cold = (T_hot >= 10.0) & (T_cold <= 0.0) & ~arid
    cold_dry_summer = cold & (P_sdry < 40.0) & (P_sdry < P_wwet / 3.0)
    cold_dry_winter = cold & (P_wdry < P_swet / 10.0) & ~cold_dry_summer
    cold_no_dry_season = cold & ~cold_dry_summer & ~cold_dry_winter

    polar = T_hot < 10.0
    frost = polar & (T_hot <= 0.0)
    tundra = polar & (T_hot > 0.0)

    # Order matches KOPPEN_CLASS_NAMES[1:] exactly -- index i here is class i+1.
    classes = [
        tundra, frost,
        cold_dry_winter, cold_dry_summer, cold_no_dry_season,
        temperate_dry_winter, temperate_dry_summer, temperate_no_dry_season,
        desert, steppe,
        savannah, monsoon, fully_humid,
    ]
    stacked = np.stack(classes, axis=0)
    n_hits = stacked.sum(axis=0)
    n_conflicts = int((n_hits > 1).sum())
    if n_conflicts:
        print(f"    ** warning: {n_conflicts} cells matched more than one Koppen class")
    n_gaps = int((n_hits == 0).sum())
    if n_gaps:
        print(f"    ** warning: {n_gaps} cells matched no Koppen class")

    label = np.zeros(T_cold.shape, dtype=np.uint8)
    for i, cls in enumerate(classes, start=1):
        label[cls] = i

    is_land = landfrac2d >= 0.5
    return np.where(is_land, label, 0).astype(np.uint8)


def write_frames(model_dir: Path, resolution_id: str, var_id: str, encoded, frame_meta) -> float:
    """encoded: (age, N_LAYERS, nlat, nlon) uint8. One file per age. Returns total MB."""
    frame_dir = model_dir / "frames" / var_id / resolution_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    total_mb = 0.0
    for i, fm in enumerate(frame_meta):
        out_path = frame_dir / f"{fm['id']}.bin"
        encoded[i].tofile(out_path)  # (layer, nlat, nlon): depth-major, matches Data3DTexture
        total_mb += out_path.stat().st_size / 1024 / 1024
    return total_mb


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--id", default="climate-540myr")
    ap.add_argument("--name", default="Li et al. 2022 Paleoclimate")
    ap.add_argument("--source", default=None,
                     help="citation; defaults to the file's own 'reference' attribute")
    ap.add_argument("--nlon", type=int, default=DEFAULT_NLON)
    ap.add_argument("--nlat", type=int, default=DEFAULT_NLAT)
    ap.add_argument("--resolution-id", default="std")
    ap.add_argument("--clip-percentile", type=float, default=DEFAULT_CLIP_PERCENTILE)
    ap.add_argument("--out", type=Path, default=Path("archive"))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    assert NH_SUMMER_MONTHS == [3, 4, 5, 6, 7, 8], "NH summer months regressed to the 1-indexed bug"
    assert SH_SUMMER_MONTHS == [0, 1, 2, 9, 10, 11], "SH summer months regressed to the 1-indexed bug"

    ds = xr.open_dataset(args.input)
    missing = [v.source_var for v in VARIABLES if v.source_var not in ds]
    if missing:
        raise SystemExit(f"variables {missing} not in {args.input.name}: {list(ds.data_vars)}")

    sim = np.asarray(ds["simulation"].values, dtype=np.int64)
    # simulation's own coordinate metadata: 'From 540 Ma to the
    # pre-industrial with a 10-million-year interval' -- index 0 is the
    # OLDEST simulation, not the present, the reverse of the obvious
    # reading. age_ma = sim*10 (Phase 1 and Phase 2's original assumption)
    # silently swapped every age around the midpoint of the series -- caught
    # visually via land fraction, which has an unmistakable shape signature
    # present-day continents have that no other variable does.
    age_ma = (float(sim.max()) - sim.astype(np.float64)) * 10.0
    source = args.source or ds.attrs.get("reference", "")
    print(f"ages        {len(sim)}  {age_ma.min():.0f}-{age_ma.max():.0f} Ma "
          f"(sim {sim.min()}={age_ma.max():.0f} Ma .. sim {sim.max()}={age_ma.min():.0f} Ma)")

    model_dir = args.out / "models" / args.id
    frame_meta = [{"id": f"{int(round(a)):03d}", "age_ma": float(a)} for a in age_ma]
    variables_meta = []

    # Kept for the Phase 4 derived variables below -- the 12-REAL-month
    # physical arrays, before add_annual_layer() extends anything to 13
    # layers and before uint8 encoding. T_RANGE and KOPPEN need actual
    # physical values, not a round trip through the lossy uint8 archive
    # format, and specifically the 12 real months (KOPPEN's MAP is a SUM
    # over them; including the Annual layer would double-count).
    physical = {}
    lat2 = None

    for spec in VARIABLES:
        print(f"\n=== {spec.var_id}  ({spec.source_var}, "
              f"{'monthly' if spec.monthly else 'static -> broadcast to every layer'})")
        vol, lon2, lat2, raw_min, raw_max = load_and_condition(
            ds, spec, args.nlon, args.nlat
        )
        if spec.var_id in ("T", "P", "LANDFRAC"):
            physical[spec.var_id] = vol
        print(f"    range       {raw_min:+.4g} to {raw_max:+.4g} {spec.units}")

        vol = add_annual_layer(vol, spec.monthly)

        if spec.fixed_range is not None:
            clip_lo, clip_hi = spec.fixed_range
            if raw_min < clip_lo or raw_max > clip_hi:
                print(f"    ** warning: data range exceeds encode range "
                      f"[{clip_lo:+.4g}, {clip_hi:+.4g}] -- will clip")
        else:
            clip_lo, clip_hi = choose_clip(
                vol, spec.diverging, args.clip_percentile, None
            )
            print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] "
                  f"({args.clip_percentile} percentile)")

        colormap = choose_colormap(spec.colormap, spec.high_means, args.out, spec.diverging)
        if spec.diverging:
            print(f"    colormap    {colormap}  (high = {spec.high_means})")
        else:
            print(f"    colormap    {colormap}")

        encoded = encode_uint8(vol, clip_lo, clip_hi)  # (age, N_LAYERS, nlat, nlon)
        total_mb = write_frames(model_dir, args.resolution_id, spec.var_id, encoded, frame_meta)
        print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")

        variables_meta.append({
            "id": spec.var_id,
            "name": spec.display_name,
            "source_var": spec.source_var,
            "units": spec.units,
            "diverging": spec.diverging,
            **({"high_means": spec.high_means} if spec.diverging else {}),
            **({"vector_only": True} if spec.vector_only else {}),
            "encode_min": round(clip_lo, 4),
            "encode_max": round(clip_hi, 4),
            "value_min": round(raw_min, 4),
            "value_max": round(raw_max, 4),
            "default_clip_min": round(clip_lo, 4),
            "default_clip_max": round(clip_hi, 4),
            "default_colormap": colormap,
        })

        if args.validate:
            expect = args.nlon * args.nlat * N_LAYERS
            first = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                 / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
            last = np.fromfile(model_dir / "frames" / spec.var_id / args.resolution_id
                                / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
            assert first.size == expect, f"{frame_meta[0]['id']}.bin is {first.size}, want {expect}"
            assert last.size == expect, f"{frame_meta[-1]['id']}.bin is {last.size}, want {expect}"
            assert not np.array_equal(first, last), \
                "first and last age frames are byte-identical -- age grouping failed"
            first3 = first.reshape(N_LAYERS, args.nlat, args.nlon)
            if spec.monthly:
                assert not np.array_equal(first3[0], first3[6]), \
                    "month 0 and month 6 are byte-identical -- month axis collapsed to one layer"
                # Annual (layer 12) must land within [min, max] of the 12 real
                # months' own decoded values. NOT a check against their mean:
                # clipping is monotonic but non-linear, so mean(clip(x)) !=
                # clip(mean(x)) whenever any month got clipped -- which
                # precipitation's heavy skew makes routine (many near-zero
                # months clipped up to clip_lo). Clip IS monotonic, though,
                # so clip(mean(x)) is mathematically guaranteed to fall
                # within [min(clip(x)), max(clip(x))] regardless of skew --
                # a small tolerance only for uint8 rounding, not clipping.
                decoded = first3.astype(np.float32) / 255.0 * (clip_hi - clip_lo) + clip_lo
                step = (clip_hi - clip_lo) / 255.0
                lo_bound = decoded[:N_MONTHS].min(axis=0) - step
                hi_bound = decoded[:N_MONTHS].max(axis=0) + step
                annual = decoded[ANNUAL_LAYER]
                assert bool(np.all(annual >= lo_bound)) and bool(np.all(annual <= hi_bound)), \
                    "Annual layer falls outside the encoded [min, max] of the 12 real months"
            phys = first3[0].astype(np.float32) / 255.0 * (clip_hi - clip_lo) + clip_lo
            r0 = lateral_roughness(first3[0].astype(np.float32))
            print(f"    validate    {expect} bytes/frame, decoded month-0 range "
                  f"[{phys.min():+.4g}, {phys.max():+.4g}] {spec.units}  roughness {r0:.3f}")

    # --- Phase 4: derived variables, from the retained 12-real-month physical
    # arrays above, not from any already-encoded/broadcast volume. ---

    print(f"\n=== T_RANGE  (derived from T, static -> broadcast to every layer)")
    t_range_2d = compute_seasonality_range(physical["T"])
    print(f"    range       {t_range_2d.min():+.4g} to {t_range_2d.max():+.4g} °C")
    clip_lo, clip_hi = choose_clip(t_range_2d, diverging=False, percentile=args.clip_percentile,
                                    override=None)
    print(f"    clip        [{clip_lo:+.4g}, {clip_hi:+.4g}] ({args.clip_percentile} percentile)")
    colormap = choose_colormap("plasma", None, args.out, diverging=False)
    print(f"    colormap    {colormap}")
    t_range_vol = broadcast_static(t_range_2d, N_LAYERS)
    encoded = encode_uint8(t_range_vol, clip_lo, clip_hi)
    total_mb = write_frames(model_dir, args.resolution_id, "T_RANGE", encoded, frame_meta)
    print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")
    variables_meta.append({
        "id": "T_RANGE",
        "name": "Seasonality (temperature range)",
        "source_var": "T",
        "units": "°C",
        "diverging": False,
        "encode_min": round(clip_lo, 4),
        "encode_max": round(clip_hi, 4),
        "value_min": round(float(t_range_2d.min()), 4),
        "value_max": round(float(t_range_2d.max()), 4),
        "default_clip_min": round(clip_lo, 4),
        "default_clip_max": round(clip_hi, 4),
        "default_colormap": colormap,
    })
    if args.validate:
        expect = args.nlon * args.nlat * N_LAYERS
        first = np.fromfile(model_dir / "frames" / "T_RANGE" / args.resolution_id
                             / f"{frame_meta[0]['id']}.bin", dtype=np.uint8)
        last = np.fromfile(model_dir / "frames" / "T_RANGE" / args.resolution_id
                            / f"{frame_meta[-1]['id']}.bin", dtype=np.uint8)
        assert first.size == expect and last.size == expect
        assert not np.array_equal(first, last), \
            "T_RANGE first and last age frames are byte-identical -- age grouping failed"
        print(f"    validate    {expect} bytes/frame")

    print(f"\n=== KOPPEN  (derived from T + P, static -> broadcast to every layer)")
    koppen_2d = compute_koppen(physical["T"], physical["P"], physical["LANDFRAC"][:, 0], lat2)
    # Encode each class at its BAND CENTRE (c + 0.5), not the raw integer c.
    # encode_uint8's astype(np.uint8) TRUNCATES rather than rounds, and the
    # shader recovers a class from uSteps=N via floor(t*N) -- composing a
    # truncating encode with a flooring decode shifts every class except 0
    # down by one band (class 9 "Desert" was being stored and rendered as
    # class 8 "Temperate, no dry season" -- confirmed by reading back the
    # actual written frame, which is why the spot checks below decode from
    # the real encoded bytes rather than this pre-encoding array). Landing
    # on the band centre leaves 1/(2*N_KOPPEN_CLASSES) of margin either side
    # of the encode step (~1/255), more than enough to absorb it.
    koppen_vol = broadcast_static(koppen_2d.astype(np.float32) + 0.5, N_LAYERS)
    encoded = encode_uint8(koppen_vol, 0.0, float(N_KOPPEN_CLASSES))
    total_mb = write_frames(model_dir, args.resolution_id, "KOPPEN", encoded, frame_meta)
    print(f"    wrote       {len(frame_meta)} frames, {total_mb:.1f} MB total")
    variables_meta.append({
        "id": "KOPPEN",
        "name": "Koppen climate classification",
        "source_var": "T,P",
        "units": "class",
        "diverging": False,
        "categorical": True,
        "class_names": KOPPEN_CLASS_NAMES,
        "encode_min": 0.0,
        "encode_max": float(N_KOPPEN_CLASSES),
        "value_min": 0.0,
        "value_max": float(N_KOPPEN_CLASSES - 1),
        "default_clip_min": 0.0,
        "default_clip_max": float(N_KOPPEN_CLASSES),
        "default_colormap": "koppen",
    })
    if args.validate:
        expect = args.nlon * args.nlat * N_LAYERS
        age0_idx = int(np.argmin(np.abs(np.asarray([f["age_ma"] for f in frame_meta]))))
        first = np.fromfile(model_dir / "frames" / "KOPPEN" / args.resolution_id
                             / f"{frame_meta[age0_idx]['id']}.bin", dtype=np.uint8)
        assert first.size == expect
        # Decode the SAME way the shader does (see the comment above this
        # block): byte -> t=byte/255 (clip spans the full 0..1 encode range
        # here) -> band=floor(t*N). Reading the pre-encoding koppen_2d array
        # directly here would have validated the wrong thing entirely -- it
        # is exactly what let the truncate/floor bug above ship unnoticed
        # the first time.
        koppen_bytes = first.reshape(N_LAYERS, args.nlat, args.nlon)[0]
        koppen_age0 = np.minimum(
            N_KOPPEN_CLASSES - 1,
            np.floor((koppen_bytes.astype(np.float64) / 255.0) * N_KOPPEN_CLASSES),
        ).astype(np.int64)

        # Present-day (age 0) spot checks against well-known reference
        # points -- there's no ground truth to check deep-time ages
        # against, so this is the correctness gate: get today right, then
        # trust the same code applied to every other age.
        def class_at(lon_q, lat_q):
            lon_grid = np.linspace(-180, 180, args.nlon, endpoint=False)
            j = int(np.argmin(np.abs(lon_grid - lon_q)))
            i = int(np.argmin(np.abs(lat2 - lat_q)))
            return KOPPEN_CLASS_NAMES[int(koppen_age0[i, j])]

        checks = [
            ("central Sahara", 10.0, 23.0, "Desert (BW)"),
            ("Congo basin", 22.0, 0.0, "Fully humid (Af)"),
            ("central England", -1.0, 52.0, "Temperate, no dry season (Cf)"),
        ]
        for label, lon_q, lat_q, expected in checks:
            got = class_at(lon_q, lat_q)
            status = "ok" if got.startswith(expected.split(" (")[0].split(",")[0]) else "** MISMATCH"
            print(f"    validate    {label} (age 0) -> {got}  [expected {expected}]  {status}")

    ds.close()

    manifest = {
        "id": args.id,
        "name": args.name,
        "type": "climate",
        "source": source,
        "lon_min": -180.0, "lon_max": 180.0,
        "lat_min": -90.0, "lat_max": 90.0,
        "depth_min_km": LAYER_MIN_KM,
        "depth_max_km": LAYER_MAX_KM,
        "dtype": "uint8",
        "default_resolution": args.resolution_id,
        "resolutions": [{
            "id": args.resolution_id,
            "nlon": args.nlon, "nlat": args.nlat, "ndepth": N_LAYERS,
        }],
        "frames": frame_meta,
        "path_template": "frames/{variable}/{resolution}/{frame}.bin",
        "default_variable": "T",
        "variables": variables_meta,
        # Declares the U/V pairing as data rather than a viewer-side
        # assumption -- see core/types.ts's Manifest.vector_fields and
        # windGlyphs.ts, which read this generically.
        "vector_fields": [
            {"id": "wind", "name": "Wind (1000 hPa)",
             "u_variable": "U", "v_variable": "V", "units": "m/s"},
        ],
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {model_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()

