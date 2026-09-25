# Archive format, version 1

What a Geode viewer expects to find at its Archive base URL. An Archive is
standalone (CONTEXT.md, ADR-0054): everything below lives under one base, and
nothing refers to another Archive.

Field-by-field definitions are **not** repeated here. `viewer/src/core/types.ts`
(`ArchiveIndex`, `Manifest`, `VariableInfo`, `CoastlineSet`,
`ReconstructionManifest`, `ColormapData`) is the normative, commented schema;
this document is the structure, the rules that span files, and the versioning
policy. `prep/verify_archive.py` checks an Archive against it.

## Layout

```
archive.json                       the index -- the only file a viewer is told about
colormaps.json                     colour ramps, by name
models/<id>/manifest.json          one per Model
models/<id>/frames/<variable>/<resolution>/<frame>.bin[.gz]
models/<id>/ingest.json            the Model's Ingest Config        (imported Models)
models/<id>/verification/          its Verification Card            (imported Models)
coastlines/  scotese_coastlines/  coastlines_<key>_native/
                                   geometry.bin[.gz] + rotations.json[.gz]
boundaries/boundaries.json[.gz]    a petrify boundary series, frames/*.geojson[.gz]
reconstructions/<id>/manifest.json one per Reconstruction Model
surface/topography.jpg             present-day surface texture
<section>/source.json              provenance of a non-Model layer
```

Only `archive.json`, `colormaps.json`, the `coastlines` set and at least one
Model are required. Every other section is optional, and a viewer must
render without it.

## Rules that span files

**The index names every file.** Every path a viewer fetches is written in
`archive.json` or in a manifest it points to, relative to the Archive base
(reconstruction manifests: relative to their own directory; boundary frames:
relative to the series manifest). Nothing is found by listing a directory.
`surface/topography.jpg` is the one file loaded by convention; it is optional.

**`.gz` is named, not guessed.** A gzipped file's reference ends in `.gz`
(`path_template` ending `.bin.gz`, `geometry.bin.gz`, ...). Readers decide
whether to decompress from the gzip magic bytes, not the name, so a host that
serves the file with `Content-Encoding: gzip` also works. A packed Archive
(`prep/pack_deploy.mjs`) differs from a raw one only in these names.

**Volume bytes.** One file per (variable, resolution, frame): unsigned 8-bit,
longitude fastest, then latitude (ascending from -90), then depth (ascending
from `depth_min_km`), matching a WebGL `Data3DTexture`. Samples sit at
longitude `-180 + i * 360 / nlon` (i = 0 .. nlon-1: the seam is not
repeated), latitude `-90 + j * 180 / (nlat - 1)` (both poles included) and
depth `depth_min_km + k * (depth_max_km - depth_min_km) / (ndepth - 1)` --
the positions `volumeUVW` in `core/glsl/geographic.ts` reads. A byte `b` decodes to
`encode_min + b / 255 * (encode_max - encode_min)`. Encoding truncates, so a
decoded value lies within one stored level *below* its source value; values
outside the encode range are clamped to it. There is no no-data byte unless
the manifest declares `no_data_sentinel`.

**Provenance.** A Model's citation is its manifest's `source`. Every other
layer's is the `source.json` in its directory, which `archive.json` collects
into `sources` keyed by directory name. A viewer credits a layer only when it
loaded and the Archive states a source for it.

**Copied layers.** A layer copied from another Archive (ADR-0054) is copied
as that release's packed bytes, and its `source.json` records where from, e.g.
`"copied_from": "Geode data-v22"`.

## Versioning

`archive.json` carries `"format": 1`. An index without it is format 1.

The number only goes up for a change an existing viewer would misread: a
renamed or removed field, a changed byte layout, a new required file.
Adding an optional field or section is not a new format. A viewer that meets
a format newer than it knows refuses the Archive with a message saying so,
instead of rendering the part it understands -- the same rule as the Explorer
recipe (ADR-0049).
