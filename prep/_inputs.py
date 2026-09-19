"""Fetchers for the large external inputs the prep scripts need.

Each of these used to be a path on one laptop, which meant the archive could only be rebuilt
on that machine. They are fetched here instead, with pooch, into the same cache gprm uses.

Two of them live inside much larger published records, so they are fetched **file by file**
rather than as a whole deposit:

* Muller et al. (2022) Zenodo record 6622194 is 4.95 GB across 10 files; only the 2.29 GB
  OPT1 temperature grids are wanted.
* NOAA's ETOPO 2022 is published per-tile and per-resolution; only the global 60 arc-second
  surface grid is wanted.

Zenodo serves individual files at a stable URL, so there is no need to pull a whole record.

Nothing here is imported at module load; call the functions. Each returns a path and caches,
so a second call is free.
"""
from pathlib import Path

# Written into the same cache gprm uses, so that one directory holds everything the build
# downloads and `gprm.datasets.cache_path()` finds it.
CACHE_SUBDIR = 'geode'


def _cache_dir():
    from gprm.datasets import cache_path
    return cache_path(CACHE_SUBDIR)


def fetch_opt1_grids():
    """Muller et al. (2022) OPT1 mantle temperature anomaly grids.

    One 2.29 GB file out of a 4.95 GB Zenodo record (doi:10.5281/zenodo.6622194), unzipped.

    :returns: Path to the directory of .nc grids, suitable for prep_convection.py --input.
    """
    from pooch import Unzip, retrieve

    files = retrieve(
        url='https://zenodo.org/records/6622194/files/'
            'OPT1_temperature_anomaly_grids_dimensional.zip?download=1',
        known_hash='md5:03029ff32702d60fbbaebb59780fb60b',
        fname='OPT1_temperature_anomaly_grids_dimensional.zip',
        path=_cache_dir(),
        processor=Unzip(extract_dir='OPT1'),
        progressbar=True,
    )

    # The zip holds a single top-level directory of grids; find it rather than assuming its
    # name, so that a repackaged archive fails loudly here instead of much later.
    grid_files = [Path(f) for f in files if f.endswith(('.nc', '.grd'))]
    if not grid_files:
        raise FileNotFoundError(
            'No .nc or .grd files found in the OPT1 archive. It may have been repackaged '
            'upstream; delete {} and retry.'.format(_cache_dir() / 'OPT1'))

    return grid_files[0].parent


def fetch_etopo():
    """NOAA ETOPO 2022 global relief, 60 arc-second surface elevation (478 MB).

    A public, registration-free replacement for the GEBCO One Minute Grid. Same 1 arc-minute
    resolution, and far finer than the 4096x2048 texture it is decimated to.

    :returns: Path to the netCDF file, suitable for prep_topography.py --input.
    """
    from pooch import retrieve

    return Path(retrieve(
        url='https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/'
            '60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc',
        # NOAA publishes no checksum for this file, so it cannot be pinned. pooch will warn.
        known_hash=None,
        fname='ETOPO_2022_v1_60s_N90W180_surface.nc',
        path=_cache_dir(),
        progressbar=True,
    ))
