"""Fetchers for the large external inputs the prep scripts need.

Each of these used to be a path on one laptop, which meant the archive could only be rebuilt
on that machine. They are fetched here instead, with pooch, into the same cache gprm uses.

All of them live inside much larger published records, so none is fetched whole:

* Muller et al. (2022) Zenodo record 6622194 is 4.95 GB across 10 files; only the 2.29 GB
  OPT1 temperature grids are wanted. Zenodo serves each file at its own URL, so this is
  simply a matter of asking for the right one.
* NOAA's ETOPO 2022 is published per-tile and per-resolution; only the global 60 arc-second
  surface grid is wanted.
* Schouten et al. (2024) Zenodo record 13991965 is a **single 18.97 GB zip**, of which the
  one wanted member is 4.98 GB. There is no per-file URL, so that member is extracted with
  HTTP range requests -- see ``fetch_zip_member``.

Nothing here is imported at module load; call the functions. Each returns a path and caches,
so a second call is free.
"""
import struct
import time
import zlib
from pathlib import Path

# Written into the same cache gprm uses, so that one directory holds everything the build
# downloads and `gprm.datasets.cache_path()` finds it.
CACHE_SUBDIR = 'geode'

# Transfers here run to gigabytes, and a dropped connection partway through was observed
# against Zenodo in practice, so every read retries with exponential backoff.
MAX_ATTEMPTS = 6


def _request_failures():
    """Exception types worth retrying: transport-level, not a 4xx from the server.

    Built on demand rather than at import, so that this module stays importable without
    requests installed (only the zip-member fetcher needs it).
    """
    import requests

    return (requests.exceptions.ChunkedEncodingError,
            requests.exceptions.ConnectionError,
            requests.exceptions.Timeout,
            ConnectionResetError)


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


def _require_partial_content(response, url):
    """Fail fast if the server answered a range request with the whole file.

    Observed in practice against Zenodo: a request that should have returned 128 bytes
    instead began streaming all 19 GB. Every range read therefore checks for 206 before
    any of the body is consumed.
    """
    if response.status_code != 206:
        raise RuntimeError(
            '{} answered a range request with HTTP {} rather than 206 Partial Content, i.e. '
            'it is sending the whole archive. Extracting a single member is only possible '
            'with range support; retry, or download the archive and unzip it by hand.'.format(
                url, response.status_code))


