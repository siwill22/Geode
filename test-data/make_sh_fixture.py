"""Reference values for the spherical-harmonic synthesis parity check.

pyshtools SHMagCoeffs.expand is the reference. This writes a JSON fixture
holding the coefficients of a few models, sample points, and pyshtools'
(Br, Btheta, Bphi) at those points plus a small grid and the Lowes spectrum,
for viewer/scripts/check_sh_synthesis.mjs to reproduce.

    python test-data/make_sh_fixture.py [out.json] [--lcs PATH] [--mli2d PATH]

Models:
  - synthetic: random coefficients to degree 300 with a lithosphere-like
    decaying spectrum, r0 = 6371.0 km (the remit forward-model radius). This
    is the case that exercises the full browser lmax cap.
  - LCS-1 (optional, from a 4-column l m g h file), r0 = 6371.2 km.
  - Swarm MLI_SHA_2D (optional, from its .shc file), r0 = 6371.2 km.
Every model is evaluated at absolute radii 6371.2 km + h, so models with
different r0 are compared at the same place.
"""

import argparse
import json

import numpy as np
import pyshtools

R_REF = 6371.2e3

parser = argparse.ArgumentParser()
parser.add_argument("out", nargs="?", default="/tmp/geode-sh-fixture.json")
parser.add_argument("--lcs", default="/Users/simon/GIT/curiesphere/remit/data/shc/LCS_mod.cof")
parser.add_argument(
    "--mli2d",
    default=(
        "/Users/simon/OneDrive - University of Tasmania/Data/StefanMausData/xDLFI/"
        "SW_OPER_MLI_SHA_2D_00000000T000000_99999999T999999_0501/"
        "SW_OPER_MLI_SHA_2D_00000000T000000_99999999T999999_0501.shc"
    ),
)
args = parser.parse_args()


def triangular(coeffs):
    """(2, L+1, L+1) pyshtools array -> flat g, h lists, index l(l+1)/2 + m."""
    lmax = coeffs.shape[1] - 1
    g, h = [], []
    for l in range(lmax + 1):
        for m in range(l + 1):
            g.append(float(coeffs[0, l, m]))
            h.append(float(coeffs[1, l, m]))
    return lmax, g, h


models = {}

rng = np.random.default_rng(20260928)
L = 300
syn = np.zeros((2, L + 1, L + 1))
for l in range(1, L + 1):
    amp = 3.0 / (l + 1) ** 0.5
    syn[0, l, : l + 1] = rng.normal(0, amp, l + 1)
    syn[1, l, 1 : l + 1] = rng.normal(0, amp, l)
models["synthetic"] = pyshtools.SHMagCoeffs.from_array(syn, r0=6371.0e3)

try:
    clm, _ = pyshtools.shio.shread(args.lcs, lmax=185)
    models["LCS-1"] = pyshtools.SHMagCoeffs.from_array(clm, r0=R_REF)
except OSError as err:
    print(f"skipping LCS-1: {err}")

try:
    models["MLI_2D_0501"] = pyshtools.SHMagCoeffs.from_file(
        args.mli2d, format="dov", r0=R_REF, r0_index=None, header=True,
        header2=True, skip=3, file_units="nT", units="nT",
    )
except OSError as err:
    print(f"skipping MLI_2D_0501: {err}")

# Sample points: random, plus near-poles and the antimeridian. Nothing closer
# than 0.01 degrees to a pole: pyshtools' point evaluation of Btheta and Bphi
# loses precision within ~1e-4 degrees of it (at 89.999999 its LCS-1 Btheta is
# -11.31 nT; a 60-digit finite difference of the potential gives -9.6534, which
# the JS matches), so the poles are checked on the JS side instead.
lat = np.concatenate([
    rng.uniform(-90, 90, 400),
    [89.99, -89.99, 89.9, -89.9, 0.0, 0.0, 45.0],
])
lon = np.concatenate([
    rng.uniform(-180, 180, 400),
    [123.0, -57.0, 0.0, 0.0, 180.0, -180.0, 179.999],
])

settings = [
    {"altitude": 0.0, "lmin": 16, "lmax": 133},
    {"altitude": 300e3, "lmin": 16, "lmax": 185},
    {"altitude": 10e3, "lmin": 16, "lmax": 300},
    {"altitude": 0.0, "lmin": 1, "lmax": 300},
]

# Small Geode grid: lon cell-centred from -180, lat gridline rows -90..90.
NLON, NLAT = 72, 37
glon = -180 + (np.arange(NLON) + 0.5) * 360 / NLON
glat = -90 + np.arange(NLAT) * 180 / (NLAT - 1)
# pyshtools cannot take dP/dtheta exactly at a pole, so the pole rows are
# evaluated just inside it. The check does not compare those two rows against
# this reference (see above); they are placeholders that keep the grid shape.
glat = np.clip(glat, -89.999999, 89.999999)
GLON, GLAT = np.meshgrid(glon, glat)  # row = lat ascending, lon fastest

out = {"r_ref": R_REF, "points": {"lat": lat.tolist(), "lon": lon.tolist()},
       "grid": {"nlon": NLON, "nlat": NLAT}, "models": {}}

# Main field for the total-field anomaly: IGRF-13 at 2020.0, as remit uses.
igrf = pyshtools.datasets.Earth.IGRF_13(year=2020.0)
ig_lmax, ig_g, ig_h = triangular(igrf.coeffs)
out["igrf"] = {"lmax": ig_lmax, "r0": igrf.r0, "g": ig_g, "h": ig_h}


def tmi(main, crust):
    """remit utils/grid.py components2tmi: |F + b| - |F|, in float64."""
    total = np.sqrt(((main + crust) ** 2).sum(axis=1))
    return total - np.sqrt((main ** 2).sum(axis=1))


for name, model in models.items():
    lmax, g, h = triangular(model.coeffs)
    entry = {"lmax": lmax, "r0": model.r0, "g": g, "h": h, "cases": [],
             "spectrum_r0": model.spectrum(function="total").tolist()}
    for s in settings:
        if s["lmin"] > lmax:
            continue
        win_lmax = min(s["lmax"], lmax)
        c = model.copy()
        c.coeffs[:, : s["lmin"], :] = 0
        c = c.pad(win_lmax) if win_lmax > c.lmax else c
        r = R_REF + s["altitude"]
        pts = c.expand(a=r, lat=lat, lon=lon, lmax_calc=win_lmax)
        grd = c.expand(a=r, lat=GLAT.ravel(), lon=GLON.ravel(), lmax_calc=win_lmax)
        main = igrf.expand(a=r, lat=lat, lon=lon)
        entry["cases"].append({
            **s, "lmax": win_lmax, "r": r,
            "points": {"br": pts[:, 0].tolist(), "btheta": pts[:, 1].tolist(), "bphi": pts[:, 2].tolist(),
                       "tmi": tmi(main, pts).tolist()},
            "grid": {"br": grd[:, 0].tolist(), "btheta": grd[:, 1].tolist(), "bphi": grd[:, 2].tolist()},
        })
    out["models"][name] = entry
    print(f"{name}: lmax {lmax}, r0 {model.r0}, {len(entry['cases'])} cases")

with open(args.out, "w") as f:
    json.dump(out, f)
print(f"wrote {args.out}")
