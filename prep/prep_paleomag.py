#!/usr/bin/env python3
"""Export paleomagnetic Virtual Geomagnetic Poles (VGPs) for the reconstruction
viewer's "Paleomagnetic poles" overlay, per docs/plans/paleomagnetic-poles.md
and ADR-0029/0032/0033.

Uses the petrify generic point pipeline (points_from_dataframe/build_points,
see viewer/vendor/petrify/python/petrify/points.py), the same primitive
prep_boucot.py already consumes -- with one difference ADR-0029 designed and
petrify now supports: a VGP's PLATE ASSIGNMENT is tested against its
*sample site* (a real location on the crust), never its *pole position* (a
computed field direction with no polygon membership to test), so this is the
first caller of points_from_dataframe's partition_lon_field/
partition_lat_field split -- pole position stays the drawn geometry, sample
site is only ever used to look up plate_id/plate_begin_age.

A VGP's age is not scrubbable the way a deposit's is: it only means something
at its own recorded AverageAge. That display rule (a fixed +-5 Ma window, no
fade) lives downstream in the viewer's own PointOverlay.load() call (Phase 5),
not here -- this script only exports WHERE each pole is and WHEN it was
recorded, per the same "export carries WHERE, the renderer decides WHEN"
split points.py's own docstring already establishes for every other point
dataset. Colour likewise does not belong in this export (see points.js's own
restyle() doc comment: "Colours do not belong in the exported JSON, because
rebuilding the data to restyle a map would be the wrong seam") -- the
deterministic plate-id -> hue palette ADR-0029 specifies is a client-side
`options.style()` hook in Phase 5, not baked in here.

Assignment runs once per Reconstruction Model that has static polygons
exported (ADR-0025's limitation: Muller2019, Seton2012, Scotese,
TorsvikCocks2017 today), independently of which model the VGP data itself
was originally computed under -- reconstructing real paleomagnetic data with
a DIFFERENT model's rotations is not a mismatch, it is the entire point: a
live visual check of whether that model's rotations agree with independent
paleomagnetic constraints.

Output per model: archive/reconstructions/<model-id>/paleomag/<dataset-id>/points.json
Also writes archive/paleomag/<dataset-id>/dataset.json, a small catalog
stub (id, name, citation, n_poles, age range) that build_archive_index.py
scans -- alongside a glob over which models actually got a points.json -- to
assemble archive.json's paleomag_pole_sets[] catalog array, the same
scan-don't-hand-maintain pattern reconstruction_models[] already uses.

Also exports the GAPWaP (Global Apparent Polar Wander Path for Gondwana)
itself for --gapwap-models -- the feature ADR-0029 deferred as "its own
future grilling session": the MODELLED polar wander path a Reconstruction
Model's own rotations predict, reproducing animators.py's
apwp_reconstruction() from the NREE22 repo. A south-pole seed point, fixed
to --gapwap-reference-plate (701, Southern Africa), traced through
--gapwap-anchor-plate's (1, "Africa") reference frame via
gprm.MotionPathFeature -- checked directly (not assumed) against this exact
model: reconstructing that path to any world_anchor is EXACTLY equal to
taking the anchor_plate=0 (present-day, world-frame) path vertices and
applying --gapwap-reference-plate's own ordinary rotation series, the same
per-plate rotation the 'rotations' transport already computes for every
other point dataset -- confirmed to machine precision (1e-12 deg) against
pygplates' own MotionPathFeature output at reconstruction_time=100 Ma. So
the path needs no new transport either: each vertex is an ordinary point
assigned to plate 701, tagged `age = path_time`, riding the SAME
'rotations' transport as the poles above, at Geode's standard anchor=0 (so
it composites correctly with coastlines/static polygons/VGPs, all of which
are anchor=0 -- NOT animators.py's own anchor_plate_id=1 choice, which was
a deliberate Africa-fixed illustration convention for that one static
figure, not a Geode-wide anchor switch). The existing 'since' lifespan mode
(a point exists from its own age to present, points.py's own default rule)
gives the path's growing/shrinking truncation as the reconstruction age
slider moves for free -- checked directly against pygplates' own truncation
behaviour (45 of 55 vertices remain at reconstruction_time=100 Ma, exactly
those with path_time >= 100). Drawing the connected line itself is Phase 1's
new "connect live points" draw mode, applied client-side (Phase 5) -- this
script only exports the vertices and their ages.

Usage:
  conda run -n pygmt17 python prep/prep_paleomag.py \\
      --source prep/sources/paleomag/T2012_TC2017.gpml \\
      --id torsvik-cocks-2017 --name "Torsvik et al. (2012)" \\
      --models torsvikcocks2017 muller2019 seton2012 scotese
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

PETRIFY_PY = Path(__file__).parent.parent / "viewer" / "vendor" / "petrify" / "python"
sys.path.insert(0, str(PETRIFY_PY))

DEFAULT_SOURCE = Path(__file__).parent / "sources" / "paleomag" / "T2012_TC2017.gpml"
# The VGPs themselves are Torsvik et al. (2012)'s compilation (the "T2012" in
# the source file name), carried in Torsvik & Cocks (2017)'s plate framework
# ("TC2017") -- cite the poles' own source, not the framework's.
DEFAULT_CITATION = (
    "Torsvik, T.H., et al. (2012), Phanerozoic polar wander, palaeogeography "
    "and dynamics, Earth-Science Reviews, 114, 325-368"
)


def build_gapwap_path(model, model_id, anchor_plate, reference_plate, age_step, age_max,
                      build_points_fn):
    """The modelled GAPWaP: present-day vertices on `reference_plate`, tagged
    with their own path_time as `age`, riding the ordinary 'rotations'
    transport at Geode's standard world anchor (0) -- see the module
    docstring for the derivation and the direct pygplates check backing it.
    """
    import pygplates
    from gprm import MotionPathFeature

    path_times = np.arange(0.0, age_max + age_step / 2, age_step)
    result = MotionPathFeature(
        seed_points=(-90, 0), path_times=path_times,
        reconstruction_plate_id=anchor_plate, relative_plate_id=reference_plate,
    ).reconstruct_motion_path(model, reconstruction_time=0.001, anchor_plate_id=0)
    if not result:
        return None
    vertices = result[0]  # oldest-first; vertices[-1] is path_time == 0 (the seed itself)
    ages = path_times[::-1][:len(vertices)]

    records = []
    for (lat, lon), age in zip(vertices, ages):
        feature = pygplates.Feature()
        feature.set_geometry(pygplates.PointOnSphere(lat, lon))
        feature.set_valid_time(pygplates.GeoTimeInstant.create_distant_past(),
                               pygplates.GeoTimeInstant.create_distant_future())
        records.append((feature, {
            "lon": round(float(lon), 4), "lat": round(float(lat), 4),
            "age": round(float(age), 4), "plate_id": reference_plate,
            "plate_begin_age": None,
        }))

    # The path's head: the node for the CURRENTLY displayed age, between the
    # 10 Myr vertices. The vertex for path_time t, reconstructed to t, is
    # R_ref(t) * R_ref(t)^-1 * R_anchor(t) * seed = R_anchor(t) * seed -- i.e.
    # just the seed carried on `anchor_plate`. So one record fixed to that
    # plate at the seed, live at every age ('since' from age_max) and last in
    # the array (connectLive joins live points in array order, so it hangs
    # off the youngest live vertex), lands exactly on the path at any t, with
    # the ordinary rotations transport. In a paleomagnetic frame that is at or
    # near the spin axis.
    seed_feature = pygplates.Feature()
    seed_feature.set_geometry(pygplates.PointOnSphere(-90.0, 0.0))
    seed_feature.set_valid_time(pygplates.GeoTimeInstant.create_distant_past(),
                                pygplates.GeoTimeInstant.create_distant_future())
    records.append((seed_feature, {
        "lon": 0.0, "lat": -90.0, "age": round(float(path_times[-1]), 4),
        "plate_id": anchor_plate, "plate_begin_age": None, "head": True,
    }))

    times = np.arange(0.0, age_max + age_step / 2, age_step)
    return build_points_fn(model, records, times, transport="rotations",
                           anchor_plate=0, model_name=model_id)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                    help="a gpml:VirtualGeomagneticPole feature collection, in "
                         "gprm.utils.pmag.vgp_to_dataframe()'s expected schema")
    ap.add_argument("--id", default="torsvik-cocks-2017", help="pole-dataset catalog id")
    ap.add_argument("--name", default="Torsvik et al. (2012)")
    ap.add_argument("--citation", default=DEFAULT_CITATION)
    ap.add_argument("--models", nargs="+",
                    default=["torsvikcocks2017", "scotese", "merdith2021"],
                    help="Reconstruction Model catalog ids to assign+export against "
                         "(each already exported by prep_reconstruction.py) -- the "
                         "three the Paleomagnetic poles toggle offers today "
                         "(reconstructionGroupConfig.ts); Muller2019/Seton2012 are "
                         "deliberately not among them")
    ap.add_argument("--archive", type=Path, default=Path("archive"))
    ap.add_argument("--gapwap-models", nargs="*",
                    default=["torsvikcocks2017", "scotese", "merdith2021"],
                    help="subset of --models to also export the modelled GAPWaP "
                         "path for -- the (anchor, reference) plate pair below was "
                         "checked directly against each of these three (plate 701 "
                         "has real static-polygon coverage and a smooth, "
                         "non-degenerate rotation relative to plate 1 across the "
                         "full age range in all three); do not add a further model "
                         "here without checking the same, since plate ids are not "
                         "guaranteed to carry the same meaning across independently "
                         "built models")
    ap.add_argument("--gapwap-anchor-plate", type=int, default=1,
                    help="the block the path is scientifically fixed to (\"Africa\"); "
                         "reconstruction_plate_id in gprm.MotionPathFeature terms")
    ap.add_argument("--gapwap-reference-plate", type=int, default=701,
                    help="the plate whose motion relative to --gapwap-anchor-plate "
                         "defines the path (\"Southern Africa\"/Gondwana reference)")
    ap.add_argument("--gapwap-age-step", type=float, default=10.0,
                    help="matches animators.py's own apwp_time_step")
    args = ap.parse_args()

    from petrify.points import points_from_dataframe, build_points
    from gprm.utils import pmag
    from gprm.datasets import Reconstructions

    print(f"loading VGPs from {args.source} via gprm.utils.pmag.vgp_to_dataframe() ...")
    gdf = pmag.vgp_to_dataframe(str(args.source))
    n_poles = len(gdf)
    age_min, age_max = float(gdf.AverageAge.min()), float(gdf.AverageAge.max())
    print(f"  {n_poles} VGPs, ages {age_min:.0f}-{age_max:.0f} Ma")

    exported_for = {}

    for model_id in args.models:
        recon_dir = args.archive / "reconstructions" / model_id
        manifest_path = recon_dir / "manifest.json"
        if not manifest_path.exists():
            print(f"  skip {model_id}: {manifest_path} not found "
                  "(run prep_reconstruction.py first)")
            continue
        manifest = json.loads(manifest_path.read_text())
        if not manifest.get("has_static_polygons"):
            print(f"  skip {model_id}: no static polygons exported "
                  "(VGP assignment needs one, see ADR-0025/0029)")
            continue

        fetch_name = manifest["source_fetch"]
        print(f"  fetching {model_id} via Reconstructions.{fetch_name}() ...")
        model = getattr(Reconstructions, fetch_name)()

        records, unassigned = points_from_dataframe(
            gdf, model,
            # Drawn geometry: the pole position itself.
            lon_field="PoleLongitude", lat_field="PoleLatitude",
            # Plate assignment: the sample site, a real location on the crust
            # -- never the pole, which has no polygon membership (ADR-0029).
            partition_lon_field="AverageSampleSiteLongitude",
            partition_lat_field="AverageSampleSiteLatitude",
            age_field="AverageAge",
            fields=[
                ("a95", "PoleA95"),
                ("name", "Name"),
                ("description", "Description"),
                # Rides along as ordinary per-point metadata so the viewer can
                # draw the faint sample-site marker (docs/plans/paleomagnetic-poles.md)
                # without a second dataset or a second partition pass.
                ("sample_lon", "AverageSampleSiteLongitude"),
                ("sample_lat", "AverageSampleSiteLatitude"),
            ],
        )
        plate_ids = {r["plate_id"] for _, r in records}
        print(f"    {len(plate_ids)} distinct plates, {unassigned} unassigned (plate 0)")

        # A VGP is drawn at its assigned plate's rotation AT THE CURRENT
        # RECONSTRUCTION AGE, exactly like every other 'rotations'-transport
        # point dataset (isLive()/recomputeXYZFromRotations in points.js) --
        # ADR-0029's "reconstructed to exactly its own averageAge" is not a
        # separate position mechanism, it falls out of pairing this ordinary
        # per-plate rotation series with a narrow +-5 Ma 'window' visibility
        # cutoff (Phase 5): a pole is only ever visible while the slider is
        # within 5 Myr of its own age, so its drawn position (at slider time)
        # and its "own age" position are always within 5 Myr of plate motion
        # of each other. The rotation series still needs to span the model's
        # full age range -- not just the poles' own ages -- because the
        # slider itself ranges over it.
        model_age_min, model_age_max = manifest["age_min"], manifest["age_max"]
        times = np.arange(model_age_min, model_age_max + 5.0 / 2, 5.0)
        payload = build_points(
            model, records, times, transport="rotations", model_name=model_id,
        )

        out_dir = recon_dir / "paleomag" / args.id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "points.json"
        out_path.write_text(json.dumps(payload))
        mb = out_path.stat().st_size / 1024 / 1024
        print(f"    wrote {out_path} ({mb:.2f} MB)")

        entry = {"points": f"reconstructions/{model_id}/paleomag/{args.id}/points.json"}

        if model_id in args.gapwap_models:
            print(f"    building GAPWaP path (anchor={args.gapwap_anchor_plate}, "
                  f"reference={args.gapwap_reference_plate}) ...")
            path_payload = build_gapwap_path(
                model, model_id, args.gapwap_anchor_plate, args.gapwap_reference_plate,
                args.gapwap_age_step, model_age_max, build_points,
            )
            if path_payload is None:
                print(f"    ! no motion path returned for plate pair "
                      f"({args.gapwap_anchor_plate}, {args.gapwap_reference_plate}) "
                      f"under {model_id} -- skipping path export for this model")
            else:
                path_out = out_dir / "gapwap_path.json"
                path_out.write_text(json.dumps(path_payload))
                print(f"    wrote {path_out} "
                      f"({path_out.stat().st_size / 1024:.1f} KB)")
                entry["path"] = f"reconstructions/{model_id}/paleomag/{args.id}/gapwap_path.json"

        exported_for[model_id] = entry

    if not exported_for:
        raise SystemExit("no Reconstruction Model had static polygons exported -- nothing written")

    catalog_dir = args.archive / "paleomag" / args.id
    catalog_dir.mkdir(parents=True, exist_ok=True)
    catalog_path = catalog_dir / "dataset.json"
    catalog_path.write_text(json.dumps({
        "id": args.id,
        "name": args.name,
        "citation": args.citation,
        "n_poles": n_poles,
        "age_min": age_min,
        "age_max": age_max,
        "exported_for": exported_for,
    }, indent=2))
    print(f"wrote {catalog_path}")
    print("re-run prep/build_archive_index.py to refresh archive.json's paleomag_pole_sets[]")


if __name__ == "__main__":
    main()