def _read_zip_directory(url, session):
    """Read a remote zip's central directory with range requests, without downloading it.

    A zip stores its index at the *end*, so three small reads are enough to learn where every
    member lives: the end-of-central-directory record, the ZIP64 record it points at when the
    archive exceeds 4 GB, and the directory itself.

    :returns: dict keyed by member name, with offset, compressed/uncompressed size and CRC.
    """
    head = session.head(url, allow_redirects=True, timeout=60)
    head.raise_for_status()
    if 'content-length' not in head.headers:
        raise RuntimeError(
            '{} reports no content-length, so its size is unknown and the zip index at the '
            'end of it cannot be located. Check the URL points at the archive itself rather '
            'than at a landing page.'.format(url))
    total = int(head.headers['content-length'])

    def read(start, end):
        # Streamed, so that the status can be checked before the body is pulled down. A
        # server that ignores the Range header answers 200 with the whole archive, and this
        # one is 19 GB: reading .content first would download all of it before complaining.
        for attempt in range(MAX_ATTEMPTS):
            try:
                with session.get(url, headers={'Range': 'bytes={}-{}'.format(start, end)},
                                 stream=True, timeout=300) as response:
                    response.raise_for_status()
                    _require_partial_content(response, url)
                    return response.content
            except _request_failures():
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                time.sleep(2 ** attempt)

    tail = read(max(0, total - 65557), total - 1)
    eocd = tail.rfind(b'PK\x05\x06')
    if eocd == -1:
        raise RuntimeError('No zip end-of-central-directory found at {}'.format(url))
    directory_size, directory_offset = struct.unpack('<II', tail[eocd + 12:eocd + 20])

    locator = tail.rfind(b'PK\x06\x07')
    if locator != -1:                                   # ZIP64, which a 19 GB archive must be
        zip64_offset = struct.unpack('<Q', tail[locator + 8:locator + 16])[0]
        record = read(zip64_offset, zip64_offset + 63)
        if record[:4] != b'PK\x06\x06':
            raise RuntimeError('Bad ZIP64 end-of-central-directory record at {}'.format(url))
        directory_size = struct.unpack('<Q', record[40:48])[0]
        directory_offset = struct.unpack('<Q', record[48:56])[0]

    directory = read(directory_offset, directory_offset + directory_size - 1)

    header = '<IHHHHHHIIIHHHHHII'                       # 46 bytes
    members, position = {}, 0
    while position + 46 <= len(directory) and directory[position:position + 4] == b'PK\x01\x02':
        (_, _, _, _, method, _, _, crc, compressed, uncompressed,
         name_len, extra_len, comment_len, _, _, _, offset) = struct.unpack(
            header, directory[position:position + 46])
        name = directory[position + 46:position + 46 + name_len].decode('utf-8', 'replace')
        extra = directory[position + 46 + name_len:position + 46 + name_len + extra_len]

        # Sizes and offsets past 4 GB are held in a ZIP64 extra field, with 0xFFFFFFFF as the
        # placeholder in the fixed header. The fields present are only those that overflowed.
        cursor = 0
        while cursor + 4 <= len(extra):
            field_id, field_size = struct.unpack('<HH', extra[cursor:cursor + 4])
            blob, taken = extra[cursor + 4:cursor + 4 + field_size], 0
            if field_id == 0x0001:
                if uncompressed == 0xFFFFFFFF:
                    uncompressed = struct.unpack('<Q', blob[taken:taken + 8])[0]; taken += 8
                if compressed == 0xFFFFFFFF:
                    compressed = struct.unpack('<Q', blob[taken:taken + 8])[0]; taken += 8
                if offset == 0xFFFFFFFF:
                    offset = struct.unpack('<Q', blob[taken:taken + 8])[0]; taken += 8
            cursor += 4 + field_size

        members[name] = dict(method=method, crc=crc, compressed=compressed,
                             uncompressed=uncompressed, offset=offset)
        position += 46 + name_len + extra_len + comment_len

    return members


def fetch_zip_member(url, member, fname=None, path=None, progressbar=True):
    """Download and inflate one member of a remote zip, leaving the rest on the server.

    For a record published as a single large archive, this is the difference between a 4.6 GB
    transfer and a 19 GB one. The member's CRC is checked against the archive's own directory,
    so a truncated or corrupted transfer is caught rather than written out as a short file.

    The archive is not pinned by checksum, because it is never downloaded in full; the member
    is pinned instead, which is the stronger guarantee for the bytes actually used.

    :param url: URL of the zip. The server must honour HTTP range requests.
    :param member: full path of the wanted member inside the archive.
    :param fname: name to cache it under; defaults to the member's basename.
    :returns: Path to the extracted file.
    """
    import requests

    destination = Path(path or _cache_dir()) / (fname or member.rsplit('/', 1)[-1])
    session = requests.Session()

    members = _read_zip_directory(url, session)
    if member not in members:
        raise FileNotFoundError(
            "'{}' is not in the archive at {}. It holds {} members; the archive may have been "
            'repackaged upstream.'.format(member, url, len(members)))
    entry = members[member]

    if destination.exists() and destination.stat().st_size == entry['uncompressed']:
        return destination                              # already fetched

    if entry['method'] not in (0, 8):
        raise NotImplementedError(
            'Member {!r} uses zip compression method {}; only stored (0) and deflate (8) are '
            'handled.'.format(member, entry['method']))

    # The local header repeats the name and extra fields, and its extra field can be a
    # different length from the central directory's, so the data offset must be read from it.
    with session.get(url, headers={'Range': 'bytes={}-{}'.format(entry['offset'],
                                                                 entry['offset'] + 29)},
                     stream=True, timeout=300) as response:
        response.raise_for_status()
        _require_partial_content(response, url)
        local = response.content
    if local[:4] != b'PK\x03\x04':
        raise RuntimeError('No local file header for {!r} at offset {}'.format(
            member, entry['offset']))
    name_len, extra_len = struct.unpack('<HH', local[26:30])
    start = entry['offset'] + 30 + name_len + extra_len
    end = start + entry['compressed'] - 1

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + '.part')

    destination.parent.mkdir(parents=True, exist_ok=True)

    # A multi-gigabyte transfer takes long enough that a dropped connection is a question of
    # when, not whether -- one was observed against this very archive after 11 GB. Rather
    # than start over, the resume loop re-requests from the compressed byte it stopped at and
    # keeps feeding the *same* decompressor, whose state carries across the break.
    decompressor = zlib.decompressobj(-15) if entry['method'] == 8 else None
    consumed = 0          # compressed bytes fed to the decompressor
    crc = 0
    written = 0           # uncompressed bytes written

    bar = None
    if progressbar:
        try:
            from tqdm import tqdm
            bar = tqdm(total=entry['uncompressed'], unit='B', unit_scale=True,
                       desc=member.rsplit('/', 1)[-1])
        except ImportError:
            pass

    try:
        with open(partial, 'wb') as handle:
            for attempt in range(MAX_ATTEMPTS):
                if consumed >= entry['compressed']:
                    break
                try:
                    with session.get(
                            url,
                            headers={'Range': 'bytes={}-{}'.format(start + consumed, end)},
                            stream=True, timeout=600) as response:
                        response.raise_for_status()
                        _require_partial_content(response, url)
                        for chunk in response.iter_content(1 << 20):
                            consumed += len(chunk)
                            block = decompressor.decompress(chunk) if decompressor else chunk
                            if block:
                                handle.write(block)
                                crc = zlib.crc32(block, crc)
                                written += len(block)
                                if bar:
                                    bar.update(len(block))
                    break
                except _request_failures() as err:
                    if attempt == MAX_ATTEMPTS - 1:
                        raise
                    handle.flush()
                    delay = 2 ** attempt
                    print('\n  transfer interrupted after {:.2f} GB ({}); resuming in {}s '
                          '[attempt {} of {}]'.format(consumed / 1e9, type(err).__name__,
                                                      delay, attempt + 2, MAX_ATTEMPTS),
                          flush=True)
                    time.sleep(delay)

            if decompressor:
                block = decompressor.flush()
                if block:
                    handle.write(block)
                    crc = zlib.crc32(block, crc)
                    written += len(block)
                    if bar:
                        bar.update(len(block))
    finally:
        if bar:
            bar.close()

    if written != entry['uncompressed'] or crc != entry['crc']:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            'Extracted {} bytes with CRC {:08x} for {!r}, but the archive records {} bytes '
            'with CRC {:08x}. The transfer was incomplete or corrupted.'.format(
                written, crc, member, entry['uncompressed'], entry['crc']))

    partial.replace(destination)
    return destination


# Schouten et al. (2024), Sci. Rep. 14, 26708 -- doi:10.5281/zenodo.13991965, the version of
# record for concept doi:10.5281/zenodo.13235438. One 18.97 GB zip, no per-file URLs.
REVEAL_ARCHIVE = ('https://zenodo.org/api/records/13991965/files/'
                  'Supplementary_material.zip/content')


def fetch_reveal(downsampled=False):
    """REVEAL tomography anomalies on a regular lon/lat/depth grid.

    REVEAL (Thrastarson et al. 2024) is published natively on an unstructured Salvus mesh;
    this regular-grid form is the derived product from the Schouten et al. (2024) supplement,
    and it is what prep_model.py reads. The grid carries vs_anomaly and vp_anomaly, among
    others, relative to a 1-D reference.

    Extracted from the middle of an 18.97 GB archive by range request, so the transfer is
    4.59 GB rather than 19 GB. CRC-checked against the archive's own directory.

    Do not confuse the source record with Zenodo 10684325, which is the dataset of the REVEAL
    *model* paper: 49.3 GB of benchmark seismograms and no tomography grid.

    :param downsampled: fetch the 84 MB, 23-depth-level version instead of the full 4.98 GB,
        342-level one. Too coarse for prep_model.py's default 192 output levels, but useful
        for exercising the pipeline without a 4.6 GB download.
    :returns: Path to the netCDF file, suitable for prep_model.py --input.
    """
    name = 'REVEAL_downsampled_anomaly.nc' if downsampled else 'REVEAL_anomaly.nc'
    return fetch_zip_member(REVEAL_ARCHIVE, 'Supplementary_material/Models/' + name)


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
